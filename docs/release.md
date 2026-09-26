# Release recipe

A release is a tag (`docs/PLAN.md` rule 10). Two separate tag namespaces:

- **`web-v*`** — publishes the public Hugging Face Space `2shay/fruitbat`.
- **`mac-v*`** — publishes a GitHub Release + updates the Sparkle appcast.

They're kept apart (decision C13) because a single `v*` namespace would make a web-only tag
turn into a GitHub "release" with no appcast entry, silently breaking every Mac user's auto-update
check. The appcast always lives at the fixed URL
`https://aj-prabhu.github.io/fruitbat/appcast.xml` (the `gh-pages` branch), never at
`releases/latest/…`, so a web tag can never touch it.

A tag containing `-test` (e.g. `web-v0.0.1-test`) is a dry run: `release.yml` stops right after
`release-check.sh` and prints what it would have deployed, without touching any Space or Release.
This is how the release path gets exercised without shipping anything.

## The recipe (rule 10 + S1-16)

1. **Freeze `main`.** No merges while a release is in flight.
2. **Bench rows on `main` HEAD.** `bench/run.sh --target web`.
3. **Commit the rows**, as a separate commit on top of the tested commit (never amend it — that
   would break `git diff --quiet <row.commit> HEAD` and invalidate the rows).
4. **`scripts/release-check.sh` on the rows commit.** This is the single dependency of every
   release: it re-runs the unit + e2e suite, `check-logs`/`check-network`, `gitleaks`, the bench
   gate, the graded pass, `strings-check`, and the privacy request log, and refuses to pass on a
   `0.0.0` version or a missing `CHANGELOG.md` section.
5. **Tag the rows commit** (not `main` HEAD before the rows land): `git tag web-v0.1.0 <rows-commit>`.
6. **Push the tag.** `release.yml` fires, re-runs `release-check.sh` against the tagged commit,
   and — for a non-`-test` `web-v*` tag — runs `scripts/deploy-space.sh 2shay/fruitbat
   --allow-public`, which updates the public Space.

```bash
bench/run.sh --target web
git add bench/results.csv bench/baselines.json
git commit -m "bench: release rows for web-v0.1.0"
TAG=web-v0.1.0 scripts/release-check.sh "$(git rev-parse HEAD)"
git tag web-v0.1.0
git push origin web-v0.1.0
```

For a dry run, tag with `-test` instead and skip the push if you just want the local check:

```bash
TAG=web-v0.0.1-test RELEASE_CHECK_ALLOW_MISSING=1 scripts/release-check.sh "$(git rev-parse HEAD)"
```

`RELEASE_CHECK_ALLOW_MISSING=1` is for local dry runs only — it downgrades a missing check
(infra that hasn't landed yet, e.g. `bench/gate.py`) from FAIL to SKIPPED. Never set it for a
real release; `release.yml` never sets it.

Mac (`mac-v*`) follows the same shape but hands off to `scripts/release.sh` (S2-12, not built
yet) after `release-check.sh` passes.

## Cut-list fallback: a hand-filled bench gate

If the bench runner slips (docs/PLAN.md cut list), commit a hand-filled gate as
`bench/release-gate-<tag>.md` (for example `bench/release-gate-web-v0.1.0.md`) in the tagged
commit. The release workflow passes it to `release-check.sh` as `RELEASE_GATE_FILE`, which then
accepts it in place of bench rows. Locally: `RELEASE_GATE_FILE=bench/release-gate-<tag>.md
scripts/release-check.sh <commit>`.
