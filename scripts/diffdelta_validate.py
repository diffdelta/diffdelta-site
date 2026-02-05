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

def validate_json(schema_path, doc_path):
    if not os.path.exists(schema_path):
        print(f"SKIP: Schema not found at {schema_path}")
        return
    schema = load(schema_path)
    doc = load(doc_path)
    Draft202012Validator(schema).validate(doc)

def endpoint_to_repo_path(endpoint: str) -> str:
    if endpoint.startswith("http://") or endpoint.startswith("https://"):
        endpoint = urlparse(endpoint).path
    endpoint = endpoint.strip().lstrip("/")
    return os.path.join(ROOT, endpoint)

def check_logic_invariants(feed_path):
    """
    Ensures the 'Bot Contract' is met:
    1. If changed is false, cursor must equal prev_cursor.
    2. All 4 buckets must exist as arrays.
    """
    feed = load(feed_path)
    changed = feed.get("changed", False)
    cursor = feed.get("cursor")
    prev_cursor = feed.get("prev_cursor")

    # Invariant: Cursor Stability
    if not changed and cursor != prev_cursor:
        raise ValueError(f"CRITICAL: Cursor instability in {feed_path}. changed=false but cursor moved.")

    # Invariant: Bucket Presence
    # Check if buckets are nested (Phase 1 schema) or top-level (legacy)
    buckets_obj = feed.get("buckets", feed)
    for bucket in ["new", "updated", "removed", "flagged"]:
        if bucket not in buckets_obj or not isinstance(buckets_obj[bucket], list):
            raise ValueError(f"CRITICAL: Missing or invalid bucket '{bucket}' in {feed_path}")

def main():
    print("--- Starting DiffDelta Validation ---")
    
    # Parse command-line arguments
    feed_path = None
    if len(sys.argv) > 1:
        feed_path = sys.argv[1]
        # Resolve relative paths relative to ROOT
        if not os.path.isabs(feed_path):
            feed_path = os.path.join(ROOT, feed_path)
        feed_path = os.path.normpath(feed_path)
    
    wk = load(WELL_KNOWN)

    # 1) Check Well-Known Endpoints
    for k in ["diff_latest", "known_issues", "healthz"]:
        ep = wk.get("endpoints", {}).get(k)
        if not ep:
            raise RuntimeError(f"Discovery missing endpoint key: {k}")
        
        path = endpoint_to_repo_path(ep)
        if not os.path.exists(path):
            raise RuntimeError(f"File missing on disk for endpoint {k}: {path}")

    # 2) Schema Validation
    diff_schema = os.path.join(SCHEMA_DIR, "diff.schema.json")
    known_schema = os.path.join(SCHEMA_DIR, "known_issues.schema.json")
    telemetry_schema = os.path.join(SCHEMA_DIR, "telemetry.schema.json")

    # If a specific feed path was provided, validate only that file
    if feed_path:
        if not os.path.exists(feed_path):
            raise FileNotFoundError(f"Feed file not found: {feed_path}")
        print(f"Validating {feed_path}...")
        validate_json(diff_schema, feed_path)
        check_logic_invariants(feed_path)
    else:
        # Default: validate all known feeds dynamically
        feeds = [os.path.join(ROOT, "diff", "latest.json")]  # Always validate global feed
        
        # Dynamically discover per-source feeds from .well-known/diffdelta.json
        sources_supported = wk.get("sources_supported", [])
        if sources_supported:
            for source_id in sources_supported:
                source_feed_path = os.path.join(ROOT, "diff", "source", source_id, "latest.json")
                if os.path.exists(source_feed_path):
                    feeds.append(source_feed_path)
        else:
            # Fallback: discover all feeds in diff/source/*/latest.json
            source_dir = os.path.join(ROOT, "diff", "source")
            if os.path.exists(source_dir):
                for item in os.listdir(source_dir):
                    source_feed_path = os.path.join(source_dir, item, "latest.json")
                    if os.path.exists(source_feed_path):
                        feeds.append(source_feed_path)

        for f in feeds:
            if os.path.exists(f):
                print(f"Validating {f}...")
                validate_json(diff_schema, f)
                check_logic_invariants(f)

    # 3) Known Issues & Telemetry
    if os.path.exists(known_schema):
        validate_json(known_schema, os.path.join(ROOT, "known_issues.json"))

    if os.path.exists(telemetry_schema):
        validate_json(telemetry_schema, TELEMETRY_LATEST)

    print("--- OK: All Invariants Passed ---")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"VALIDATION ERROR: {e}", file=sys.stderr)
        sys.exit(1)
