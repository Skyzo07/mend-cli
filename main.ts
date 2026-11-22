// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: sections 1 to 4 (command line, output and exit codes, safe paths, format
// detection), section 5 (matching lines at three tiers), section 6 (unified diffs), section 7
// (SEARCH/REPLACE blocks), section 8 (V4A patches), section 9 (JSON edits) and section 10 (order and
// atomicity). In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A move a successful edit performed, for the R output line (section 2). */
interface Move {
  old: string;
  new: string;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines, and the file as lines.
// ---------------------------------------------------------------------------

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

interface FileDoc {
  br: '\r\n' | '\n';
  lines: string[];
  ends: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const parts = text.split(br);
  if (ends) parts.pop();
  return { br, lines: parts, ends };
}

function renderDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.ends ? d.br : '');
}

const normAt = (tier: number, s: string): string => (tier === 0 ? s : tier === 1 ? trimEndWS(s) : trimWS(s));

/** Positions i where O matches lines[i..] at `tier`, at or after `from`. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const ol = O.map((s) => normAt(tier, s));
  const out: number[] = [];
  for (let i = from; i + ol.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < ol.length; j++) {
      if (normAt(tier, lines[i + j]) !== ol[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence at or after `from`. */
function firstTier(lines: string[], O: string[], strict: boolean, from = 0, endOk?: (pos: number) => boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t, from);
    if (occ.some((p) => !endOk || endOk(p))) return t;
  }
  return -1;
}

/** One line of N: `fromO` set when it is a context line, the file's own matched line O[fromO]. */
interface NLine {
  text: string;
  fromO?: number;
}

/**
 * The lines N writes, replacing the k matched lines at `pos`: context lines are the file's own
 * matched lines, and at tier 2 every other line is re-indented (section 5).
 */
function resolveN(N: NLine[], docLines: string[], pos: number, tier: number, O: string[]): string[] {
  const out = N.map((n) => (n.fromO !== undefined ? docLines[pos + n.fromO]! : n.text));
  if (tier === 2) {
    const F = leadWS(docLines[pos] ?? '');
    const P = leadWS(O[0] ?? '');
    for (let k = 0; k < N.length; k++) {
      if (N[k]!.fromO !== undefined) continue;
      const s = out[k]!;
      if (s === '' || s.trim() === '') continue;
      if (s.startsWith(P)) out[k] = F + s.slice(P.length);
    }
  }
  return out;
}

/** O and N of a body of ` `, `-`, `+` lines (an empty line is an empty context line). */
function chunkON(body: string[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.startsWith(' ')) {
      const text = b.slice(1);
      const oIdx = O.length;
      O.push(text);
      N.push({ text, fromO: oIdx });
    } else if (b === '') {
      const oIdx = O.length;
      O.push('');
      N.push({ text: '', fromO: oIdx });
    } else if (b.startsWith('-')) {
      O.push(b.slice(1));
    } else if (b.startsWith('+')) {
      N.push({ text: b.slice(1) });
    }
  }
  return { O, N };
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  O: string[];
  N: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinal: boolean;
  /** A `\` line follows the hunk's last `+` line, or null when it has none. */
  plusNoFinal: boolean | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(l: string, lineNo: number): number {
  const m = HUNK_RE.exec(l);
  if (!m) throw new Exit2(`error: parse ${lineNo}`);
  return Number(m[1]);
}

/** The hunk's body: lines after the header starting with ` `, `-`, `+`, `\`, or empty. */
function parseHunkBody(lines: string[], i: number): { body: string[]; next: number } {
  const body: string[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

function buildHunk(a: number, parsed: { body: string[]; next: number }): { hunk: Hunk; next: number } {
  const { O, N } = chunkON(parsed.body);
  let lastCtxPlus = -1;
  let lastPlus = -1;
  parsed.body.forEach((b, idx) => {
    if (b.startsWith(' ') || b === '') lastCtxPlus = idx;
    else if (b.startsWith('+')) {
      lastCtxPlus = idx;
      lastPlus = idx;
    }
  });
  const follows = (idx: number): boolean => parsed.body[idx + 1] !== undefined && parsed.body[idx + 1]!.startsWith('\\');
  return {
    hunk: {
      a,
      O,
      N,
      noFinal: lastCtxPlus >= 0 && follows(lastCtxPlus),
      plusNoFinal: lastPlus >= 0 ? follows(lastPlus) : null,
    },
    next: parsed.next,
  };
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  diffOld: string | null;
  diffNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function headerPath(l: string): string {
  return l.slice(4).split('\t')[0]!.trim();
}

function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: Section[] = [];
  const newSection = (): Section => ({
    pairOld: undefined,
    pairNew: undefined,
    diffOld: null,
    diffNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSection();
        sections.push(cur);
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (cur.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.pairOld = stripPrefix(headerPath(l));
        cur.pairNew = stripPrefix(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) {
        const h = buildHunk(parseHunkHeader(l, i + 1), parseHunkBody(lines, i + 1));
        cur.hunks.push(h.hunk);
        i = h.next;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // After the section's hunks: another hunk, a new section, or ignored prose.
    if (l.startsWith('@@')) {
      const h = buildHunk(parseHunkHeader(l, i + 1), parseHunkBody(lines, i + 1));
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection();
      sections.push(cur);
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict, moves));
}

/** Apply a section's hunks in order to a file's lines. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), doc.lines.length);
      const atEnd = at === doc.lines.length;
      doc.lines.splice(at, 0, ...h.N.map((n) => n.text));
      if (atEnd) doc.ends = !h.noFinal;
      d += h.N.length;
      continue;
    }
    const tier = firstTier(doc.lines, h.O, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrences(doc.lines, h.O, tier);
    const target = h.a - 1 + d;
    let best = occ[0]!;
    for (const p of occ) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    const oldLen = doc.lines.length;
    const rep = resolveN(h.N, doc.lines, best, tier, h.O);
    const toEnd = best + h.O.length === oldLen;
    doc.lines.splice(best, h.O.length, ...rep);
    if (toEnd) doc.ends = !h.noFinal;
    d += h.N.length - h.O.length;
  }
}

function unifiedSectionEdit(sec: Section, strict: boolean, moves: Move[]): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== null ? sec.renameFrom : sec.diffOld;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== null ? sec.renameTo : sec.diffNew;
  const isCreate = oldP === null || sec.newFile;
  const isDelete = !isCreate && (newP === null || sec.deletedFile);
  if (isCreate) {
    const np = newP;
    return (tree) => {
      if (np === null) return;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusNoFinal: boolean | null = null;
      for (const h of sec.hunks) {
        for (const n of h.N) if (n.fromO === undefined) plus.push(n.text);
        if (h.plusNoFinal !== null) lastPlusNoFinal = h.plusNoFinal;
      }
      const ends = plus.length > 0 && !(lastPlusNoFinal ?? false);
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (ends ? '\n' : ''));
    };
  }
  if (isDelete) {
    const op = oldP;
    return (tree) => {
      if (op === null) return;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = parseDoc(cur);
      applyHunks(doc, sec.hunks, strict, oldP);
      tree.now.set(newP, renderDoc(doc));
      tree.now.set(oldP, null);
      moves.push({ old: oldP, new: newP });
    };
  }
  const p = oldP ?? newP;
  return (tree) => {
    if (p === null) return;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const doc = parseDoc(cur);
    applyHunks(doc, sec.hunks, strict, p);
    tree.now.set(p, renderDoc(doc));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseDoc(cur);
    const tier = firstTier(doc.lines, oldLines, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrences(doc.lines, oldLines, tier);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const pos = occ[0]!;
    const rep = resolveN(newLines.map((t) => ({ text: t })), doc.lines, pos, tier, oldLines);
    doc.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, renderDoc(doc));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

const V4A_SECTION = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const flines: string[] = [];
      let j = i + 1;
      while (j < last) {
        const x = lines[j]!;
        if (V4A_SECTION(x) || x.trim() === '*** End Patch') break;
        if (x.startsWith('+')) {
          flines.push(x.slice(1));
          j++;
          continue;
        }
        if (x === '') {
          flines.push('');
          j++;
          continue;
        }
        if (blank(x)) {
          // A whitespace-only line: a blank line at the end of the section is not part of it,
          // but one before more file lines is not a line of the section.
          let k = j + 1;
          while (k < last && blank(lines[k]!)) k++;
          if (k >= last || V4A_SECTION(lines[k]!) || lines[k]!.trim() === '*** End Patch') {
            j = k;
            break;
          }
          throw new Exit2(`error: parse ${j + 1}`);
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (flines.length > 0 && flines[flines.length - 1] === '') flines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, flines.length === 0 ? '' : flines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i++;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const r = parseV4aUpdate(lines, i, last, strict, moves);
      edits.push(r.edit);
      i = r.next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function parseV4aUpdate(
  lines: string[],
  i: number,
  last: number,
  strict: boolean,
  moves: Move[],
): { edit: Edit; next: number } {
  const path = lines[i]!.slice('*** Update File: '.length).trim();
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let j = i + 1;
  if (j < last && lines[j]!.startsWith('*** Move to: ')) {
    moveTo = lines[j]!.slice('*** Move to: '.length).trim();
    j++;
  }
  let cur: V4aChunk | null = null;
  let anyChunk = false;
  while (j < last) {
    const l = lines[j]!;
    if (V4A_SECTION(l) || l.trim() === '*** End Patch') break;
    if (l.startsWith('@@')) {
      if (cur) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      anyChunk = true;
      j++;
      continue;
    }
    if (l === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${j + 1}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      j++;
      continue;
    }
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${j + 1}`);
    if (blank(l)) {
      // A blank line is an empty context line of an open chunk, the first line of the first
      // chunk, or a blank line at the end of the section, which is not part of it.
      if (cur) {
        cur.body.push(l);
        j++;
        continue;
      }
      if (!anyChunk) {
        cur = { anchor: null, eof: false, body: [l] };
        anyChunk = true;
        j++;
        continue;
      }
      j++;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (!cur && anyChunk) throw new Exit2(`error: parse ${j + 1}`);
      if (!cur) {
        cur = { anchor: null, eof: false, body: [] };
        anyChunk = true;
      }
      cur.body.push(l);
      j++;
      continue;
    }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  if (cur) {
    while (cur.body.length > 0 && blank(cur.body[cur.body.length - 1]!)) cur.body.pop();
    chunks.push(cur);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
  const edit: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const tier = firstTier(doc.lines, [ch.anchor], strict, cursor);
        if (tier < 0) throw new Fail('no-match', path);
        cursor = occurrences(doc.lines, [ch.anchor], tier, cursor)[0]! + 1;
      }
      const { O, N } = chunkON(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        doc.lines.splice(at, 0, ...N.map((n) => n.text));
        cursor = at + N.length;
        continue;
      }
      const endOk = ch.eof ? (p: number): boolean => p + O.length === doc.lines.length : undefined;
      const tier = firstTier(doc.lines, O, strict, cursor, endOk);
      if (tier < 0) throw new Fail('no-match', path);
      const pos = occurrences(doc.lines, O, tier, cursor).filter((p) => !endOk || endOk(p))[0]!;
      const rep = resolveN(N, doc.lines, pos, tier, O);
      doc.lines.splice(pos, O.length, ...rep);
      cursor = pos + rep.length;
    }
    const text = renderDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
  return { edit, next: j };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, { key: string; text: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of moves) {
    const dRow = rows.get(m.old);
    const aRow = rows.get(m.new);
    if (dRow !== undefined && dRow.text.startsWith('D ') && aRow !== undefined && aRow.text.startsWith('A ')) {
      rows.delete(m.old);
      rows.delete(m.new);
      rows.set(`\0R:${m.new}`, { key: m.new, text: `R ${m.old} -> ${m.new}` });
    }
  }
  const out = [...rows.values()]
    .sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))
    .map((r) => r.text);
  if (!check) {
    // Deletions first: a created path may sit under a path this patch deletes.
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now !== null) continue;
      rmSync(p, { force: true });
    }
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
