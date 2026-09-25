# Corpus attribution

One line per doc: id, title/description, source, license, what was cut or changed.
All fetched docs are cut only at paragraph boundaries, with headers/nav/footnotes/
captions/citation marks/tables removed per the source-fetch instructions; no wording
inside a kept sentence was rewritten except where noted.

- 001 — Alice's Adventures in Wonderland, ch. 1 (opening) — Lewis Carroll, Project
  Gutenberg #11 (https://www.gutenberg.org/cache/epub/11/pg11.txt) — public domain.
  Trimmed to the first ~500 words at a paragraph boundary; Gutenberg's `_italic_`
  markup underscores stripped.
- 002 — Photosynthesis (lead section) — Wikipedia
  (https://en.wikipedia.org/wiki/Photosynthesis) — CC BY-SA 4.0, "Photosynthesis",
  https://en.wikipedia.org/wiki/Photosynthesis. Lead section only (first 5 paragraphs,
  before the first `==` heading).
- 003 — Workplace email: Q3 invoice numbers — original, written for this corpus —
  original-CC0. Not fetched.
- 004 — Family email: Thanksgiving flights and the cabin split — original, written
  for this corpus — original-CC0. Not fetched.
- 005 — Relational/negation short doc: money and favors between Alice, Bob, Carla,
  and Dev — original, written for this corpus — original-CC0. Not fetched. Role:
  relational-negation.
- 006 — Workplace email: vendor renewal terms — original, written for this corpus —
  original-CC0. Not fetched.
- 007 — "NASA Selects Far-Infrared Telescope as First in New Mission Class" (press
  release body) — NASA
  (https://www.nasa.gov/news-release/nasa-selects-far-infrared-telescope-as-first-in-new-mission-class/)
  — public domain (US government work). Nav, byline/date/release-number, contact
  block, and "Details"/"Related Terms" footer removed; body kept in full.
- 008 — Tornadoes preparedness guide (excerpt) — ready.gov/FEMA
  (https://www.ready.gov/tornadoes) — public domain (US government work). Language
  switcher, nav table of contents, FEMA disaster-survivor boilerplate, image alt
  placeholders, and trailing resources/link list removed; trimmed to short range at
  a paragraph boundary.
- 009 — 17 U.S.C. §102 (Subject matter of copyright: in general) + §106 (Exclusive
  rights in copyrighted works) — U.S. Code via uscode.house.gov
  (https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title17-section102&num=0&edition=prelim
  and .../section106) — public domain (US government work). Historical/Revision
  Notes and the trailing "(Pub. L. ...)" citation line removed from each section;
  codified text kept verbatim and concatenated.
- 010 — Walden, opening lines — Henry David Thoreau, Project Gutenberg #205
  (https://www.gutenberg.org/cache/epub/205/pg205.txt) — public domain. First ~400
  words at a paragraph boundary.
- 011 — Bat article (role: sample-article) combining "Bats" (Carlsbad Caverns
  National Park), "Benefits of Bats," "White-nose Syndrome," and "Help Bats" — NPS
  (https://www.nps.gov/cave/learn/nature/bats.htm,
  https://www.nps.gov/subjects/bats/benefits-of-bats.htm,
  https://www.nps.gov/subjects/bats/white-nose-syndrome.htm,
  https://www.nps.gov/subjects/bats/help-bats.htm) — public domain (US government
  work). Photo captions/credits, "Last updated" footers, "Loading results...", and
  promotional link teasers removed from each page; the four pages' remaining body
  text concatenated in order, each preceded by its own page title as a plain-text
  label (manifest source_url records the first/primary page).
- 012 — Sherlock Holmes, "A Scandal in Bohemia" (opening) — Arthur Conan Doyle,
  Project Gutenberg #1661 (https://www.gutenberg.org/cache/epub/1661/pg1661.txt) —
  public domain. Trimmed to medium range at a paragraph boundary; italic-markup
  underscores stripped.
- 013 — 17 U.S.C. §106A (Rights of certain authors to attribution and integrity) +
  §121 (Limitations on exclusive rights: reproduction for blind or other people with
  disabilities) — U.S. Code via uscode.house.gov
  (https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title17-section106A&num=0&edition=prelim
  and .../section121) — public domain (US government work). Historical/Revision
  Notes, "Effective Date," and "Amendments" sections removed from each; codified
  text kept verbatim and concatenated.
- 014 — Chernobyl disaster: background and reactor-cooling sections (first ~1,700
  words) — Wikipedia (https://en.wikipedia.org/wiki/Chernobyl_disaster) — CC BY-SA
  4.0, "Chernobyl disaster", https://en.wikipedia.org/wiki/Chernobyl_disaster.
  `==` heading markers converted to plain lines; trimmed to medium range at a
  paragraph boundary. Non-overlapping with doc 029, which continues from where
  this excerpt stops.
- 015 — Home Fires preparedness guide (excerpt) — ready.gov/FEMA
  (https://www.ready.gov/home-fires) — public domain (US government work). Same
  boilerplate removal as 008; trimmed to medium range at a paragraph boundary.
- 016 — Plate tectonics (excerpt) — Wikipedia
  (https://en.wikipedia.org/wiki/Plate_tectonics) — CC BY-SA 4.0, "Plate tectonics",
  https://en.wikipedia.org/wiki/Plate_tectonics. `==` heading markers converted to
  plain lines; trimmed to medium range at a paragraph boundary.
- 017 — Walden, continuing directly after doc 010's cutoff (non-overlapping) — Henry
  David Thoreau, Project Gutenberg #205
  (https://www.gutenberg.org/cache/epub/205/pg205.txt) — public domain. Trimmed to
  medium range at a paragraph boundary.
- 018 — Treasure Island, ch. 1 ("The Old Sea-dog at the Admiral Benbow") — Robert
  Louis Stevenson, Project Gutenberg #120
  (https://www.gutenberg.org/cache/epub/120/pg120.txt) — public domain. Trimmed to
  medium range at a paragraph boundary.
- 019 — Winter Weather + Extreme Heat preparedness guides, combined — ready.gov/FEMA
  (https://www.ready.gov/winter-weather and https://www.ready.gov/heat) — public
  domain (US government work). Same boilerplate removal as 008; each page's own
  title used as a plain-text label between the two; trimmed to medium range.
- 020 — The Time Machine, opening (role: unpunctuated) — H.G. Wells, Project
  Gutenberg #35 (https://www.gutenberg.org/cache/epub/35/pg35.txt) — public domain.
  Trimmed to 1,000-1,200 words at a paragraph boundary, then every `.`, `!`, `?`,
  `;`, `:` character removed and the surrounding whitespace collapsed, per the
  unpunctuated role's requirement. No abbreviations, decimals, or ellipses occurred
  in the selected passage.
- 021 — Evolution (through the last body section, before "See also") — Wikipedia
  (https://en.wikipedia.org/wiki/Evolution) — CC BY-SA 4.0, "Evolution",
  https://en.wikipedia.org/wiki/Evolution. `==` heading markers converted to plain
  lines; References/Bibliography/Further reading/External links sections dropped.
- 022 — Nine ready.gov hazard guides combined (Earthquakes, Wildfires, Floods,
  Hurricanes, Tsunamis, Volcanoes, Landslides & Debris Flow, Drought, Power
  Outages) — ready.gov/FEMA (https://www.ready.gov/earthquakes,
  /wildfires, /floods, /hurricanes, /tsunamis, /volcanoes,
  /landslides-debris-flow, /drought, /power-outages) — public domain (US
  government work). Same boilerplate removal as 008; each guide's own page title
  used as a plain-text label; one scraping artifact ("coveruntil" -> "cover until",
  a lost space from adjacent inline tags) corrected in the earthquake section;
  step-header phrases the nine guides share verbatim ("Prepare NOW," "Gather
  Supplies," etc.) deduplicated to their first occurrence. Manifest source_url
  records the first guide.
- 023 — Apollo 11, through splashdown and quarantine (before "Celebrations") —
  Wikipedia (https://en.wikipedia.org/wiki/Apollo_11) — CC BY-SA 4.0, "Apollo 11",
  https://en.wikipedia.org/wiki/Apollo_11. `==` heading markers converted to plain
  lines; Celebrations/Legacy/Spacecraft/anniversary/References-type sections and
  later dropped.
- 024 — 17 U.S.C. §101 (Definitions) + §107 (Fair use) + §108 (Reproduction by
  libraries and archives) + §110 (Exemption of certain performances and displays) —
  U.S. Code via uscode.house.gov (section101, section107, section108, section110
  at https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title17-section101&num=0&edition=prelim
  etc.) — public domain (US government work). Historical/Revision Notes and
  Amendments sections removed from each; codified text kept verbatim and
  concatenated; a handful of numbered clauses that repeat verbatim between §108's
  own subsections deduplicated to their first occurrence. Manifest source_url
  records §101.
- 025 — A Christmas Carol, Stave I in full + the first part of Stave II (role:
  multi-chunk) — Charles Dickens, Project Gutenberg #46
  (https://www.gutenberg.org/cache/epub/46/pg46.txt) — public domain. Trimmed to
  8,000-12,000 words at a paragraph boundary; the STAVE I/STAVE II headers are kept
  verbatim as the doc's chapter structure; a few lines of dialogue/narration
  Dickens repeats verbatim in the source (variants of "Good afternoon," said
  Scrooge. and the bell's "Ding, dong!") deduplicated to their first occurrence.
- 026 — On the Origin of Species, Introduction + ch. 1 ("Variation Under
  Domestication") — Charles Darwin, Project Gutenberg #1228
  (https://www.gutenberg.org/cache/epub/1228/pg1228.txt) — public domain. Trimmed
  to long range at a paragraph boundary.
- 027 — Immune system (through the last body section, before "See also") —
  Wikipedia (https://en.wikipedia.org/wiki/Immune_system) — CC BY-SA 4.0, "Immune
  system", https://en.wikipedia.org/wiki/Immune_system. `==` heading markers
  converted to plain lines; References-type sections dropped.
- 028 — Pride and Prejudice, opening chapters — Jane Austen, Project Gutenberg
  #1342 (https://www.gutenberg.org/cache/epub/1342/pg1342.txt) — public domain.
  Trimmed to 8,000-10,000 words at a paragraph boundary; this Gutenberg edition is
  an illustrated-edition transcription, so bracketed plate captions ("[Illustration]",
  "[Copyright 1894 by George Allen.]]") were removed entirely as non-prose artifacts.
- 029 — Chernobyl disaster, continuing directly after doc 014's cutoff through the
  "In popular culture" section (non-overlapping with 014) — Wikipedia
  (https://en.wikipedia.org/wiki/Chernobyl_disaster) — CC BY-SA 4.0, "Chernobyl
  disaster", https://en.wikipedia.org/wiki/Chernobyl_disaster. `==` heading markers
  converted to plain lines; trimmed to long range at a paragraph boundary.
- 030 — The Federalist Papers, Nos. 1-6 — Alexander Hamilton, John Jay, and James
  Madison, Project Gutenberg #1404
  (https://www.gutenberg.org/cache/epub/1404/pg1404.txt) — public domain. Trimmed
  to long range at a paragraph boundary; the shared salutation ("To the People of
  the State of New York:"), the "PUBLIUS"/author-name signature lines, and the
  subtitle that Nos. 2-5 repeat verbatim (Jay's four-paper run on the same topic)
  deduplicated to their first occurrence.
