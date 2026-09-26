// Harness page for the summarizer engine (S1-05): exposes window.__llm for the e2e tests and
// the bake-off. Strings here are throwaway harness labels, not product copy (the product UI
// is app.tsx; S1-06 wires the engine into it).
import { Summarizer, type BulletOut, type Level, type NoticeOut, type RunStats } from "./engine/llm";
import { parseFlags } from "./engine/capabilities";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLParagraphElement>("status");
const textEl = $<HTMLTextAreaElement>("text");
const levelEl = $<HTMLSelectElement>("level");
const bulletsEl = $<HTMLUListElement>("bullets");
const rawEl = $<HTMLPreElement>("raw");

const flags = parseFlags();
const engine = new Summarizer(flags);
const H = {
  bullets: [] as BulletOut[],
  notices: [] as NoticeOut[],
  raw: "",
  aborted: false,
  flags,
  isolated: typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
  ready: false,
};
engine.onNotice = (n) => {
  statusEl.textContent = `notice: ${n.key}`;
};
engine.onProgress = (p) => {
  statusEl.textContent = `loading ${p.file ?? ""} ${p.loaded && p.total ? Math.round((p.loaded / p.total) * 100) + "%" : ""}`;
};

type RunOut = { bullets: BulletOut[]; notices: NoticeOut[]; raw: string; stats: RunStats; state: string; error: string | null; aborted: boolean };

// The engine serializes runs; the harness does too, so a second request never wipes the
// output of the one still streaming (Codex review, PR #16).
let queue: Promise<unknown> = Promise.resolve();
function run(text: string, level: Level): Promise<RunOut> {
  const p = queue.then(() => runNow(text, level));
  queue = p.catch(() => undefined);
  return p;
}

async function runNow(text: string, level: Level): Promise<RunOut> {
  H.bullets = [];
  H.notices = [];
  H.raw = "";
  H.aborted = false;
  bulletsEl.replaceChildren();
  rawEl.textContent = "";
  const stats = await engine.summarize(text, level, {
    onNotice: (n) => H.notices.push(n), // the per-run callback; the e2e notice checks read it
    onBullet: (b) => {
      H.bullets.push(b);
      const li = document.createElement("li");
      li.textContent = b.text;
      bulletsEl.appendChild(li);
    },
    onToken: (t) => {
      H.raw += t;
      rawEl.textContent = H.raw;
    },
  });
  H.aborted = engine.state === "stopped";
  statusEl.textContent = `${engine.state}: ${H.bullets.length} bullets`;
  return { bullets: H.bullets, notices: H.notices, raw: H.raw, stats, state: engine.state, error: engine.error, aborted: H.aborted };
}

const api = {
  probe: () => engine.probe(),
  load: () => engine.ensureLoaded(),
  summarize: run,
  abort: () => engine.abort(),
  state: () => ({ state: engine.state, error: engine.error, gpu: engine.gpu, isolated: H.isolated, ready: H.ready, flags }),
  stats: () => engine.stats(),
  requests: () => engine.requests(),
  notices: () => engine.noticesSeen(),
  sizeMb: () => engine.sizeMb(),
  bullets: () => H.bullets,
};
(window as unknown as { __llm: typeof api }).__llm = api;

$<HTMLButtonElement>("go").addEventListener("click", () => void run(textEl.value, levelEl.value as Level));
$<HTMLButtonElement>("stop").addEventListener("click", () => engine.abort());
void engine.probe().then((g) => {
  H.ready = true;
  statusEl.textContent = `ready: webgpu=${g.ok ? "yes" : "no (" + g.reason + ")"} llm=${flags.llm} size=${engine.sizeMb()} MB`;
});
