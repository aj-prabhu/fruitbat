// Token counting with the pinned summarizer tokenizer (docs/PLAN.md S1-03a, rule 4).
// Every token budget in spec/chunking.md is measured with this function, on both the
// chunker (S1-03) and the summarizer worker (S1-05), so the two never disagree.
import { AutoTokenizer, type PreTrainedTokenizer } from "@huggingface/transformers";
import { configureRuntime } from "../engine/loader";
import { pinnedModels } from "../engine/pins";

let ready: Promise<PreTrainedTokenizer> | null = null;

/** The pinned tokenizer, loaded once (Cache API in the browser, FS cache in Node). */
export function tokenizerReady(): Promise<PreTrainedTokenizer> {
  if (!ready) {
    configureRuntime();
    const { id, revision } = pinnedModels().web.summarizer;
    ready = AutoTokenizer.from_pretrained(id, { revision }).catch((e: unknown) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

/** Number of tokens `text` occupies as model input, without special tokens. */
export async function countTokens(text: string): Promise<number> {
  const tok = await tokenizerReady();
  return countTokensWith(tok, text);
}

/** Same count with an already-loaded tokenizer, for hot loops. */
export function countTokensWith(tok: PreTrainedTokenizer, text: string): number {
  if (text.length === 0) return 0;
  const { input_ids } = tok(text, { add_special_tokens: false });
  return input_ids.dims.at(-1) ?? 0;
}
