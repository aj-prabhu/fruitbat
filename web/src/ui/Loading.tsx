// The loading line under the header (docs/PLAN.md S1-09 "Loading UX", rule 11). Renders the
// orchestrator's own snapshot -- it triggers nothing except the explicit "Load summarizer"
// button; the voice's automatic load (rule 11) and the summarizer's on-request load (also rule
// 11) both already happen in engine/orchestrator.ts and engine/llm.ts. This component only
// shows what is true right now: probing -> voice loading (with MB) -> ready; the summarizer's
// size before its download, MB-so-far during, and cache detection for both.
import { useEffect, useState } from "preact/hooks";
import { isMobile, saveData } from "../engine/capabilities";
import { isModelCached } from "../engine/cache";
import { orchestrator, type Snapshot } from "../engine/orchestrator";
import { pinnedModels } from "../engine/pins";
import { t } from "../strings";

function mb(bytes: number | undefined): number {
  return Math.round((bytes ?? 0) / 1e6);
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), template);
}

// docs/PLAN.md S1-09: "Progress bars are real progress elements with aria-valuenow".
/** `total` of 0/undefined renders an indeterminate bar. */
function Bar({ testId, loaded, total }: { testId: string; loaded: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined;
  return pct === undefined ? (
    <progress data-testid={testId} class="loading-bar" />
  ) : (
    <progress data-testid={testId} class="loading-bar" max={100} value={pct} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} />
  );
}

type CacheState = "unknown" | "cached" | "first_time";

/** Was `url`'s model already cached, checked once. "unknown" until the check settles. */
function useCacheState(model: { id: string; revision: string; url_template: string; files: { path: string; bytes: number }[] } | null): CacheState {
  const [state, setState] = useState<CacheState>("unknown");
  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    void isModelCached(model).then((cached) => {
      if (!cancelled) setState(cached ? "cached" : "first_time");
    });
    return () => {
      cancelled = true;
    };
  }, [model?.id, model?.revision]);
  return state;
}

function CacheNote({ state }: { state: CacheState }) {
  if (state === "unknown") return null;
  return <p class="loading-cache">{t(state === "cached" ? "loading.cached" : "loading.first_time")}</p>;
}

function useSnapshot(): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(() => orchestrator().snapshot());
  useEffect(() => orchestrator().subscribe(setSnap), []);
  return snap;
}

/** The summarizer section: size shown before its download (rule 11), MB-so-far during, cache
 *  note, the explicit "Load summarizer" button, and the two-stage-probe notices. */
function SummarizerSection({ s }: { s: Snapshot }) {
  const llm = orchestrator().llm;
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const cache = useCacheState(llm.tier());
  // Either this button, or the app's own "Read it" (rule 11's "first summary request") can start
  // the download; either way `s.gen` and `s.progress` move once it does (Codex review would flag
  // a button that only knows about clicks on itself).
  // Readiness comes from the summarizer's own state, not from `s.gen`: a Read-all run moves gen
  // through loading/running/done without ever loading the summarizer (Codex review, PR #20).
  const started = phase !== "idle" || s.progress !== null || llm.state === "loading";
  const done = phase === "ready" || (s.progress !== null && llm.state !== "loading" && llm.state !== "failed" && !llm.error);
  const loaded = mb(s.progress?.loaded);
  const total = mb(s.progress?.total) || (started ? llm.sizeMb() : 0);

  const onLoad = () => {
    if (started) return;
    setPhase("loading");
    void llm.ensureLoaded().then((ok) => setPhase(ok ? "ready" : "failed"));
  };

  return (
    <div class="loading-summarizer" data-started={started}>
      <p class="loading-line">{t("loading.summarizer_size").replace("{mb}", String(llm.sizeMb()))}</p>
      {!started && (
        <button type="button" class="loading-summarizer-button" data-testid="summarizer-load" onClick={onLoad}>
          {t("loading.summarizer_button").replace("{mb}", String(llm.sizeMb()))}
        </button>
      )}
      {started && (
        <>
          <Bar testId="summarizer-progress" loaded={done ? 1 : loaded} total={done ? 1 : total} />
          <p class="loading-line">{fill(t("loading.progress"), { mb: loaded })}</p>
          <CacheNote state={cache} />
        </>
      )}
      {s.notices
        .filter((n, i) => (n === "notice.no_webgpu" || n === "notice.probe_failed" || n === "notice.low_end_tier") && s.notices.indexOf(n) === i)
        .map((n) => (
          <p key={n} class="loading-notice" role="status" data-notice={n}>
            {t(n)}
          </p>
        ))}
    </div>
  );
}

/** The line under the header: probing -> voice loading (MB bar) -> ready, or the mobile /
 *  save-data message rule 11 replaces it with (the voice does not auto-load either way). */
function VoiceLine({ s }: { s: Snapshot }) {
  const voice = pinnedModels().web.voice;
  const cache = useCacheState(voice);
  if (saveData()) return <p class="loading-line" data-phase="save_data">{t("loading.save_data")}</p>;
  if (isMobile()) return <p class="loading-line" data-phase="mobile">{t("loading.mobile")}</p>;
  if (s.voiceReady) return <p class="loading-line" data-phase="ready">{t("loading.ready")}</p>;
  if (s.voiceProgress) {
    const loaded = mb(s.voiceProgress.loaded);
    const total = mb(s.voiceProgress.total);
    return (
      <div class="loading-voice" data-phase="voice">
        <p class="loading-line">{t("loading.voice")}</p>
        <Bar testId="voice-progress" loaded={loaded} total={total} />
        <p class="loading-line">{fill(t("loading.progress"), { mb: loaded })}</p>
        <CacheNote state={cache} />
      </div>
    );
  }
  return <p class="loading-line" data-phase="probing">{t("loading.probing")}</p>;
}

export function Loading() {
  const s = useSnapshot();
  return (
    <section class="loading" data-testid="loading">
      <VoiceLine s={s} />
      <SummarizerSection s={s} />
    </section>
  );
}
