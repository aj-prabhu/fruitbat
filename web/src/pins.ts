// Pinned models for the walking skeleton. spec/models.json is the source of truth; S1-03a's
// loader reads that file directly and a test asserts these values match it until then.
export const PINS = {
  llm: {
    id: "onnx-community/Qwen3.5-0.8B-Text-ONNX",
    revision: "1e45daba048899e7f771657ada617ec49350aa91",
    dtype: "q4f16",
    device: "webgpu",
  },
  tts: {
    id: "onnx-community/Kokoro-82M-v1.0-ONNX",
    revision: "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
    dtype: "q8",
    device: "wasm",
    voice: "af_heart",
  },
} as const;
