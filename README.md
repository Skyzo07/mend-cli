# mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Skyzo07/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Skyzo07/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line patch tool that applies the edits AI models write — unified diffs,
SEARCH/REPLACE blocks, V4A patches and JSON edits — to a tree of text files. It finds each
edit's lines at the first of three matching tiers (exact, trailing-whitespace-insensitive,
re-indented), and writes every change or none, printing what it changed or why it failed.
Node 22, standard library only; see `SPEC.md` for the full contract.

## Run it

```sh
node main.ts fix.patch
node main.ts --check fix.patch   # preview without writing
cat fix.patch | node main.ts -   # read the patch from stdin
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=pp5cg6v9&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
