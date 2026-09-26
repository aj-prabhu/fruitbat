// Message protocol between the main thread (engine/llm.ts) and the LLM workers (real and fake).
// Every message carries `runId`; stale results are dropped on the main thread (docs/PLAN.md,
// "Cancellation"). Payloads are numbers, enums, and the generated text; never the source text
// in any log.
import type { PinnedModel } from "./pins";
import type { Inject } from "./capabilities";

export type Level = "short" | "caveman" | "oneline";

export interface LoadMsg {
  type: "load";
  runId: number;
  model: PinnedModel & { role: string };
  inject: Inject;
}
export interface ProbeMsg {
  type: "probe";
  runId: number;
}
export interface GenerateMsg {
  type: "generate";
  runId: number;
  chunkIndex: number;
  /** Rendered user message (prompt file with {{text}} filled). */
  user: string;
  /** Optional system message (bake-off variant). */
  system?: string;
  maxNewTokens: number;
  /** Fake worker hints only: which fixture entry, the level, the chunk text. */
  fake?: { key: string | null; level: Level; text: string; delay_ms: number };
}
export interface AbortMsg {
  type: "abort";
  runId: number;
}
export type MainToWorker = LoadMsg | ProbeMsg | GenerateMsg | AbortMsg;

export interface ProgressOut {
  type: "progress";
  runId: number;
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}
export interface LoadedOut {
  type: "loaded";
  runId: number;
  modelId: string;
  role: string;
  /** true when the low-end tier replaced the requested one after a memory failure */
  downgraded: boolean;
  /** model bytes fetched over the network by this load (0 when every file came from the cache) */
  netBytes?: number;
  ms: number;
}
export interface ProbeOut {
  type: "probe_result";
  runId: number;
  ok: boolean;
  error?: string;
  ms: number;
}
export interface TokenOut {
  type: "token";
  runId: number;
  chunkIndex: number;
  text: string;
}
export interface ChunkDoneOut {
  type: "chunk_done";
  runId: number;
  chunkIndex: number;
  tokens: number;
  ms: number;
}
export interface AbortedOut {
  type: "aborted";
  runId: number;
}
export interface ErrorOut {
  type: "error";
  runId: number;
  name: string;
  message: string;
}
export type WorkerToMain = ProgressOut | LoadedOut | ProbeOut | TokenOut | ChunkDoneOut | AbortedOut | ErrorOut;
