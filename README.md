# Fruitbat

Select text, get the short version, hear it.

## What it is

Highlight text, press a hotkey, and get a small panel of bullet-point summaries
read aloud as they appear. A compression dial lets you choose the level: "Read
all" for the full text, "Short" for a tight digest, "Caveman" for ultra-simple
language, or "One line" for just the essence. Everything runs on your machine
with free open models. Nothing you read leaves your device. Zero telemetry.

## Status

![health](https://github.com/aj-prabhu/fruitbat/actions/workflows/health.yml/badge.svg)

Pre-alpha. Nothing runs yet. Building in public. Read the plan at `docs/PLAN.md`.

Web demo target: 2026-09-29. macOS app after that.

## Layout

| Directory | Purpose |
|-----------|---------|
| `spec/` | Shared spec loaded by both web and macOS targets |
| `web/` | Stage 1: static web app demo on Hugging Face Spaces |
| `mac/` | Stage 2: native macOS menu-bar app |
| `bench/` | Benchmarks and performance gates |
| `brand/` | Protected brand assets (name, Pip, logo) |
| `docs/` | Plan, architecture decision records, QA gate files |
| `scripts/` | Deploy and release scripts |

## Privacy

Nothing you read leaves your device. No telemetry. See `PRIVACY.md` for the
complete list of outbound traffic.

## Contributing

Contributing requires signing off on your commits (DCO). No CLA. Merge commits
only. Read `CONTRIBUTING.md` for the full process.

## License

Code is under the GNU AGPL-3.0. See `LICENSE`.

The name "Fruitbat", the character "Pip", the logo, and all files under `brand/`
are all rights reserved. See `brand/LICENSE`.
