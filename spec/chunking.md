# Chunking, TTS-safe segments, and input limits

Shared by web and Mac. S0-03 fills the token budgets; S1-00a measured the voice model's limit.

## TTS-safe segments (measured 2026-09-23, S1-00a)

Voice model: `onnx-community/Kokoro-82M-v1.0-ONNX` @ `1939ad2a8e416c0acfeecc08a694d14ef25f2231`, `onnx/model_quantized.onnx` (q8), Transformers.js 4.3.0, Node/CPU. Script: `web/scripts/measure-tts-limit.mjs` (`npm run measure:tts`). Method: grow the phoneme string and record audio duration; find where duration stops growing; then find the largest phoneme string that tokenizes within the model's limit.

| phonemes | tokens | audio s |
|---:|---:|---:|
| 100 | 102 | 5.58 |
| 200 | 202 | 11.15 |
| 300 | 302 | 16.80 |
| 400 | 402 | 20.95 |
| 450 | 452 | 22.40 |
| 480 | 482 | 24.83 |
| 500 | 502 | 25.58 |
| 505 | 507 | 25.58 |
| 510 | 512 | 25.03 |
| 511+ | 512 (truncated) | 25.28 |

Findings:
- `tokenizer.model_max_length` = 512. One phoneme character = one token, plus two boundary tokens.
- tts_phoneme_limit: 510. The largest phoneme string that fits. Past it the tokenizer truncates when `truncation: true`; with truncation off the ONNX model throws (`/encoder/bert/Expand: invalid expand shape`), so an over-limit call is loud, never silent.
- Duration stops growing at ~500 phonemes. It is linear only to ~300 phonemes (5.6 s per 100); by 400 the speech is compressed ~6 %, by 500 ~9 %.
- tts_phoneme_target: 300. The splitter's target segment size, where duration stays linear (about 60 English words). Sentences longer than that are split at clause punctuation, then at word boundaries, keeping source offsets.

Rules for the TTS worker (S1-04):
1. Phonemize each segment and assert `tokens ≤ 512` (`phonemes ≤ tts_phoneme_limit`) before every synthesis call. A violation is counted as `tts_overlimit` and the segment is split further. The vendored loader throws `tts_overlimit` instead of truncating.
2. Segments target `tts_phoneme_target`; the additivity check on doc `020` (sum of segment durations vs. one-shot duration, within 10 %) guards the compression effect.

## Token budgets (S0-03)

Tokens are counted with the pinned summarizer's tokenizer (`web/src/core/tokens.ts`, S1-03a;
Mac counts with its own tokenizer and its own fixtures, `tokens.mac.json`). Word counts are
never used to enforce a budget.

| Budget | Value |
|---|---|
| `chunk_input_tokens` | 1,600 (the text of one chunk, before the prompt) |
| `output_reserved_tokens` | 256 (per level `max_new_tokens` in `spec/dial.json` is ≤ this) |
| `single_chunk_tokens` | 1,600: a document at or under this is one chunk |
| `max_chunks` | 100 (≈ 120,000 words). Over: refuse with `notice.input_limit`, shown and spoken. |
| `reduce_group_size` | 10 one-liners per reduce call |
| `reduce_max_depth` | 2 (10 → 100 chunks) |

Rules:
1. Chunks are sentence-aligned: a chunk ends at a sentence boundary (`Intl.Segmenter` on web,
   `NLTokenizer` on Mac) and never splits a sentence.
2. A sentence longer than `chunk_input_tokens` is first split by the TTS-safe rule above (clause
   punctuation, then word boundaries, source offsets kept); the pieces are then chunked as
   sentences.
3. Every segment carries `[start, end)` character offsets into the normalized source. Segments
   tile the source: no gaps, no overlaps (the coverage test, S1-04).
4. Per-chunk bullet caps come from `spec/dial.json` (`max_bullets_per_chunk`,
   `max_words_per_bullet`). The bullet parser enforces them: extra bullets are dropped, an
   over-long bullet is kept but counted (`bullet_overlength`). The prompt asks; the parser
   enforces. On doc `011` (CPU try-out, 2026-09-23) Caveman returned 7 bullets where the prompt
   asked for 2–5, so the parser cap is not optional.
5. Docs `001–020` in the corpus are one chunk; `021–030` are several; `025` is the multi-chunk
   fixture for the graded set.

## One-line policy on more than one chunk

1. Every chunk gets a one-liner (`prompts/oneline.md`), grounded against its chunk.
2. A cut one-liner contributes nothing and is counted. Nothing per-chunk is spoken.
3. Survivors are reduced in groups of ≤ `reduce_group_size` with `prompts/reduce-oneline.md`,
   at most `reduce_max_depth` deep; the reduced line is grounded against the lines it came from.
4. If more than `max_cut_fraction` (0.5) of the chunks were cut, One line fails over to Short with
   `notice.oneline_failed`, shown and spoken.
5. Only the final line is spoken.
