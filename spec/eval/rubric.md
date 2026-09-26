# Grading rubric

Three 1-5 scales, scored per output (one doc, one dial level). The grader is never shown
`key_facts` / `forbidden_claims` / `relational_checks` in isolation and asked to judge from
memory or general knowledge: it always receives, together, **the full source text, the
generated output, and the doc's `NNN.facts.json`**. Facts alone are not enough to catch a
reversed relation or a dropped negation — only the source text is. `score` for a row is the
**minimum** of the three scales (`spec/eval/grade.md`).

## Faithfulness

Does every claim in the output hold up against the source? This is the safety scale: a single
reversal or dropped negation caps the whole output at 1, no matter how good coverage or clarity
are.

- **5** — Every claim in the output is supported by the source. No invented numbers, names,
  relations, or negations.
- **4** — Every claim is supported; wording is looser than the source but not misleading.
- **3** — One minor unsupported detail (e.g. an adjective or a vague generality the source
  doesn't state) that doesn't change what the reader would believe happened.
- **2** — More than one minor unsupported detail, or one detail that's borderline misleading,
  but no reversed relation and no dropped negation.
- **1** — A reversed relation, a dropped negation, or an invented fact. This is explicit and
  non-negotiable: if the source says "Alice paid Bob" and the output says "Bob paid Alice",
  that is a **1**, full stop, regardless of how good the rest of the output is. Dropping a
  "not" or a "never" (source: "Bob never repaid Alice"; output: "Bob repaid Alice") is
  likewise a **1**. An invented name, number, or entity the source never mentions is a **1**.

## Coverage

Judged against the doc's `key_facts`, relative to what a summary at that dial level's length
cap (`spec/dial.json`) could realistically hold. A One-line output is not marked down for
omitting facts a Short output would be expected to keep.

- **5** — Every key fact a summary of this length could hold is present, in substance if not
  in wording.
- **4** — All but one key fact that fits the length budget is present, and the missing one is
  not the main point.
- **3** — Several key facts are missing, but the output still captures the doc's main point.
- **2** — Most key facts are missing; the output is thin even for its length budget.
- **1** — Misses the main point of the doc entirely, or covers something else instead.

## Clarity

Can this be read aloud, once, and understood? This is the accessibility bar the whole product
exists for.

- **5** — Plain words throughout, one idea per bullet, reads aloud naturally at a normal pace.
- **4** — Plain words, mostly one idea per bullet; one bullet is a little dense or runs on.
- **3** — Understandable but effortful: some jargon, a bullet with two ideas crammed in, or an
  awkward sentence that needs a re-read.
- **2** — Hard to follow aloud: heavy jargon, long clauses, or several bullets each carrying
  more than one idea.
- **1** — Not readable as plain spoken language (dense academic register, run-on sentences,
  unexplained jargon throughout).
