// Token counting with the pinned summarizer tokenizer (docs/PLAN.md S1-03a, rule 4).
// Every token budget in spec/chunking.md is measured with this function, on both the
// chunker (S1-03) and the summarizer worker (S1-05), so the two never disagree.
import { AutoTokenizer, type PreTrainedTokenizer } from "@huggingface/transformers";
import { configureRuntime } from "../engine/loader";
import { pinnedModels } from "../engine/pins";

/** A pinned model whose tokenizer is wanted: the default summarizer unless a fallback tier is live. */
export type TokenizerPin = { id: string; revision: string };

const ready = new Map<string, Promise<PreTrainedTokenizer>>();

/**
 * The pinned tokenizer, loaded once per model (Cache API in the browser, FS cache in Node).
 * Defaults to the default summarizer; when a fallback tier is loaded, the summarizer passes that
 * tier so chunk budgets match the model that reads them (Codex review, PR #16).
 */
export function tokenizerReady(pin: TokenizerPin = pinnedModels().web.summarizer): Promise<PreTrainedTokenizer> {
  let p = ready.get(pin.id);
  if (!p) {
    configureRuntime();
    p = AutoTokenizer.from_pretrained(pin.id, { revision: pin.revision }).catch((e: unknown) => {
      ready.delete(pin.id);
      throw e;
    });
    ready.set(pin.id, p);
  }
  return p;
}

/** Number of tokens `text` occupies as model input, without special tokens. */
export async function countTokens(text: string, pin?: TokenizerPin): Promise<number> {
  const tok = await tokenizerReady(pin);
  return countTokensWith(tok, text);
}

/** Same count with an already-loaded tokenizer, for hot loops. */
export function countTokensWith(tok: PreTrainedTokenizer, text: string): number {
  if (text.length === 0) return 0;
  const { input_ids } = tok(text, { add_special_tokens: false });
  return input_ids.dims.at(-1) ?? 0;
}
