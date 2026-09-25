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

Filled by S0-03 from the pinned tokenizer (S1-03a): chunk ≤ 1,600 input tokens, 256 reserved for output; sentence-aligned; docs ≤ 1,600 tokens are one chunk; per-chunk bullet caps per level; input limit 100 chunks (≈ 120,000 words); one-line reduction groups ≤ 10, depth ≤ 2.
