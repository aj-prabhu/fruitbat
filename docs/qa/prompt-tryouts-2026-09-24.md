# Prompt try-outs, 2026-09-24 (S0-03)

`spec/tools/try-prompts.mjs`, `onnx-community/Qwen3.5-0.8B-Text-ONNX` @ `1e45dab`, `model_q4.onnx` on CPU
(Node, Transformers.js 4.3.0, M1 Pro), greedy, thinking off, `--max-words 1000`. Inputs: doc `005`
(relational/negation, 400 words, from the first S0-04a draft; the text itself is fine) and the
walking-skeleton bat paragraph as a stand-in for `011` (158 words; the first S0-04a corpus was
rejected and the redo had not landed when these ran).

## What the runs show

- Every level returns `- ` lines only, no `<think>`, numbers and names kept. The S0-03 proof holds.
- **The model does not obey bullet counts.** "3 to 6", "exactly 5", and "exactly 4" all produced
  10–19 bullets: it transcribes the document sentence by sentence until `max_new_tokens`. Putting
  the rules after the text (v3) did not help and produced more paraphrase drift ("paid him $400"
  where the source says Marcus paid Sarah).
- So the per-chunk caps in `spec/dial.json` are enforced by the bullet parser (S1-03), and a cap
  that keeps the first N bullets keeps the **start** of the chunk only. That is the main quality
  risk for S1-05's bake-off to solve: try q4f16 on WebGPU (different numerics), a system prompt,
  one-shot examples, fallback A (Qwen2.5-0.5B-Instruct), or chunking at ~500 tokens so N bullets
  ≈ one chunk. Speed on CPU q4: 14–18 tok/s at Short.
- Grounding v3 passes "Sarah drove Marcus to appointments and paid him $400" against a source
  where Marcus paid Sarah: names and numbers are all present. That is the reversed relation the
  filter cannot see; the graded rubric on `005` exists for exactly this.
- One line worked on both inputs (1 line, ≤ 25 words). Caveman bullets were ≤ 12 words, most ≤ 9.

## Raw outputs

### Proof run: caveman, doc 011 (first corpus draft, later rejected)
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=caveman doc=011.txt words=1000 prompt_tokens=1409 new_tokens=82 load_ms=33580 gen_ms=8515 tok_s=9.6
- Bats are the only mammals that can fly with their wings.
- Their wings are made of skin stretched between finger bones.
- They use sound to navigate in total darkness.
- Their diet includes insects and fruit.
- They are essential for pest control and pollination.
- They face many threats from habitat loss.
- Conservation efforts are needed to protect them.

### short / oneline / caveman on 005 and 011 (first corpus draft), prompts v1 (ranges)
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=short doc=005.txt words=400 prompt_tokens=678 new_tokens=220 load_ms=1291 gen_ms=12075 tok_s=18.2
- Sarah needed a car for her move to Portland in March.
- She asked Marcus, who owned a sedan, if she could borrow it for two weeks.
- Marcus agreed, never expecting repayment.
- In April, Marcus came down with pneumonia and missed two weeks of work.
- Sarah immediately took time off and drove Marcus to his medical appointments.
- Instead of accepting her help without charge, Marcus paid her $400.
- By June, Sarah had saved $6000.
- She asked David, her accountant, for help.
- David found $1200 in deductions she had missed.
- Sarah paid David $250.
- David's daughter needed essay help.
- Sarah edited five essays over fifteen hours.
- David insisted on paying $500, though Sarah refused.
- In September, Rachel lost her job.
- Sarah was unable to work but had $1000 to spare.
- She gave money to Rachel with no conditions.
- Rachel found work
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=short doc=011.txt words=1000 prompt_tokens=1429 new_tokens=220 load_ms=1201 gen_ms=15362 tok_s=14.3
- Bats represent one of nature's most successful and diverse groups of mammals.
- There are over 1,400 bat species worldwide, making bats nearly one-quarter of all mammal species.
- Bats inhabit every continent except Antarctica.
- They thrive in diverse environments from tropical rainforests to temperate woodlands.
- Despite their abundance, bats remain misunderstood by many people.
- Bats are the only mammals capable of sustained powered flight.
- This remarkable adaptation evolved millions of years ago.
- Their wings consist of thin membranes of skin stretched between elongated finger bones and the body.
- This arrangement provides exceptional maneuverability.
- Many bat species have evolved echolocation, a sophisticated biological sonar system.
- Bats emit high-frequency sounds and listen to echoes returning from objects.
- This allows them to navigate and hunt in complete darkness.
- The sophistication of bat echolocation exceeds human sonar technology in several respects.
- Bats have evolved remarkable dietary specializations.
- Most bat species are insectivorous
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=oneline doc=005.txt words=400 prompt_tokens=641 new_tokens=19 load_ms=1256 gen_ms=2671 tok_s=7.1
- Sarah asked Marcus to borrow a car for two weeks to help her move.
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=oneline doc=011.txt words=1000 prompt_tokens=1392 new_tokens=16 load_ms=1263 gen_ms=4815 tok_s=3.3
- Bats are the only mammals capable of sustained powered flight.
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=caveman doc=005.txt words=400 prompt_tokens=658 new_tokens=120 load_ms=1223 gen_ms=7590 tok_s=15.8
- Sarah asked Marcus to borrow a car for two weeks.
- Marcus agreed without expecting repayment.
- In April, Marcus missed work due to pneumonia.
- Sarah drove Marcus to appointments instead of accepting help.
- Marcus paid $400 for her help.
- By June, Sarah saved $6000.
- Sarah asked David for help with deductions.
- David found $1200 in missed payments.
- Sarah paid David $250.
- David's daughter needed essay help.
- Sarah edited five essays over fifteen hours
done

### prompts v2 (exact counts, committed), short + caveman on 005 and 011
[short-005]
- Sarah asked Marcus to borrow a sedan for two weeks.
- Marcus agreed without expecting repayment.
- In April, Marcus missed two weeks of work.
- Sarah took time off and drove Marcus to appointments.
- Instead of accepting help without charge, Marcus paid $400.
- By June, Sarah had saved $6000.
- She asked David for help with deductions.
- David found $1200 in missed deductions.
- Sarah paid David $250.
- David's daughter needed essay help.
- Sarah edited five essays over fifteen hours.
- David insisted on paying $500, though Sarah refused.
- In September, Rachel lost her job.
- Sarah was unable to work but had $1000 to spare.
- She gave money to Rachel with no conditions.
- Rachel found work in November and immediately repaid $1000.
- However, Sarah and Marcus never made the repayment official.
- The debt hung between them.
- By
[short-011]
- Bats are one of nature's most successful and diverse groups of mammals.
- There are over 1,400 bat species worldwide, making bats nearly one-quarter of all mammal species.
- Bats inhabit every continent except Antarctica.
- They thrive in diverse environments from tropical rainforests to temperate woodlands.
- Despite their abundance, bats remain misunderstood by many people.
- Bats are the only mammals capable of sustained powered flight.
- This remarkable adaptation evolved millions of years ago.
- Their wings consist of thin membranes of skin stretched between elongated finger bones and the body.
- This arrangement provides exceptional maneuverability.
- Many bat species have evolved echolocation, a sophisticated biological sonar system.
- Bats emit high-frequency sounds and listen to echoes returning from objects.
- This allows them to navigate and hunt in complete darkness.
- The sophistication of bat echolocation exceeds human sonar technology in several respects.
- Bats have evolved remarkable dietary specializations.
- Most bat species are insectivorous
[caveman-005]
- Sarah asked Marcus to borrow a car for two weeks.
- Marcus agreed without expecting repayment.
- In April, Marcus missed work due to pneumonia.
- Sarah took time off to drive Marcus to appointments.
- Instead of accepting help, Marcus paid $400.
- By June, Sarah saved $6000.
- She asked David for help with deductions.
- David found $1200 in missed payments.
- Sarah paid David $250.
- David's daughter needed essay help.
- Sarah edited five essays over
[caveman-011]
- Bats are mammals that fly with thin skin stretched between finger bones.
- They live in every continent except Antarctica.
- Their wings allow them to maneuver easily.
- They use echolocation to hunt in total darkness.
- They feed on insects and serve as pollinators.
- They are essential for pest control and food distribution.
- They face threats like habitat loss and disease.
- Conservation efforts are needed to protect them.
- Understanding their biology helps us appreciate them.
- They are one of nature's most successful groups.

### experiment v3 (rules after the text), short on 005 and the 011 stand-in — not adopted
(13 and 12 bullets; see above)
