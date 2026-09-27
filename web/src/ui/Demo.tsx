// The canned demo (docs/PLAN.md S1-09, C14): "Try it now" plays a pre-generated recording of the
// sample article for the dial's current level in under a second, labeled as a recording, while
// the real models load (or on a phone / a laptop with no WebGPU, where they never do). It shares
// the header's dial (state/level.ts) rather than drawing a second one, so turning that dial
// switches the recording. It never imports the engine (no orchestrator, no llm.ts, no tts.ts):
// only static files under public/demo/, fetched same-origin through net.ts like any other asset.
// That includes the audio: a Hugging Face Space serves the WAVs from the Hub's CDN, which the CSP's
// `media-src 'self' blob:` refuses for an <audio src>, so each recording plays from a blob: URL.
import { useEffect, useRef, useState } from "preact/hooks";
import { guardedFetch } from "../engine/net";
import { getLevel, subscribeLevel } from "../state/level";
import { t } from "../strings";
import type { Level } from "../types";

interface DemoItem {
  text: string;
  start: number;
  end: number;
  audioStart: number;
  audioEnd: number;
}
interface DemoTrack {
  level: Level;
  label_key: string;
  source_doc: string;
  source_start: number;
  source_end: number;
  sample_rate: number;
  duration_seconds: number;
  items: DemoItem[];
}

function currentItemIndex(items: DemoItem[], time: number): number {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const started = time >= item.audioStart;
    const notYetEnded = time < item.audioEnd;
    if (started && notYetEnded) return i;
  }
  const last = items[items.length - 1];
  return last && time >= last.audioEnd ? items.length - 1 : -1;
}

/** Fetches and caches every level's track so a dial flip while playing switches instantly. */
function useTracks(): { track: DemoTrack | null; level: Level } {
  const [level, setLevel] = useState<Level>(getLevel);
  const [tracks, setTracks] = useState<Partial<Record<Level, DemoTrack>>>({});

  useEffect(() => subscribeLevel(setLevel), []);

  useEffect(() => {
    if (tracks[level]) return;
    let cancelled = false;
    void guardedFetch(`/demo/${level}.json`)
      .then((res) => {
        return res.json() as Promise<DemoTrack>;
      })
      .then((data) => {
        if (!cancelled) setTracks((prev) => ({ ...prev, [level]: data }));
      })
      .catch(() => {
        // a missing/broken demo track leaves the player showing nothing rather than throwing
      });
    return () => {
      cancelled = true;
    };
  }, [level, tracks]);

  return { track: tracks[level] ?? null, level };
}

/** Each level's recording as a blob: URL, fetched once when that level is first shown and kept
 *  until the demo unmounts, so a dial flip back is instant. At most four files of 4 MB or less. */
function useRecordings(level: Level): Partial<Record<Level, string>> {
  const [urls, setUrls] = useState<Partial<Record<Level, string>>>({});
  const made = useRef<string[]>([]);

  useEffect(() => {
    if (urls[level]) return;
    let cancelled = false;
    void guardedFetch(`/demo/${level}.wav`)
      .then((res) => {
        if (!res.ok) throw new Error(`demo_http_${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        made.current.push(url);
        setUrls((prev) => ({ ...prev, [level]: url }));
      })
      .catch(() => {
        // a missing recording leaves "Try it now" disabled rather than throwing
      });
    return () => {
      cancelled = true;
    };
  }, [level, urls]);

  useEffect(() => () => made.current.forEach((u) => URL.revokeObjectURL(u)), []);

  return urls;
}

export function Demo() {
  const { track, level } = useTracks();
  const recordings = useRecordings(level);
  const src = track ? recordings[track.level] : undefined;
  const [playing, setPlaying] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Set when the dial moved during playback to a level whose recording is still downloading:
  // playback resumes on the new recording once it lands.
  const resumeRef = useRef(false);

  // A dial flip mid-playback switches the recording at once (docs/PLAN.md: "switching the dial
  // switches the recording"): reload the element for the new level and keep playing if it was.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !track) return;
    const wasPlaying = playing || resumeRef.current;
    setActiveIndex(-1);
    if (!src) {
      // this level's recording is still downloading: hold, and pick up again when it lands
      resumeRef.current = wasPlaying;
      if (!el.paused) el.pause();
      return;
    }
    resumeRef.current = false;
    el.load();
    if (wasPlaying) void el.play().catch(() => setPlaying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.level, src]);

  // Esc and fruitbat.stop() must silence the recording too, not only the engine's voice
  // (Codex review, PR #20). main.tsx dispatches fruitbat:stop for both.
  useEffect(() => {
    const stop = () => {
      const el = audioRef.current;
      if (el && !el.paused) el.pause();
      // Also when no element is mounted (the next level's track is still loading): otherwise it
      // would start by itself once it loads (Codex review, PR #20). Same for a recording still
      // downloading after a dial flip.
      resumeRef.current = false;
      setPlaying(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    window.addEventListener("fruitbat:stop", stop);
    window.addEventListener("fruitbat:run", stop); // a live read never plays over the recording
    window.addEventListener("fruitbat:live", stop); // nor a dial regeneration or "Read this part"
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("fruitbat:stop", stop);
      window.removeEventListener("fruitbat:run", stop);
      window.removeEventListener("fruitbat:live", stop);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const onTryItNow = () => {
    const el = audioRef.current;
    if (!el) return;
    // A live read or summary never plays under the recording: main.tsx stops it on this event,
    // and only it; a background model download keeps going (this component does not import the
    // engine) (Codex review, PR #20).
    window.dispatchEvent(new CustomEvent("fruitbat:demo"));
    void el.play().catch(() => setPlaying(false));
  };

  const onTimeUpdate = () => {
    const el = audioRef.current;
    if (!el || !track) return;
    setActiveIndex(currentItemIndex(track.items, el.currentTime));
  };

  return (
    <section class="demo" data-testid="demo" data-level={level}>
      <p class="demo-recording-label">{t("demo.recording_label")}</p>
      <p class="demo-excerpt-note">{t("demo.excerpt_note")}</p>
      <button type="button" class="demo-try-it-now" data-testid="demo-try" onClick={onTryItNow} disabled={!track || !src}>
        {t("demo.try_it_now")}
      </button>
      <p class="demo-switch-level">{t("demo.switch_level")}</p>
      {track && (
        <audio
          ref={audioRef}
          data-testid="demo-audio"
          preload="auto"
          src={src}
          onPlay={() => {
            setPlaying(true);
            window.dispatchEvent(new CustomEvent("fruitbat:demo-playing", { detail: true })); // the panel's Stop can reach it
          }}
          onPause={() => {
            setPlaying(false);
            window.dispatchEvent(new CustomEvent("fruitbat:demo-playing", { detail: false }));
          }}
          onEnded={() => {
            setPlaying(false);
            window.dispatchEvent(new CustomEvent("fruitbat:demo-playing", { detail: false }));
          }}
          onTimeUpdate={onTimeUpdate}
        />
      )}
      {track && (
        <ul class="demo-items" data-testid="demo-bullets" aria-label={t("a11y.bullet_list")}>
          {track.items.map((item, i) => (
            <li key={i} aria-current={i === activeIndex ? "true" : undefined}>
              {item.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
