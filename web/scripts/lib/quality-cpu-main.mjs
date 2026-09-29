// The real work behind scripts/quality-cpu.mjs. Only ever run through that re-exec shim (it needs
// --experimental-transform-types + the ts-resolve-loader hook, like make-demo).
//
// Runs the production summarize path from web/src/core (segmentSentences → chunkSentences with the
// pinned tokenizer → prompt from spec/dial.json → BulletParser caps → grounding v3, and the One-line
// per-chunk + reduce policy of engine/llm.ts) against the pinned summarizer on CPU (cpu_tryout
// dtype, q4 by default), then measures what the bench cannot see on its own:
//   facts_token_hit, halluc_flags, oneline_keyword_hit   bench/score.py on the kept output
//   compression      kept bullet words / source words of the chunks summarized
//   tail_hit         share of chunks with a kept bullet whose best-matching source sentence starts
//                    in the chunk's last third
//   tail_facts       key facts located in the last third of their chunk that the output hits
//   copy_rate        share of kept bullets with >= 80 % of their tokens in one source sentence
//   verbatim_rate    share of kept bullets whose longest contiguous run shared with one source
//                    sentence is >= 80 % of the bullet (a copied clause, not a compression)
//   cut_rate         grounding cuts / bullets parsed
// CPU q4 is not the browser's WebGPU q4f16: numerics differ slightly, so greedy outputs can too.
//
//   node scripts/quality-cpu.mjs --docs 005,011,/path/megabat.txt --levels short,caveman,oneline --out /tmp/q --tag before
// A doc is a corpus id (spec/eval/corpus/<id>.txt + .facts.json) or a path to a .txt whose
// .facts.json sits next to it. --spec <dir> points at an alternate spec folder (dial.json +
// prompts/) for prompt experiments; the default is this checkout's spec/. Experiment switches:
// --part-tokens N (override part_tokens for Short/Caveman), --gen '{"repetition_penalty":1.1}'
// (extra generate() options), --system <file> (a system message), --think true (thinking on).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutoModelForCausalLM, AutoTokenizer, env } from "@huggingface/transformers";
import { segmentSentences, chunkSentences, BulletParser, ground, COMMON_WORDS, countTokensWith, partCount, splitParts } from "../../src/core/index.ts";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ROOT = here("../../../");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);
const SPEC = path.resolve(args.spec ?? path.join(ROOT, "spec"));
const dial = JSON.parse(readFileSync(path.join(SPEC, "dial.json"), "utf8"));
const models = JSON.parse(readFileSync(path.join(ROOT, "spec/models.json"), "utf8"));
const SUMMARIZER = models.web.summarizer;
const dtype = args.dtype ?? SUMMARIZER.cpu_tryout.dtype;
const docs = (args.docs ?? "005,011,013,020,025,028").split(",");
const levels = (args.levels ?? "short,caveman,oneline").split(",");
const outDir = path.resolve(args.out ?? "/tmp/fruitbat-quality");
const tag = args.tag ?? "run";
const maxChunks = args["max-chunks"] ? Number(args["max-chunks"]) : Infinity;
const extraGen = args.gen ? JSON.parse(args.gen) : {};
const BUDGET = { chunk_input_tokens: 1600, max_chunks: 100 }; // spec/chunking.md, as engine/llm.ts
mkdirSync(outDir, { recursive: true });

env.cacheDir = process.env.FRUITBAT_HF_CACHE ?? here("../../.cache/hf/");
env.allowLocalModels = false;
env.allowRemoteModels = true;
{
  const base = globalThis.fetch;
  env.fetch = (input, init) => base(String(input).replace(`/${SUMMARIZER.id}/resolve/main/`, `/${SUMMARIZER.id}/resolve/${SUMMARIZER.revision}/`), init);
}

const PROMPTS = {};
for (const l of dial.levels) {
  if (l.prompt) PROMPTS[l.prompt] = readFileSync(path.join(SPEC, l.prompt), "utf8");
  if (l.reduce_prompt) PROMPTS[l.reduce_prompt] = readFileSync(path.join(SPEC, l.reduce_prompt), "utf8");
}
const levelCfg = (id) => {
  const l = { max_bullets_per_chunk: 6, max_words_per_bullet: 18, max_new_tokens: 220, ...dial.levels.find((x) => x.id === id) };
  if (args["part-tokens"] && id !== "oneline") l.part_tokens = Number(args["part-tokens"]);
  return l;
};

// ------------------------------------------------------------------------------------------------
// text helpers
// ------------------------------------------------------------------------------------------------
const STOP = new Set(
  "the a an of to in on and or is was were be been being that this these those it its at by for with as from has have had which who whom not no but than then so their they he she we you i are will would can could should may might about into over under more most less least each every other such only just also when where while because if do does did there here them his her him our your some all any per up out off".split(" "),
);
const toks = (s) => s.toLowerCase().match(/[a-z0-9]+(?:['.][a-z0-9]+)*/g) ?? [];
const content = (ts) => ts.filter((t) => t.length >= 3 && !STOP.has(t));
const words = (s) => s.split(/\s+/).filter(Boolean).length;

function bagPrecision(b, s) {
  if (b.length === 0) return 0;
  const m = new Map();
  for (const t of s) m.set(t, (m.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of b) {
    const n = m.get(t) ?? 0;
    if (n > 0) {
      hit++;
      m.set(t, n - 1);
    }
  }
  return hit / b.length;
}
function longestRun(b, s) {
  let best = 0;
  const prev = new Array(s.length + 1).fill(0);
  for (let i = 1; i <= b.length; i++) {
    let diag = 0;
    for (let j = 1; j <= s.length; j++) {
      const tmp = prev[j];
      prev[j] = b[i - 1] === s[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}
function f1(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  if (inter === 0) return 0;
  const p = inter / A.size;
  const r = inter / B.size;
  return (2 * p * r) / (p + r);
}
/** Per bullet: best-matching segment of its chunk (content-token F1), copy and verbatim flags. */
function analyseBullet(text, chunk) {
  const bt = toks(text);
  const bc = content(bt);
  let bestIdx = -1;
  let bestF = 0;
  let maxPrec = 0;
  let maxRun = 0;
  chunk.segments.forEach((seg, i) => {
    const st = toks(seg.text);
    const f = f1(bc, content(st));
    if (f > bestF) {
      bestF = f;
      bestIdx = i;
    }
    maxPrec = Math.max(maxPrec, bagPrecision(bt, st));
    maxRun = Math.max(maxRun, bt.length ? longestRun(bt, st) / bt.length : 0);
  });
  const seg = bestIdx >= 0 ? chunk.segments[bestIdx] : null;
  const pos = seg ? (seg.start - chunk.start) / Math.max(1, chunk.end - chunk.start) : null;
  return { seg: bestIdx, pos, copy: maxPrec >= 0.8, verbatim: maxRun >= 0.8, prec: +maxPrec.toFixed(2), run: +maxRun.toFixed(2) };
}

function score(docId, corpusDir, level, output) {
  const f = path.join(outDir, `.score-${process.pid}.txt`);
  writeFileSync(f, output.trim() ? output : "-\n");
  const r = spawnSync("python3", [path.join(ROOT, "bench/score.py"), "--doc", docId, "--level", level, "--output", f, "--corpus-dir", corpusDir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`score.py: ${r.stderr}`);
  const pf = spawnSync("python3", ["-c", PERFACT, path.join(ROOT, "bench"), path.join(corpusDir, `${docId}.facts.json`), f], { encoding: "utf8" });
  if (pf.status !== 0) throw new Error(`perfact: ${pf.stderr}`);
  return { ...JSON.parse(r.stdout), per_fact: JSON.parse(pf.stdout) };
}
const PERFACT = `
import json, sys
sys.path.insert(0, sys.argv[1])
import score
facts = json.load(open(sys.argv[2]))["key_facts"]
out = open(sys.argv[3]).read()
nums = set(score.extract_numbers(out)); low = out.lower()
res = []
for f in facts:
    t = score._fact_distinctive_tokens(f)
    ok = all((x in nums) if score._is_number_token(x) else score._whole_word(low, x) for x in t) if t else True
    res.append({"fact": f, "tokens": t, "hit": ok})
print(json.dumps(res))
`;

/** Where each key fact sits: the segment holding most of its distinctive tokens, as a fraction of its chunk. */
function locateFacts(perFact, chunks) {
  return perFact.map((pf) => {
    let best = null;
    let bestN = 0;
    for (const c of chunks) {
      for (const seg of c.segments) {
        const low = seg.text.toLowerCase().replace(/,(?=\d{3})/g, "");
        const n = pf.tokens.filter((t) => low.includes(t)).length;
        if (n > bestN) {
          bestN = n;
          best = { chunk: c.index, pos: (seg.start - c.start) / Math.max(1, c.end - c.start) };
        }
      }
    }
    return { ...pf, where: best };
  });
}

// ------------------------------------------------------------------------------------------------
// the pipeline, as engine/llm.ts runs it
// ------------------------------------------------------------------------------------------------
console.error(`quality-cpu: ${SUMMARIZER.id}@${SUMMARIZER.revision.slice(0, 7)} ${dtype}/cpu spec=${SPEC} gen=${JSON.stringify(extraGen)}`);
const tokenizer = await AutoTokenizer.from_pretrained(SUMMARIZER.id, { revision: SUMMARIZER.revision });
const model = await AutoModelForCausalLM.from_pretrained(SUMMARIZER.id, { dtype, device: "cpu", revision: SUMMARIZER.revision });

async function generate(user, cfg) {
  const messages = [];
  if (args.system) messages.push({ role: "system", content: readFileSync(args.system, "utf8") });
  messages.push({ role: "user", content: user });
  const inputs = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true, enable_thinking: args.think === "true" });
  const promptTokens = inputs.input_ids.dims.at(-1);
  const t0 = Date.now();
  const gen = { ...(cfg.generation ?? {}), ...extraGen };
  const out = await model.generate({ ...inputs, max_new_tokens: cfg.max_new_tokens, do_sample: false, ...gen });
  const ms = Date.now() - t0;
  const newTokens = out.slice(null, [promptTokens, null]);
  const text = tokenizer.batch_decode(newTokens, { skip_special_tokens: true })[0];
  return { text, promptTokens, newTokens: newTokens.dims.at(-1), ms };
}

function parseAll(text, caps, cutOff = false) {
  const p = new BulletParser(caps);
  const bullets = [...p.push(text), ...p.flush(cutOff)];
  return { bullets, dropped: p.dropped, overlength: p.overlength };
}

async function perChunk(chunks, levelId) {
  const cfg = levelCfg(levelId);
  const prompt = PROMPTS[cfg.prompt];
  const rows = [];
  for (const chunk of chunks) {
    if (cfg.part_tokens) {
      // spec/chunking.md "Parts": one call per part, one line each, grounded against its part.
      const n = partCount(chunk.tokens, chunk.segments.length, { part_tokens: cfg.part_tokens, min_bullets_per_chunk: cfg.min_bullets_per_chunk ?? 1, max_bullets_per_chunk: cfg.max_bullets_per_chunk });
      const parts = splitParts(chunk.segments, n);
      let raw = "";
      let ms = 0;
      let nt = 0;
      let dropped = 0;
      let overlength = 0;
      const bullets = [];
      for (const part of parts) {
        const ptext = part.map((s) => s.text).join(" ");
        const g = await generate(prompt.replace("{{text}}", () => ptext), cfg);
        raw += g.text.trim() + "\n";
        ms += g.ms;
        nt += g.newTokens;
        const p = parseAll(g.text, { max_bullets_per_chunk: 1, max_words_per_bullet: cfg.max_words_per_bullet }, g.newTokens >= cfg.max_new_tokens);
        dropped += p.dropped;
        overlength += p.overlength;
        for (const b of p.bullets) {
          const gr = ground(b.text, ptext, COMMON_WORDS);
          bullets.push({ text: b.text, kept: gr.ok, reasons: gr.reasons, ...analyseBullet(b.text, chunk) });
        }
      }
      rows.push({ chunk: chunk.index, words: words(chunk.text), raw, bullets, dropped, overlength, new_tokens: nt, ms, parts: parts.length });
      process.stderr.write(`  ${levelId} chunk ${chunk.index}: ${parts.length} parts, ${bullets.filter((b) => b.kept).length}/${bullets.length} kept, ${nt} tok ${ms} ms\n`);
      continue;
    }
    const g = await generate(prompt.replace("{{text}}", () => chunk.text), cfg);
    const parsed = parseAll(g.text, { max_bullets_per_chunk: cfg.max_bullets_per_chunk, max_words_per_bullet: cfg.max_words_per_bullet }, g.newTokens >= cfg.max_new_tokens);
    const bullets = parsed.bullets.map((b) => {
      const gr = ground(b.text, chunk.text, COMMON_WORDS);
      return { text: b.text, kept: gr.ok, reasons: gr.reasons, ...analyseBullet(b.text, chunk) };
    });
    rows.push({ chunk: chunk.index, words: words(chunk.text), raw: g.text, bullets, dropped: parsed.dropped, overlength: parsed.overlength, prompt_tokens: g.promptTokens, new_tokens: g.newTokens, ms: g.ms });
    process.stderr.write(`  ${levelId} chunk ${chunk.index}: ${bullets.filter((b) => b.kept).length}/${bullets.length} kept, dropped ${parsed.dropped}, ${g.newTokens} tok ${g.ms} ms\n`);
  }
  return rows;
}

async function oneLine(chunks) {
  const cfg = levelCfg("oneline");
  const reduce = cfg.reduce;
  const prompt = PROMPTS[cfg.prompt];
  const per = [];
  const survivors = [];
  let cut = 0;
  let total = 0;
  let reduceCalls = 0;
  for (const chunk of chunks) {
    const g = await generate(prompt.replace("{{text}}", () => chunk.text), cfg);
    const parsed = parseAll(g.text, { max_bullets_per_chunk: 1, max_words_per_bullet: cfg.max_words_per_bullet }, g.newTokens >= cfg.max_new_tokens);
    total += parsed.bullets.length;
    const line = parsed.bullets[0]?.text;
    const gr = line ? ground(line, chunk.text, COMMON_WORDS) : { ok: false, reasons: ["no_line"] };
    if (line && gr.ok) survivors.push(line);
    else {
      cut++;
    }
    per.push({ chunk: chunk.index, raw: g.text, line, kept: !!line && gr.ok, reasons: gr.reasons, ...(line ? analyseBullet(line, chunk) : {}) });
  }
  const cutLines = per.filter((p) => p.line && !p.kept).length;
  if (chunks.length === 0 || cut / chunks.length > reduce.max_cut_fraction || survivors.length === 0) {
    return { fallback: true, per, total, cut: cutLines, reduceCalls };
  }
  let lines = survivors;
  let depth = 0;
  let reduceCut = 0;
  const reduceRaw = [];
  while (lines.length > 1 && depth < reduce.max_depth) {
    depth++;
    const next = [];
    for (let i = 0; i < lines.length; i += reduce.group_size) {
      const source = lines.slice(i, i + reduce.group_size).map((l) => `- ${l}`).join("\n");
      reduceCalls++;
      const g = await generate(PROMPTS[cfg.reduce_prompt].replace("{{lines}}", () => source), cfg);
      const parsed = parseAll(g.text, { max_bullets_per_chunk: 1, max_words_per_bullet: cfg.max_words_per_bullet }, g.newTokens >= cfg.max_new_tokens);
      total += parsed.bullets.length;
      const line = parsed.bullets[0]?.text;
      reduceRaw.push({ source, raw: g.text });
      if (line && ground(line, source, COMMON_WORDS).ok) next.push(line);
      else if (line) reduceCut++;
    }
    if (next.length === 0) return { fallback: true, per, total, cut: cutLines + reduceCut, reduceCalls, reduceRaw };
    lines = next;
  }
  return { fallback: false, final: lines[0], per, total, cut: cutLines + reduceCut, reduceCalls, reduceRaw };
}

const rows = [];
for (const d of docs) {
  const isPath = d.includes("/") || d.endsWith(".txt");
  const txtPath = isPath ? path.resolve(d) : path.join(ROOT, "spec/eval/corpus", `${d}.txt`);
  const docId = path.basename(txtPath, ".txt");
  const corpusDir = path.dirname(txtPath);
  if (!existsSync(path.join(corpusDir, `${docId}.facts.json`))) throw new Error(`no facts file for ${docId}`);
  const text = readFileSync(txtPath, "utf8");
  const all = await chunkSentences(segmentSentences(text), (t) => countTokensWith(tokenizer, t), BUDGET);
  const chunks = all.slice(0, maxChunks);
  const srcWords = chunks.reduce((n, c) => n + words(c.text), 0);
  for (const levelId of levels) {
    process.stderr.write(`${docId} ${levelId}: ${chunks.length}/${all.length} chunks, ${srcWords} words\n`);
    const t0 = Date.now();
    let row;
    if (levelId === "oneline") {
      const r = await oneLine(chunks);
      let output;
      let fellBack = null;
      if (r.fallback) {
        fellBack = await perChunk(chunks, levelCfg("oneline").reduce.fallback_level);
        output = fellBack.flatMap((c) => c.bullets.filter((b) => b.kept).map((b) => `- ${b.text}\n`)).join("");
      } else output = `- ${r.final}\n`;
      const s = score(docId, corpusDir, "oneline", output);
      const finalA = !r.fallback ? analyseBullet(r.final, { segments: chunks.flatMap((c) => c.segments), start: chunks[0].start, end: chunks.at(-1).end }) : null;
      row = {
        doc: docId, level: "oneline", chunks: chunks.length, chunks_total: all.length, src_words: srcWords, output,
        fallback: r.fallback, per_chunk: r.per, reduce: r.reduceRaw, fallback_rows: fellBack,
        bullets_total: r.total, bullets_cut: r.cut, cut_rate: r.total ? r.cut / r.total : 0,
        compression: words(output.replace(/^- /gm, "")) / srcWords,
        copy_rate: finalA ? (finalA.copy ? 1 : 0) : null, verbatim_rate: finalA ? (finalA.verbatim ? 1 : 0) : null,
        per_chunk_copy_rate: r.per.filter((p) => p.line).length ? r.per.filter((p) => p.line && p.copy).length / r.per.filter((p) => p.line).length : null,
        facts_token_hit: s.facts_token_hit, halluc_flags: s.halluc_flags, forbidden_hits: s.forbidden_hits, oneline_keyword_hit: s.oneline_keyword_hit,
        per_fact: s.per_fact, ms: Date.now() - t0,
      };
    } else {
      const per = await perChunk(chunks, levelId);
      const kept = per.flatMap((c) => c.bullets.filter((b) => b.kept));
      const parsed = per.flatMap((c) => c.bullets);
      const output = kept.map((b) => `- ${b.text}\n`).join("");
      const s = score(docId, corpusDir, levelId, output);
      const located = locateFacts(s.per_fact, chunks);
      const tailFacts = located.filter((f) => f.where && f.where.pos >= 2 / 3);
      row = {
        doc: docId, level: levelId, chunks: chunks.length, chunks_total: all.length, src_words: srcWords, output, per_chunk: per,
        bullets_total: parsed.length, bullets_cut: parsed.length - kept.length, cut_rate: parsed.length ? (parsed.length - kept.length) / parsed.length : 0,
        parser_dropped: per.reduce((n, c) => n + c.dropped, 0), parser_overlength: per.reduce((n, c) => n + c.overlength, 0),
        compression: kept.reduce((n, b) => n + words(b.text), 0) / srcWords,
        tail_hit: per.filter((c) => c.bullets.some((b) => b.kept && b.pos !== null && b.pos >= 2 / 3)).length / per.length,
        tail_facts: tailFacts.length ? { hit: tailFacts.filter((f) => f.hit).length, of: tailFacts.length } : null,
        copy_rate: kept.length ? kept.filter((b) => b.copy).length / kept.length : null,
        verbatim_rate: kept.length ? kept.filter((b) => b.verbatim).length / kept.length : null,
        facts_token_hit: s.facts_token_hit, halluc_flags: s.halluc_flags, forbidden_hits: s.forbidden_hits,
        per_fact: located, ms: Date.now() - t0,
      };
    }
    rows.push(row);
    const pct = (x) => (x === null || x === undefined ? "  -  " : `${Math.round(x * 100)}%`.padStart(5));
    console.log(
      `${tag}\t${docId}\t${levelId}\tfacts ${pct(row.facts_token_hit)}\tkw ${pct(row.oneline_keyword_hit)}\tcomp ${pct(row.compression)}\ttail ${pct(row.tail_hit)}\ttailFacts ${row.tail_facts ? `${row.tail_facts.hit}/${row.tail_facts.of}` : "-"}\tcopy ${pct(row.copy_rate)}\tverb ${pct(row.verbatim_rate)}\tcut ${pct(row.cut_rate)}\thalluc ${row.halluc_flags}\tforb ${row.forbidden_hits}\t${Math.round(row.ms / 1000)}s`,
    );
    writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify({ tag, spec: SPEC, dtype, gen: extraGen, system: args.system ?? null, rows }, null, 2));
  }
}
