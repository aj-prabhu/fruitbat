#!/usr/bin/env python3
"""Reproducible fetch+trim recipe for the 26 fetched docs in spec/eval/corpus/.
Docs 003/004/005/006 are original-CC0 writing (not fetched), not produced here.
Run: python3 spec/eval/fetch-corpus.py [--out DIR]. Stdlib only, needs network."""
import argparse, json, re, sys, time, urllib.parse, urllib.request
from html.parser import HTMLParser
from pathlib import Path

UA = "Mozilla/5.0 (compatible; FruitbatCorpusBot/1.0; contact mail@ahpb.me)"

def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        text = r.read().decode("utf-8", errors="replace")
    return text.replace("\r\n", "\n").replace("\r", "\n")  # normalize to universal newlines

def gutenberg_text(book_id):
    raw = http_get(f"https://www.gutenberg.org/cache/epub/{book_id}/pg{book_id}.txt")
    m1 = re.search(r"\*\*\* START OF[^\n]*\*\*\*", raw)
    m2 = re.search(r"\*\*\* END OF[^\n]*\*\*\*", raw)
    return raw[m1.end():m2.start()].strip() if (m1 and m2) else raw.strip()

def wikipedia_extract(title):
    url = ("https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1"
           f"&format=json&exlimit=1&titles={urllib.parse.quote(title)}")
    return next(iter(json.loads(http_get(url))["query"]["pages"].values())).get("extract", "")

# --- minimal HTML -> paragraph-list extractor (drops script/style/nav-ish blocks) ---
SKIP = {"script", "style", "nav", "header", "footer", "noscript", "form", "button", "svg", "aside", "template", "iframe"}
BLOCK = {"p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "blockquote", "table", "ul", "ol"}
VOID = {"br", "img", "meta", "link", "input", "hr", "area", "base", "col", "embed", "source", "track", "wbr"}
NAVISH = ["nav", "menu", "footer", "header", "breadcrumb", "sidebar", "skip-link", "banner", "search-form",
          "social", "share", "site-alert", "global-", "utility-nav", "toolbar", "back-to-top", "pagination",
          "byline", "related-content", "tags-list", "cookie"]

class _Extractor(HTMLParser):
    def __init__(self):
        super().__init__(); self.stack, self.chunks, self.cur = [], [], []
    def _skip(self): return any(s for _, s in self.stack)
    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            if tag == "br" and not self._skip(): self.cur.append("\n")
            return
        d = dict(attrs)
        cls = ((d.get("class", "") or "") + " " + (d.get("id", "") or "")).lower()
        is_skip = tag in SKIP or any(k in cls for k in NAVISH)
        if tag in BLOCK and not self._skip(): self._flush()
        self.stack.append((tag, is_skip or self._skip()))
    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i]; break
        if tag in BLOCK and not self._skip(): self._flush()
    def handle_data(self, data):
        if not self._skip(): self.cur.append(data)
    def _flush(self):
        text = " ".join("".join(self.cur).split())
        if text: self.chunks.append(text)
        self.cur = []
    def paragraphs(self):
        self._flush(); return self.chunks

def html_paras(html):
    p = _Extractor(); p.feed(html); return p.paragraphs()

def paras_from(text):
    return [" ".join(p.split()).replace("_", "") for p in text.split("\n\n") if p.strip()]

def select_range(paras, lo, hi):
    # concatenate paragraphs, cutting only at paragraph boundaries, until in [lo, hi]
    out, cum = [], 0
    for p in paras:
        n = len(p.split())
        if cum + n > hi and cum >= lo: break
        out.append(p); cum += n
    return out, cum

LANG_NAMES = {"العربية", "English", "Español", "Français", "Kreyòl", "Kreyòl Ayisyen",
              "日本語", "한국어", "Русский", "Tagalog", "Tiếng Việt", "简体中文"}
END_MARKERS = {"Additional Resources", "Associated Content", "Related Content", "Resources"}

def clean_ready_gov(html):
    # drop the language switcher + nav TOC + FEMA blurb, and the trailing related-links/footer
    paras = html_paras(html)
    n = len(paras); i = 2
    while i < n and (paras[i] in LANG_NAMES or len(paras[i].split()) <= 5): i += 1
    if i < n and "disaster survivor" in paras[i]: i += 1
    paras = paras[i:]
    end = next((j for j, p in enumerate(paras) if p in END_MARKERS), len(paras))
    paras = paras[:end]
    return [p for p in paras if p not in ("Image", "Image Image", "Image Image Image")
            and not p.startswith("Last Updated") and p != "Return to top"]

STOP_HEADERS = {"Historical and Revision Notes", "Amendments", "Effective Date", "Short Title",
                "References in Text", "Termination Date", "Transfer of Functions", "Editorial Notes",
                "Statutory Notes and Related Subsidiaries", "Regulations", "Construction"}

def uscode_operative(section):
    # fetch a Title 17 section; keep only codified text (drop history/amendment notes + citation)
    url = f"https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title17-section{section}&num=0&edition=prelim"
    out = []
    for p in (" ".join(x.split()) for x in html_paras(http_get(url))):
        if p in STOP_HEADERS: break
        if re.match(r"^\(.*Pub\. L\.", p) and len(p.split()) < 120: break
        out.append(p)
    return out

NPS_DROP = {
    "Loading results...", "Need more reasons?", "20 Reasons to Appreciate Bats", "Help Bats in Parks",
    "Conservation At Home", "Help Bats At Home!", "Bativities", "Southwest Composites",
    "Help bats by learning more about them through some fun activities.", "Celebrate Bat Week!",
    "Brazilian free-tailed bats.",
    "Bat Week is Oct. 24-31! Let's hear it for the bats! From pollinating to eating insects, bats make our world a better place.",
    "A lesser-long nosed bat covered in yellow pollen.", "A bat catches an adult corn earworm.",
    "A flying fox eats a papaya from a tree in American Samoa.",
    "Learn more about White-nose syndrome in the following articles or discover more by watching videos on white-nose syndrome and bat research.",
    "And no matter where you are, you can celebrate Bat Week in October every year!",
    "Infrared photo of the Brazilian free-tailed bat roost in Bat Cave within Carlsbad Cavern. Notice that bats do not sleep all day—some are flying around.",
}

def clean_nps(url):
    out = []
    for p in (" ".join(x.split()) for x in html_paras(http_get(url))):
        if p.startswith("Last updated:") or p in NPS_DROP: continue
        if re.match(r"^(NPS Photo|Photo courtesy of|Image courtesy of|©)", p): continue
        if " - Bats (U.S. National Park Service)" in p or " - Carlsbad Caverns" in p: continue
        out.append(p)
    return out

def strip_sentence_punctuation(text):
    out = re.sub(r"[.!?;:]+", "", text)
    out = re.sub(r"[ \t]+", " ", out)
    return re.sub(r" ?\n ?", "\n", out)

WIKI_STOP = {"See also", "References", "Bibliography", "Further reading", "External links",
             "Notes", "Citations", "Works cited"}

def wiki_paras(text, stop=WIKI_STOP):
    out = []
    for l in (x.strip() for x in text.split("\n") if x.strip()):
        m = re.match(r"^=+\s*(.*?)\s*=+$", l)
        if m:
            if m.group(1) in stop: break
            out.append(m.group(1))
        else:
            out.append(l)
    return out

def gutenberg_paras(book_id, anchor):
    t = gutenberg_text(book_id)
    return paras_from(t[t.find(anchor):])

def gutenberg_slice(book_id, anchor, lo, hi):
    sel, _ = select_range(gutenberg_paras(book_id, anchor), lo, hi)
    return sel

def wiki_slice(title, lo, hi, stop=WIKI_STOP):
    sel, _ = select_range(wiki_paras(wikipedia_extract(title), stop), lo, hi)
    return sel

def readygov_paras(slug):
    return clean_ready_gov(http_get(f"https://www.ready.gov/{slug}"))

def dedupe_paragraphs(paras):
    # Keep only the first occurrence of each exact paragraph: combined pages can
    # share a step-header/signature line, and some prose repeats a line on purpose
    # (a tolling bell); either way a repeat would look like templated filler.
    seen, out = set(), []
    for p in paras:
        if p not in seen:
            seen.add(p); out.append(p)
    return out

def drop_illustration_markers(paras):
    # some Gutenberg editions carry bracketed plate captions ("[Illustration]", "[Copyright ...]"); not prose
    return [p for p in paras if not re.match(r"^\[(Illustration|Copyright)\b", p, re.I)]

def build(out_dir):
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    def save(name, paras):
        paras = dedupe_paragraphs(drop_illustration_markers(paras))
        (out_dir / name).write_text("\n\n".join(paras).strip() + "\n")

    save("001.txt", gutenberg_slice(11, "Alice was beginning to get very tired", 350, 600))
    lead = [l.strip() for l in wikipedia_extract("Photosynthesis").split("\n") if l.strip() and not l.startswith("==")][:5]
    save("002.txt", lead)
    html = http_get("https://www.nasa.gov/news-release/nasa-selects-far-infrared-telescope-as-first-in-new-mission-class/")
    text = "\n\n".join(html_paras(html))
    body = text[text.find("NASA announced Wednesday"):text.find("astrophysics and heliophysics programs.") + 40]
    save("007.txt", [body])
    sel, _ = select_range(readygov_paras("tornadoes"), 350, 600)
    save("008.txt", sel)
    save("009.txt", uscode_operative("102") + uscode_operative("106"))
    save("010.txt", gutenberg_slice(205, "When I wrote the following pages", 350, 550))
    combined = (clean_nps("https://www.nps.gov/cave/learn/nature/bats.htm")
                + ["Benefits of Bats"] + clean_nps("https://www.nps.gov/subjects/bats/benefits-of-bats.htm")
                + ["White-nose Syndrome"] + clean_nps("https://www.nps.gov/subjects/bats/white-nose-syndrome.htm")
                + ["Help Bats"] + clean_nps("https://www.nps.gov/subjects/bats/help-bats.htm"))
    save("011.txt", combined)  # role: sample-article
    save("012.txt", gutenberg_slice(1661, "To Sherlock Holmes she is always", 1100, 1700))
    save("013.txt", uscode_operative("106A") + uscode_operative("121"))
    save("014.txt", wiki_slice("Chernobyl disaster", 1300, 1800))
    sel, _ = select_range(readygov_paras("home-fires"), 1100, 1700)
    save("015.txt", sel)
    save("016.txt", wiki_slice("Plate tectonics", 1200, 1800))
    walden_all = gutenberg_paras(205, "When I wrote the following pages")
    sel010, _ = select_range(walden_all, 350, 550)
    sel017, _ = select_range(walden_all[len(sel010):], 1200, 1800)
    save("017.txt", sel017)
    save("018.txt", gutenberg_slice(120, "Squire Trelawney, Dr. Livesey", 1100, 1700))
    winter, heat = readygov_paras("winter-weather"), readygov_paras("heat")
    sel, _ = select_range(["Winter Weather"] + winter + ["Extreme Heat"] + heat, 1300, 1900)
    save("019.txt", sel)
    sel = gutenberg_slice(35, "The Time Traveller (for so it will be convenient", 1050, 1200)
    save("020.txt", [strip_sentence_punctuation("\n\n".join(sel))])  # role: unpunctuated
    save("021.txt", wiki_paras(wikipedia_extract("Evolution")))
    guides = [("Earthquakes", "earthquakes"), ("Wildfires", "wildfires"), ("Floods", "floods"),
              ("Hurricanes", "hurricanes"), ("Tsunamis", "tsunamis"), ("Volcanoes", "volcanoes"),
              ("Landslides & Debris Flow", "landslides-debris-flow"), ("Drought", "drought"),
              ("Power Outages", "power-outages")]
    combined = []
    for label, slug in guides:
        combined += [label] + readygov_paras(slug); time.sleep(0.3)
    sel, _ = select_range(combined, 6000, 11500)
    save("022.txt", [p.replace("coveruntil", "cover until") for p in sel])
    apollo_stop = WIKI_STOP | {"Celebrations", "World tour", "Legacy", "Cultural significance",
                                "Spacecraft", "Moon rocks", "Experiment results", "Moonwalk camera",
                                "Lunar Module Eagle memorabilia", "Anniversary events",
                                "40th anniversary", "50th anniversary", "Films and documentaries"}
    save("023.txt", wiki_paras(wikipedia_extract("Apollo 11"), apollo_stop))
    save("024.txt", uscode_operative("101") + uscode_operative("107") +
                    uscode_operative("108") + uscode_operative("110"))
    sel, _ = select_range(gutenberg_paras(46, "STAVE I:"), 9000, 11500)
    save("025.txt", sel)  # role: multi-chunk (Staves I-II)
    save("026.txt", gutenberg_slice(1228, "When on board H.M.S.", 5000, 9000))
    save("027.txt", wiki_paras(wikipedia_extract("Immune system")))
    save("028.txt", gutenberg_slice(1342, "It is a truth universally acknowledged", 8000, 10000))
    chernobyl_all = wiki_paras(wikipedia_extract("Chernobyl disaster"))
    sel014, _ = select_range(chernobyl_all, 1300, 1800)
    sel029, _ = select_range(chernobyl_all[len(sel014):], 6000, 9000)
    save("029.txt", sel029)
    fed_all = paras_from(gutenberg_text(1404)[78:])
    sel, _ = select_range(fed_all, 5000, 9000)
    save("030.txt", sel)
    print(f"Wrote fetched docs to {out_dir}", file=sys.stderr)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).parent / "corpus"))
    build(ap.parse_args().out)
