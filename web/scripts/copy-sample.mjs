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
const STANDIN =
  "Bats are the only mammals that can truly fly. More than 1,400 species live on every continent except Antarctica, and about 47 of them live in the United States. A single little brown bat can eat up to 1,000 insects in one hour, which is why farmers count on bats to protect crops. Most bats find their way in the dark by echolocation: they send out high-pitched calls and listen for the echoes that bounce back. Fruit bats, also called flying foxes, rely more on their large eyes and strong sense of smell, and they spread the seeds of figs, mangoes, and more than 300 other plants. Since 2006 a fungal disease called white-nose syndrome has killed millions of bats in North America, cutting some colonies by 90 percent. Bats are slow to recover because most females raise only one pup a year. Leaving dead trees standing and turning off outdoor lights are two simple ways people help.\n\n" +
  "Echolocation is precise enough that a bat can tell a moth from a raindrop in total darkness. Some species time their calls to the wingbeats of the insects they hunt, adjusting pitch and rate as they close in. Others hunt over water, skimming the surface for insects trapped in the surface tension.\n\n" +
  "Bat colonies can number in the millions, and the largest roosts produce enough guano to support their own cave ecosystems, feeding beetles, cockroaches, and fungi found nowhere else. Bracken Cave in Texas alone holds an estimated 15 million Mexican free-tailed bats each summer.\n\n" +
  "Wing shape varies with diet and habitat. Long, narrow wings suit fast, open-air hunters that chase insects far from cover, while short, broad wings suit bats that dodge through dense forest understory. A few species even wade into shallow water and rake the surface with their feet to catch small fish.\n\n" +
  "Vampire bats are the outliers: three species feed on blood, almost always from livestock, and rarely from people. A vampire bat that fails to feed for two nights in a row can starve, so roostmates that fed well will regurgitate blood to share with a hungry neighbor, a rare example of reciprocal generosity outside primates.\n\n" +
  "Conservation groups now track roosts with acoustic monitors that record and classify echolocation calls automatically, replacing years of hand counts with data collected every night, in every season, without disturbing the colony.\n";

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
