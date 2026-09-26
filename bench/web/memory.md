# Web bench memory measurement (S1-13)

Two numbers, measured two different ways, for two different purposes.

## `heap_mb` -- JS heap, via CDP

`bench/web/run.mjs` opens a Chrome DevTools Protocol session on the bench page
(`context.newCDPSession(page)`, `Performance.enable`) and reads `Performance.getMetrics()`'s
`JSHeapUsedSize` entry (bytes) right after a run finishes (gen terminal, voice drained), converted
to MB. This **replaces** the value the app itself would have put on the row: `web/src/engine/tts.ts`
already stamps `heap_mb` from `performance.memory.usedJSHeapSize` read in-page, which is the same
underlying number Chrome exposes two ways (in-page `performance.memory` is Chromium-only and
imprecise-by-default outside a cross-origin-isolated context; CDP's `Performance.getMetrics` is the
harness-side equivalent the packet spec asks for). The two should track closely; if they ever
diverge by a lot, that's worth a look, not a bug report -- it means the page moved between the
measurement and the CDP read.

**What it includes:** V8's JS heap for the page's main-thread realm at the moment of the read
(after the run, not a running peak). It does **not** include the LLM/TTS worker heaps (workers
have their own `JSHeapUsedSize`, and Chrome's `Performance.getMetrics` for a page target reports
only the main-thread realm), WASM linear memory (onnxruntime-wasm's arena), or GPU-side buffers
(WebGPU model weights/activations, which live outside V8's heap entirely). So `heap_mb` is a
**floor**, not a total memory picture -- most of a loaded LLM's weights (hundreds of MB) live in
WASM memory or GPU buffers and never show up here. Read it as "is the page itself leaking JS
objects across runs," not "how much RAM does Fruitbat use."

## `peak_mb` -- renderer + GPU process RSS, via `ps`

Before triggering a run, `findPids()` greps `ps -eo pid,command` for processes whose command line
contains this run's Chromium profile directory (`--user-data-dir=<profile>`) **and** either
`--type=renderer` or `--type=gpu-process`. This works because the bundled Chromium build actually
does forward `--user-data-dir` to its renderer and GPU-process children (verified empirically
against this exact Playwright/Chromium build on 2026-09-25 -- launched a throwaway persistent
context and grepped `ps aux` for its profile path; both child types showed it, plus several
utility processes that aren't sampled). If a future Chromium build stops doing this, `findPids()`
returns `[]` and `peak_mb` comes back `null` for that row rather than a wrong number -- this is
the "record null and say so" fallback the packet spec calls for, not a silent guess.

Every 250 ms during the run, `sampleRssMb()` runs `ps -o rss= -p <pids>` and sums RSS (KB) across
every matched pid, converted to MB. `peak_mb` is the max of those samples. **What it includes:**
the renderer process (JS heap, DOM, onnxruntime-wasm's arena, any WASM linear memory) plus the GPU
process (WebGPU buffers -- model weights and activations when running on WebGPU, which for the
default summarizer tier is most of the download size). **What it excludes:** the browser's
top-level/network/utility processes (not sampled -- they don't hold model data), and it's a
resident-set number, so shared pages (e.g. the Chromium binary's own mapped code) inflate it
somewhat versus a true unique-memory count.

**Multiple renderer processes.** A single tab is normally one renderer process for the run's
lifetime (no cross-origin navigation happens mid-run), so in practice `findPids()` returns one
renderer pid + one GPU pid. If Chromium ever spins up a second renderer for the same profile
(e.g. a leftover tab from a previous run that wasn't closed), its RSS would be summed in too,
inflating `peak_mb`. `run.mjs` closes contexts between reps for `--cache cold` and reuses exactly
one page for the whole `--cache warm` session, so this shouldn't come up in normal use.

## Why `peak_mb` is informational (docs/PLAN.md KPI table: "web RSS informational, heap separate")

`peak_mb` is recorded on every row and gated by nothing (`bench/gate.py`'s floors/regressions are
all `heap_mb`/other fields; `peak_mb`'s only entry in the gate tables is Mac-specific --
`bench/README.md`'s "`peak_mb` (Mac only)" rows). It stays informational until it's been checked by
hand against Activity Monitor's own numbers for the same run, because `ps`'s RSS and Activity
Monitor's "Memory" column diverge for reasons that have nothing to do with a bug here (compressed
memory, purgeable pages, shared framework mappings all get counted differently). Akshay: fill this
in from three runs (pick any `--cache warm` bench run; watch Activity Monitor's "Google Chrome for
Testing" process group while `bench/run.sh --target web` is running, or read the peak off it
afterward if it's still open).

| Run (doc/level) | `peak_mb` (this harness) | Activity Monitor peak (renderer + GPU) | Delta | Notes |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |
