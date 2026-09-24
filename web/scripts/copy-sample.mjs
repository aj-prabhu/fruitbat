// Copies the sample article into web/public/sample.txt at build time, so the app only ever
// fetches a same-origin path at runtime (docs/PLAN.md rule 1; net.ts is the only fetch site
// for anything else). Runs as `prebuild`.
//
// The real corpus (spec/eval/corpus/011.txt, the bat article) is landing on S0-04a. Until that
// packet merges, this falls back to the stand-in paragraph vendored below (the same text
// web/tests/skeleton.spec.ts uses), so S1-01 can build and test without reaching outside web/
// at runtime. Once S0-04a merges, delete nothing here: the corpus file simply exists and this
// script picks it up automatically.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.join(here, "..", "..", "spec", "eval", "corpus", "011.txt");
const outDir = path.join(here, "..", "public");
const outPath = path.join(outDir, "sample.txt");

// Stand-in only: paragraph 1 mirrors web/tests/skeleton.spec.ts's TEXT constant word for word
// (S0-04a owns the real 011.txt); the rest pads it to the paragraph count the layout needs.
// Stand-in only, used if spec/eval/corpus/011.txt is missing: the one paragraph
// web/tests/skeleton.spec.ts uses, word for word. Nothing invented.
const STANDIN =
  "Bats are the only mammals that can truly fly. More than 1,400 species live on every continent except Antarctica, and about 47 of them live in the United States. A single little brown bat can eat up to 1,000 insects in one hour, which is why farmers count on bats to protect crops. Most bats find their way in the dark by echolocation: they send out high-pitched calls and listen for the echoes that bounce back. Fruit bats, also called flying foxes, rely more on their large eyes and strong sense of smell, and they spread the seeds of figs, mangoes, and more than 300 other plants. Since 2006 a fungal disease called white-nose syndrome has killed millions of bats in North America, cutting some colonies by 90 percent. Bats are slow to recover because most females raise only one pup a year. Leaving dead trees standing and turning off outdoor lights are two simple ways people help.\n";

let text;
let source;
try {
  await access(corpusPath);
  text = await readFile(corpusPath, "utf8");
  source = "spec/eval/corpus/011.txt";
} catch {
  text = STANDIN;
  source = "stand-in (spec/eval/corpus/011.txt not landed yet, S0-04a)";
}

await mkdir(outDir, { recursive: true });
await writeFile(outPath, text, "utf8");
process.stdout.write(`copy-sample: public/sample.txt <- ${source}\n`);
