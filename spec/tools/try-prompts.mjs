// S0-03: try a dial level's prompt against a corpus doc on CPU in Node (Transformers.js 4.x).
//   node spec/tools/try-prompts.mjs --model onnx-community/Qwen3.5-0.8B-Text-ONNX --dtype q4 --device cpu \
//        --doc spec/eval/corpus/011.txt --level caveman --max-words 1000 --out /tmp/p.txt
// Reads the prompt from spec/dial.json -> spec/prompts/<level>.md, applies the chat template with
// thinking off, greedy-decodes max_new_tokens, and writes the raw model output to --out.
// The revision comes from spec/models.json when the model id matches; --revision overrides.
import { AutoTokenizer, AutoModelForCausalLM, env } from "@huggingface/transformers";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.resolve(here, "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);
const model_id = args.model ?? "onnx-community/Qwen3.5-0.8B-Text-ONNX";
const dtype = args.dtype ?? "q4";
const device = args.device ?? "cpu";
const level = args.level ?? "short";
const maxWords = Number(args["max-words"] ?? 1000);
const out = args.out ?? "/tmp/p.txt";
if (!args.doc) throw new Error("--doc required");

env.cacheDir = path.join(here, ".cache", "hf");
env.allowLocalModels = false;

const dial = JSON.parse(await readFile(path.join(specDir, "dial.json"), "utf8"));
const lvl = dial.levels.find((l) => l.id === level);
if (!lvl || !lvl.uses_llm) throw new Error(`level ${level} has no prompt`);
const models = JSON.parse(await readFile(path.join(specDir, "models.json"), "utf8"));
const candidates = [models.web?.summarizer, ...(models.web?.summarizer_fallbacks ?? [])].filter(Boolean);
const revision = args.revision ?? candidates.find((c) => c.id === model_id)?.revision ?? "main";

const template = await readFile(path.join(specDir, lvl.prompt), "utf8");
const words = (await readFile(args.doc, "utf8")).split(/\s+/).filter(Boolean);
const text = words.slice(0, maxWords).join(" ");
const prompt = template.replace("{{text}}", () => text); // no $&-style interpretation of the document (Codex merge-gate review, PR #8)

// Transformers.js 4.3.0 probes tokenizer_config.json at `main` even when a revision is given;
// rewrite that probe to the pinned revision, as the app's loader does (Codex merge-gate review, PR #8).
if (revision !== "main") {
  const base = globalThis.fetch;
  env.fetch = (input, init) => base(String(input).replace(`/${model_id}/resolve/main/`, `/${model_id}/resolve/${revision}/`), init);
}

const t0 = Date.now();
const tokenizer = await AutoTokenizer.from_pretrained(model_id, { revision });
const model = await AutoModelForCausalLM.from_pretrained(model_id, { dtype, device, revision });
const tLoad = Date.now() - t0;

const messages = [{ role: "user", content: prompt }];
const inputs = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true, enable_thinking: false });
const promptTokens = inputs.input_ids.dims.at(-1);
const t1 = Date.now();
const output = await model.generate({ ...inputs, max_new_tokens: lvl.max_new_tokens, do_sample: false });
const tGen = Date.now() - t1;
const newTokens = output.slice(null, [promptTokens, null]);
const textOut = tokenizer.batch_decode(newTokens, { skip_special_tokens: true })[0].trim();
await writeFile(out, textOut + "\n");
const nOut = newTokens.dims.at(-1);
process.stdout.write(
  `${model_id}@${revision.slice(0, 7)} ${dtype}/${device} level=${level} doc=${path.basename(args.doc)} words=${Math.min(words.length, maxWords)} ` +
    `prompt_tokens=${promptTokens} new_tokens=${nOut} load_ms=${tLoad} gen_ms=${tGen} tok_s=${(nOut / (tGen / 1000)).toFixed(1)}\n${textOut}\n`,
);
