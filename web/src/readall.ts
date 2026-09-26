// Read-all harness page (S1-04). Drives engine/tts.ts without the orchestrator (S1-06 wires it
// into window.__fruitbat.run). Labels come from spec/strings/en.json; this page is a test and
// bench surface, not the product panel (S1-07).
import { voiceEngine, RATE_MIN, RATE_MAX, VOICES } from "./engine/tts";
import { t } from "./strings";

const engine = voiceEngine();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const textEl = $<HTMLTextAreaElement>("text");
const statusEl = $<HTMLParagraphElement>("status");
const nowEl = $<HTMLParagraphElement>("now");
const rateEl = $<HTMLInputElement>("rate");
const voiceEl = $<HTMLSelectElement>("voice");

$<HTMLButtonElement>("readall").textContent = t("dial.readall");
$<HTMLButtonElement>("stop").textContent = t("panel.stop");
$<HTMLButtonElement>("pause").textContent = t("panel.pause");
$<HTMLButtonElement>("resume").textContent = t("panel.resume");
$<HTMLButtonElement>("skip").textContent = t("panel.skip");
$<HTMLLabelElement>("rate-label").textContent = t("panel.rate");
$<HTMLLabelElement>("voice-label").textContent = t("panel.voice");
rateEl.min = String(RATE_MIN);
rateEl.max = String(RATE_MAX);
rateEl.step = "0.1";
rateEl.value = String(engine.getRate());
for (const v of VOICES) {
  const o = document.createElement("option");
  o.value = v;
  o.textContent = v;
  voiceEl.appendChild(o);
}
voiceEl.value = engine.getVoice();

function setStatus(s: string) {
  statusEl.textContent = s;
}

engine.onProgress((file, loaded, total) => setStatus(`${t("loading.voice")} ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB ${file}`));

async function readAll(text: string, opts: { rate?: number; voice?: "af_heart" | "af_bella" } = {}) {
  setStatus(t("notice.reading_all"));
  const r = await engine.readAll(text, {
    ...opts,
    onStart: (e) => {
      nowEl.textContent = text.slice(e.start, e.end);
      nowEl.dataset.seq = String(e.seq);
    },
    onEnd: (e) => {
      // Only the sentence that ended clears the line; the next one may already have started.
      if (nowEl.dataset.seq === String(e.seq)) nowEl.textContent = "";
    },
  });
  setStatus(r.finished ? t("notice.done") : t("notice.stopped"));
  return r;
}

$<HTMLButtonElement>("readall").addEventListener("click", () => void readAll(textEl.value));
$<HTMLButtonElement>("stop").addEventListener("click", () => {
  engine.stop();
  setStatus(t("notice.stopped"));
});
$<HTMLButtonElement>("pause").addEventListener("click", () => engine.pause());
$<HTMLButtonElement>("resume").addEventListener("click", () => engine.resume());
$<HTMLButtonElement>("skip").addEventListener("click", () => engine.skip());
rateEl.addEventListener("input", () => (rateEl.value = String(engine.setRate(Number(rateEl.value)))));
voiceEl.addEventListener("change", () => engine.setVoice(voiceEl.value));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    engine.stop();
    setStatus(t("notice.stopped"));
  }
});

// Test hook (S1-04 proof; S1-06 replaces it with window.__fruitbat.run).
(window as unknown as { __tts: unknown }).__tts = {
  load: () => engine.load(),
  plan: (text: string) => engine.plan(text),
  measure: (text: string, target: number, rate?: number) => engine.measure(text, target, rate),
  readAll,
  speak: (key: string) => engine.speak(key),
  stop: () => engine.stop(),
  pause: () => engine.pause(),
  resume: () => engine.resume(),
  skip: () => engine.skip(),
  setRate: (r: number) => engine.setRate(r),
  getRate: () => engine.getRate(),
  setVoice: (v: string) => engine.setVoice(v),
  state: () => engine.state(),
  stats: () => engine.stats(),
};
setStatus(t("loading.ready"));
