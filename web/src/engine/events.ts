// A small ring buffer of structured events (docs/PLAN.md S1-11, Non-negotiable 1: "Logs are
// structured (numbers + enums) and never contain source text, bullets, audio, file names, or
// URLs"). `EventFields` is deliberately a closed bag of numbers/enums that mirrors
// spec/schemas/event.schema.json's `fields` object field-for-field, so nothing free-text can ever
// be pushed here even by accident -- the TypeScript type itself is the guardrail.
//
// Fed by main.tsx diffing successive orchestrator snapshots (Snapshot, engine/orchestrator.ts)
// into pushEvent() -- deliberately *not* wired inside orchestrator.ts itself (S1-11 packet: "wire
// it minimally in main.tsx via o.subscribe state deltas, not inside orchestrator.ts"), so the
// pipeline's own code never has to know a bug report exists. Consumed by report/build.ts,
// oldest-first, when assembling a BugReport.
import type { Level } from "../types";

export type EventName =
  | "run_start"
  | "run_done"
  | "run_failed"
  | "run_stopped"
  | "dial_change"
  | "model_load_start"
  | "model_load_done"
  | "tts_overlimit"
  | "all_cut"
  | "input_limit"
  | "probe_result"
  | "cache_hit"
  | "cache_miss"
  | "quota_error";

/** Exactly spec/schemas/event.schema.json's `fields` properties: a closed, numbers/enums-only
 *  bag reused across every event name. Not every field applies to every event name (the schema's
 *  own $comment), so all of them stay optional. */
export interface EventFields {
  level?: Level;
  from_level?: Level;
  to_level?: Level;
  device?: "webgpu" | "wasm" | "mlx";
  model_id?: string;
  model_role?: "default" | "fallback-a" | "fallback-b" | "low-end" | "voice";
  reason?: "abort" | "model_error" | "network_error" | "oom" | "timeout" | "unknown";
  probe_result?: "ok" | "fail";
  resource?: "model" | "voice" | "tokenizer";
  store?: "stats" | "cache";
  chunk_count?: number;
  chunk_index?: number;
  bullets_total?: number;
  word_count?: number;
  phoneme_count?: number;
  bytes?: number;
  bytes_attempted?: number;
  duration_ms?: number;
  latency_ms?: number;
  at_ms?: number;
}

/** The field names EventFields declares, kept as a runtime list so report/build.ts can strip any
 *  key outside this set from a fields object before it ever reaches a report (defense in depth:
 *  the type already prevents this at compile time, this covers a value that arrived unchecked,
 *  e.g. from a test fixture or a future caller). */
export const EVENT_FIELD_KEYS: readonly (keyof EventFields)[] = Object.freeze([
  "level",
  "from_level",
  "to_level",
  "device",
  "model_id",
  "model_role",
  "reason",
  "probe_result",
  "resource",
  "store",
  "chunk_count",
  "chunk_index",
  "bullets_total",
  "word_count",
  "phoneme_count",
  "bytes",
  "bytes_attempted",
  "duration_ms",
  "latency_ms",
  "at_ms",
]);

export interface Event {
  event: EventName;
  t_ms: number;
  fields: EventFields;
}

/** Generous margin over the report's own `events: last <= 50` cap (report/build.ts trims), so a
 *  burst of activity between two bug reports doesn't push out everything a first one might still
 *  want. */
const CAPACITY = 200;

let buffer: Event[] = [];
let t0 = typeof performance !== "undefined" ? performance.now() : 0;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/** Record one structured event, oldest evicted past CAPACITY. Never throws: a bad push would be
 *  a bug-report gap, never a reason to crash the app whose bug it might have explained. */
export function pushEvent(event: EventName, fields: EventFields = {}): void {
  try {
    buffer.push({ event, t_ms: Math.round(now() - t0), fields });
    while (buffer.length > CAPACITY) buffer.shift();
  } catch {
    // never let event capture be the thing that breaks the app
  }
}

/** Every buffered event, oldest first. A snapshot copy: callers never mutate the live buffer. */
export function events(): Event[] {
  return [...buffer];
}

/** Test-only / a fresh report shouldn't replay a previous session's events in the same tab. */
export function clearEvents(): void {
  buffer = [];
  t0 = now();
}
