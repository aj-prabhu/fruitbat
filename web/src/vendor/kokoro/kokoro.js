/*
 * Vendored from kokoro-js 1.2.1 (https://github.com/hexgrad/kokoro, kokoro.js/src/kokoro.js).
 * Copyright 2025 Hexgrad and contributors. Apache License 2.0 (see ./LICENSE).
 * Fruitbat changes (S1-00a, 2026-09-23):
 *  - `revision` is passed through to Transformers.js 4.x so every model file URL carries the
 *    pinned commit hash from spec/models.json (the upstream loader always fetched `main`).
 *  - voice data comes from an injected `loadVoice(id)` (see voices.js); this file never fetches.
 *  - no console output (docs/PLAN.md rule 1: logs are numbers and enums, in the logger module).
 *  - `generate_from_phonemes()` asserts the phoneme string fits `tokenizer.model_max_length`
 *    before every synthesis call and throws `tts_overlimit` instead of truncating (rule 2).
 *    Upstream tokenized with `truncation: true`, which silently drops the end of long input.
 */
import { StyleTextToSpeech2Model, AutoTokenizer, Tensor, RawAudio } from "@huggingface/transformers";
import { phonemize } from "./phonemize.js";
import { TextSplitterStream } from "./splitter.js";
import { getVoiceData, VOICES } from "./voices.js";

const STYLE_DIM = 256;
const SAMPLE_RATE = 24000;

export class KokoroTTS {
  /**
   * @param {import('@huggingface/transformers').StyleTextToSpeech2Model} model
   * @param {import('@huggingface/transformers').PreTrainedTokenizer} tokenizer
   * @param {(id: string) => Promise<Float32Array>} loadVoice
   */
  constructor(model, tokenizer, loadVoice) {
    this.model = model;
    this.tokenizer = tokenizer;
    this.loadVoice = loadVoice;
  }

  /**
   * @param {string} model_id
   * @param {Object} options
   * @param {"fp32"|"fp16"|"q8"|"q4"|"q4f16"|"q8f16"} [options.dtype="q8"]
   * @param {"wasm"|"webgpu"|"cpu"|null} [options.device=null]
   * @param {string} [options.revision="main"] pinned commit hash
   * @param {import("@huggingface/transformers").ProgressCallback} [options.progress_callback=null]
   * @param {(id: string) => Promise<Float32Array>} options.loadVoice required
   * @param {string} [options.model_file_name] ONNX file name without `.onnx` (e.g. `model_q8f16`)
   */
  static async from_pretrained(model_id, { dtype = "q8", device = null, revision = "main", progress_callback = null, loadVoice, model_file_name = undefined } = {}) {
    if (typeof loadVoice !== "function") throw new Error("KokoroTTS.from_pretrained: loadVoice(id) is required");
    // `model_file_name` names the ONNX file directly (Fruitbat, S1-06): Transformers.js 4.3.0 has
    // no `q8f16` dtype, so the WebGPU variant is loaded as `model_q8f16` with dtype fp32.
    const model = StyleTextToSpeech2Model.from_pretrained(model_id, { progress_callback, dtype, device, revision, ...(model_file_name ? { model_file_name } : {}) });
    const tokenizer = AutoTokenizer.from_pretrained(model_id, { progress_callback, revision });
    const [m, t] = await Promise.all([model, tokenizer]);
    return new KokoroTTS(m, t, loadVoice);
  }

  get voices() {
    return VOICES;
  }

  /** Model input limit in tokens, including the two boundary tokens. */
  get max_tokens() {
    return this.tokenizer.model_max_length;
  }

  _validate_voice(voice) {
    if (!Object.prototype.hasOwnProperty.call(VOICES, voice)) {
      throw new Error(`Voice "${voice}" not found. Should be one of: ${Object.keys(VOICES).join(", ")}.`);
    }
    return /** @type {"a"|"b"} */ (voice.at(0));
  }

  /**
   * Tokenize a phoneme string without truncation.
   * @param {string} phonemes
   * @returns {Tensor} input_ids
   */
  tokenize(phonemes) {
    const { input_ids } = this.tokenizer(phonemes, { truncation: false });
    return input_ids;
  }

  /** @param {string} phonemes @returns {number} token count including boundary tokens */
  count_tokens(phonemes) {
    return this.tokenize(phonemes).dims.at(-1);
  }

  /** @param {string} phonemes */
  fits(phonemes) {
    return this.count_tokens(phonemes) <= this.max_tokens;
  }

  /**
   * @param {string} text
   * @param {{voice?: string, speed?: number}} options
   * @returns {Promise<RawAudio>}
   */
  async generate(text, { voice = "af_heart", speed = 1 } = {}) {
    const language = this._validate_voice(voice);
    const phonemes = await phonemize(text, language);
    return this.generate_from_phonemes(phonemes, { voice, speed });
  }

  /**
   * Synthesize a phoneme string. Throws `tts_overlimit` if it does not fit the model.
   * @param {string} phonemes
   * @param {{voice?: string, speed?: number}} options
   * @returns {Promise<RawAudio>}
   */
  async generate_from_phonemes(phonemes, { voice = "af_heart", speed = 1 } = {}) {
    const input_ids = this.tokenize(phonemes);
    const n = input_ids.dims.at(-1);
    if (n > this.max_tokens) {
      const err = new Error("tts_overlimit");
      err.name = "tts_overlimit";
      err.tokens = n;
      err.limit = this.max_tokens;
      throw err;
    }
    return this.generate_from_ids(input_ids, { voice, speed });
  }

  /**
   * @param {Tensor} input_ids
   * @param {{voice?: string, speed?: number}} options
   * @returns {Promise<RawAudio>}
   */
  async generate_from_ids(input_ids, { voice = "af_heart", speed = 1 } = {}) {
    const num_tokens = Math.min(Math.max(input_ids.dims.at(-1) - 2, 0), 509);
    const data = await getVoiceData(voice, this.loadVoice);
    const offset = num_tokens * STYLE_DIM;
    const voiceData = data.slice(offset, offset + STYLE_DIM);
    const inputs = {
      input_ids,
      style: new Tensor("float32", voiceData, [1, STYLE_DIM]),
      speed: new Tensor("float32", [speed], [1]),
    };
    const { waveform } = await this.model(inputs);
    return new RawAudio(waveform.data, SAMPLE_RATE);
  }

  /**
   * Stream sentence by sentence. Every sentence must fit; the TTS-safe splitter (S1-03/S1-04)
   * guarantees that before text reaches here.
   * @param {string|TextSplitterStream} text
   * @param {{voice?: string, speed?: number, split_pattern?: RegExp|null}} options
   * @returns {AsyncGenerator<{text: string, phonemes: string, audio: RawAudio}, void, void>}
   */
  async *stream(text, { voice = "af_heart", speed = 1, split_pattern = null } = {}) {
    const language = this._validate_voice(voice);
    let splitter;
    if (text instanceof TextSplitterStream) {
      splitter = text;
    } else if (typeof text === "string") {
      splitter = new TextSplitterStream();
      const chunks = split_pattern
        ? text.split(split_pattern).map((c) => c.trim()).filter((c) => c.length > 0)
        : [text];
      splitter.push(...chunks);
      splitter.close(); // a string input is complete; without this the iterator never ends (Codex review, PR #2)
    } else {
      throw new Error("Invalid input type. Expected string or TextSplitterStream.");
    }
    for await (const sentence of splitter) {
      const phonemes = await phonemize(sentence, language);
      const audio = await this.generate_from_phonemes(phonemes, { voice, speed });
      yield { text: sentence, phonemes, audio };
    }
  }
}

export { TextSplitterStream, phonemize, VOICES };
