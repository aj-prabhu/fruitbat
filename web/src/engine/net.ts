// The ONLY fetch site in web/src (docs/PLAN.md rule 1; scripts/check-network.sh enforces it).
// S1-03a turns this module into the allowlist enforcer driven by spec/network.json and the
// pinned-file loader. The walking skeleton only needs same-origin voice files.
//
// Transformers.js does its own model-file fetches inside the dependency; those URLs are pinned
// by `revision` (see src/pins.ts) and are checked by the privacy test (S1-12), not by this file.

const VOICE_BASE = "/models/kokoro-voices/";
const VOICE_ID = /^[a-z]{2}_[a-z]+$/;

/** Load a Kokoro voice's style vectors from the same origin. */
export async function loadVoice(id: string): Promise<Float32Array> {
  if (!VOICE_ID.test(id)) throw new Error("bad voice id");
  const res = await fetch(`${VOICE_BASE}${id}.bin`);
  if (!res.ok) throw new Error(`voice_http_${res.status}`);
  return new Float32Array(await res.arrayBuffer());
}
