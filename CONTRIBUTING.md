# Contributing

## Ground rules

We ask that you:

- Sign off on your commits with DCO (`git commit -s`). No CLA required.
- Understand that once an outside contributor lands a commit, the code has
  multiple copyright holders. Relicensing later would require every contributor's
  consent. We've accepted this tradeoff.

## Branches and PRs

Use these naming conventions:

- Work packets: `pkt/<ID>-<slug>` (e.g. `pkt/S1-04-voice-engine`)
- Bug fixes: `fix/<issue>-<slug>`

PR titles must start with the packet ID for work packets.

Anyone may open a PR. Only a maintainer merges, and never by auto-merge.

## Merging

Use a merge commit for every PR. Never squash, never rebase-merge.

**Why?** Bench result rows are committed on top of the tested commit. A row is
valid for HEAD only when this command is clean:

```bash
git diff --quiet <row.commit> HEAD -- . ':!bench/results.csv' ':!bench/baselines.json'
```

Squashing or rebase-merging rewrites the tested commit, so `row.commit` is no
longer an ancestor of HEAD and every row on that PR becomes invalid. A merge
commit keeps the tested commit and its rows intact.

## Bench rows and labels

Every PR needs bench rows (performance measurements), OR the `bootstrap` label
if it's a foundation packet before benchmarking infrastructure exists.

The `bootstrap` label is retired once the bench runner lands.

Use `baseline-reset` to replace bench baselines when the environment legitimately
changed (e.g. a new machine, a dependency update that affects runtime).

## Privacy for code

Logs must be structured (numbers and enums only). Never log:

- Source text or reading material
- Summaries or bullet points
- Audio or audio transcripts
- File names or URLs

For any new outbound network destination, add it to `spec/network.json`.

The only `fetch` site in the web app is `web/src/engine/net.ts`.

## Strings

All human-facing strings live in `spec/strings/en.json`. No string literals in
UI code.
