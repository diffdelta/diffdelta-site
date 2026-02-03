import json
import os
import sys
from urllib.parse import urlparse

from jsonschema import Draft202012Validator

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

WELL_KNOWN = os.path.join(ROOT, ".well-known", "diffdelta.json")
SCHEMA_DIR = os.path.join(ROOT, "schema", "v1")
TELEMETRY_LATEST = os.path.join(ROOT, "telemetry", "latest.json")


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def validate(schema_path, doc_path):
    schema = load(schema_path)
    doc = load(doc_path)
    Draft202012Validator(schema).validate(doc)


def endpoint_to_repo_path(endpoint: str) -> str:
    """
    Accepts:
      - "/diff/latest.json"
      - "diff/latest.json"
      - "https://diffdelta.io/diff/latest.json"
    Returns absolute path to the file in the repo checkout.
    """
    if endpoint.startswith("http://") or endpoint.startswith("https://"):
        endpoint = urlparse(endpoint).path  # "/diff/latest.json"

    endpoint = endpoint.strip()
    if endpoint.startswith("/"):
        endpoint = endpoint[1:]  # "diff/latest.json"

    return os.path.join(ROOT, endpoint)


def main():
    wk = load(WELL_KNOWN)

    # 1) endpoints listed in discovery exist in repo
    # Adjust keys here if your well-known uses different names.
    for k in ["diff_latest", "known_issues", "healthz"]:
        ep = wk.get("endpoints", {}).get(k)
        if not ep:
            raise RuntimeError(f"Missing endpoint in discovery: {k}")

        path = endpoint_to_repo_path(ep)
        if not os.path.exists(path):
            raise RuntimeError(f"Discovery endpoint missing on disk: {ep} -> {path}")

    # 1b) telemetry exists (not yet required in discovery)
    if not os.path.exists(TELEMETRY_LATEST):
        raise RuntimeError(f"Telemetry missing on disk: {TELEMETRY_LATEST}")

    # 2) validate payloads if schemas exist under your naming
    diff_schema = os.path.join(SCHEMA_DIR, "diff.schema.json")
    known_schema = os.path.join(SCHEMA_DIR, "known_issues.schema.json")

    if os.path.exists(diff_schema):
        validate(diff_schema, os.path.join(ROOT, "diff", "latest.json"))
        validate(diff_schema, os.path.join(ROOT, "diff", "source", "moltbook", "latest.json"))

    if os.path.exists(known_schema):
        validate(known_schema, os.path.join(ROOT, "known_issues.json"))

    telemetry_schema = os.path.join(SCHEMA_DIR, "telemetry.schema.json")
    if os.path.exists(telemetry_schema):
    validate(telemetry_schema, TELEMETRY_LATEST)

    print("OK: validation passed")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"VALIDATION ERROR: {e}", file=sys.stderr)
        sys.exit(1)
