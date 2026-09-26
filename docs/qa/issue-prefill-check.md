# S1-11 manual check: does the GitHub issue form actually prefill?

**This is Akshay's step, not an agent's.** Opening the URL below needs a real GitHub session
(logged in as aj-prabhu, or whichever account owns/watches the repo), and the screenshot is
something only he can take and judge. Everything up to "build the URL" is proven by
`npm test -- report` (see `web/src/tests/report.test.ts`); this file exists because that test
cannot open a browser tab.

## The sample URL

Produced by `buildReport()` + `buildIssueUrl()` (`web/src/report/build.ts`) from a small, realistic
`BugReport` fixture in the test suite (one run_stats row, one event, description "short bug").
Captured verbatim from `npx vitest run report --reporter=verbose` on 2026-09-25. Length: 2,200
characters (well under the 8,000 cap; see the "trims oldest events first, then oldest rows" test
for a 60-event/5-row case that lands at 7,943).

```
https://github.com/aj-prabhu/fruitbat/issues/new?template=bug.yml&title=bug%3A+short+web+dial+change&what_happened=short+bug&env=%7B%0A++%22ua%22%3A+%22Mozilla%2F5.0+%28Macintosh%3B+Intel+Mac+OS+X+10_15_7%29+AppleWebKit%2F537.36+%28KHTML%2C+like+Gecko%29+Chrome%2F130.0.0.0+Safari%2F537.36%22%2C%0A++%22gpu%22%3A+%22unknown%22%2C%0A++%22os%22%3A+%22macos+10%22%2C%0A++%22chip%22%3A+%22MacIntel%22%2C%0A++%22ram_bucket%22%3A+%22unknown%22%0A%7D&models=%5B%0A++%7B%0A++++%22id%22%3A+%22onnx-community%2FKokoro-82M-v1.0-ONNX%22%2C%0A++++%22rev%22%3A+%221939ad2a8e416c0acfeecc08a694d14ef25f2231%22%0A++%7D%2C%0A++%7B%0A++++%22id%22%3A+%22onnx-community%2FQwen3.5-0.8B-Text-ONNX%22%2C%0A++++%22rev%22%3A+%221e45daba048899e7f771657ada617ec49350aa91%22%0A++%7D%0A%5D&run_stats=%5B%0A++%7B%0A++++%22schema_version%22%3A+1%2C%0A++++%22target%22%3A+%22web%22%2C%0A++++%22device%22%3A+%22webgpu%22%2C%0A++++%22level%22%3A+%22short%22%2C%0A++++%22browser%22%3A+%22chrome%22%2C%0A++++%22browser_major%22%3A+130%2C%0A++++%22os%22%3A+%22macos%22%2C%0A++++%22os_major%22%3A+15%2C%0A++++%22cache_state%22%3A+%22warm%22%2C%0A++++%22model_id%22%3A+%22onnx-community%2FQwen3.5-0.8B-Text-ONNX%22%2C%0A++++%22model_rev%22%3A+%221e45daba048899e7f771657ada617ec49350aa91%22%2C%0A++++%22dtype%22%3A+%22q4f16%22%2C%0A++++%22doc_id%22%3A+%22011%22%2C%0A++++%22commit%22%3A+%2281092b9%22%2C%0A++++%22date%22%3A+%222026-09-24T12%3A00%3A00Z%22%2C%0A++++%22machine_id%22%3A+%22web%22%2C%0A++++%22ttfa_ms%22%3A+5200%2C%0A++++%22gen_ms%22%3A+3100%2C%0A++++%22tok_s%22%3A+22.5%2C%0A++++%22rtf%22%3A+1.4%2C%0A++++%22gap_ms%22%3A+90%2C%0A++++%22stop_ms%22%3A+140%2C%0A++++%22coverage%22%3A+null%2C%0A++++%22bullets_total%22%3A+5%2C%0A++++%22bullets_cut%22%3A+0%2C%0A++++%22cut_rate%22%3A+0%2C%0A++++%22facts_token_hit%22%3A+0.93%2C%0A++++%22halluc_flags%22%3A+0%2C%0A++++%22forbidden_hits%22%3A+0%2C%0A++++%22oneline_keyword_hit%22%3A+null%2C%0A++++%22tts_overlimit%22%3A+0%2C%0A++++%22peak_mb%22%3A+540%2C%0A++++%22heap_mb%22%3A+310%0A++%7D%0A%5D&events=%5B%0A++%7B%0A++++%22event%22%3A+%22dial_change%22%2C%0A++++%22t_ms%22%3A+0%2C%0A++++%22fields%22%3A+%7B%0A++++++%22chunk_index%22%3A+0%0A++++%7D%0A++%7D%0A%5D&app_version=web+0.0.0
```

(This one is from the test fixture, not a live app session, so the `env.ua`/`env.gpu`/`env.os`
values are whatever Node's stubbed `navigator` reports for the test, not a real browser. That's
fine for checking the *mechanism* -- does GitHub's form actually fill in from these field ids --
which is the only thing this check is for.)

## What to do

1. Open the URL above in a logged-in browser tab.
2. Take a screenshot of the opened issue form with every field visibly populated.
3. Check each box below against what's actually on screen.

## Checklist

- [ ] Title bar reads `bug: short web dial change` (from the `title` param).
- [ ] **What happened?** contains exactly `short bug`.
- [ ] **Environment** is a JSON block starting `{` and containing `"ua"`, `"gpu"`, `"os"`, `"chip"`,
      `"ram_bucket"` keys with values (not blank, not `undefined`).
- [ ] **Models** is a JSON array of two `{id, rev}` objects (Kokoro voice model, Qwen3.5 summarizer).
- [ ] **Run stats** is a JSON array with one object containing `schema_version`, `target`,
      `device`, `level`, and the rest of the RunStats columns.
- [ ] **Events** is a JSON array with one `{event, t_ms, fields}` object.
- [ ] **App and version** input reads `web 0.0.0`.
- [ ] The confirmation checkbox ("I checked the preview and this report contains nothing I was
      reading.") is present and **unchecked** -- it should never be prefilled; that tick is the
      user's own act after they've reviewed the preview in-app.
- [ ] `bug` label is applied (from `.github/ISSUE_TEMPLATE/bug.yml`'s own `labels:`, not the URL).
- [ ] No default assignee is set.
- [ ] Nothing on the form shows raw source text, article content, or a file name/URL of anything
      that would have been "what the user was reading" -- only structured data and the one
      sentence the user typed themselves.

If any box doesn't check out, the mismatch is almost certainly in
`.github/ISSUE_TEMPLATE/bug.yml`'s field `id`s vs. the param names `buildIssueUrl()`
(`web/src/report/build.ts`) sets -- GitHub silently drops a param whose name doesn't match a
field id exactly, per PLAN-REVIEW-LOG.md round 1 #26.
