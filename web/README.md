---
title: Fruitbat
emoji: 🦇
colorFrom: purple
colorTo: gray
sdk: static
app_file: index.html
pinned: false
license: agpl-3.0
short_description: Select text, get the short version, hear it.
tags:
  - accessibility
  - dyslexia
  - text-to-speech
  - summarization
  - webgpu
  - kokoro
  - qwen
---

# Fruitbat

Select text, get the short version, hear it. Everything runs in your browser: the summarizer
(Qwen3.5-0.8B, WebGPU) and the voice (Kokoro-82M, WASM) are downloaded once from the Hugging Face
Hub at pinned revisions and cached. Nothing you paste leaves this page.

This Space is a prebuilt static site. Source, plan, and licenses: https://github.com/aj-prabhu/fruitbat

## Releases

Every push to `main` deploys this app to the dev Space (`2shay/fruitbat-dev`), so it never sits
stale. The **public** Space (`2shay/fruitbat`, what you're looking at) only updates on a
`web-v*` tag, and only after `scripts/release-check.sh` passes — see `docs/release.md` for the
full recipe. The Mac app updates on a separate `mac-v*` tag (later; see `docs/PLAN.md` C13 for
why the tag namespaces are kept apart).

A tag containing `-test` (e.g. `web-v0.0.1-test`) never reaches this Space: `release.yml` treats
it as a dry run and stops after `release-check.sh`, printing what it would have deployed.
