# Short / Caveman / One line quality, 2026-09-29

Trigger: on the live dev Space (WebGPU, `onnx-community/Qwen3.5-0.8B-Text-ONNX` q4f16 @ `1e45dab`)
a 751-character megabat paragraph at Short came back as its first six sentences near-verbatim,
split at "and"; the last three facts (colonies, threats, extinctions) were missing.

All numbers here: `web/scripts/quality-cpu.mjs` (the production chunk → prompt → parse → ground
path from `web/src/core`, pinned model at its `cpu_tryout` dtype, **q4 on CPU in Node**, greedy,
thinking off), scored with `bench/score.py` plus compression, tail coverage, copy rate and cut
rate. The browser runs q4f16 on WebGPU; greedy outputs can differ slightly. The machine was under
heavy load from other jobs, so no timing number here means anything.

## Root cause

1. **The model transcribes.** Given a chunk and asked for N bullets, it writes one bullet per
   sentence or clause, in order, until it runs out of text or tokens. The megabat paragraph
   (7 sentences) came back as 11 clause-bullets on CPU; the first six are the live output.
2. **The cap keeps the head.** The parser keeps the first `max_bullets_per_chunk` (6) and drops
   the rest, so what survives is always the chunk's opening. On the 21 full-size chunks (> 800
   words) of the graded docs, the furthest kept Short bullet sat a median 16 % of the way into
   its chunk (range 6–78 %); the model usually hits `max_new_tokens` (220) before the middle.
3. **No single-call lever changes (1).** Same model, same megabat paragraph, Short:

| Variant (one call per chunk) | Result |
|---|---|
| current prompt | 11 clause-bullets = the text; the cap keeps the first 6, i.e. sentences 1–5 |
| "5 points, point 1 = start, point 5 = end, own words, never copy" | 10 bullets, verbatim |
| one-shot example (honeybees, 5 merged bullets) | identical to the current prompt |
| text first, then "exactly 5 numbered points" | exactly 5, = sentences 1–5 verbatim; tail missing |
| text rendered as "Part 1: … Part 5: …", "one point per part" | identical transcription, parts ignored |
| "3 sentences, ≤ 50 words, cover beginning/middle/end" | 3 merged lines covering sentences 1–4 only |
| `no_repeat_ngram_size: 6` | still 11 sentence-bullets, now with slips ("root in colonies", "20 gram") |
| `repetition_penalty: 1.15` | real paraphrase, but invents facts ("under two hundred grams", "for protection from predators", "to locate prey"); still 8 bullets, tail cut |

Thinking on was not measured to the end: it spends hundreds of tokens before the first bullet,
which the ≤ 8 s warm TTFA budget cannot absorb.

4. **Grounding is not the cause.** It runs after generation and the model never sees it. Probed
   directly on plausible condensed megabat lines, it passes paraphrases ("Hunting and forest loss
   threaten several species", "Most megabats find food by sight and smell, not echolocation") and
   cuts only invented numbers ("Two senses guide them") and one false positive class: a
   sentence-initial uncommon noun whose number changed ("Megabat colonies…" vs source
   "Megabats") is cut as an unknown name. Pooled cut rate stayed 1–2 % before and after. What does push
   toward copying is `facts_token_hit` itself: it needs the top three distinctive tokens of each
   key fact verbatim (e.g. "17", "different", "species"), so a copied sentence scores and a
   condensed one does not.

## What changed

- **Parts** (`spec/chunking.md` "Parts", `web/src/core/parts.ts`): a level with `part_tokens`
  splits each chunk's sentences into contiguous parts and asks for one line per part. Short:
  `part_tokens` 40, 3–6 parts per chunk. Caveman: 60, 2–5.
- **Prompts** ask for one point taken from one sentence. Every prompt that let the model merge
  sentences produced reversed or blended facts on the small model:
  "Bob asked Alice to pay him $120" (005: Alice paid Bob), "Dev paid off the $40 owed by Carla"
  (Dev owes Carla), "flying foxes … weighing less than 20 grams" (the smallest species weigh
  that). So Short and Caveman condense by choosing and trimming, not by rewriting.
- **Parts never open on a sentence that leans back** ("They …", "Instead they …"): cut off from
  its name the model guessed one ("Flying foxes have large eyes and a strong sense of smell" from
  "Instead they rely on large eyes"; after the rule, that line is gone).
- **Cut-off lines** are dropped: a last line that stops at `max_new_tokens` mid-sentence is
  never shown or spoken. One line gets `max_new_tokens` 80 (was 60) so a long line can finish.
- **Meta openers** ("The passage states that …") are stripped when a whole sentence follows.
- One line prompts are unchanged: a topic-first prompt and a "cover the whole document" reduce
  prompt moved keywords 25/25/25 % → 0/50/25 % on 005/011/013, i.e. noise.

## Before / after

Graded set (005, 011, 013, 020, 025, 028 = 24 chunks). Before = `main` @ `9122efe` prompts and
dial; after = this branch (`0e88f9b` code). Copy = kept lines with ≥ 80 % of their tokens in one
source sentence; verbatim = the longest run shared with one sentence is ≥ 80 % of the line.

| Level | Run | facts_token_hit median (005/011/013/020/025/028) | One-line keywords median | compression median | chunks with a kept line from the last third | last-third key facts hit | copy | verbatim | grounding cut | halluc numbers / forbidden |
|---|---|---|---|---|---|---|---|---|---|---|
| Short | before | 25 % (60/0/56/0/40/10) | – | 11 % | 4/24 | 2/15 | 48 % (64/133) | 24 % | 1 % (1/134) | 0 / 0 |
| Short | after | 16 % (30/0/11/12/30/20) | – | 9 % | 24/24 | 3/15 | 37 % (52/140) | 21 % | 1 % (1/141) | 0 / 0 |
| Caveman | before | 11 % (60/0/11/12/10/0) | – | 5 % | 4/24 | 1/15 | 53 % (62/117) | 18 % | 1 % (1/118) | 0 / 0 |
| Caveman | after | 16 % (20/0/11/0/30/20) | – | 5 % | 21/24 | 1/15 | 46 % (51/111) | 14 % | 2 % (2/113) | 0 / 0 |
| One line | before | 0 % (30/0/11/0/0/0) | 25 % (25/25/25/100/50/25) | 2 % | – | – | 1/6 final lines | – | 0/28 | 0 / 0 |
| One line | after | 0 % (30/0/11/0/0/0) | 25 % (25/25/25/100/50/25) | 2 % | – | – | 1/6 final lines | – | 0/28 | 0 / 0 |

Gates (acceptance table): facts ≥ 90 / 75 / 60 %, keywords ≥ 80 %, cut ≤ 10 %, 0 halluc. Only
cut rate and hallucinated numbers pass, before and after.

Per doc, Short and Caveman (megabat facts = 9 hand-set facts, 3 of them in the last third):

| Doc | Level | Run | facts_token_hit | compression | chunks with a last-third line | last-third facts | copy | cut | halluc |
|---|---|---|---|---|---|---|---|---|---|
| megabat | Short | before | 67 % | 65 % | 0/1 | 0/3 | 6/6 | 0/6 | 0 |
| megabat | Short | after | 56 % | 51 % | 1/1 | 2/3 | 5/5 | 0/5 | 0 |
| megabat | Caveman | before | 44 % | 23 % | 0/1 | 0/3 | 4/5 | 0/5 | 0 |
| megabat | Caveman | after | 33 % | 21 % | 1/1 | 1/3 | 3/3 | 0/3 | 0 |
| 005 | Short | before | 60 % | 45 % | 0/1 | 1/3 | 6/6 | 0/6 | 0 |
| 005 | Short | after | 30 % | 20 % | 1/1 | 1/3 | 6/6 | 0/6 | 0 |
| 005 | Caveman | before | 60 % | 21 % | 0/1 | 1/3 | 5/5 | 0/5 | 0 |
| 005 | Caveman | after | 20 % | 14 % | 1/1 | 0/3 | 4/4 | 0/4 | 0 |
| 011 | Short | before | 0 % | 12 % | 1/2 | 0/3 | 5/12 | 0/12 | 0 |
| 011 | Short | after | 0 % | 9 % | 2/2 | 0/3 | 8/10 | 0/10 | 0 |
| 011 | Caveman | before | 0 % | 6 % | 0/2 | 0/3 | 4/10 | 0/10 | 0 |
| 011 | Caveman | after | 0 % | 5 % | 2/2 | 0/3 | 5/8 | 0/8 | 0 |
| 013 | Short | before | 56 % | 24 % | 0/2 | 0/1 | 2/7 | 0/7 | 0 |
| 013 | Short | after | 11 % | 16 % | 2/2 | 0/1 | 9/11 | 0/11 | 0 |
| 013 | Caveman | before | 11 % | 11 % | 0/2 | 0/1 | 8/8 | 0/8 | 0 |
| 013 | Caveman | after | 11 % | 6 % | 2/2 | 0/1 | 4/7 | 1/8 | 0 |

Megabat, Short, before (CPU; the same six lines the live Space showed):

```
- Megabats are a family of bats that live in the tropics and subtropics of Africa, Asia and Oceania.
- They are often called fruit bats because most of them eat fruit or nectar.
- They play a big role in spreading seeds and pollinating plants.
- Unlike most other bats, nearly all megabats do not use echolocation.
- Instead they rely on large eyes and a strong sense of smell to find food at night.
- The largest species, the flying foxes, can have a wingspan of up to 1.7 meters.
```

Megabat, Short, after:

```
- Megabats are a family of bats that live in the tropics and subtropics of Africa, Asia and Oceania.
- Nearly all megabats do not use echolocation.
- The largest species, the flying foxes, can have a wingspan of up to 1.7 meters, while the smallest weigh less than 20 grams.
- Many megabats roost in large colonies in trees.
- Several species are threatened by hunting and the loss of forest habitat.
```

Megabat, Caveman, before → after: "Megabats live in Africa, Asia, and Oceania. / They eat fruit and
spread seeds. / They do not use echolocation. / They rely on eyes and smell. / The largest
species is the flying fox." → "Megabats live in Africa, Asia, and Oceania. / The largest flying
fox can have a wingspan of up to 1.7 meters. / Many megabats roost in large colonies in trees."

Doc 011 (Carlsbad bats), Caveman after, for a longer text: "The park has 17 bat species. /
Carlsbad bats are not maternity colonies because they are mostly male. / More than 50 unique
species of bats live in national parks. / Bats eat 50% or more of their bodyweight in insects
each night. / Fungal disease kills bats in winter. / Bats hide in caves to rest and raise young. /
Decontaminate shoes, clothes, and gear before entering another cave. / Do not disturb a bat if you
see it." Before, Caveman's five lines for the first chunk stopped 57 % of the way in (no
white-nose syndrome, no wind turbines), and Short's six stopped at 16 %.

A density knob, measured once: Short with `max_bullets_per_chunk` 8 instead of 6 raised
facts_token_hit on 005 from 30 to 50 % and on 013 from 11 to 22 % (011 stayed 0 %), at 27 % and
24 % compression. Not adopted: the dial describes Short as 3–6 sentences per chunk.

## Calls and time (estimate, not measured on WebGPU)

A full 1,600-token chunk now takes **6 calls at Short** (was 1) and **5 at Caveman**; One line is
unchanged (1 per chunk plus reduce). The megabat paragraph takes 5 calls at Short. Per call the
prompt is ~119 template tokens + the part (~270 tokens on a full chunk), so ~390 tokens, against
~1,725 before. Measured on CPU: median 23 new tokens per Short call (139 per full chunk, was 220)
and 32 per Caveman call (160 per chunk, was 120: it writes past the one line it keeps).

At ~20 tok/s decode and ~1,000 tok/s prefill (ADR 0001's warm 2.1 s first bullet on 011 with a
1,725-token prompt implies roughly that), per full chunk:

| | before | after |
|---|---|---|
| Short, first line ready | ~1.7 s prefill + ~0.9 s decode ≈ 2.6 s | ~0.4 s + ~1.2 s ≈ 1.6 s |
| Short, whole chunk | ~1.7 s + 11 s ≈ 13 s | 6 × (0.4 + 1.2) ≈ 10 s |
| Caveman, whole chunk | ~1.7 s + 6 s ≈ 8 s | 5 × (0.45 + 1.6) ≈ 10 s |

So warm time-to-first-audio at Short should drop by about a second (the voice adds the same
either way) and a Short chunk should finish a little sooner; Caveman gets ~25 % slower. Each call
also pays a fixed worker round trip and `generate()` setup that these numbers leave out; if that
is 100–200 ms, Short's total is a wash. Caveman's cost can come down by cutting its
`max_new_tokens` from 32 toward 24. Check on the dev Space before relying on any of this.

## Known limits

- The lean-back rule only looks at a sentence's first word. A pronoun later in the first
  sentence of a part ("After that, they …") can still lose its name. If many sentences in a row
  lean back, parts get uneven (the rule gives way only when a part would be left empty).
- Legal text with list items (013) segments into fragments ("(A) is blind;"); a part made of
  fragments yields a fragment line.
- `facts_token_hit` falls on dense docs (005, 013): the old output was long verbatim run-ons
  (58 of 133 Short bullets over 18 words) that carried several facts each. Neither version is
  near the 90 % floor.
