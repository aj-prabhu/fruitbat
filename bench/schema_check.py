#!/usr/bin/env python3
"""Stdlib-only validator for the small JSON Schema (draft 2020-12) subset used by
spec/schemas/*.json: type (incl. nullable via `["T","null"]`), required,
additionalProperties (bool), properties, items, enum, minimum, maximum, maxItems,
minItems, maxLength, minLength, pattern, and `$ref` — both within the same document
(`#/$defs/Name`) and to a sibling schema file (`other.schema.json` or
`other.schema.json#/$defs/Name`).

No third-party dependency (no `jsonschema`). This is deliberately a subset: it
covers exactly what spec/schemas/*.json uses, not the full JSON Schema spec.

Usage:
    python3 bench/schema_check.py <instance.json> <schema.json>

Prints "OK" and exits 0 when the instance is valid. Otherwise prints every
violation found, one per line, and exits 1. Exits 2 on a usage/IO error (missing
or unreadable file) so a missing artifact never silently reads as "valid".
"""
import json
import math
import re
import sys
from pathlib import Path

TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
    # bool is a subclass of int in Python; exclude it from number/integer.
    # JSON has no NaN/Infinity; Python's loader accepts them, so reject them here (Codex merge-gate review, PR #15).
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
}


class SchemaError(Exception):
    pass


class Validator:
    """Validates one instance against one schema document, resolving $ref
    to $defs in the same document or to a sibling schema file."""

    def __init__(self, schema_dir):
        self.schema_dir = schema_dir
        self._docs = {}  # resolved Path -> parsed schema document

    def load_doc(self, path):
        path = path.resolve()
        if path not in self._docs:
            if not path.exists():
                raise SchemaError(f"referenced schema file does not exist: {path}")
            self._docs[path] = json.loads(path.read_text(encoding="utf-8"))
        return self._docs[path]

    def resolve_ref(self, ref, current_doc, current_path):
        """Returns (target_schema, doc_the_target_lives_in, path_of_that_doc)."""
        if "#" in ref:
            file_part, frag = ref.split("#", 1)
        else:
            file_part, frag = ref, ""

        if file_part:
            target_path = current_path.parent / file_part
            doc = self.load_doc(target_path)
        else:
            doc = current_doc
            target_path = current_path

        node = doc
        for part in [p for p in frag.split("/") if p]:
            if not isinstance(node, dict) or part not in node:
                raise SchemaError(f"$ref {ref!r} does not resolve (missing {part!r})")
            node = node[part]
        return node, doc, target_path

    def validate(self, instance, schema, path_str, current_doc, current_path, errors):
        if "$ref" in schema:
            target, target_doc, target_path = self.resolve_ref(
                schema["$ref"], current_doc, current_path
            )
            self.validate(instance, target, path_str, target_doc, target_path, errors)
            return

        if "type" in schema:
            types = schema["type"]
            if isinstance(types, str):
                types = [types]
            if not any(TYPE_CHECKS.get(t, lambda v: False)(instance) for t in types):
                errors.append(
                    f"{path_str}: expected type {types}, got {type(instance).__name__} ({instance!r})"
                )
                return  # further checks would be noise once the type itself is wrong

        if "enum" in schema and instance not in schema["enum"]:
            errors.append(f"{path_str}: {instance!r} is not one of {schema['enum']!r}")

        if isinstance(instance, str):
            if "maxLength" in schema and len(instance) > schema["maxLength"]:
                errors.append(
                    f"{path_str}: length {len(instance)} exceeds maxLength {schema['maxLength']}"
                )
            if "minLength" in schema and len(instance) < schema["minLength"]:
                errors.append(
                    f"{path_str}: length {len(instance)} is below minLength {schema['minLength']}"
                )
            if "pattern" in schema and re.search(schema["pattern"], instance) is None:
                errors.append(f"{path_str}: {instance!r} does not match pattern {schema['pattern']!r}")

        if isinstance(instance, (int, float)) and not isinstance(instance, bool):
            if "minimum" in schema and instance < schema["minimum"]:
                errors.append(f"{path_str}: {instance} is below minimum {schema['minimum']}")
            if "maximum" in schema and instance > schema["maximum"]:
                errors.append(f"{path_str}: {instance} exceeds maximum {schema['maximum']}")

        if isinstance(instance, dict):
            for req in schema.get("required", []):
                if req not in instance:
                    errors.append(f"{path_str}: missing required property {req!r}")

            props = schema.get("properties", {})
            additional = schema.get("additionalProperties", True)
            for key, value in instance.items():
                child_path = f"{path_str}.{key}"
                if key in props:
                    self.validate(value, props[key], child_path, current_doc, current_path, errors)
                elif additional is False:
                    errors.append(f"{path_str}: additional property {key!r} is not allowed")
                elif isinstance(additional, dict):
                    self.validate(value, additional, child_path, current_doc, current_path, errors)

        if isinstance(instance, list):
            if "minItems" in schema and len(instance) < schema["minItems"]:
                errors.append(f"{path_str}: {len(instance)} items is below minItems {schema['minItems']}")
            if "maxItems" in schema and len(instance) > schema["maxItems"]:
                errors.append(f"{path_str}: {len(instance)} items exceeds maxItems {schema['maxItems']}")
            if "items" in schema:
                for i, item in enumerate(instance):
                    self.validate(item, schema["items"], f"{path_str}[{i}]", current_doc, current_path, errors)


def validate_file(instance_path, schema_path):
    """Returns a list of error strings (empty means valid)."""
    instance = json.loads(instance_path.read_text(encoding="utf-8"))
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validator = Validator(schema_path.parent)
    errors = []
    validator.validate(instance, schema, "$", schema, schema_path, errors)
    return errors


def main():
    if len(sys.argv) != 3:
        print("usage: schema_check.py <instance.json> <schema.json>", file=sys.stderr)
        sys.exit(2)

    instance_path = Path(sys.argv[1])
    schema_path = Path(sys.argv[2])
    for p in (instance_path, schema_path):
        if not p.exists() or p.stat().st_size == 0:
            print(f"error: missing or empty file: {p}", file=sys.stderr)
            sys.exit(2)

    try:
        errors = validate_file(instance_path, schema_path)
    except (json.JSONDecodeError, SchemaError) as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(2)

    if errors:
        for e in errors:
            print(e)
        sys.exit(1)

    print("OK")
    sys.exit(0)


if __name__ == "__main__":
    main()
