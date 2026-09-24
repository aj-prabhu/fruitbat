#!/usr/bin/env python3
"""Validate spec/dial.json against spec/dial.schema.json.

Uses the `jsonschema` package when present; otherwise a small stdlib checker that covers the
subset of JSON Schema the dial schema uses (type, required, additionalProperties, properties,
items, minItems, minimum, maximum, exclusiveMinimum, pattern, const, if/then).
Exit 0 and print `dial.json OK` on success; print each problem and exit 1 otherwise.
"""
import json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = HERE.parent
dial = json.loads((SPEC / "dial.json").read_text())
schema = json.loads((SPEC / "dial.schema.json").read_text())

try:
    import jsonschema  # type: ignore
    jsonschema.validate(dial, schema)
    print("dial.json OK (jsonschema)")
    sys.exit(0)
except ImportError:
    pass

TYPES = {"object": dict, "array": list, "string": str, "integer": int, "number": (int, float), "boolean": bool}
problems = []

def check(inst, sch, path="$"):
    t = sch.get("type")
    if t:
        py = TYPES[t]
        ok = isinstance(inst, py) and not (t in ("integer", "number") and isinstance(inst, bool))
        if not ok:
            problems.append(f"{path}: expected {t}"); return
    if "const" in sch and inst != sch["const"]:
        problems.append(f"{path}: expected const {sch['const']!r}")
    if isinstance(inst, dict):
        for r in sch.get("required", []):
            if r not in inst: problems.append(f"{path}: missing required {r!r}")
        props = sch.get("properties", {})
        if sch.get("additionalProperties") is False:
            for k in inst:
                if k not in props: problems.append(f"{path}: unexpected property {k!r}")
        for k, sub in props.items():
            if k in inst: check(inst[k], sub, f"{path}.{k}")
        if "if" in sch:
            hit = True
            for k, sub in sch["if"].get("properties", {}).items():
                if k not in inst or ("const" in sub and inst[k] != sub["const"]): hit = False
            if hit and "then" in sch:
                for r in sch["then"].get("required", []):
                    if r not in inst: problems.append(f"{path}: missing {r!r} (required when {sch['if']['properties']})")
    if isinstance(inst, list):
        if "minItems" in sch and len(inst) < sch["minItems"]: problems.append(f"{path}: fewer than {sch['minItems']} items")
        if "items" in sch:
            for i, it in enumerate(inst): check(it, sch["items"], f"{path}[{i}]")
    if isinstance(inst, (int, float)) and not isinstance(inst, bool):
        if "minimum" in sch and inst < sch["minimum"]: problems.append(f"{path}: {inst} < minimum {sch['minimum']}")
        if "maximum" in sch and inst > sch["maximum"]: problems.append(f"{path}: {inst} > maximum {sch['maximum']}")
        if "exclusiveMinimum" in sch and inst <= sch["exclusiveMinimum"]: problems.append(f"{path}: {inst} <= exclusiveMinimum")
    if isinstance(inst, str) and "pattern" in sch and not re.search(sch["pattern"], inst):
        problems.append(f"{path}: {inst!r} does not match {sch['pattern']}")

check(dial, schema)
# Semantic checks the schema cannot express.
ids = [l["id"] for l in dial["levels"]]
if dial["default"] not in ids: problems.append(f"default {dial['default']!r} is not a level")
if len(set(ids)) != len(ids): problems.append("duplicate level ids")
for l in dial["levels"]:
    for key in ("prompt", "reduce_prompt"):
        if key in l and not (SPEC / l[key]).is_file(): problems.append(f"{l['id']}: {l[key]} missing")
    if "reduce" in l and l["reduce"]["fallback_level"] not in ids: problems.append(f"{l['id']}: fallback_level not a level")
    if "prompt" in l:
        words = len((SPEC / l["prompt"]).read_text().split())
        if words > 120: problems.append(f"{l['prompt']}: {words} words > 120")
if problems:
    print("\n".join(problems)); sys.exit(1)
print("dial.json OK (stdlib checker)")
