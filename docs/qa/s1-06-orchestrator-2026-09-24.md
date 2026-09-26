# S1-06: orchestrator, measured

Built 2026-09-24 on `pkt/S1-06-orchestrator` (S1-05 + S1-04 + S1-02 + S1-L0 merged). Numbers from
this machine (M1 Pro, Chrome for Testing 153, bundled Chromium); every command is in the PR.

## Proofs (wasm-ci, `?llm=fake` + real Kokoro q8 on WASM)

| Check | Result |
|---|---|
| Stop (`stop()`) mid-run, then 3 s of the fake still streaming | no bullet after stop; gen idle, play stopped; `stop_ms` 0.04 |
| Dial Short → Caveman while chunk 0 plays and chunk 1 already exists | notice spoken after **0.22 ms**; regeneration starts at chunk 0 (the cursor's chunk); every new bullet ≤ 9 words; `level_used` caveman; Caveman → Short speaks `notice.dial_longer` |
| Rapid re-select (`run(A); run(B)` in one tick) | only B's bullets; `runs` +2 |
| Esc mid-generation (025, 10 chunks) | gen idle + play stopped; `stop_ms` 0.02; nothing scheduled ahead |
| Finished run | `ttfa_ms` 4,872 (fake LLM, first bullet after 481 ms; the rest is the first synthesis on WASM), `notice.done` spoken |
| All-cut chunk (`?fake=cutshort`) | `notice.all_cut` shown and spoken; "Read this part" offered; **nothing enqueued** until it is clicked; then a Read-all of that chunk plays |
| Input limit (`?chunk=20`, 011) | `notice.input_limit` shown and spoken, gen failed, no bullets |

## Real run (webgpu-local, `scripts/real-run.mjs`, 011 at Short, cold cache)

| Measure | Value |
|---|---|
| Summarizer load (download + init) | 33.7 s |
| First bullet after the summarizer was ready | 2.1 s |
| Decode | 35.4 tok/s |
| Bullets | 12 over 2 chunks, 0 cut |
| First audio after the click (cold) | 43.3 s |
| Voice RTF / worst gap between bullets | 1.15 / 499 ms |
| Audio for the 12 bullets | 66.7 s |

## Kokoro on WebGPU (`?tts=webgpu`): not viable tonight

- Transformers.js 4.3.0 has no `q8f16` dtype (table: fp32, fp16, q8, int8, uint8, q4, q4f16, bnb4).
  Asking for it fell back to fp32 and requested the unpinned `onnx/model.onnx`, which the network
  policy refused, correctly. The flag now loads the variant by file name (`model_file_name`).
- With that fixed, the load + warm-up of `model_q8f16.onnx` on WebGPU **did not complete in 10
  minutes** (readall.spec's beforeAll timed out twice). Not retried further; the run was killed.
- Decision: **q8 on WASM stays the default.** The flag stays for a later measurement (S1-14's
  browser matrix, or a different ORT build). The plan's ≤ 150 ms gap KPI is not reachable with the
  WASM voice on long sentences (S1-04: 3.4 s early gaps on Read all); bullet streams do better
  (499 ms worst gap here) because the pieces are short.

## Known limits carried forward

- A stopped ORT synthesis cannot be aborted: after Esc the worker finishes the piece it was on
  (up to one 300-phoneme segment, ~4 s on WASM) before the next run's first piece. Options for
  S1-07/S1-09: a smaller first piece after a stop, or a standby worker.
- `readThisPart` reads the all-cut chunk as a Read-all run of that chunk only; it stops the
  current run first (rule 2 is about never auto-playing, not about mixing runs).
- Notices are spoken over a playing bullet stream (they are short and cached); "Paused." is not
  spoken because the context is suspended while paused.
