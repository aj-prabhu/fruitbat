# S1-00b gate: walking skeleton on the dev Space

Date: 2026-09-24 00:0x PDT (built 2026-09-23 23:3x). Commit under test: `7225106` (S1-00a) deployed by `scripts/deploy-space.sh 2shay/fruitbat-dev`.
URL: https://2shay-fruitbat-dev.static.hf.space (public). `2shay/fruitbat` exists too, created **private**; it goes public with `web-v0.1.0` (S1-15/S1-16), never before.

| Check | Result |
|---|---|
| `BASE_URL=https://2shay-fruitbat-dev.static.hf.space npx playwright test tests/skeleton.spec.ts --project=webgpu-local` | 2 passed (1.2 m) |
| `crossOriginIsolated` on the dev URL | true (service worker; static Space sends no COOP/COEP) |
| Real summary spoken from the dev URL | yes: 4–6 bullets, `AudioContext` running, ≥ 1 s played (Chromium audio muted in the test; audible check by Akshay pending) |
| Cold download from the dev URL | 562 MB of weights; first audio 40 s after the click |
| Requests recorded | `docs/qa/network-capture-2026-09-24.json` (32 requests, 2 hosts page-level) |
| Redirect hosts (curl) | `us.aws.cdn.hf.co` (LFS, signed params), `huggingface.co` (`/api/resolve-cache/...`) → `spec/network.json` |
| Unpinned URL seen | `resolve/main/tokenizer_config.json` ×2 (Transformers.js 4.3.0). Handed to S1-03a. |
| ORT runtime files requested | only `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`; `copy-ort.mjs` trimmed to those two |
| `space-dev.yml` | wired on push to `main`; first run happens when this PR merges (`gh run list --workflow space-dev.yml` proof deferred to merge) |
