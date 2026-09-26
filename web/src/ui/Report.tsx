// The bug-report modal (docs/PLAN.md S1-11, C7, C11): "Report a problem" (app.tsx, panel.bug_report)
// opens this behind a preview of *every* field the report will carry, per Non-negotiable 1 -- the
// user sees exactly what leaves the device before it does. `description` is component state only,
// never written to storage or the orchestrator (asserted by report.test.ts's localStorage check);
// report/build.ts's `buildReport` is the only thing that ever assembles the real envelope, this
// component just calls it and renders the result. Every label comes from spec/strings/en.json
// (CONTRIBUTING.md "Strings"); the structured preview itself is rendered from the report object,
// not from translated copy, the same way ui/Stats.tsx renders its raw column names.
import { useEffect, useRef, useState } from "preact/hooks";
import { events } from "../engine/events";
import { orchestrator } from "../engine/orchestrator";
import { buildCopyText, buildIssueUrl, buildReport, type BugReport } from "../report/build";
import * as stats from "../stats/store";
import { t } from "../strings";

export function Report({ onClose }: { onClose: () => void }) {
  const [base, setBase] = useState<BugReport | null>(null);
  const [description, setDescription] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const previewRef = useRef(null) as { current: HTMLPreElement | null };

  // Built once per open: the env/model probe is async (WebGPU adapter info) and doesn't need to
  // re-run on every keystroke in the description box below -- that field is overlaid locally.
  useEffect(() => {
    let cancelled = false;
    void buildReport({
      orchestratorStats: orchestrator().stats(),
      rows: stats.rows(),
      events: events(),
      description: "",
    }).then((r) => {
      if (!cancelled) setBase(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const report: BugReport | null = base ? { ...base, user_description: description.slice(0, 2000) } : null;

  const viewRef = useRef<HTMLDivElement>(null);
  // Opened from the header above a long article: bring it to the reader and move focus into it
  // (Codex review, PR #23).
  useEffect(() => {
    viewRef.current?.scrollIntoView({ block: "start" });
    viewRef.current?.focus();
  }, []);

  return (
    <div class="report-view" role="dialog" aria-label={t("report.title")} ref={viewRef} tabIndex={-1}>
      <div class="report-view-header">
        <h2>{t("report.title")}</h2>
        <button type="button" class="report-close" onClick={onClose}>
          {t("panel.close")}
        </button>
      </div>
      <p class="report-privacy-note">{t("report.privacy_note")}</p>
      <label class="report-describe-label" for="report-describe">
        {t("report.describe")}
      </label>
      <textarea
        id="report-describe"
        class="report-describe"
        value={description}
        onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
      />
      <p class="report-preview-intro">{t("report.preview_intro")}</p>
      <pre class="report-preview" data-testid="report-preview" ref={previewRef}>
        {report ? JSON.stringify(report, null, 2) : ""}
      </pre>
      <div class="report-actions">
        <button
          type="button"
          class="report-open-github"
          disabled={!report}
          onClick={() => {
            if (!report) return;
            // window.open's "noopener" feature is the window.open equivalent of an anchor's
            // rel="noopener" (docs/PLAN.md S1-11 v3): the opened tab gets no window.opener back.
            window.open(buildIssueUrl(report), "_blank", "noopener");
          }}
        >
          {t("report.open_github")}
        </button>
        <button
          type="button"
          class="report-copy"
          disabled={!report}
          onClick={() => {
            if (!report) return;
            // A denied clipboard (browser permission, embedding policy) says so and selects the
            // preview, so the report can still be copied by hand (Codex review, PR #23).
            // No Clipboard API at all (a plain-HTTP preview, an old browser) takes the same
            // "copy it by hand" path as a refused one (Codex review, PR #23).
            const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
            const write = clip ? clip.writeText(buildCopyText(report)) : Promise.reject(new Error("no clipboard"));
            void write.then(
              () => {
                setCopyFailed(false);
                setCopied(true);
              },
              () => {
                setCopied(false);
                setCopyFailed(true);
                const el = previewRef.current;
                const sel = typeof window !== "undefined" ? window.getSelection() : null;
                if (el && sel) {
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
              },
            );
          }}
        >
          <span aria-live="polite">{copyFailed ? t("report.copy_failed") : copied ? t("report.copied") : t("report.copy")}</span>
        </button>
      </div>
    </div>
  );
}
