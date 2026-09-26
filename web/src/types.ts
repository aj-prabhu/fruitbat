// window.__fruitbat test hook (docs/PLAN.md S1-01). This packet only records the request and
// counts it; S1-06 listens for the `fruitbat:run` / `fruitbat:stop` events dispatched here and
// wires the real pipeline (segmenter -> LLM worker -> TTS worker).
export type Level = "readall" | "short" | "caveman" | "oneline";

export interface RunRequest {
  level: Level;
  chars: number;
}

export interface FruitbatStats {
  runs: number;
  last: RunRequest | null;
  // S1-06: the orchestrator's measurements (see engine/orchestrator.ts OrchestratorStats)
  ttfa_ms?: number | null;
  stop_ms?: number | null;
  notice_latency_ms?: number | null;
  notices_spoken?: string[];
  gen?: unknown;
  voice?: unknown;
  voice_run?: unknown;
}

export interface FruitbatAPI {
  run(text: string, level: Level): void;
  stop(): void;
  stats(): FruitbatStats;
  // S1-06
  state?(): unknown;
  setLevel?(level: Level): Promise<void>;
  readThisPart?(chunkIndex: number): Promise<void>;
  pause?(): void;
  resume?(): void;
  skip?(): boolean;
  setSpeakMessages?(on: boolean): void;
  // S1-10 (stats store)
  rows?(): unknown[];
  setDocId?(id: string): void;
}

export interface FruitbatRunEventDetail {
  text: string;
  level: Level;
}

declare global {
  interface Window {
    __fruitbat: FruitbatAPI;
  }
  interface WindowEventMap {
    "fruitbat:run": CustomEvent<FruitbatRunEventDetail>;
    "fruitbat:stop": CustomEvent<undefined>;
    /** the demo recording is about to play (main.tsx stops a live run, never a model download) */
    "fruitbat:demo": CustomEvent<undefined>;
    /** the orchestrator started a live run (any kind); the demo recording stops */
    "fruitbat:live": CustomEvent<undefined>;
  }
  // vite.config.ts `define`s this from `git rev-parse --short HEAD` (S1-10, stats/store.ts).
  const __FRUITBAT_COMMIT__: string;
}
