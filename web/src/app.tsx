// The app shell (docs/PLAN.md S1-01): header (title + dial), article column (the sample
// article), a paste box with a live word count, and an empty panel slot. S1-06 wires the real
// pipeline; S1-07 owns the panel's contents; S1-02 (this packet) owns selection/paste intake
// behavior: the "Read" chip and the paste box now live in ./intake, and the dial's level is
// mirrored into ./state/level so intake can read "what level is selected right now" without a
// prop chain back up to here.
import { useEffect, useState } from "preact/hooks";
import dialSpec from "../../spec/dial.json";
import { guardedFetch } from "./engine/net";
import { PasteBox } from "./intake/paste";
import { ReadChip } from "./intake/ReadChip";
import { orchestrator, type Snapshot } from "./engine/orchestrator";
import { setLevel as setSharedLevel } from "./state/level";
import { t } from "./strings";
import { Demo } from "./ui/Demo";
import { Loading } from "./ui/Loading";
import type { Level } from "./types";
import { Stats } from "./ui/Stats";

interface DialLevel {
  id: string;
  label_key: string;
}

const LEVELS = dialSpec.levels as DialLevel[];
const DEFAULT_LEVEL = (dialSpec.default as Level) ?? "short";

function Dial({ level, onChange }: { level: Level; onChange: (level: Level) => void }) {
  return (
    <fieldset class="dial">
      <legend class="visually-hidden">{t("a11y.dial")}</legend>
      {LEVELS.map((lvl) => (
        <label class="dial-option" key={lvl.id}>
          <input
            type="radio"
            name="level"
            value={lvl.id}
            checked={level === lvl.id}
            onChange={() => onChange(lvl.id as Level)}
          />
          <span>{t(lvl.label_key)}</span>
        </label>
      ))}
    </fieldset>
  );
}

type Theme = "light" | "dark";

function currentTheme(): Theme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
  }
  if (typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("fruitbat-theme", next);
    } catch {
      // private browsing / quota: theme just won't survive reload
    }
  };

  return (
    <button type="button" class="theme-toggle" onClick={toggle} aria-pressed={theme === "dark"}>
      {t("theme.toggle")}
    </button>
  );
}

function Article({ paragraphs }: { paragraphs: string[] }) {
  return (
    <article class="article" aria-label={t("intake.sample_label")}>
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </article>
  );
}

/** The sample article, split on blank lines. Loaded from the same-origin path S1-01's
 * copy-sample.mjs prebuild step writes (spec/eval/corpus/011.txt once S0-04a lands, a stand-in
 * until then). Every network call goes through engine/net.ts (CONTRIBUTING.md "Strings"/rule 1). */
function useSampleArticle(): string[] {
  const [paragraphs, setParagraphs] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    guardedFetch("/sample.txt")
      .then((res) => res.text())
      .then((text) => {
        if (cancelled) return;
        setParagraphs(
          text
            .split(/\n{2,}/)
            .map((p) => p.trim())
            .filter(Boolean),
        );
      })
      .catch(() => {
        if (!cancelled) setParagraphs([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return paragraphs;
}

/** The pipeline's state for the panel (S1-06). S1-07 styles it; this is the minimal rendering. */
function useOrchestrator(): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(() => orchestrator().snapshot());
  useEffect(() => orchestrator().subscribe(setSnap), []);
  return snap;
}

function Panel() {
  const s = useOrchestrator();
  const cur = s.current;
  const empty = s.bullets.length === 0 && !cur && s.allCut.length === 0 && !s.lastNotice;
  return (
    <aside id="panel" class="panel" aria-label={t("a11y.panel_region")} data-gen={s.gen} data-play={s.play}>
      {empty && <p class="panel-empty">{t("panel.empty")}</p>}
      {cur?.kind === "sentence" && (
        <div class="now-reading">
          <p class="now-label">{t("panel.now_reading")}</p>
          <p class="now-text" data-testid="now-text">
            {cur.text}
          </p>
          {cur.next && (
            <p class="next-text">
              <span class="next-label">{t("panel.next_up")}</span> {cur.next}
            </p>
          )}
        </div>
      )}
      {s.bullets.length > 0 && (
        <ul class="bullets" aria-label={t("a11y.bullet_list")}>
          {s.bullets.map((b, i) => (
            <li key={i} data-chunk={b.chunkIndex} aria-current={cur?.kind === "bullet" && cur.index === i ? "true" : undefined}>
              {b.text}
            </li>
          ))}
        </ul>
      )}
      {s.allCut.map((ci) => (
        <p key={ci} class="read-part-row">
          <button type="button" class="read-part" data-chunk={ci} onClick={() => void orchestrator().readThisPart(ci)}>
            {t("panel.read_this_part")}
          </button>
        </p>
      ))}
      {s.lastNotice && (
        <p class="panel-notice" role="status" aria-live="polite" data-notice={s.lastNotice}>
          {t(s.lastNotice)}
        </p>
      )}
    </aside>
  );
}

export function App() {
  const [level, setLevel] = useState<Level>(DEFAULT_LEVEL);
  const [statsOpen, setStatsOpen] = useState(false);
  const paragraphs = useSampleArticle();

  useEffect(() => {
    document.title = t("app.title");
  }, []);

  // Keep intake's read of "the current level" (window.getSelection-driven, no props access) in
  // sync with the dial's own state, which stays the single source of truth for what's checked.
  useEffect(() => {
    setSharedLevel(level);
  }, [level]);

  return (
    <div class="app-shell">
      <header class="app-header">
        <h1 class="app-title">{t("app.title")}</h1>
        <Dial
          level={level}
          onChange={(l) => {
            setSharedLevel(l); // synchronous, so a read triggered right after the click sees it (Codex merge-gate review, PR #12)
            setLevel(l);
          }}
        />
        <button type="button" class="stats-toggle" onClick={() => setStatsOpen(true)}>
          {t("panel.stats")}
        </button>
        <ThemeToggle />
      </header>
      <Loading />
      <main class="app-main">
        <Demo />
        <Article paragraphs={paragraphs} />
        <PasteBox />
      </main>
      <Panel />
      <ReadChip />
      {statsOpen && <Stats onClose={() => setStatsOpen(false)} />}
    </div>
  );
}
