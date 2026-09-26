#!/usr/bin/env python3
"""bench/gate.py — the merge gate for docs/PLAN.md rule 3 ("No merge without a bench run").

Three modes:

    python3 bench/gate.py --self-test
        Runs 10 self-tests against the pure gating logic (no network, throwaway git
        repos under a temp dir). Prints "10/10 self-tests passed" and exits 0 when
        every test passes.

    python3 bench/gate.py --pr-head --base <sha> --head <sha> [--allow-baseline-reset] [--labels a,b]
        CI's bench-gate job. Finds rows in bench/results.csv whose commit is valid
        evidence for <head> (rule 3's row-validity rule), groups them by bench
        identity (bench/identity.md), takes the per-metric median of each group, and
        gates every group against bench/baselines.json. Prints a table and exits 1 on
        any failing group. With zero valid rows: the `bootstrap` label (from --labels,
        or GITHUB_EVENT_PATH's pull_request.labels when present) prints
        "bench-gate: runner not yet available (bootstrap)" and exits 0; without the
        label, exits 1. `--allow-baseline-reset` (the `baseline-reset` label) skips the
        regression-vs-baseline comparison for this PR's rows and replaces the stored
        baseline with their medians instead — the acceptance-table floors still apply.

    python3 bench/gate.py --release --commit <sha>
        The live/release gate (S1-16, scripts/release-check.sh). Same row-validity
        rule against <sha>, but with **no bootstrap exemption**: zero valid rows is an
        outright fail. Every valid group is checked against the acceptance-table
        floors only (no baseline comparison — a release must clear the absolute bar
        regardless of what a rolling baseline says).

Stdlib only (subprocess + git; no `jsonschema`, no network).
"""
import argparse
import csv
import datetime as dt
import json
import os
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NamedTuple

HERE = Path(__file__).resolve().parent
REPO_ROOT_FALLBACK = HERE.parent

# --- RunStats field order (bench/results.csv header, spec/schemas/run-stats.schema.json) ---
IDENTITY_FIELD_NAMES = [
    "target", "model_id", "model_rev", "dtype", "device",
    "browser", "browser_major", "os", "os_major", "machine_id", "cache_state",
    "doc_id", "level",
]
METRIC_FIELDS = [
    "ttfa_ms", "gen_ms", "tok_s", "rtf", "gap_ms", "stop_ms", "coverage",
    "bullets_total", "bullets_cut", "cut_rate", "facts_token_hit", "halluc_flags",
    "forbidden_hits", "oneline_keyword_hit", "tts_overlimit", "peak_mb", "heap_mb",
]
CSV_FIELDS = (
    ["schema_version", "target", "device", "level", "browser", "browser_major", "os", "os_major",
     "cache_state", "model_id", "model_rev", "dtype", "doc_id", "commit", "date", "machine_id"]
    + METRIC_FIELDS
)
INT_FIELDS = {"schema_version", "browser_major", "os_major", "bullets_total", "bullets_cut",
              "halluc_flags", "forbidden_hits", "tts_overlimit"}
FLOAT_FIELDS = {"ttfa_ms", "gen_ms", "tok_s", "rtf", "gap_ms", "stop_ms", "coverage", "cut_rate",
                "facts_token_hit", "oneline_keyword_hit", "peak_mb", "heap_mb"}

EVIDENCE_PATHSPEC = [
    ".", ":!bench/results.csv", ":!bench/baselines.json", ":!bench/graded/*",
    ":!docs/qa/privacy-requests-*.json",
]

# --- gate thresholds (docs/PLAN.md S0-05 packet text + KPI table) ---
TOK_S_FLOOR = {"web": 15, "mac": 40}
FACTS_TOKEN_HIT_FLOOR = {"short": 0.90, "caveman": 0.75, "oneline": 0.60}
ONELINE_KEYWORD_HIT_FLOOR = 0.80
STOP_MS_FLOOR = 200
PEAK_MB_FLOOR_MAC = 4096
FACTS_TOKEN_HIT_DELTA_PTS = 0.05  # "-5 pts"
TTFA_REGRESSION_FACTOR = 1.20     # "+20%"
TOK_S_REGRESSION_FACTOR = 0.85    # "-15%"
GAP_MS_REGRESSION_ABS = 50        # "+50ms"
PEAK_MB_REGRESSION_FACTOR = 1.25  # "+25%" (mac only)


class Identity(NamedTuple):
    target: str
    model_id: str
    model_rev: str
    dtype: str
    device: str
    browser: str
    browser_major: object
    os: str
    os_major: object
    machine_id: str
    cache_state: str
    doc_id: str
    level: str


def identity_of(d):
    return Identity(*(d[f] for f in IDENTITY_FIELD_NAMES))


def identity_str(identity):
    return "/".join(str(x) for x in identity)


# --------------------------------------------------------------------------------------
# CSV + baselines.json I/O
# --------------------------------------------------------------------------------------

def _parse_value(field, raw):
    if raw is None or raw == "":
        return None
    if field in INT_FIELDS:
        return int(raw)
    if field in FLOAT_FIELDS:
        return float(raw)
    return raw


def _row_problems(row):
    """Schema + finiteness check for one parsed row (Codex merge-gate review, PR #15)."""
    import math
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from schema_check import Validator  # noqa: E402  (sibling module, stdlib only)
    schema_path = REPO_ROOT_FALLBACK / "spec" / "schemas" / "run-stats.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    errors = []
    Validator(schema_path.parent).validate(row, schema, "$", schema, schema_path, errors)
    for k, v in row.items():
        if isinstance(v, float) and not math.isfinite(v):
            errors.append(f"$.{k}: not a finite number")
    return errors


def load_results_csv(path, strict=True):
    """Parsed rows from results.csv. With strict=True (the default) a row that fails the RunStats
    schema or carries a non-finite number is dropped and reported on stderr, so it can never be
    aggregated or gated."""
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = [{f: _parse_value(f, raw.get(f)) for f in CSV_FIELDS} for raw in reader]
    if not strict:
        return rows
    kept = []
    for i, row in enumerate(rows, start=2):
        errs = _row_problems(row)
        if errs:
            print(f"bench-gate: results.csv line {i} rejected: {'; '.join(errs[:3])}", file=sys.stderr)
            MALFORMED_ROWS.append(i)
        else:
            kept.append(row)
    return kept


# Line numbers of rows load_results_csv() rejected. Any entry fails --pr-head and --release: the
# runner validates before appending, so a malformed row is a bug or an edit, never noise
# (Codex merge-gate review, PR #15).
MALFORMED_ROWS = []


def load_baselines(path):
    if not path.exists():
        return {"version": 1, "baselines": []}
    return json.loads(path.read_text(encoding="utf-8"))


def load_baselines_at(repo_root, rev):
    """bench/baselines.json as it is at `rev` (empty set if the file did not exist there)."""
    out = subprocess.run(["git", "-C", str(repo_root), "show", f"{rev}:bench/baselines.json"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        return {"version": 1, "baselines": []}
    return json.loads(out.stdout)


def save_baselines(path, data):
    path.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def find_baseline(baselines, identity):
    for entry in baselines.get("baselines", []):
        if identity_of(entry) == identity:
            return entry
    return None


def upsert_baseline(baselines, identity, medians, commit):
    entry = {
        "schema_version": 1,
        **identity._asdict(),
        "commit": commit,
        "date": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **medians,
    }
    lst = baselines.setdefault("baselines", [])
    for i, existing in enumerate(lst):
        if identity_of(existing) == identity:
            lst[i] = entry
            return
    lst.append(entry)


def group_rows_by_identity(rows):
    groups = {}
    for row in rows:
        groups.setdefault(identity_of(row), []).append(row)
    return groups


# Zero-tolerance counters: one bad rep is a failure, so they aggregate by the worst rep, not the
# median (Codex merge-gate review, PR #15: [0, 0, 1] halluc_flags must not pass as 0).
WORST_REP_FIELDS = {"halluc_flags", "forbidden_hits", "tts_overlimit"}
# Coverage must be 100 % on every rep: its worst rep is the minimum (Codex merge-gate review, PR #15).
WORST_REP_MIN_FIELDS = {"coverage"}


def compute_medians(rows):
    out = {}
    for field in METRIC_FIELDS:
        values = [r[field] for r in rows if r.get(field) is not None]
        if not values:
            out[field] = None
        elif field in WORST_REP_FIELDS:
            out[field] = max(values)
        elif field in WORST_REP_MIN_FIELDS:
            out[field] = min(values)
        else:
            out[field] = statistics.median(values)
    return out


def rep_problems(rows, target, level):
    """Every repetition must carry every required metric: a median over the reps that happen to
    have a number would hide the reps that don't (Codex merge-gate review, PR #15)."""
    required = list(REQUIRED_METRICS.get(level, []))
    if target == "mac":
        required.append("peak_mb")
    out = []
    for field in required:
        missing = sum(1 for r in rows if r.get(field) is None)
        if missing:
            out.append(f"{field} missing in {missing} of {len(rows)} reps")
    return out


# --------------------------------------------------------------------------------------
# Row-validity / evidence rule (docs/PLAN.md rule 3; scripts/release-check.sh mirrors this)
# --------------------------------------------------------------------------------------

def _git(repo_root, *args):
    return subprocess.run(
        ["git", *args], cwd=repo_root, capture_output=True, text=True
    )


def is_valid_row(row_commit, target_commit, repo_root):
    """A row is valid evidence for `target_commit` when its commit is an ancestor of it
    and nothing but evidence files changed since (rule 3)."""
    if not row_commit:
        return False
    rev = _git(repo_root, "rev-parse", "--verify", "-q", f"{row_commit}^{{commit}}")
    if rev.returncode != 0:
        return False
    anc = _git(repo_root, "merge-base", "--is-ancestor", row_commit, target_commit)
    if anc.returncode != 0:
        return False
    diff = _git(repo_root, "diff", "--quiet", row_commit, target_commit, "--", *EVIDENCE_PATHSPEC)
    return diff.returncode == 0


def read_labels(labels_arg):
    labels = set()
    if labels_arg:
        labels |= {s.strip() for s in labels_arg.split(",") if s.strip()}
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if event_path and os.path.exists(event_path):
        try:
            event = json.loads(Path(event_path).read_text(encoding="utf-8"))
            for label in event.get("pull_request", {}).get("labels", []):
                name = label.get("name")
                if name:
                    labels.add(name)
        except (json.JSONDecodeError, OSError):
            pass
    return labels


# --------------------------------------------------------------------------------------
# Gating: absolute floors (acceptance table) + deltas vs baseline (regression)
# --------------------------------------------------------------------------------------

def _ttfa_floor_ms(target, level, cache_state):
    if cache_state == "cold":
        return 90000 if target == "web" else None  # cold budget is only specified for web
    if level == "readall":
        return 3000 if target == "web" else 1500
    return 8000 if target == "web" else 4000


# Measurements a row must carry for its level; a blank one is not "not applicable", it is
# a missing measurement and fails the gate (Codex review, PR #15).
REQUIRED_METRICS = {
    "readall": ["ttfa_ms", "rtf", "stop_ms", "coverage", "tts_overlimit"],
    "short": ["ttfa_ms", "gen_ms", "tok_s", "stop_ms", "bullets_total", "bullets_cut", "cut_rate",
              "facts_token_hit", "halluc_flags", "forbidden_hits"],
    "caveman": ["ttfa_ms", "gen_ms", "tok_s", "stop_ms", "bullets_total", "bullets_cut", "cut_rate",
                "facts_token_hit", "halluc_flags", "forbidden_hits"],
    "oneline": ["ttfa_ms", "gen_ms", "tok_s", "stop_ms", "bullets_total", "bullets_cut", "cut_rate",
                "facts_token_hit", "halluc_flags", "forbidden_hits", "oneline_keyword_hit"],
}


def evaluate_floors(target, level, cache_state, m):
    """Absolute product-requirement checks from the Stage 1 acceptance table. These
    apply regardless of baseline / baseline-reset — a release can't ship below them
    just because the environment "legitimately changed"."""
    fails = []

    required = list(REQUIRED_METRICS.get(level, []))
    if target == "mac":
        required.append("peak_mb")  # the Mac memory ceiling is a gate, so the number must be there (Codex merge-gate review, PR #15)
    for field in required:
        if m.get(field) is None:
            fails.append(f"{field} missing: required for level {level}")

    ttfa_floor = _ttfa_floor_ms(target, level, cache_state)
    if ttfa_floor is not None and m.get("ttfa_ms") is not None and m["ttfa_ms"] > ttfa_floor:
        fails.append(f"ttfa_ms {m['ttfa_ms']} exceeds floor {ttfa_floor}ms ({target}/{level}/{cache_state})")

    tok_floor = TOK_S_FLOOR.get(target)
    if tok_floor is not None and m.get("tok_s") is not None and m["tok_s"] < tok_floor:
        fails.append(f"tok_s {m['tok_s']} below floor {tok_floor} ({target})")

    if level in FACTS_TOKEN_HIT_FLOOR and m.get("facts_token_hit") is not None:
        floor = FACTS_TOKEN_HIT_FLOOR[level]
        if m["facts_token_hit"] < floor:
            fails.append(f"facts_token_hit {m['facts_token_hit']} below floor {floor} ({level})")

    if level == "oneline" and m.get("oneline_keyword_hit") is not None:
        if m["oneline_keyword_hit"] < ONELINE_KEYWORD_HIT_FLOOR:
            fails.append(f"oneline_keyword_hit {m['oneline_keyword_hit']} below floor {ONELINE_KEYWORD_HIT_FLOOR}")

    if m.get("halluc_flags") is not None and m["halluc_flags"] > 0:
        fails.append(f"halluc_flags {m['halluc_flags']} > 0")

    if m.get("forbidden_hits") is not None and m["forbidden_hits"] > 0:
        fails.append(f"forbidden_hits {m['forbidden_hits']} > 0")

    if m.get("stop_ms") is not None and m["stop_ms"] > STOP_MS_FLOOR:
        fails.append(f"stop_ms {m['stop_ms']} exceeds floor {STOP_MS_FLOOR}ms")

    if level == "readall":
        if m.get("coverage") is not None and m["coverage"] < 1.0:  # the requirement is 100 % (Codex merge-gate review, PR #15)
            fails.append(f"coverage {m['coverage']} below 1.0 floor (readall)")
        if m.get("tts_overlimit") is not None and m["tts_overlimit"] > 0:
            fails.append(f"tts_overlimit {m['tts_overlimit']} > 0 (readall)")

    if target == "mac" and m.get("peak_mb") is not None and m["peak_mb"] > PEAK_MB_FLOOR_MAC:
        fails.append(f"peak_mb {m['peak_mb']} exceeds floor {PEAK_MB_FLOOR_MAC}MB (mac)")

    return fails


def evaluate_deltas(target, m, b):
    """Regression-vs-baseline checks: docs/PLAN.md S0-05 packet text, verbatim list."""
    fails = []

    # A metric the baseline measured must still be measured: a blank current value would otherwise
    # skip its regression check silently (Codex merge-gate review, PR #15).
    for field in METRIC_FIELDS:
        if b.get(field) is not None and m.get(field) is None:
            fails.append(f"{field} missing (the baseline has {b[field]})")

    if m.get("ttfa_ms") is not None and b.get("ttfa_ms") is not None:
        limit = b["ttfa_ms"] * TTFA_REGRESSION_FACTOR
        if m["ttfa_ms"] > limit:
            fails.append(f"ttfa_ms regressed: {m['ttfa_ms']} > baseline {b['ttfa_ms']} * 1.20 = {limit:.1f}")

    if m.get("tok_s") is not None and b.get("tok_s") is not None:
        limit = b["tok_s"] * TOK_S_REGRESSION_FACTOR
        if m["tok_s"] < limit:
            fails.append(f"tok_s regressed: {m['tok_s']} < baseline {b['tok_s']} * 0.85 = {limit:.2f}")

    if m.get("facts_token_hit") is not None and b.get("facts_token_hit") is not None:
        drop = b["facts_token_hit"] - m["facts_token_hit"]
        if drop >= FACTS_TOKEN_HIT_DELTA_PTS - 1e-9:  # 0.95 - 0.90 is 0.04999...; inclusive threshold (Codex review, PR #15)
            fails.append(f"facts_token_hit dropped {b['facts_token_hit']} -> {m['facts_token_hit']} (>= 5 pts)")

    if m.get("halluc_flags") is not None and b.get("halluc_flags") is not None:
        if m["halluc_flags"] > b["halluc_flags"]:
            fails.append(f"halluc_flags increased: {b['halluc_flags']} -> {m['halluc_flags']}")

    if m.get("forbidden_hits") is not None and b.get("forbidden_hits") is not None:
        if m["forbidden_hits"] > b["forbidden_hits"]:
            fails.append(f"forbidden_hits increased: {b['forbidden_hits']} -> {m['forbidden_hits']}")

    if m.get("gap_ms") is not None and b.get("gap_ms") is not None:
        limit = b["gap_ms"] + GAP_MS_REGRESSION_ABS
        if m["gap_ms"] > limit:
            fails.append(f"gap_ms regressed: {m['gap_ms']} > baseline {b['gap_ms']} + 50 = {limit}")

    if target == "mac" and m.get("peak_mb") is not None and b.get("peak_mb") is not None:
        limit = b["peak_mb"] * PEAK_MB_REGRESSION_FACTOR
        if m["peak_mb"] > limit:
            fails.append(f"peak_mb regressed: {m['peak_mb']} > baseline {b['peak_mb']} * 1.25 = {limit:.1f}")

    return fails


def gate_identity(identity, medians, baseline, allow_reset):
    """Returns (passed, reasons, new_baseline_metrics_or_None)."""
    floor_fails = evaluate_floors(identity.target, identity.level, identity.cache_state, medians)

    if baseline is None:
        if not allow_reset:
            reasons = ["no baseline for this identity — add via a bench/baselines.json PR"] + floor_fails
            return False, reasons, None  # missing baseline is always a fail, floor or not
        passed = len(floor_fails) == 0
        return passed, floor_fails or ["no prior baseline; recording as the new baseline (baseline-reset)"], (
            medians if passed else None
        )

    if allow_reset:
        passed = len(floor_fails) == 0
        reasons = floor_fails or ["baseline replaced (baseline-reset)"]
        return passed, reasons, (medians if passed else None)

    delta_fails = evaluate_deltas(identity.target, medians, baseline)
    fails = floor_fails + delta_fails
    return len(fails) == 0, fails, None


# --------------------------------------------------------------------------------------
# pr-head / release: table building shared by the CLI and the self-tests
# --------------------------------------------------------------------------------------

def gate_groups(groups, baselines, allow_reset):
    """Runs gate_identity over every identity group. Returns (all_pass, lines, updates)
    where `updates` is a list of (identity, medians) to persist when allow_reset."""
    all_pass = True
    lines = ["status | identity | detail"]
    updates = []
    for identity, rows in sorted(groups.items(), key=lambda kv: identity_str(kv[0])):
        medians = compute_medians(rows)
        baseline = find_baseline(baselines, identity)
        passed, reasons, new_metrics = gate_identity(identity, medians, baseline, allow_reset)
        rep_fails = rep_problems(rows, identity.target, identity.level)
        if rep_fails:
            passed, reasons, new_metrics = False, rep_fails + list(reasons), None
        status = "PASS" if passed else "FAIL"
        if not passed:
            all_pass = False
        lines.append(f"{status} | {identity_str(identity)} | {'; '.join(reasons) if reasons else 'ok'}")
        if new_metrics is not None:
            updates.append((identity, new_metrics))
    return all_pass, lines, updates


def pr_head_logic(valid_rows, baselines, labels, allow_reset, head_commit="HEAD"):
    """Pure core of --pr-head. Returns (exit_code, output_lines, baseline_updates)."""
    if not valid_rows:
        if "bootstrap" in labels:
            return 0, ["bench-gate: runner not yet available (bootstrap)"], []
        return 1, ["bench-gate: no valid bench rows for this PR and no bootstrap label"], []

    groups = group_rows_by_identity(valid_rows)
    all_pass, lines, updates = gate_groups(groups, baselines, allow_reset)
    if updates:
        for identity, medians in updates:
            upsert_baseline(baselines, identity, medians, head_commit)
        lines.append(f"bench-gate: baselines.json updated ({len(updates)} identities, baseline-reset)")
    return (0 if all_pass else 1), lines, updates


def release_logic(valid_rows):
    """Pure core of --release: no bootstrap exemption, floors only, no baseline lookup."""
    if not valid_rows:
        return 1, ["bench-gate --release: no bench rows are valid evidence for this commit "
                    "(no bootstrap exemption for release)"]
    groups = group_rows_by_identity(valid_rows)
    all_pass = True
    lines = ["status | identity | detail"]
    for identity, rows in sorted(groups.items(), key=lambda kv: identity_str(kv[0])):
        medians = compute_medians(rows)
        fails = rep_problems(rows, identity.target, identity.level) + evaluate_floors(identity.target, identity.level, identity.cache_state, medians)
        status = "PASS" if not fails else "FAIL"
        if fails:
            all_pass = False
        lines.append(f"{status} | {identity_str(identity)} | {'; '.join(fails) if fails else 'ok'}")
    return (0 if all_pass else 1), lines


# --------------------------------------------------------------------------------------
# CLI commands (thin wrappers around the pure logic above)
# --------------------------------------------------------------------------------------

def cmd_pr_head(args):
    repo_root = REPO_ROOT_FALLBACK
    rows = load_results_csv(repo_root / "bench" / "results.csv")
    valid_rows = [r for r in rows if is_valid_row(r.get("commit"), args.head, repo_root)]
    labels = read_labels(args.labels)
    allow_reset = bool(args.allow_baseline_reset) or ("baseline-reset" in labels)  # label or flag (Codex review, PR #15)
    # The approved baselines are the base revision's: a PR that edits bench/baselines.json alongside
    # its rows must not grade itself against its own numbers. Only `baseline-reset` may replace them
    # (Codex merge-gate review, PR #15).
    baselines = load_baselines_at(repo_root, args.base) if args.base else load_baselines(repo_root / "bench" / "baselines.json")
    exit_code, lines, updates = pr_head_logic(valid_rows, baselines, labels, allow_reset, args.head)
    if MALFORMED_ROWS:
        exit_code, updates = 1, []
        lines.append(f"FAIL | results.csv | {len(MALFORMED_ROWS)} malformed row(s) at line(s) {MALFORMED_ROWS[:10]}")
    print("\n".join(lines))
    if updates:
        save_baselines(repo_root / "bench" / "baselines.json", baselines)
    return exit_code


def cmd_release(args):
    repo_root = REPO_ROOT_FALLBACK
    commit = _git(repo_root, "rev-parse", args.commit).stdout.strip() or args.commit
    rows = load_results_csv(repo_root / "bench" / "results.csv")
    valid_rows = [r for r in rows if is_valid_row(r.get("commit"), commit, repo_root)]
    exit_code, lines = release_logic(valid_rows)
    if MALFORMED_ROWS:
        exit_code = 1
        lines.append(f"FAIL | results.csv | {len(MALFORMED_ROWS)} malformed row(s) at line(s) {MALFORMED_ROWS[:10]}")
    print("\n".join(lines))
    return exit_code


# --------------------------------------------------------------------------------------
# Self-tests
# --------------------------------------------------------------------------------------

def _good_medians(**overrides):
    m = {
        "ttfa_ms": 5000, "gen_ms": 3000, "tok_s": 20, "rtf": 1.4, "gap_ms": 80, "stop_ms": 120,
        "coverage": None, "bullets_total": 5, "bullets_cut": 0, "cut_rate": 0.0,
        "facts_token_hit": 0.95, "halluc_flags": 0, "forbidden_hits": 0, "oneline_keyword_hit": None,
        "tts_overlimit": 0, "peak_mb": 500, "heap_mb": 300,
    }
    m.update(overrides)
    return m


WEB_SHORT_IDENTITY = Identity(
    target="web", model_id="onnx-community/Qwen3.5-0.8B-Text-ONNX",
    model_rev="1e45daba048899e7f771657ada617ec49350aa91", dtype="q4f16", device="webgpu",
    browser="chrome", browser_major=130, os="macos", os_major=15, machine_id="web",
    cache_state="warm", doc_id="011", level="short",
)


def _init_test_repo(tmpdir):
    repo = Path(tmpdir) / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    return repo


def _commit(repo, filename, content, message):
    path = repo / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    _git(repo, "add", filename)
    _git(repo, "commit", "-q", "-m", message)
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


def test_regression_ttfa_fails():
    baseline = {**WEB_SHORT_IDENTITY._asdict(), **_good_medians()}
    medians = _good_medians(ttfa_ms=5000 * 1.25)  # +25%, over the +20% allowance
    passed, reasons, _ = gate_identity(WEB_SHORT_IDENTITY, medians, baseline, allow_reset=False)
    ok = (not passed) and any("ttfa_ms" in r for r in reasons)
    return ok, f"passed={passed} reasons={reasons}"


def test_improvement_passes():
    baseline = {**WEB_SHORT_IDENTITY._asdict(), **_good_medians()}
    medians = _good_medians(ttfa_ms=4000, tok_s=25)
    passed, reasons, _ = gate_identity(WEB_SHORT_IDENTITY, medians, baseline, allow_reset=False)
    return passed, f"passed={passed} reasons={reasons}"


def test_missing_baseline_and_wrong_identity():
    baselines = {"version": 1, "baselines": []}
    upsert_baseline(baselines, WEB_SHORT_IDENTITY, _good_medians(), commit="aaaaaaa")
    other_identity = WEB_SHORT_IDENTITY._replace(doc_id="020")
    baseline = find_baseline(baselines, other_identity)
    if baseline is not None:
        return False, "wrong-identity lookup incorrectly matched a baseline for a different doc_id"
    medians = _good_medians()
    passed, reasons, _ = gate_identity(other_identity, medians, baseline, allow_reset=False)
    ok = (not passed) and any("add via a bench/baselines.json PR" in r for r in reasons)
    same_identity_still_present = find_baseline(baselines, WEB_SHORT_IDENTITY) is not None
    return ok and same_identity_still_present, f"passed={passed} reasons={reasons}"


def test_floor_breach():
    baseline = {**WEB_SHORT_IDENTITY._asdict(), **_good_medians(tok_s=10)}  # baseline itself is bad
    medians = _good_medians(tok_s=10)  # identical to baseline: no regression, but floor breach
    passed, reasons, _ = gate_identity(WEB_SHORT_IDENTITY, medians, baseline, allow_reset=False)
    ok = (not passed) and any("tok_s" in r and "floor" in r for r in reasons) and _worst_rep_check()
    # A row with every metric blank must fail too, not slide past every skip (Codex review, PR #15).
    blank = {k: None for k in _good_medians()}
    passed_blank, reasons_blank, _ = gate_identity(WEB_SHORT_IDENTITY, blank, baseline, allow_reset=False)
    ok = ok and (not passed_blank) and any("missing" in r for r in reasons_blank)
    # Inclusive five-point threshold survives float rounding.
    passed_rt, reasons_rt, _ = gate_identity(
        WEB_SHORT_IDENTITY, _good_medians(facts_token_hit=0.90),
        {**WEB_SHORT_IDENTITY._asdict(), **_good_medians(facts_token_hit=0.95)}, allow_reset=False)
    ok = ok and (not passed_rt) and any("facts_token_hit dropped" in r for r in reasons_rt)
    return ok, f"passed={passed} blank={passed_blank} rounding={passed_rt} reasons={reasons}"


def _worst_rep_check():
    m = compute_medians([{**_good_medians(halluc_flags=0)}, {**_good_medians(halluc_flags=0)}, {**_good_medians(halluc_flags=1)}])
    return m["halluc_flags"] == 1


def test_nullable_readall_skips_llm_gates():
    identity = WEB_SHORT_IDENTITY._replace(level="readall")
    medians = {
        "ttfa_ms": 2000, "gen_ms": None, "tok_s": None, "rtf": 1.2, "gap_ms": 80, "stop_ms": 100,
        "coverage": 1.0, "bullets_total": None, "bullets_cut": None, "cut_rate": None,
        "facts_token_hit": None, "halluc_flags": None, "forbidden_hits": None,
        "oneline_keyword_hit": None, "tts_overlimit": 0, "peak_mb": 400, "heap_mb": 250,
    }
    passed, reasons, _ = gate_identity(identity, medians, baseline=None, allow_reset=True)
    return passed, f"passed={passed} reasons={reasons}"


def test_row_validity_valid():
    with tempfile.TemporaryDirectory() as tmp:
        repo = _init_test_repo(tmp)
        c1 = _commit(repo, "web/src/x.ts", "export const x = 1;\n", "add source")
        c2 = _commit(repo, "bench/results.csv", "commit,target\n" + c1 + ",web\n", "append row")
        ok = is_valid_row(c1, c2, repo)
        return ok, f"is_valid_row(c1, c2)={ok}, expected True"


def test_row_validity_invalid_source_changed():
    with tempfile.TemporaryDirectory() as tmp:
        repo = _init_test_repo(tmp)
        c1 = _commit(repo, "web/src/x.ts", "export const x = 1;\n", "add source")
        _commit(repo, "bench/results.csv", "commit,target\n" + c1 + ",web\n", "append row")
        c3 = _commit(repo, "web/src/x.ts", "export const x = 2;\n", "change source after the row")
        ok = not is_valid_row(c1, c3, repo)
        return ok, f"is_valid_row(c1, c3)={not ok}, expected False (source changed)"


def test_row_validity_bootstrap():
    exit_code, lines, _ = pr_head_logic([], {"version": 1, "baselines": []}, {"bootstrap"}, False)
    ok = exit_code == 0 and any("runner not yet available (bootstrap)" in l for l in lines)
    return ok, f"exit={exit_code} lines={lines}"


def test_baseline_reset_replaces_baseline():
    baselines = {"version": 1, "baselines": []}
    upsert_baseline(baselines, WEB_SHORT_IDENTITY, _good_medians(ttfa_ms=5000), commit="aaaaaaa")
    new_medians = _good_medians(ttfa_ms=8000)  # would fail a normal regression check (+60%)
    exit_code, lines, updates = pr_head_logic(
        [{"commit": "bbbbbbb", **WEB_SHORT_IDENTITY._asdict(), **new_medians}],
        baselines, labels=set(), allow_reset=True, head_commit="bbbbbbb",
    )
    replaced = find_baseline(baselines, WEB_SHORT_IDENTITY)
    ok = (
        exit_code == 0
        and len(updates) == 1
        and replaced is not None
        and replaced["ttfa_ms"] == 8000
    )
    return ok, f"exit={exit_code} replaced_ttfa_ms={replaced.get('ttfa_ms') if replaced else None}"


def test_release_evidence_rule():
    with tempfile.TemporaryDirectory() as tmp:
        repo = _init_test_repo(tmp)
        c1 = _commit(repo, "web/src/x.ts", "export const x = 1;\n", "add source")
        c2 = _commit(repo, "bench/results.csv", "commit,target\n" + c1 + ",web\n", "append row")
        c3 = _commit(repo, "web/src/x.ts", "export const x = 2;\n", "change source after the row")

        # (a) release commit == c3: the only row's evidence (c1) is stale -> no bootstrap
        # exemption, must fail outright.
        valid_for_c3 = [r for r in [{"commit": c1}] if is_valid_row(r["commit"], c3, repo)]
        exit_a, lines_a = release_logic(valid_for_c3)
        ok_a = exit_a == 1 and "no bench rows are valid evidence" in lines_a[0]

        # (b) release commit == c2: the row's evidence is valid, and its (good) medians
        # clear the floors -> pass, with no baseline involved at all.
        row = {"commit": c1, **WEB_SHORT_IDENTITY._asdict(), **_good_medians()}
        valid_for_c2 = [r for r in [row] if is_valid_row(r["commit"], c2, repo)]
        exit_b, lines_b = release_logic(valid_for_c2)
        ok_b = exit_b == 0

        ok = ok_a and ok_b
        return ok, f"release(c3)={exit_a}/{lines_a}; release(c2)={exit_b}/{lines_b}"


SELF_TESTS = [
    ("regression_ttfa_fails", test_regression_ttfa_fails),
    ("improvement_passes", test_improvement_passes),
    ("missing_baseline_and_wrong_identity", test_missing_baseline_and_wrong_identity),
    ("floor_breach", test_floor_breach),
    ("nullable_readall_skips_llm_gates", test_nullable_readall_skips_llm_gates),
    ("row_validity_valid", test_row_validity_valid),
    ("row_validity_invalid_source_changed", test_row_validity_invalid_source_changed),
    ("row_validity_bootstrap", test_row_validity_bootstrap),
    ("baseline_reset_replaces_baseline", test_baseline_reset_replaces_baseline),
    ("release_evidence_rule", test_release_evidence_rule),
]


def run_self_tests():
    passed_count = 0
    failures = []
    for name, fn in SELF_TESTS:
        try:
            ok, detail = fn()
        except Exception as e:  # a broken test should not crash the whole run
            ok, detail = False, f"raised {type(e).__name__}: {e}"
        if ok:
            passed_count += 1
        else:
            failures.append(f"FAIL {name}: {detail}")

    for line in failures:
        print(line)
    total = len(SELF_TESTS)
    print(f"{passed_count}/{total} self-tests passed")
    return 0 if passed_count == total else 1


# --------------------------------------------------------------------------------------

def build_arg_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--self-test", action="store_true")
    mode.add_argument("--pr-head", action="store_true")
    mode.add_argument("--release", action="store_true")
    ap.add_argument("--base", help="--pr-head: base sha (accepted for CI symmetry; row validity only needs --head)")
    ap.add_argument("--head", help="--pr-head: head sha")
    ap.add_argument("--commit", help="--release: commit sha")
    ap.add_argument("--allow-baseline-reset", action="store_true")
    ap.add_argument("--labels", default="", help="comma-separated PR labels (else read from GITHUB_EVENT_PATH)")
    return ap


def main():
    args = build_arg_parser().parse_args()

    if args.self_test:
        sys.exit(run_self_tests())

    if args.pr_head:
        if not args.head:
            print("--pr-head requires --head", file=sys.stderr)
            sys.exit(2)
        sys.exit(cmd_pr_head(args))

    if args.release:
        if not args.commit:
            print("--release requires --commit", file=sys.stderr)
            sys.exit(2)
        sys.exit(cmd_release(args))


if __name__ == "__main__":
    main()
