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
}

export interface FruitbatAPI {
  run(text: string, level: Level): void;
  stop(): void;
  stats(): FruitbatStats;
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
  }
}
