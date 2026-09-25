// The real work behind scripts/make-demo.mjs (docs/PLAN.md S1-09). Only ever run through that
// re-exec shim (it needs --experimental-transform-types + the ts-resolve-loader hook active).
//
// What it does, end to end, on CPU in Node -- no browser, no bundler:
//   1. Picks the demo's source text: the first three paragraphs of spec/eval/corpus/011.txt
//      (docs/PLAN.md S1-09 "Read all is an excerpt"), then trims that pool sentence by sentence,
//      by REAL measured audio, to whatever fits the 4 MB read-all WAV budget -- see "Why the
//      excerpt is shorter than three full paragraphs" below.
//   2. Runs the real chunker/parser/grounder from web/src/core (chunkSentences, BulletParser,
//      ground) against the pinned summarizer (Qwen3.5-0.8B-Text, CPU, q4 -- the same "cpu_tryout"
//      tier spec/tools/try-prompts.mjs uses) to produce Short and Caveman bullets and the One
//      line line, exactly the parsing/grounding path production uses.
//   3. Synthesizes every level's audio with the vendored KokoroTTS (the same class
//      web/src/workers/tts.worker.ts drives), af_heart, on CPU.
//   4. Writes web/public/demo/{level}.json (bullets/sentences with source offsets into 011.txt
//      and per-item audio offsets into the WAV) and {level}.wav (16-bit PCM mono 24 kHz).
//
// Why the excerpt is shorter than three full paragraphs: 011.txt's first three blank-line-
// delimited paragraphs (the second one is long -- see the printed word count below) run to about
// 465 words. At 24 kHz 16-bit mono that is roughly 8-9 MB of read-all audio at real-time speech,
// almost double the packet's 4 MB-per-WAV budget. The packet's own ordering ("so each WAV stays
// <= 4 MB") makes the byte budget the binding constraint, not the paragraph count, so this script
// adds sentences from that three-paragraph pool one at a time, synthesizing each and stopping
// before the running total would exceed the budget. The excerpt used is always a plain prefix of
// 011.txt (offset 0 to wherever it stops), so every offset in every level's JSON is a real offset
// into spec/eval/corpus/011.txt, and Short/Caveman/One line summarize the *same* excerpt Read all
// reads, so the dial genuinely switches between compressions of one shared source.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AutoModelForCausalLM, AutoTokenizer, env } from "@huggingface/transformers";
import { phonemize } from "../../src/vendor/kokoro/phonemize.js";
import { KokoroTTS } from "../../src/vendor/kokoro/kokoro.js";
import { segmentSentences, chunkSentences, splitTtsSafe, BulletParser, ground, COMMON_WORDS, countTokensWith } from "../../src/core/index.ts";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const specDir = here("../../../spec/");
const webDir = here("../../");

const models = JSON.parse(readFileSync(`${specDir}models.json`, "utf8"));
const dial = JSON.parse(readFileSync(`${specDir}dial.json`, "utf8"));
const SUMMARIZER = models.web.summarizer;
const VOICE = models.web.voice;
const SR = 24000;
const TTS_LIMIT = VOICE.tts_phoneme_limit; // 510
const TTS_TARGET = VOICE.tts_phoneme_target; // 300
const VOICE_ID = "af_heart";
// spec/chunking.md "Token budgets" (the same numbers web/src/engine/llm.ts uses).
const BUDGET = { chunk_input_tokens: 1600, max_chunks: 100 };
// docs/PLAN.md S1-09: "each WAV stays <= 4 MB". A safety margin under the hard 4 MiB cap.
const READALL_BUDGET_BYTES = 3_900_000;
const CORPUS_ID = "011";
const CORPUS_PATH = `${specDir}eval/corpus/${CORPUS_ID}.txt`;
const OUT_DIR = `${webDir}public/demo/`;

env.cacheDir = here("../../.cache/hf/");
env.allowLocalModels = false;
env.allowRemoteModels = true;

function round(n, d = 4) {
  const m = 10 ** d;
  return Math.round(n * m) / m;
}

function concatFloat32(arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** 16-bit PCM mono WAV (docs/PLAN.md S1-09: "not float32"). */
function encodeWav(pcm, sampleRate) {
  const dataSize = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), o);
    o += 2;
  }
  return buf;
}

/** Synthesize `text` with the vendored KokoroTTS, splitting TTS-safe (core/split.ts) if it is
 *  over the phoneme limit -- the same rule the TTS worker enforces before every real call. */
async function synth(tts, text) {
  const ph = await phonemize(text, "a");
  if (ph.length <= TTS_LIMIT) {
    const audio = await tts.generate_from_phonemes(ph, { voice: VOICE_ID, speed: 1 });
    return { pcm: audio.audio, sampleRate: audio.sampling_rate };
  }
  const pieces = await splitTtsSafe(segmentSentences(text), (t) => phonemize(t, "a"), { target: TTS_TARGET, limit: TTS_LIMIT });
  const chunks = [];
  let sampleRate = SR;
  for (const p of pieces) {
    const pph = await phonemize(p.text, "a");
    const audio = await tts.generate_from_phonemes(pph, { voice: VOICE_ID, speed: 1 });
    chunks.push(audio.audio);
    sampleRate = audio.sampling_rate;
  }
  return { pcm: concatFloat32(chunks), sampleRate };
}

/** The first three blank-line-delimited paragraphs of 011.txt, as a byte range [0, end). */
function firstThreeParagraphs(fullText) {
  const re = /\n\s*\n+/g;
  const boundaries = [];
  let m;
  while ((m = re.exec(fullText)) && boundaries.length < 3) boundaries.push(m.index);
  const end = boundaries[2] ?? fullText.length;
  return fullText.slice(0, end);
}

/** Read-all excerpt: sentences from the three-paragraph pool, added one at a time by REAL
 *  measured audio until the next sentence would push the WAV over budget (see the file banner). */
async function buildReadAll(tts, pool) {
  const sentences = segmentSentences(pool);
  const items = [];
  const pcmPieces = [];
  let audioT = 0;
  let bytes = 0;
  let excerptEnd = 0;
  for (const sent of sentences) {
    const { pcm } = await synth(tts, sent.text);
    const addBytes = pcm.length * 2;
    if (items.length > 0 && bytes + addBytes > READALL_BUDGET_BYTES) break;
    pcmPieces.push(pcm);
    const dur = pcm.length / SR;
    items.push({ text: sent.text, start: sent.start, end: sent.end, audioStart: round(audioT), audioEnd: round(audioT + dur) });
    audioT += dur;
    bytes += addBytes;
    excerptEnd = sent.end;
  }
  return { items, pcm: concatFloat32(pcmPieces), excerptEnd, seconds: audioT, bytes, poolWords: pool.split(/\s+/).filter(Boolean).length };
}

/** The real chunk -> generate -> parse -> ground path (web/src/engine/llm.ts's perChunk/oneLine),
 *  against the pinned summarizer, for one dial level. Single chunk by construction (the excerpt
 *  is well under the 1,600-token chunk budget). */
async function generateLevel(tokenizer, model, excerptText, level) {
  const cfg = dial.levels.find((l) => l.id === level);
  const promptTemplate = readFileSync(`${specDir}${cfg.prompt}`, "utf8");
  const countTokens = (t) => countTokensWith(tokenizer, t);
  const chunks = await chunkSentences(segmentSentences(excerptText), countTokens, BUDGET);
  if (chunks.length !== 1) throw new Error(`expected 1 chunk for the demo excerpt, got ${chunks.length}`);
  const chunk = chunks[0];
  const prompt = promptTemplate.replace("{{text}}", chunk.text);
  const messages = [{ role: "user", content: prompt }];
  const inputs = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true, enable_thinking: false });
  const promptTokens = inputs.input_ids.dims.at(-1);
  const t0 = Date.now();
  const out = await model.generate({ ...inputs, max_new_tokens: cfg.max_new_tokens, do_sample: false });
  const genMs = Date.now() - t0;
  const newTokens = out.slice(null, [promptTokens, null]);
  const raw = tokenizer.batch_decode(newTokens, { skip_special_tokens: true })[0].trim();
  const parser = new BulletParser({ max_bullets_per_chunk: cfg.max_bullets_per_chunk, max_words_per_bullet: cfg.max_words_per_bullet });
  const bullets = [...parser.push(raw), ...parser.flush()];
  const kept = [];
  const cut = [];
  for (const b of bullets) {
    const g = ground(b.text, chunk.text, COMMON_WORDS);
    if (g.ok) kept.push(b.text);
    else cut.push({ text: b.text, reasons: g.reasons });
  }
  return { raw, kept, cut, dropped: parser.dropped, overlength: parser.overlength, genMs, chunk };
}

async function writeLevel(name, labelKey, excerptStart, excerptEnd, items, pcm) {
  await mkdir(OUT_DIR, { recursive: true });
  const seconds = pcm.length / SR;
  const json = {
    level: name,
    label_key: labelKey,
    source_doc: `spec/eval/corpus/${CORPUS_ID}.txt`,
    source_start: excerptStart,
    source_end: excerptEnd,
    sample_rate: SR,
    duration_seconds: round(seconds, 3),
    items,
  };
  await writeFile(`${OUT_DIR}${name}.json`, `${JSON.stringify(json, null, 2)}\n`);
  const wav = encodeWav(pcm, SR);
  await writeFile(`${OUT_DIR}${name}.wav`, wav);
  return { bytes: wav.length, seconds };
}

async function main() {
  console.log(`make-demo: cache dir ${env.cacheDir}`);
  const fullDoc = await readFile(CORPUS_PATH, "utf8");
  const pool = firstThreeParagraphs(fullDoc);
  console.log(`make-demo: three-paragraph pool = ${pool.split(/\s+/).filter(Boolean).length} words (source of the excerpt before the audio-budget trim)`);

  console.log(`make-demo: loading voice ${VOICE.id}@${VOICE.revision.slice(0, 7)} (q8, cpu)...`);
  const tts = await KokoroTTS.from_pretrained(VOICE.id, {
    dtype: "q8",
    device: "cpu",
    revision: VOICE.revision,
    loadVoice: async (id) => new Float32Array((await readFile(`${webDir}public/models/kokoro-voices/${id}.bin`)).buffer),
  });

  const readall = await buildReadAll(tts, pool);
  const excerptText = fullDoc.slice(0, readall.excerptEnd);
  console.log(
    `make-demo: excerpt trimmed to ${excerptText.split(/\s+/).filter(Boolean).length} words / ${readall.items.length} sentences ` +
      `(${round(readall.bytes / 1e6, 2)} MB read-all audio, budget ${round(READALL_BUDGET_BYTES / 1e6, 2)} MB)`,
  );

  console.log(`make-demo: loading summarizer ${SUMMARIZER.id}@${SUMMARIZER.revision.slice(0, 7)} (${SUMMARIZER.cpu_tryout.dtype}, cpu)...`);
  const tokenizer = await AutoTokenizer.from_pretrained(SUMMARIZER.id, { revision: SUMMARIZER.revision });
  const model = await AutoModelForCausalLM.from_pretrained(SUMMARIZER.id, { dtype: SUMMARIZER.cpu_tryout.dtype, device: "cpu", revision: SUMMARIZER.revision });

  const results = { readall };
  for (const level of ["short", "caveman", "oneline"]) {
    console.log(`make-demo: generating ${level}...`);
    const r = await generateLevel(tokenizer, model, excerptText, level);
    console.log(`make-demo: ${level} raw output:\n${r.raw}`);
    if (r.cut.length > 0) console.log(`make-demo: ${level} cut by grounding: ${JSON.stringify(r.cut)}`);
    if (r.kept.length === 0) throw new Error(`${level}: every bullet was cut by grounding or the parser found none -- inspect the raw output above and adjust the excerpt or retry`);
    const items = [];
    const pcmPieces = [];
    let audioT = 0;
    for (const text of r.kept) {
      const { pcm } = await synth(tts, text);
      const dur = pcm.length / SR;
      items.push({ text, start: r.chunk.start, end: r.chunk.end, audioStart: round(audioT), audioEnd: round(audioT + dur) });
      pcmPieces.push(pcm);
      audioT += dur;
    }
    results[level] = { items, pcm: concatFloat32(pcmPieces) };
  }

  const written = [];
  written.push(["readall", await writeLevel("readall", "dial.readall", 0, readall.excerptEnd, readall.items, readall.pcm)]);
  for (const level of ["short", "caveman", "oneline"]) {
    const labelKey = dial.levels.find((l) => l.id === level).label_key;
    written.push([level, await writeLevel(level, labelKey, 0, readall.excerptEnd, results[level].items, results[level].pcm)]);
  }

  console.log("make-demo: written:");
  let totalBytes = 0;
  for (const [name, w] of written) {
    totalBytes += w.bytes;
    console.log(`  ${name}.wav  ${round(w.bytes / 1e6, 2)} MB  ${round(w.seconds, 2)} s`);
  }
  console.log(`make-demo: total ${round(totalBytes / 1e6, 2)} MB across ${written.length} files (budget 12 MB)`);
  if (totalBytes > 12_000_000) console.warn("make-demo: WARNING over the 12 MB total budget");
}

await main();
