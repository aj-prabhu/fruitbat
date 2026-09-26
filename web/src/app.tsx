// The app shell (docs/PLAN.md S1-01): header (title + dial), article column (the sample
// article), a paste box with a live word count, and an empty panel slot. S1-06 wires the real
// pipeline; S1-07 owns the panel's contents; S1-02 owns selection/paste intake behavior. This
// packet only lays out the skeleton and keeps window.__fruitbat alive (see main.tsx).
import { useEffect, useState } from "preact/hooks";
import dialSpec from "../../spec/dial.json";
import { guardedFetch } from "./engine/net";
import { t } from "./strings";
import type { Level } from "./types";

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

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function PasteBox() {
  const [value, setValue] = useState("");
  const count = wordCount(value);

  return (
    <div class="paste-box">
      <label class="paste-label" for="paste-input">
        {t("intake.paste_placeholder")}
      </label>
      <textarea
        id="paste-input"
        class="paste-textarea"
        placeholder={t("intake.paste_placeholder")}
        value={value}
        onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
      />
      <p class="word-count" aria-live="polite" data-word-count={count}>
        {t("intake.word_count").replace("{n}", String(count))}
      </p>
    </div>
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

export function App() {
  const [level, setLevel] = useState<Level>(DEFAULT_LEVEL);
  const paragraphs = useSampleArticle();

  useEffect(() => {
    document.title = t("app.title");
  }, []);

  return (
    <div class="app-shell">
      <header class="app-header">
        <h1 class="app-title">{t("app.title")}</h1>
        <Dial level={level} onChange={setLevel} />
        <ThemeToggle />
      </header>
      <main class="app-main">
        <Article paragraphs={paragraphs} />
        <PasteBox />
      </main>
      <aside id="panel" class="panel" aria-label={t("a11y.panel_region")}>
        <p class="panel-empty">{t("panel.empty")}</p>
      </aside>
    </div>
  );
}
