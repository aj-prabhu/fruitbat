# ADR 0000: Web runtime for Stage 1

Status: accepted (S1-00a, 2026-09-23). Supersedes nothing.

## Context

Rule 4 pins every model and inference library. Codex round 1 (#1, #2) showed the plan's original
stack could not work: Qwen3.5 ONNX needs Transformers.js 4.x, and the kokoro-js npm package pins
Transformers.js 3.x and never forwards a model revision, so voices and weights would silently load
from `main`. The Fable pass (#20) flagged that a static Space cannot send COOP/COEP headers, so
without a workaround there is no `SharedArrayBuffer` and WASM inference is single-threaded.

## Decision

| Piece | Pinned | Why |
|---|---|---|
| `@huggingface/transformers` | 4.3.0 (onnxruntime-web 1.31.0-dev.20260914) | First major with Qwen3.5 support; latest at pin time. |
| Kokoro loader | kokoro-js 1.2.1 sources vendored into `web/src/vendor/kokoro/` (Apache-2.0 notice kept) | npm package pins Transformers.js 3.x. Vendored copy adds `revision`, an injected voice loader, no console output, and a pre-synthesis limit check instead of silent truncation. |
| `phonemizer` | 1.2.1 | kokoro-js's G2P (eSpeak-NG in WASM). |
| Summarizer | `onnx-community/Qwen3.5-0.8B-Text-ONNX` @ `1e45daba048899e7f771657ada617ec49350aa91`, `q4f16`, WebGPU | Plan default. Thinking off via `enable_thinking: false` in the chat template. |
| Voice | `onnx-community/Kokoro-82M-v1.0-ONNX` @ `1939ad2a8e416c0acfeecc08a694d14ef25f2231`, `q8` (`model_quantized.onnx`, 92 MB), WASM | Plan default. |
| Voice files | `af_heart.bin` vendored at that revision into `web/public/models/kokoro-voices/` | Same-origin, no Hub fetch for voices, exact pin. |
| ORT WASM runtime | copied from `node_modules/onnxruntime-web/dist` into `web/public/ort/` at build (`scripts/copy-ort.mjs`, gitignored) | Transformers.js otherwise loads it from a CDN, an outbound destination rule 1 forbids. |
| Cross-origin isolation | `coi-serviceworker` 0.1.7 (MIT) in `web/public/` | Static host cannot set headers; the service worker adds COOP/COEP and reloads once. Proven on `vite preview` without server headers: `crossOriginIsolated === true`, `SharedArrayBuffer` present. |
| Build | Vite 8.3.0, TypeScript 5.9.3 | Vite 8 (Rolldown) builds the app in under a second; build manifest on for the privacy test. |
| E2E | `@playwright/test` 1.63.0, bundled Chromium 1243 (Chrome for Testing 153) | Projects `wasm-ci` (headless, WebGPU off) and `webgpu-local` (headed, `--mute-audio`). Never the agent Chrome profile. |

Measured Kokoro input limit (`spec/chunking.md`): `tts_phoneme_limit: 510`, `tts_phoneme_target: 300`. Over the limit the ONNX model throws; nothing is silently cut.

## Walking-skeleton run (webgpu-local, M1 Pro, Chrome for Testing 153)

Cold cache (fresh Chromium profile), 150-word bat paragraph, `npx playwright test tests/skeleton.spec.ts --project=webgpu-local` against `vite preview`, 2026-09-23 23:24:

| Measure | Value |
|---|---|
| `crossOriginIsolated` | true (service worker, no server headers) |
| Bullets | 6, every number and name present in the source, no `<think>` |
| Downloaded (model weights, progress events) | 562 MB (Qwen q4f16 469 MB + Kokoro q8 92 MB; tokenizer 19 MB not counted by the callback) |
| Click → both models loaded | 32.5 s (LLM 27.3 s, then Kokoro) |
| Click → first token | 33.4 s |
| Click → first bullet | 33.7 s |
| Click → first audio scheduled | 40.1 s (cold; the plan's cold gate is ≤ 90 s) |
| Audio scheduled / played by the test's end | 34.1 s / 30.0 s, `AudioContext` running |
| Generation end | 70.1 s |

Not measured here: decode tok/s. In the skeleton Kokoro runs on the main thread, so its WASM synthesis blocks the LLM's dispatch loop; the 37 s generation window is not a decode rate. S1-04/S1-05 move both engines to workers and the bench (S1-13) measures tok/s properly. The 6.3 s from first bullet to first audio is Kokoro's first-call warm-up on WASM plus main-thread contention, the same caveat.

## Consequences

- `wasm-ci` has no LLM. `tests/skeleton.spec.ts` skips the generation test there; S1-05's `?llm=fake` worker makes CI specs meaningful.
- Playwright has no `--base-url` flag. Deployed runs use `BASE_URL=https://… npx playwright test …` (S1-00b); the plan's proof line is read that way.
- The skeleton hard-codes its few strings and downloads both models on the first click. Rule 8 (strings from `spec/strings/en.json`) and rule 11 (voice on load, summarizer on request with the size shown) land in S1-01, S1-L0, S1-05, S1-09. Nothing in `web/src/skeleton.ts` is product code.
- The test asserts the `AudioContext` is running and ≥ 1 s of PCM has played by the context clock, with Chromium's audio output muted, so the overnight run makes no sound. Audible output was not asserted; S1-00b's manual check on the dev URL does that by ear when Akshay is awake.
- `web/public/ort/` holds all four `ort-wasm-simd-threaded` variants (83 MB) until the dev-Space capture (S1-00b) shows which two the browser actually requests; then `copy-ort.mjs` is trimmed.
- The vendored loader's `generate_from_phonemes` throws `tts_overlimit`; S1-03's TTS-safe splitter must keep segments ≤ 510 phonemes (target 300) so that never fires in production.
