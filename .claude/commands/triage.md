# /triage — bug report triage

Given a GitHub issue number, triage a Fruitbat bug report end to end.

## Steps

1. **Read the report.** `gh issue view <number>` and read the `BugReport`
   fields (level, target, doc/corpus id, what happened). The report never
   contains source text or file names — if it looks like it does, stop and
   flag it instead of continuing.

2. **Reproduce.** Use the corpus doc and level named in the report:
   - Mac: `fruitbat-cli` with that doc and level.
   - Web: `bench/run.sh --target web` with that doc and level.

3. **Classify** the result as one of:
   - `bug` — reproduced, behavior is wrong.
   - `cannot-reproduce` — doesn't reproduce with the given doc/level.
   - `needs-info` — can't reproduce or classify without more detail.
   - `duplicate` — matches an existing open issue.

4. **If `needs-info`**, post exactly ONE question as an issue comment. Don't
   guess and don't ask more than one thing at a time.

5. **If `bug`**:
   - Create a branch `fix/<issue>-<slug>`.
   - Fix it.
   - Attach bench rows for the fix commit (or the `bootstrap` label if the
     bench runner isn't live yet).
   - Open a PR whose body links the issue (`Fixes #<issue>`).
   - Request a Codex cross-inspection of the diff before asking Akshay to
     merge.

6. **Never paste user text into the issue or PR.** Not the report's
   `user_description`, not reproduced source text, nothing from what the user
   was reading. Refer to it by doc id and level only.

7. **Akshay merges by hand.** This command never merges anything. It opens
   the PR and stops.
