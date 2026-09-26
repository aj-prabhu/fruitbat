// Every visible string in web/src/ui comes through here (CONTRIBUTING.md "Strings"; docs/PLAN.md
// rule 8, S1-L0). S0-03 owns the keys in spec/strings/en.json; S1-L0 (Claude, Voice Bank) fills
// every value. Until then values are the literal placeholder "TODO(S1-L0)", which is expected and
// correct for this packet, not a bug: `strings-check.mjs` (S1-L0's proof) is what asserts 0
// placeholders remain, not this packet.
import stringsFile from "../../spec/strings/en.json";

const STRINGS: Record<string, string> = stringsFile.strings as Record<string, string>;

/** Look up a user-facing string by its spec/strings/en.json key. */
export function t(key: string): string {
  return STRINGS[key] ?? key;
}
