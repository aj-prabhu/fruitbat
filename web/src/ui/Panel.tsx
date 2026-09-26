// The panel (docs/PLAN.md S1-07, impeccable pass): bottom-right dock on desktop, full-width
// bottom sheet under 640px. Replaces the minimal <aside id="panel"> S1-06 left in app.tsx.
// Renders the orchestrator's own Snapshot (engine/orchestrator.ts) -- it triggers nothing on
// mount except reading the voice engine's already-persisted rate/voice (engine/tts.ts). Every
// visible string comes from spec/strings/en.json via ./strings' t() (rule 8, strings-check.mjs);
// two fixed decorative glyphs (Pip, the text-size/spacing icons) carry no letters so there is
// nothing to translate. Text size and spacing are MUST-light per the packet: three steps each,
// persisted, applied as data-* on the panel itself so panel.css only has to read them once.
import { useEffect, useRef, useState } from "preact/hooks";
import { orchestrator, type Cursor, type Snapshot } from "../engine/orchestrator";
import { RATE_MAX, RATE_MIN, VOICES, type VoiceId } from "../engine/tts";
import { t } from "../strings";
import "./panel.css";

const FONT_SIZES = ["sm", "md", "lg"] as const;
type FontSize = (typeof FONT_SIZES)[number];
const SPACINGS = ["compact", "cozy", "roomy"] as const;
type Spacing = (typeof SPACINGS)[number];
const FONT_SIZE_KEY = "fruitbat.panelFontSize";
const SPACING_KEY = "fruitbat.panelSpacing";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / quota: the setting just won't survive reload
  }
}

function useSnapshot(): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(() => orchestrator().snapshot());
  useEffect(() => orchestrator().subscribe(setSnap), []);
  return snap;
}

// ---------------------------------------------------------------- decorative glyphs (no letters)
function IconStop() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="panel-transport-icon">
      <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}
function IconPause() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="panel-transport-icon">
      <rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor" />
      <rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor" />
    </svg>
  );
}
function IconResume() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="panel-transport-icon">
      <path d="M4 2.5 13 8 4 13.5Z" fill="currentColor" />
    </svg>
  );
}
function IconSkip() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="panel-transport-icon">
      <path d="M3 2.5 9 8 3 13.5Z" fill="currentColor" />
      <rect x="11" y="2.5" width="2" height="11" rx="1" fill="currentColor" />
    </svg>
  );
}

/** Pip, code-drawn (docs/PLAN.md S1-08 replaces this with the illustrator's art; unprotected
 *  placeholder per Q5). A small silhouette peeking over the panel's top edge. */
function Pip() {
  return (
    <div class="panel-pip">
      <svg viewBox="0 0 48 24" width="30" height="15" role="img" aria-label={t("a11y.pip")} class="panel-pip-svg">
        <path d="M26 11 34 4 30 10 44 6 34 13 40 18 28 15 26 17Z" fill="currentColor" aria-hidden="true" />
        <path d="M22 11 14 4 18 10 4 6 14 13 8 18 20 15 22 17Z" fill="currentColor" aria-hidden="true" />
        <ellipse cx="24" cy="13" rx="3" ry="4.5" fill="currentColor" aria-hidden="true" />
        <path d="M21 9 22.5 4 24 9Z" fill="currentColor" aria-hidden="true" />
        <path d="M27 9 25.5 4 24 9Z" fill="currentColor" aria-hidden="true" />
      </svg>
    </div>
  );
}

function SizeGlyph({ step }: { step: number }) {
  return (
    <svg viewBox="0 0 20 14" width="18" height="13" aria-hidden="true" class="panel-step-glyph">
      <rect x="1" y="9" width="4" height="5" rx="1" fill="currentColor" opacity={step >= 0 ? 1 : 0.35} />
      <rect x="8" y="6" width="4" height="8" rx="1" fill="currentColor" opacity={step >= 1 ? 1 : 0.35} />
      <rect x="15" y="3" width="4" height="11" rx="1" fill="currentColor" opacity={step >= 2 ? 1 : 0.35} />
    </svg>
  );
}
function SpacingGlyph({ step }: { step: number }) {
  const ys = [
    [2, 7, 12],
    [2, 9, 16],
    [2, 11, 20],
  ][step];
  return (
    <svg viewBox="0 0 20 24" width="16" height="19" aria-hidden="true" class="panel-step-glyph">
      {ys.map((y, i) => (
        <rect key={i} x="2" y={y} width="16" height="2.5" rx="1" fill="currentColor" />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- bullets / read-all
function BulletList({ s }: { s: Snapshot }) {
  const playing = s.current?.kind === "bullet" ? s.current.index : -1;
  // The body scrolls: keep the bullet being spoken in view as playback moves down the list
  // (Codex review, PR #25).
  useEffect(() => {
    if (playing < 0) return;
    const el = document.querySelector(`.panel-bullets li[data-index="${playing}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [playing]);
  return (
    <ol class="panel-bullets" aria-live="polite" aria-label={t("a11y.bullet_list")}>
      {s.bullets.map((b, i) => (
        <li key={i} data-index={i} data-chunk={b.chunkIndex} aria-current={playing === i ? "true" : undefined}>
          {b.text}
        </li>
      ))}
    </ol>
  );
}

function ReadAllView({ cur }: { cur: Extract<Cursor, { kind: "sentence" }> }) {
  const ref = useRef(null) as { current: HTMLDivElement | null };
  // "Read this part" from far down a long summary inserts this view above the scroll position:
  // bring the sentence being read into view (Codex review, PR #25).
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [cur.start]);
  return (
    <div class="now-reading" ref={ref}>
      <p class="now-label">{t("panel.now_reading")}</p>
      <p class="now-text" data-testid="now-text">
        {cur.text}
      </p>
      {cur.next && (
        <div>
          <p class="next-label">{t("panel.next_up")}</p>
          <p class="next-text">{cur.next}</p>
        </div>
      )}
    </div>
  );
}

function AllCutRows({ allCut }: { allCut: number[] }) {
  return (
    <>
      {allCut.map((ci) => (
        <p key={ci} class="read-part-row">
          <button type="button" class="read-part" data-chunk={ci} onClick={() => void orchestrator().readThisPart(ci)}>
            <IconResume />
            {t("panel.read_this_part")}
          </button>
        </p>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- controls
function TransportRow({ s }: { s: Snapshot }) {
  // The demo recording is not the engine's, but Stop must reach it too: it plays via its own audio
  // element and says so with fruitbat:demo-playing (Codex review, PR #25).
  const [demoPlaying, setDemoPlaying] = useState(false);
  useEffect(() => {
    const on = (e: CustomEvent<boolean>) => setDemoPlaying(e.detail);
    window.addEventListener("fruitbat:demo-playing", on);
    return () => window.removeEventListener("fruitbat:demo-playing", on);
  }, []);
  const canStop = demoPlaying || s.gen !== "idle" || s.play === "playing" || s.play === "paused";
  const canPause = s.play === "playing";
  const canResume = s.play === "paused";
  const canSkip = s.play === "playing" || s.play === "paused";
  return (
    <div class="panel-controls-row">
      {/* The shared stop event, like Esc: the orchestrator and the demo recording both listen. */}
      <button type="button" class="panel-transport" disabled={!canStop} onClick={() => window.dispatchEvent(new CustomEvent("fruitbat:stop"))}>
        <IconStop />
        {t("panel.stop")}
      </button>
      {canResume ? (
        <button type="button" class="panel-transport panel-transport--primary" onClick={() => orchestrator().resume()}>
          <IconResume />
          {t("panel.resume")}
        </button>
      ) : (
        <button type="button" class="panel-transport" disabled={!canPause} onClick={() => orchestrator().pause()}>
          <IconPause />
          {t("panel.pause")}
        </button>
      )}
      <button type="button" class="panel-transport" disabled={!canSkip} onClick={() => orchestrator().skip()}>
        <IconSkip />
        {t("panel.skip")}
      </button>
    </div>
  );
}

function RateControl({ rate, onChange }: { rate: number; onChange: (r: number) => void }) {
  return (
    <div class="panel-field">
      <span class="panel-field-label" id="panel-rate-label">
        {t("panel.rate")}
      </span>
      <div class="panel-rate-row">
        <span class="panel-rate-end">{t("panel.rate_slower")}</span>
        <input
          type="range"
          class="panel-rate-slider"
          data-testid="rate-slider"
          min={RATE_MIN}
          max={RATE_MAX}
          step={0.05}
          value={rate}
          aria-labelledby="panel-rate-label"
          onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
        />
        <span class="panel-rate-end">{t("panel.rate_faster")}</span>
        <span class="panel-rate-value" data-testid="rate-value">
          {`${rate.toFixed(2)}×`}
        </span>
      </div>
    </div>
  );
}

/** Picker labels from spec/strings, never the engine's voice ids (Codex review, PR #25). */
const VOICE_LABEL: Record<VoiceId, string> = { af_heart: "panel.voice.af_heart", af_bella: "panel.voice.af_bella" };

function VoiceControl({ voice, onChange }: { voice: VoiceId; onChange: (v: VoiceId) => void }) {
  return (
    <div class="panel-field">
      <label class="panel-field-label" for="panel-voice-select">
        {t("panel.voice")}
      </label>
      <select
        id="panel-voice-select"
        class="panel-select"
        data-testid="voice-select"
        value={voice}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value as VoiceId)}
      >
        {VOICES.map((v) => (
          <option key={v} value={v}>
            {t(VOICE_LABEL[v])}
          </option>
        ))}
      </select>
    </div>
  );
}

function SpeakToggle({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div class="panel-toggle-row">
      <input
        type="checkbox"
        id="panel-speak-toggle"
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <label for="panel-speak-toggle">{t("panel.speak_messages")}</label>
    </div>
  );
}

function TextSizeControl({ value, onChange }: { value: FontSize; onChange: (v: FontSize) => void }) {
  const items: { id: FontSize; key: string }[] = [
    { id: "sm", key: "panel.font_size_small" },
    { id: "md", key: "panel.font_size_medium" },
    { id: "lg", key: "panel.font_size_large" },
  ];
  return (
    <div class="panel-field">
      <span class="panel-field-label" id="panel-fontsize-label">
        {t("panel.font_size")}
      </span>
      <div class="panel-steps" role="group" aria-labelledby="panel-fontsize-label">
        {items.map((it, i) => (
          <button
            key={it.id}
            type="button"
            class="panel-step-btn"
            data-testid={`font-size-${it.id}`}
            aria-pressed={value === it.id}
            aria-label={t(it.key)}
            onClick={() => onChange(it.id)}
          >
            <SizeGlyph step={i} />
          </button>
        ))}
      </div>
    </div>
  );
}

function SpacingControl({ value, onChange }: { value: Spacing; onChange: (v: Spacing) => void }) {
  const items: { id: Spacing; key: string }[] = [
    { id: "compact", key: "panel.spacing_compact" },
    { id: "cozy", key: "panel.spacing_cozy" },
    { id: "roomy", key: "panel.spacing_roomy" },
  ];
  return (
    <div class="panel-field">
      <span class="panel-field-label" id="panel-spacing-label">
        {t("panel.spacing")}
      </span>
      <div class="panel-steps" role="group" aria-labelledby="panel-spacing-label">
        {items.map((it, i) => (
          <button
            key={it.id}
            type="button"
            class="panel-step-btn"
            data-testid={`spacing-${it.id}`}
            aria-pressed={value === it.id}
            aria-label={t(it.key)}
            onClick={() => onChange(it.id)}
          >
            <SpacingGlyph step={i} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function Panel() {
  const s = useSnapshot();
  const [rate, setRate] = useState(() => orchestrator().voice.getRate());
  const [voice, setVoiceState] = useState<VoiceId>(() => orchestrator().voice.getVoice());
  const [fontSize, setFontSize] = useState<FontSize>(() => {
    const v = readStored(FONT_SIZE_KEY);
    return (FONT_SIZES as readonly string[]).includes(v ?? "") ? (v as FontSize) : "md";
  });
  const [spacing, setSpacing] = useState<Spacing>(() => {
    const v = readStored(SPACING_KEY);
    return (SPACINGS as readonly string[]).includes(v ?? "") ? (v as Spacing) : "cozy";
  });

  const onRate = (r: number) => setRate(orchestrator().voice.setRate(r));
  const onVoice = (v: VoiceId) => setVoiceState(orchestrator().voice.setVoice(v));
  const onFontSize = (v: FontSize) => {
    setFontSize(v);
    writeStored(FONT_SIZE_KEY, v);
  };
  const onSpacing = (v: Spacing) => {
    setSpacing(v);
    writeStored(SPACING_KEY, v);
  };

  const cur = s.current;
  const empty = s.bullets.length === 0 && !cur && s.allCut.length === 0 && !s.lastNotice;

  return (
    <aside
      id="panel"
      class="panel"
      role="complementary"
      aria-label={t("a11y.panel_region")}
      data-gen={s.gen}
      data-play={s.play}
      data-font-size={fontSize}
      data-spacing={spacing}
    >
      <Pip />
      {/* One scroll container for everything but Pip: at any window size, whatever does not fit
          scrolls, while Pip still pokes above the panel's edge (Codex review, PR #25). */}
      <div class="panel-scroll">
        <div class="panel-head">
          <h2 class="panel-title">{t("panel.title")}</h2>
        </div>
        {/* tabIndex=0: panel-body scrolls (panel.css, max-height + overflow-y) once content grows
            past it, and a scrollable region must be reachable by keyboard on its own (axe
            scrollable-region-focusable) rather than only through buttons it happens to contain. */}
        <div class="panel-body" tabIndex={0}>
          {empty && <p class="panel-empty">{t("panel.empty")}</p>}
          {cur?.kind === "sentence" && <ReadAllView cur={cur} />}
          {s.bullets.length > 0 && <BulletList s={s} />}
          <AllCutRows allCut={s.allCut} />
          {s.lastNotice && (
            <p class="panel-notice" role="status" aria-live="polite" data-notice={s.lastNotice}>
              {t(s.lastNotice)}
            </p>
          )}
        </div>
        <div class="panel-controls">
          <TransportRow s={s} />
          <RateControl rate={rate} onChange={onRate} />
          <VoiceControl voice={voice} onChange={onVoice} />
          <SpeakToggle checked={s.speakMessages} onChange={(on) => orchestrator().setSpeakMessages(on)} />
          <div class="panel-controls-row">
            <TextSizeControl value={fontSize} onChange={onFontSize} />
            <SpacingControl value={spacing} onChange={onSpacing} />
          </div>
        </div>
      </div>
    </aside>
  );
}
