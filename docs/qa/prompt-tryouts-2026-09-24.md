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

## Rerun on the redone corpus (4c130a4), 2026-09-24 00:2x

Validator: `python3 spec/eval/validate.py --corpus-only` → `30 docs OK, roles OK`. Proof (caveman, real 011): PASS, 8 bullets, no <think>.

### caveman on 011
```
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=caveman doc=011.txt words=1000 prompt_tokens=1428 new_tokens=120 load_ms=1222 gen_ms=10319 tok_s=11.6
- The park hosts 17 bat species, including free-tailed and cave myotis.
- These bats roost in caves, trees, or rock cliffs.
- Bats are mammals that give live birth and are warm-blooded.
- They are insectivores and weigh about 1/2 ounce.
- Their numbers fluctuate seasonally and daily.
- Researchers use thermal cameras to count bats.
- The resident colony is typically greater than 50% male.
- WNS is a deadly fungus affecting bats in the US.
- WNS
[caveman 011] bullets=9 think=0
```

### short on 005
```
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=short doc=005.txt words=437 prompt_tokens=702 new_tokens=220 load_ms=1231 gen_ms=12669 tok_s=17.4
- Alice paid Bob $120 on March 3 to cover her half of the electric bill, not the water bill, which Carla had already handled separately.
- Bob never repaid Alice for a $45 parking ticket he asked her to cover in February, and by June he still owed her that amount, in addition to nothing else.
- Carla lent Dev her car for the weekend of April 12, not her truck, because the truck was in the shop that week.
- Dev scratched the car's bumper and paid Carla $80 toward the repair, rather than the full $200 estimate, since Carla decided the shop was overcharging and got a second quote for $95 instead.
- Dev has since paid off that lower amount in full, owing Carla $40 for a grocery run in May, not $400 — a typo in the group spreadsheet listed it as $400 for two weeks before Alice caught the error and fixed it.
- Carla has not chased Dev for the $40 yet, and Dev
[short 005] bullets=6 think=0
```

### oneline on 005
```
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=oneline doc=005.txt words=437 prompt_tokens=659 new_tokens=21 load_ms=1236 gen_ms=2861 tok_s=7.3
- Bob owed Alice $45 for a ride to the airport, which Carla denied.
[oneline 005] bullets=1 think=0
```

### caveman on 005
```
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=caveman doc=005.txt words=437 prompt_tokens=673 new_tokens=120 load_ms=1321 gen_ms=8018 tok_s=15.0
- Alice paid Bob $120 on March 3 to cover her half of the electric bill, not the water bill.
- Bob never repaid Alice for a $45 parking ticket he asked her to cover in February.
- Carla lent Dev her car for the weekend of April 12, not her truck.
- Dev scratched the car's bumper and paid Carla $80 toward the repair, not the full $200 estimate.
- Dev owes Carla $40 for a grocery run in May, not $400 — a typo in the
[caveman 005] bullets=5 think=0
```

### short on 011
```
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=short doc=011.txt words=1000 prompt_tokens=1457 new_tokens=220 load_ms=1161 gen_ms=15340 tok_s=14.3
- The park hosts 17 bat species, including free-tailed bats and cave myotis.
- Free-tailed bats roost in the caverns and fly 1.5 miles before exiting the Natural Entrance.
- Other species like eastern red bats and hoary bats roost in trees or rock cliffs.
- Bats are mammals that give live birth, are warm-blooded, and have fur.
- Bats are the only true flying mammals in the park.
- All bats in the area are insectivores.
- The Brazilian free-tailed bat weighs about 1/2 ounce (3 nickel coins).
- Their wingspan is approximately 11 inches (28 cm).
- Bat numbers in the cavern vary, with summer colonies reaching 400,000.
- Migration numbers peaked at 793,000 in 2005.
- Researchers use thermal infrared cameras and visual recognition software to count bats.
- The resident colony should not be called the maternity colony because it is
[short 011] bullets=12 think=0
```

### oneline on 011
```
onnx-community/Qwen3.5-0.8B-Text-ONNX@1e45dab q4/cpu level=oneline doc=011.txt words=1000 prompt_tokens=1414 new_tokens=32 load_ms=1315 gen_ms=5871 tok_s=5.5
- The text states bats are mammals that give live birth, are warm-blooded, have fur, and are fed breast milk by their mothers.
[oneline 011] bullets=1 think=0
```

