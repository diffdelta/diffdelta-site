import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple, Optional

import requests

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

STATE_PATH = os.path.join(ROOT, "diff", "source", "moltbook", "_state.json")
MOLT_LATEST_PATH = os.path.join(ROOT, "diff", "source", "moltbook", "latest.json")
TOP_LATEST_PATH = os.path.join(ROOT, "diff", "latest.json")
KNOWN_ISSUES_PATH = os.path.join(ROOT, "known_issues.json")
TELEMETRY_PATH = os.path.join(ROOT, "telemetry", "latest.json")

MOLTBOOK_POSTS_URL = "https://www.moltbook.com/api/v1/posts?sort=new&limit=50"

# Must satisfy schema constraints
SCHEMA_VERSION = "1.0.0"
TTL_SEC = 60
TARGET_MAX_PAYLOAD_KB = 256
GENERATOR_VERSION = "moltbook-gen/1.0.0"
SOURCE_NAME = "moltbook"

MAX_ITEMS = 50
MAX_SUMMARY_LEN = 1200


# --- time helpers ---

def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(ts: str) -> Optional[datetime]:
    if not ts or not isinstance(ts, str):
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        return datetime.fromisoformat(ts)
    except Exception:
        return None


# --- cursor helpers (Fix B) ---

def make_cursor(updated_at: str, stable_id: str) -> str:
    return f"{updated_at}|{stable_id}"


def parse_cursor(cursor: str) -> Tuple[datetime, str]:
    """
    Cursor format: "{iso_ts}|{stable_id}"
    Returns (ts_dt_utc, id_str). Falls back to epoch on bad input.
    """
    if not cursor or not isinstance(cursor, str) or "|" not in cursor:
        return datetime(1970, 1, 1, tzinfo=timezone.utc), ""
    ts, sid = cursor.split("|", 1)
    dt = parse_iso(ts) or datetime(1970, 1, 1, tzinfo=timezone.utc)
    return dt, (sid or "")


def is_after_cursor(updated_at: str, pid: str, boundary_cursor: str) -> bool:
    """
    True if (updated_at, pid) is strictly newer than boundary_cursor.
    Tie-break: updated_at equal -> pid lexicographically greater.
    """
    bdt, bid = parse_cursor(boundary_cursor)
    udt = parse_iso(updated_at) or datetime(1970, 1, 1, tzinfo=timezone.utc)

    if udt > bdt:
        return True
    if udt < bdt:
        return False
    return str(pid) > str(bid)


# --- json io ---

def read_json(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json_atomic(path: str, obj: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(obj: Any) -> bytes:
    """Generate canonical JSON bytes for deterministic hashing."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def compute_content_hash(item: Dict[str, Any]) -> str:
    """Compute deterministic hash of item's canonical content."""
    # Build canonical representation (exclude timestamps, IDs, etc.)
    canonical = {
        "title": (item.get("title") or "").strip(),
        "content": (item.get("content") or "").strip(),
        "url": (item.get("url") or "").strip(),
    }
    return sha256_bytes(canonical_json(canonical))


def load_prev_published_cursor() -> str:
    """
    Fix B: the emit boundary comes from the *previous published feed*,
    not from private state.
    """
    prev_feed = read_json(MOLT_LATEST_PATH, default={})
    if isinstance(prev_feed, dict):
        c = prev_feed.get("cursor")
        if isinstance(c, str) and c:
            return c
    return "init|0"


# --- moltbook fetch ---

def moltbook_headers() -> Dict[str, str]:
    headers = {"Accept": "application/json"}
    key = os.environ.get("MOLTBOOK_API_KEY")
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def fetch_moltbook_posts() -> Tuple[List[Dict[str, Any]], int]:
    """
    Returns (posts, http_status_code)
    """
    r = requests.get(MOLTBOOK_POSTS_URL, headers=moltbook_headers(), timeout=20)
    status = int(r.status_code)
    r.raise_for_status()
    data = r.json()

    # Accept either {posts:[...]} or [...]
    if isinstance(data, dict) and isinstance(data.get("posts"), list):
        return data["posts"], status
    if isinstance(data, list):
        return data, status
    raise ValueError(f"Unexpected Moltbook response shape: {type(data)}")


# --- normalization + diff logic aligned to your schema ---

def best_effort_post_id(p: Dict[str, Any]) -> str:
    """
    Moltbook payloads can vary. Prefer canonical post UUIDs, even if nested.
    Fall back to a stable hash ONLY if we truly can't find an id.
    """
    # Common direct keys
    for k in ("id", "post_id", "postId"):
        v = p.get(k)
        if v:
            return str(v)

    # Common nested containers
    for container_key in ("post", "data", "item"):
        c = p.get(container_key)
        if isinstance(c, dict):
            for k in ("id", "post_id", "postId"):
                v = c.get(k)
                if v:
                    return str(v)

    # Fall back to stable-ish hash
    url = p.get("url") or ""
    created = p.get("created_at") or p.get("createdAt") or ""
    title = p.get("title") or ""
    content = p.get("content") or ""
    return sha256(f"{url}\n{created}\n{title}\n{content}")[:32]


def best_effort_url(p: Dict[str, Any], pid: str) -> str:
    url = p.get("url")
    if isinstance(url, str) and url.startswith("http"):
        return url
    return f"https://www.moltbook.com/post/{pid}"


def best_effort_times(p: Dict[str, Any]) -> Tuple[str, str]:
    created = p.get("created_at") or p.get("createdAt")
    updated = p.get("updated_at") or p.get("updatedAt") or created

    created_dt = parse_iso(created) if isinstance(created, str) else None
    updated_dt = parse_iso(updated) if isinstance(updated, str) else None

    if not created_dt:
        created = now_iso()
    else:
        created = created_dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")

    if not updated_dt:
        updated = created
    else:
        updated = updated_dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")

    return created, updated


def content_fingerprint(p: Dict[str, Any]) -> str:
    """
    Used to detect content changes (optional). Keep it stable and cheap.
    """
    title = p.get("title") or ""
    content = p.get("content") or ""
    score = p.get("score") or p.get("upvotes") or ""
    comments = p.get("comment_count") or p.get("comments") or ""
    return sha256(f"{title}\n{content}\n{score}\n{comments}")[:32]


# --- risk / flags (defensive; no exploit content) ---

TOKEN_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),  # JWT
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),  # AWS access key id
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),  # GitHub tokens
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]

KEYWORDS = {
    "api_key": "possible_secret",
    "private_key": "possible_secret",
    "api key": "possible_secret",
    "apikey": "possible_secret",
    "access key": "possible_secret",
    "secret key": "possible_secret",
    "private key": "possible_secret",
    "mnemonic": "possible_secret",
    "seed phrase": "possible_secret",
    "bearer": "possible_secret",
    "authorization": "possible_secret",
    "jwt": "possible_secret",

    "supabase": "security_incident_terms",
    "data leak": "security_incident_terms",
    "db leak": "security_incident_terms",
    "database leak": "security_incident_terms",
    "credential leak": "security_incident_terms",
    "key leak": "security_incident_terms",
    "data dump": "security_incident_terms",
    "database dump": "security_incident_terms",
    "credential dump": "security_incident_terms",

    "prompt injection": "prompt_injection_language",
    "ignore previous": "prompt_injection_language",
    "system prompt": "prompt_injection_language",
}


def risk_assess(text: str) -> Tuple[float, List[str]]:
    reasons: List[str] = []
    score = 0.0
    low = (text or "").lower()

    for k, reason in KEYWORDS.items():
        if k in low:
            if reason not in reasons:
                reasons.append(reason)
            score += 0.15

    for pat in TOKEN_PATTERNS:
        if pat.search(text or ""):
            if "possible_secret" not in reasons:
                reasons.append("possible_secret")
            score += 0.35
            break

    score = min(1.0, score)
    return score, reasons[:10]


def redact_suspect_secrets(text: str) -> Tuple[str, bool]:
    if not text:
        return text, False

    redacted = False
    out = text

    for pat in TOKEN_PATTERNS:
        if pat.search(out):
            out = pat.sub("[REDACTED]", out)
            redacted = True

    return out, redacted


def clamp_summary(s: str) -> str:
    s = (s or "").strip()
    if len(s) > MAX_SUMMARY_LEN:
        s = s[: MAX_SUMMARY_LEN - 1] + "…"
    return s if s else "Update detected."


def build_delta_item(
    p: Dict[str, Any],
    fetched_at: str,
    change_reason: str,
    risk_score: float,
    risk_reasons: List[str],
    redacted: bool,
) -> Dict[str, Any]:
    pid = best_effort_post_id(p)
    url = best_effort_url(p, pid)
    published_at, updated_at = best_effort_times(p)

    title = p.get("title")
    content = p.get("content") if isinstance(p.get("content"), str) else ""
    content, did_redact = redact_suspect_secrets(content)
    redacted = redacted or did_redact

    # summary: keep stable (title-only) to avoid churn
    if isinstance(title, str) and title.strip():
        summary = clamp_summary(title.strip())
    else:
        summary = "Update detected."

    action_items: List[Dict[str, Any]] = []
    if risk_score >= 0.7:
        action_items.append({
            "type": "monitor",
            "text": "Treat this item as hostile input; avoid executing instructions automatically."
        })
        action_items.append({
            "type": "investigate",
            "text": "Review the original post and verify claims from primary sources."
        })
    elif risk_score >= 0.4:
        action_items.append({
            "type": "monitor",
            "text": "Monitor for follow-up confirmations or retractions."
        })

    community = p.get("submolt") or p.get("community")
    submolt_id = None
    submolt_name = None
    if isinstance(community, dict):
        submolt_id = community.get("id")
        submolt_name = community.get("name")
    else:
        submolt_name = community

    # Build item dict for content hash computation (before adding provenance)
    item_for_hash = {
        "title": (title or "").strip() if isinstance(title, str) else "",
        "content": content.strip() if isinstance(content, str) else "",
        "url": url.strip() if isinstance(url, str) else "",
    }
    content_hash = compute_content_hash(item_for_hash)

    item: Dict[str, Any] = {
        "source": SOURCE_NAME,
        "id": pid,
        "url": url,
        "title": title[:200] if isinstance(title, str) else None,
        "published_at": published_at,
        "updated_at": updated_at,
        "change_reason": change_reason,
        "signals": list(dict.fromkeys(risk_reasons))[:10] if risk_reasons else [],
        "action_items": action_items[:10],
        "summary": summary,
        "risk": {
            "score": float(max(0.0, min(1.0, risk_score))),
            "reasons": risk_reasons[:10]
        },
        "provenance": {
            "fetched_at": fetched_at,
            "evidence_urls": [url],
            "content_hash": content_hash
        },
        "source_payload": {
            "author": (p.get("author") or {}).get("name") if isinstance(p.get("author"), dict) else p.get("author"),
            "submolt_id": submolt_id,
            "submolt_name": submolt_name,
            "score": p.get("score") or p.get("upvotes"),
            "comment_count": p.get("comment_count") or p.get("comments"),
            "redacted": redacted,
        },
    }

    if item.get("title") is None:
        item.pop("title", None)

    sp = item.get("source_payload", {})
    if isinstance(sp, dict):
        item["source_payload"] = {k: v for k, v in sp.items() if v is not None}

    return item


def compute_buckets(prev_state: Dict[str, Any], posts: List[Dict[str, Any]]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Fix B: emit boundary is prev_cursor (from published feed).
    _state.json remains optional for content fingerprint tracking.
    """
    fetched_at = now_iso()

    prev_cursor = prev_state.get("cursor") or "init|0"
    prev_hash_by_id: Dict[str, str] = prev_state.get("hash_by_id") or {}

    normalized: List[Dict[str, Any]] = []
    for p in posts:
        pid = best_effort_post_id(p)
        published_at, updated_at = best_effort_times(p)
        fp = content_fingerprint(p)
        normalized.append({
            "_raw": p,
            "id": pid,
            "published_at": published_at,
            "updated_at": updated_at,
            "fp": fp,
        })

    # Sort newest -> oldest
    normalized.sort(
        key=lambda x: (parse_iso(x["updated_at"]) or datetime.min.replace(tzinfo=timezone.utc), x["id"]),
        reverse=True
    )
    normalized = normalized[:MAX_ITEMS]

    # Frontier cursor represents newest observed item (even if we emit nothing)
    if normalized:
        frontier_cursor = make_cursor(normalized[0]["updated_at"], normalized[0]["id"])
    else:
        frontier_cursor = prev_cursor

    bucket_new: List[Dict[str, Any]] = []
    bucket_updated: List[Dict[str, Any]] = []
    bucket_removed: List[Dict[str, Any]] = []
    bucket_flagged: List[Dict[str, Any]] = []

    next_hash_by_id: Dict[str, str] = dict(prev_hash_by_id)
    next_seen_ids: List[str] = []  # retained only for future use / debugging

    changed = False

    for row in normalized:
        pid = row["id"]
        p = row["_raw"]
        fp = row["fp"]
        
        # Risk assessment for both New and Updated items
        title = p.get("title") if isinstance(p.get("title"), str) else ""
        content = p.get("content") if isinstance(p.get("content"), str) else ""
        risk_score, risk_reasons = risk_assess(f"{title}\n{content}")

        # LOGIC A: Is it strictly NEW? (Beyond the cursor)
        if is_after_cursor(row["updated_at"], pid, prev_cursor):
            item = build_delta_item(p, fetched_at, "new_item", risk_score, risk_reasons, redacted=False)
            changed = True
            # Quarantine: flagged items go ONLY to flagged bucket, not to new/updated
            if risk_score >= 0.7:
                bucket_flagged.append(item)
            else:
                bucket_new.append(item)
        
        # LOGIC B: Is it an UPDATE? (Behind cursor but fingerprint changed)
        else:
            old_hash = prev_hash_by_id.get(pid)
            if old_hash and fp != old_hash:
                item = build_delta_item(p, fetched_at, "content_edit", risk_score, risk_reasons, redacted=False)
                changed = True
                # Quarantine: flagged items go ONLY to flagged bucket, not to new/updated
                if risk_score >= 0.7:
                    bucket_flagged.append(item)
                else:
                    bucket_updated.append(item)

        # Always track seen IDs and hashes for the next state
        next_seen_ids.append(pid)
        next_hash_by_id[pid] = fp

    # Cursor invariant: if changed=false, cursor must equal prev_cursor
    next_cursor = frontier_cursor if changed else prev_cursor

    # Keep hash map bounded / relevant
    next_seen_ids = list(dict.fromkeys(next_seen_ids))[:500]
    if next_seen_ids:
        next_hash_by_id = {k: v for k, v in next_hash_by_id.items() if k in set(next_seen_ids)}
    else:
        # If we emitted nothing, keep prior hashes as-is (optional)
        next_hash_by_id = prev_hash_by_id

    # Generate batch_narrative (required per SPEC.md)
    total_changes = len(bucket_new) + len(bucket_updated)
    if total_changes == 0:
        batch_narrative = f"{SOURCE_NAME}: No changes detected."
    elif total_changes == 1:
        item = (bucket_new + bucket_updated)[0]
        title = item.get("title") or item.get("summary", "item")
        change_type = "new" if item in bucket_new else "updated"
        batch_narrative = f"{SOURCE_NAME}: {change_type} '{title[:40]}'."
    else:
        new_count = len(bucket_new)
        updated_count = len(bucket_updated)
        flagged_count = len(bucket_flagged)
        parts = [f"{SOURCE_NAME}: {total_changes} changes"]
        if new_count > 0 and updated_count > 0:
            parts.append(f"({new_count} new, {updated_count} updated)")
        elif new_count > 0:
            parts.append(f"({new_count} new)")
        elif updated_count > 0:
            parts.append(f"({updated_count} updated)")
        if flagged_count > 0:
            parts.append(f"{flagged_count} flagged")
        batch_narrative = " ".join(parts) + "."
        # Enforce max 30 words per SPEC.md
        words = batch_narrative.split()
        if len(words) > 30:
            batch_narrative = " ".join(words[:30]) + "..."
    
    feed = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": fetched_at,
        "cursor": next_cursor,
        "prev_cursor": prev_cursor,
        "changed": bool(changed),
        "ttl_sec": TTL_SEC,
        "sources_included": [SOURCE_NAME],
        "batch_narrative": batch_narrative,
        "new": bucket_new,
        "updated": bucket_updated,
        "removed": bucket_removed,
        "flagged": bucket_flagged,
        "meta": {
            "target_max_payload_kb": TARGET_MAX_PAYLOAD_KB,
            "generator_version": GENERATOR_VERSION,
        },
    }

    next_state = {
        "cursor": next_cursor,
        "seen_ids": next_seen_ids,
        "hash_by_id": next_hash_by_id,
        "last_run_at": fetched_at,
    }

    return feed, next_state


def set_known_issues(issues: List[Dict[str, Any]]) -> None:
    """
    Avoid churn: don't rewrite known_issues.json if issues array is unchanged.
    """
    new_payload = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now_iso(),
        "issues": issues,
    }

    existing = read_json(KNOWN_ISSUES_PATH, default=None)
    if isinstance(existing, dict):
        if existing.get("schema_version") == new_payload["schema_version"] and existing.get("issues") == issues:
            return

    write_json_atomic(KNOWN_ISSUES_PATH, new_payload)


def write_telemetry(
    fetch_ok: bool,
    status_code: int,
    fetch_duration_ms: int,
    items_fetched: int,
    feed: Dict[str, Any],
) -> None:
    run_id = os.environ.get("GITHUB_RUN_ID") or "local"
    telemetry = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now_iso(),
        "run_id": f"github_actions:{run_id}",
        "source": SOURCE_NAME,
        "fetch": {
            "ok": bool(fetch_ok),
            "status_code": int(status_code),
            "duration_ms": int(fetch_duration_ms),
            "items_fetched": int(items_fetched),
        },
        "emit": {
            "changed": bool(feed.get("changed")),
            "new": len(feed.get("new", [])),
            "updated": len(feed.get("updated", [])),
            "removed": len(feed.get("removed", [])),
            "flagged": len(feed.get("flagged", [])),
        },
        "state": {
            "cursor": feed.get("cursor", ""),
            "prev_cursor": feed.get("prev_cursor", ""),
        },
    }
    write_json_atomic(TELEMETRY_PATH, telemetry)


def main() -> None:
    # Load private state (optional) but cursor boundary comes from published feed
    prev_state = read_json(
        STATE_PATH,
        default={"cursor": "init|0", "seen_ids": [], "hash_by_id": {}, "last_run_at": ""}
    )
    prev_state["cursor"] = load_prev_published_cursor()

    fetch_ok = False
    status_code = 0
    items_fetched = 0
    fetch_duration_ms = 0

    try:
        t0 = datetime.now(timezone.utc)
        posts, status_code = fetch_moltbook_posts()
        fetch_duration_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
        items_fetched = len(posts)
        fetch_ok = True

        feed, next_state = compute_buckets(prev_state, posts)

        # Only write feeds when changed=true to avoid churn commits
        if feed.get("changed"):
            write_json_atomic(MOLT_LATEST_PATH, feed)
            write_json_atomic(TOP_LATEST_PATH, feed)

        # Always write telemetry
        write_telemetry(fetch_ok, status_code, fetch_duration_ms, items_fetched, feed)

        # Clear known issues on success, but no-op if already empty
        set_known_issues([])

        # Persist state last (even if unchanged; not staged by commit step)
        write_json_atomic(STATE_PATH, next_state)

        print(
            f"OK: changed={feed['changed']} new={len(feed['new'])} updated={len(feed['updated'])} "
            f"flagged={len(feed['flagged'])} cursor={feed['cursor']} prev_cursor={feed['prev_cursor']}"
        )

    except Exception as e:
        first_seen = now_iso()
        issue = {
            "issue_key": "moltbook_fetch_failed",
            "status": "active",
            "severity": "high",
            "scope": {"level": "source", "ref": SOURCE_NAME},
            "summary": "Moltbook fetch failed; diff feed may be stale.",
            "details": f"{type(e).__name__}: {e}",
            "first_seen_at": first_seen,
            "last_updated_at": now_iso(),
            "signals": ["endpoint"],
            "sources": [
                {"source": SOURCE_NAME, "url": MOLTBOOK_POSTS_URL, "note": "Fetch URL"},
            ],
            "workarounds": [
                {"text": "Retry after TTL; treat feed as stale until next successful run."}
            ],
        }
        try:
            set_known_issues([issue])
        except Exception:
            pass

        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
