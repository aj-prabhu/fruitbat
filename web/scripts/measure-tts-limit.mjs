// S1-00a: measure the Kokoro (ONNX, q8) input limit the way the plan defines it:
// grow the phoneme string, synthesize, and find where audio duration stops growing.
// Runs in Node on CPU with the pinned revision. Output: a table + the measured limit.
import { StyleTextToSpeech2Model, AutoTokenizer, Tensor, env } from "@huggingface/transformers";
import { phonemize } from "../src/vendor/kokoro/phonemize.js";
import { readFile } from "node:fs/promises";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const REV = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const SR = 24000, STYLE_DIM = 256;
env.cacheDir = new URL("../.cache/hf/", import.meta.url).pathname;
env.allowLocalModels = false;

const t0 = Date.now();
const model = await StyleTextToSpeech2Model.from_pretrained(MODEL, { dtype: "q8", device: "cpu", revision: REV });
const tok = await AutoTokenizer.from_pretrained(MODEL, { revision: REV });
console.log(`loaded in ${Date.now() - t0} ms; model_max_length=${tok.model_max_length}`);
const voice = new Float32Array((await readFile(new URL("../public/models/kokoro-voices/af_heart.bin", import.meta.url))).buffer);

const base = "The quick brown fox jumps over the lazy dog near the river bank while seven geese watch from the old stone bridge. ";
const text = base.repeat(12);
const ph = await phonemize(text, "a");
console.log(`phonemizer ok: ${text.length} chars -> ${ph.length} phoneme chars; sample: ${ph.slice(0, 60)}`);

async function synth(phonemes, truncation) {
  const { input_ids } = tok(phonemes, { truncation });
  const n = input_ids.dims.at(-1);
  const num_tokens = Math.min(Math.max(n - 2, 0), 509);
  const style = new Tensor("float32", voice.slice(num_tokens * STYLE_DIM, num_tokens * STYLE_DIM + STYLE_DIM), [1, STYLE_DIM]);
  const speed = new Tensor("float32", [1], [1]);
  const { waveform } = await model({ input_ids, style, speed });
  return { tokens: n, seconds: waveform.data.length / SR };
}

const rows = [];
let lastSeconds = 0, plateauAt = null;
for (const k of [100, 200, 300, 400, 450, 480, 500, 505, 508, 509, 510, 511, 512, 520, 540, 600]) {
  const p = ph.slice(0, k);
  const r = await synth(p, true);
  rows.push({ phonemes: k, tokens: r.tokens, seconds: +r.seconds.toFixed(3) });
  if (plateauAt === null && rows.length > 1 && r.seconds <= lastSeconds + 0.05) plateauAt = rows[rows.length - 2].phonemes;
  lastSeconds = Math.max(lastSeconds, r.seconds);
}
console.table(rows);
// Now the exact boundary: largest phoneme length whose token count is not truncated.
let limit = null;
for (let k = 505; k <= 515; k++) {
  const { input_ids } = tok(ph.slice(0, k), { truncation: false });
  const n = input_ids.dims.at(-1);
  if (n <= tok.model_max_length) limit = k; else break;
}
console.log(`plateau (duration stops growing) after phonemes=${plateauAt}`);
console.log(`tts_phoneme_limit=${limit} (largest phoneme-string length that tokenizes within model_max_length=${tok.model_max_length}, incl. 2 boundary tokens)`);
// What happens over the limit without truncation?
try {
  const r = await synth(ph.slice(0, 600), false);
  console.log(`over-limit without truncation: tokens=${r.tokens} seconds=${r.seconds.toFixed(3)} (NO ERROR: silent misbehaviour possible)`);
} catch (e) {
  console.log(`over-limit without truncation throws: ${String(e).slice(0, 160)}`);
}
