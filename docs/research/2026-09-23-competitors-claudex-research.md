# Competitor + platform research — 2026-09-23

## Key Takeaways
- Nobody ships select → summary → spoken in one keypress, system-wide, on Mac. Only one-action tool: Raycast "Read AI" extension (cloud, user's own OpenAI key, ~2,985 installs).
- Nobody offers a length/compression dial. TTS tools read everything; summarizers are text-only.
- Kokoro select→speak Mac apps exist but are 0–16 star weekend projects: tilakp/aloud (MIT), speak-kokoro (MIT), Freekoko (MIT, MLX), OpenReaderMac (MIT), Narrateify (MIT), moxspeak (source-available, not OSS), Kokoro-Clipboard-TTS (no license).
- Popup-bubble UX precedent: Easydict (14.7k stars, GPL-3), select → popup for translation.
- Paid incumbents: Speechify ($29/mo, AI Summaries, cloud), NaturalReader ($79–159/yr), Voice Dream (~$50/yr), Read&Write (schools), Readwise Reader ($9.99/mo), Elephas ($9.99/mo, no TTS).
- Biggest threat: Apple. Writing Tools summarizes on-device; Speak Selection (Option-Esc) is free. Two separate steps today, robotic voice.
- VoiceInk: GPL v3, 6.5k stars, solo dev, paid build = auto-updates + support, sold via Polar.sh. Price conflicting ($25/$39/$49 or $29/$49/$69 lifetime). Claims 200k+ downloads.
- Price signal: $25–39 lifetime safer than $50.
- Trust risk: summaries that drop or invent facts hurt readers who can't check the source. Full read-aloud must always be one key away.
- HF platform: Static Spaces free for all; Gradio/Docker Spaces need PRO; hosting ZeroGPU needs account >30 days old (his: created 2026-09-22 → ~2026-10-22). So Stage 1 = static Space, inference in the visitor's browser.
- Browser inference: WebGPU default in Chrome/Edge/Firefox/Safari (macOS 26) as of mid-2026. Sweet spot 0.5–3B at 4-bit, 300MB–2GB download. kokoro-js runs Kokoro-82M via Transformers.js (wasm/webgpu).
- Demo slot: OS AI Week kickoff Oct 16, 36 slots, must be built on HF Spaces, apply by Oct 2.
