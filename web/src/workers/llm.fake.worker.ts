/// <reference lib="webworker" />
// The scripted LLM for CI (docs/PLAN.md "Fake LLM for CI", C5): same protocol as llm.worker.ts,
// no model, no network. Bullets come from spec/fixtures/fake-llm.json when a fixture key is
// given, else deterministically from the chunk's own sentences (so grounding passes). Tokens
// stream word by word with `delay_ms`, and abort is honored between tokens.
import fixture from "../../../spec/fixtures/fake-llm.json";
import type { MainToWorker, WorkerToMain, Level } from "../engine/llmProtocol";

type Entry = Partial<Record<Level, string[] | null>>;
const ENTRIES = (fixture as { entries: Record<string, Entry> }).entries;
const post = (m: WorkerToMain) => self.postMessage(m);
const aborted = new Set<number>();
let generating: number | null = null;

const CAP: Record<Level, number> = { short: 4, caveman: 3, oneline: 1 };

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function autoLines(level: Level, text: string): string[] {
  const sents = sentences(text);
  const n = Math.min(CAP[level], Math.max(1, sents.length));
  const picked = sents.slice(0, n).map((s) => (level === "caveman" ? s.split(/\s+/).slice(0, 9).join(" ") : s));
  return picked.map((s) => `- ${s}`);
}

function linesFor(key: string | null, level: Level, text: string): string[] {
  if (key && ENTRIES[key]) {
    const lines = ENTRIES[key][level];
    if (Array.isArray(lines)) return lines;
  }
  return autoLines(level, text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function onGenerate(msg: Extract<MainToWorker, { type: "generate" }>): Promise<void> {
  const hint = msg.fake ?? { key: null, level: "short" as Level, text: msg.user, delay_ms: 0 };
  // A reduce call carries the one-liners as the text; reduce = the first surviving line.
  const isReduce = /^Below are one-line summaries/.test(msg.user);
  const lines = isReduce ? [hint.text.split("\n").find((l) => l.startsWith("- ")) ?? `- ${hint.text.split("\n")[0]}`] : linesFor(hint.key, hint.level, hint.text);
  const tokens = `${lines.join("\n")}\n`.split(/(?<=\s)/);
  const t0 = performance.now();
  let n = 0;
  generating = msg.runId;
  try {
    for (const tok of tokens) {
      if (aborted.has(msg.runId)) {
        post({ type: "aborted", runId: msg.runId });
        return;
      }
      post({ type: "token", runId: msg.runId, chunkIndex: msg.chunkIndex, text: tok });
      n++;
      if (hint.delay_ms > 0) await sleep(hint.delay_ms);
    }
    if (aborted.has(msg.runId)) {
      post({ type: "aborted", runId: msg.runId });
      return;
    }
    post({ type: "chunk_done", runId: msg.runId, chunkIndex: msg.chunkIndex, tokens: n, ms: Math.round(performance.now() - t0) });
  } finally {
    if (generating === msg.runId) generating = null;
  }
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case "load":
      post({ type: "loaded", runId: msg.runId, modelId: "fake", role: "fake", downgraded: false, ms: 0 });
      break;
    case "probe":
      post({ type: "probe_result", runId: msg.runId, ok: true, ms: 0 });
      break;
    case "generate":
      void onGenerate(msg);
      break;
    case "abort":
      // Same contract as llm.worker.ts: an idle worker confirms at once, a busy one when it stops.
      aborted.add(msg.runId);
      if (generating !== msg.runId) post({ type: "aborted", runId: msg.runId });
      break;
  }
};
