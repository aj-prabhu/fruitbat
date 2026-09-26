// The Stats view (docs/PLAN.md S1-10, NICE): a plain table of the persisted RunStats rows behind
// the header's "Stats" button (app.tsx), plus Export CSV and Clear. Reads stats/store.ts directly
// (rows() is a snapshot, not a subscription: this view only needs to be fresh when it is opened
// or refreshed, not live during a run). Every label comes from spec/strings/en.json (S1-L0 owns
// the values; no string literal here per CONTRIBUTING.md "Strings").
import { useEffect, useRef, useState } from "preact/hooks";
import * as stats from "../stats/store";
import type { StatsRow } from "../stats/store";
import { t } from "../strings";

/** A readable subset of RunStats' 32 columns; exportCsv() (the download) still carries every
 *  column in bench/results.csv's order. */
const COLUMNS: (keyof StatsRow)[] = [
  "date",
  "level",
  "device",
  "dtype",
  "cache_state",
  "doc_id",
  "ttfa_ms",
  "tok_s",
  "rtf",
  "bullets_total",
  "bullets_cut",
];

/** Column headings come from spec/strings/en.json, never the raw field names (Codex review, PR #22). */
const COLUMN_LABEL: Record<string, string> = {
  date: "stats.col.date",
  level: "stats.col.level",
  device: "stats.col.device",
  dtype: "stats.col.dtype",
  cache_state: "stats.col.cache_state",
  doc_id: "stats.col.doc_id",
  ttfa_ms: "stats.col.ttfa_ms",
  tok_s: "stats.col.tok_s",
  rtf: "stats.col.rtf",
  bullets_total: "stats.col.bullets_total",
  bullets_cut: "stats.col.bullets_cut",
};

function downloadCsv(text: string): void {
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "fruitbat-stats.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function Stats({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<StatsRow[]>(() => stats.rows());
  const ref = useRef<HTMLDivElement>(null);
  // Opened from a button above a long article: bring the view to the reader and move focus into it,
  // so keyboard and screen-reader users land on it too (Codex review, PR #22).
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "start" });
    ref.current?.focus();
  }, []);

  return (
    <div class="stats-view" role="dialog" aria-label={t("stats.title")} ref={ref} tabIndex={-1}>
      <div class="stats-view-header">
        <h2>{t("stats.title")}</h2>
        <button type="button" class="stats-close" onClick={onClose}>
          {t("panel.close")}
        </button>
      </div>
      {rows.length === 0 ? (
        <p class="stats-empty">{t("stats.empty")}</p>
      ) : (
        <table class="stats-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c}>{t(COLUMN_LABEL[c])}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {COLUMNS.map((c) => (
                  <td key={c}>{row[c] === null ? "" : String(row[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div class="stats-actions">
        <button type="button" onClick={() => downloadCsv(stats.exportCsv())}>
          {t("stats.export")}
        </button>
        <button
          type="button"
          onClick={() => {
            stats.clear();
            setRows(stats.rows());
          }}
        >
          {t("stats.clear")}
        </button>
      </div>
    </div>
  );
}
