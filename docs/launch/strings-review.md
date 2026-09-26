# S1-L0: product copy review

Written 2026-09-24 by Claude under the Voice Bank protocol: spine (`Voice Bank.md`) plus the
teaching channel file read in full before drafting; anti-phrase and AI-ism sweep after. File:
`spec/strings/en.json`, 118 values, both targets. Every message is also spoken (rule 8), so every
value was read aloud once and key names are words, never symbols (Control Option V, Command C).

## Choices

- One verb for the whole product: **Read**. The chip says Read, the button says Read it, the dial says
  how much (Read all, Short, Caveman, One line). "Summarize" never appears in the UI.
- Notices are one plain sentence with a period, so the voice ends them cleanly. Labels have no period.
- Plan-fixed wording kept as written (`notice.dial_shorter`, `notice.all_cut`, `notice.oneline_failed`,
  `notice.input_limit`, dial labels, `loading.summarizer_button`). `mac.intake.press_cmd_c` is the plan's
  sentence with the key spelled out for the voice.
- Every failure message says what still works ("Read all still works"). Rule 2 in copy form.
- Privacy is said in plain words where it matters: the download "stays on this device", the report has
  "numbers and settings only. Never your text", the update check is "the only time it calls home".
- Mac permission sentences: one plain sentence, what it is for, what still works if denied (C15).
- Caveman's own label is "Caveman"; its register lives in the prompt, not in the UI copy.
- Placeholders: `{n}` (count), `{mb}` (megabytes). Filled at runtime by both targets.

## Sweep (Voice Bank anti-phrases and AI-isms)

Checked and absent: em-dashes, triplet emphasis, period-separated imperatives, rhetorical-question
transitions, "unlock", "seamless", "elevate", "exciting", closing meta-punchlines ("That's it",
"That's the whole idea" were drafted and cut). Commas: only where a sentence needs one.

## Proof

- `node scripts/strings-check.mjs` → `strings-check: OK (118 strings, 2 UI files, 8 keys used)`:
  0 placeholder values, 0 JSX or attribute string literals in the UI files, every key the UI asks
  for exists.
- Voice capture: `vh capture snapshot --draft-id 2026-09-24-fruitbat-strings --channel teaching`,
  id logged below, so edits Akshay makes become Voice Bank rules.

## Not covered here

S1-02 and later packets add keys as they land; each new key is filled in that packet's PR, in the
same register, and this file gets a line. The application text (S1-L1) and the launch post (S1-L2)
are separate packets with their own Voice Bank pass.
