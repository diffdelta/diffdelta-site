import json
import os
import sys
from jsonschema import Draft202012Validator

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

WELL_KNOWN = os.path.join(ROOT, ".well-known", "diffdelta.json")
SCHEMA_DIR = os.path.join(ROOT, "schema", "v1")

def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def validate(schema_path, doc_path):
    schema = load(schema_path)
    doc = load(doc_path)
    Draft202012Validator(schema).validate(doc)

def main():
    wk = load(WELL_KNOWN)

    # 1) endpoints listed in discovery exist in repo
    for k in ["diff_latest", "known_issues", "healthz"]:
        rel = wk["endpoints"].get(k)
        if not rel:
            raise RuntimeError(f"Missing endpoint in discovery: {k}")
        path = os.path.join(ROOT, rel.lstrip("/"))
        if not os.path.exists(path):
            raise RuntimeError(f"Discovery endpoint missing on disk: {rel}")

    # 2) validate payloads if the schemas exist under your naming
    # Adjust these filenames if yours differ.
    diff_schema = os.path.join(SCHEMA_DIR, "diff.schema.json")
    known_schema = os.path.join(SCHEMA_DIR, "known_issues.schema.json")

    if os.path.exists(diff_schema):
        validate(diff_schema, os.path.join(ROOT, "diff", "latest.json"))
        validate(diff_schema, os.path.join(ROOT, "diff", "source", "moltbook", "latest.json"))

    if os.path.exists(known_schema):
        validate(known_schema, os.path.join(ROOT, "known_issues.json"))

    print("OK: validation passed")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"VALIDATION ERROR: {e}", file=sys.stderr)
        sys.exit(1)
