/*
 * Vendored from kokoro-js 1.2.1 (https://github.com/hexgrad/kokoro, kokoro.js/src/voices.js).
 * Copyright 2025 Hexgrad and contributors. Apache License 2.0 (see ./LICENSE).
 * Fruitbat changes (S1-00a, 2026-09-23): browser-only; no Node fs/path imports; the Hub URL and
 * the fetch() are gone. Voice data comes from an injected loader (web/src/engine/net.ts is the
 * only fetch site, docs/PLAN.md rule 1) and is served same-origin from public/models/kokoro-voices/
 * at the pinned revision recorded in spec/models.json. Only voices we ship are listed.
 */

export const VOICES = Object.freeze({
  // Only voices whose .bin ships in web/public/models/kokoro-voices/ are listed (Codex review, PR #4).
  // S1-04 adds the second voice for 9/29 together with its vendored file.
  af_heart: { name: "Heart", language: "en-us", gender: "Female", targetQuality: "A", overallGrade: "A" },
});

/** @type {Map<string, Promise<Float32Array>>} */
const cache = new Map();

/**
 * Get the style vectors for a voice (256 floats per token position), via the injected loader.
 * @param {string} voice
 * @param {(id: string) => Promise<Float32Array>} loadVoice
 * @returns {Promise<Float32Array>}
 */
export function getVoiceData(voice, loadVoice) {
  let p = cache.get(voice);
  if (!p) {
    p = loadVoice(voice);
    cache.set(voice, p);
    p.catch(() => cache.delete(voice));
  }
  return p;
}
