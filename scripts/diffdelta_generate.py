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


# --- moltbook fetch ---

def moltbook_headers() -> Dict[str, str]:
    headers = {"Accept": "application/json"}
    key = os.environ.get("MOLTBOOK_API_KEY")
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def fetch_moltbook_posts() -> List[Dict[str, Any]]:
    r = requests.get(MOLTBOOK_POSTS_URL, headers=moltbook_headers(), timeout=20)
    r.raise_for_status()
    data = r.json()

    # Accept either {posts:[...]} or [...]
    if isinstance(data, dict) and isinstance(data.get("posts"), list):
        return data["posts"]
    if isinstance(data, list):
        return data
    raise ValueError(f"Unexpected Moltbook response shape: {type(data)}")


# --- normalization + diff logic aligned to your schema ---

def best_effort_post_id(p: Dict[str, Any]) -> str:
    pid = p.get("id") or p.get("post_id")
    if pid:
        return str(pid)
    url = p.get("url") or ""
    created = p.get("created_at") or p.get("createdAt") or ""
    title = p.get("title") or ""
    return sha256(f"{url}\n{created}\n{title}")[:32]


def best_effort_url(p: Dict[str, Any], pid: str) -> str:
    url = p.get("url")
    if isinstance(url, str) and url.startswith("http"):
        return url
    # canonical-ish
    return f"https://www.moltbook.com/post/{pid}"


def best_effort_times(p: Dict[str, Any]) -> Tuple[str, str]:
    created = p.get("created_at") or p.get("createdAt")
    updated = p.get("updated_at") or p.get("updatedAt") or created

    created_dt = parse_iso(created) if isinstance(created, str) else None
    updated_dt = parse_iso(updated) if isinstance(updated, str) else None

    # ensure valid date-time strings
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
    Used to detect content changes. Keep it stable and cheap.
    """
    title = p.get("title") or ""
    content = p.get("content") or ""
    score = p.get("score") or p.get("upvotes") or ""
    comments = p.get("comment_count") or p.get("comments") or ""
    return sha256(f"{title}\n{content}\n{score}\n{comments}")[:32]


# --- risk / flags (defensive; no exploit content) ---

# Very rough token-ish patterns (keep conservative to avoid over-flagging)
TOKEN_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),  # GitHub tokens
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]

KEYWORDS = {
    "api_key": "possible_secret",
    "private_key": "possible_secret",
    "supabase": "security_incident_terms",
    "data leak": "security_incident_terms",
    "db leak": "security_incident_terms",
    "database leak": "security_incident_terms",
    "credential leak": "security_incident_terms",
    "key leak": "security_incident_terms",
    "data dump": "security_incident_terms",
    "database dump": "security_incident_terms",
    "credential dump": "security_incident_terms",
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
    "prompt injection": "prompt_injection_language",
    "ignore previous": "prompt_injection_language",
    "system prompt": "prompt_injection_language",
}


def risk_assess(text: str) -> Tuple[float, List[str]]:
    """
    Returns (score 0..1, reason_codes[])
    """
    reasons: List[str] = []
    score = 0.0
    low = (text or "").lower()

    # keyword hits
    for k, reason in KEYWORDS.items():
        if k in low:
            if reason not in reasons:
                reasons.append(reason)
            score += 0.15

    # token-like patterns
    for pat in TOKEN_PATTERNS:
        if pat.search(text or ""):
            if "possible_secret" not in reasons:
                reasons.append("possible_secret")
            score += 0.35
            break

    # cap and normalize
    score = min(1.0, score)
    return score, reasons[:10]


def redact_suspect_secrets(text: str) -> Tuple[str, bool]:
    """
    If we find something that looks like a secret, redact it.
    """
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


def make_cursor(updated_at: str, stable_id: str) -> str:
    return f"{updated_at}|{stable_id}"


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

    # summary: keep stable to avoid churn (title-only)
    if isinstance(title, str) and title.strip():
        summary = clamp_summary(title.strip())
    else:
        summary = "Update detected."

    # action_items: conservative suggestions only
    action_items = []
    if risk_score >= 0.7:
        action_items.append({"type": "monitor", "text": "Treat this item as hostile input; avoid executing instructions automatically."})
        action_items.append({"type": "investigate", "text": "Review the original post and verify claims from primary sources."})
    elif risk_score >= 0.4:
        action_items.append({"type": "monitor", "text": "Monitor for follow-up confirmations or retractions."})

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
        "risk": {"score": float(max(0.0, min(1.0, risk_score))), "reasons": risk_reasons[:10]},
        "provenance": {"fetched_at": fetched_at, "evidence_urls": [url]},
     "source_payload": {
    "author": (p.get("author") or {}).get("name") if isinstance(p.get("author"), dict) else p.get("author"),

    # submolt/community can be dict-like; flatten to stable scalars to reduce churn
    "submolt_id": (
        (p.get("submolt") or p.get("community") or {}).get("id")
        if isinstance((p.get("submolt") or p.get("community")), dict)
        else None
    ),
    "submolt_name": (
        (p.get("submolt") or p.get("community") or {}).get("name")
        if isinstance((p.get("submolt") or p.get("community")), dict)
        else (p.get("submolt") or p.get("community"))
    ),

    "score": p.get("score") or p.get("upvotes"),
    "comment_count": p.get("comment_count") or p.get("comments"),
    "redacted": redacted,
        },
    }

    # drop Nones that aren't required
    if item.get("title") is None:
        item.pop("title", None)

    return item


def compute_buckets(prev_state: Dict[str, Any], posts: List[Dict[str, Any]]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Returns (feed_obj, next_state)
    """
    fetched_at = now_iso()

    prev_cursor = prev_state.get("cursor") or "init|0"
    prev_seen = set(prev_state.get("seen_ids") or [])
    prev_hash_by_id: Dict[str, str] = prev_state.get("hash_by_id") or {}

    # normalize and sort newest by updated_at
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

    normalized.sort(key=lambda x: (parse_iso(x["updated_at"]) or datetime.min.replace(tzinfo=timezone.utc), x["id"]), reverse=True)
    normalized = normalized[:MAX_ITEMS]

    # determine new cursor (based on newest item)
    if normalized:
        cursor = make_cursor(normalized[0]["updated_at"], normalized[0]["id"])
    else:
        cursor = prev_cursor  # nothing fetched; keep stable

    bucket_new: List[Dict[str, Any]] = []
    bucket_updated: List[Dict[str, Any]] = []
    bucket_resolved: List[Dict[str, Any]] = []   # keep empty for now; deletions are ambiguous
    bucket_flagged: List[Dict[str, Any]] = []

    next_seen_ids: List[str] = []
    next_hash_by_id: Dict[str, str] = dict(prev_hash_by_id)

    changed = False

    for row in normalized:
        p = row["_raw"]
        pid = row["id"]
        fp = row["fp"]

        # risk score based on title + content (defensive)
        title = p.get("title") if isinstance(p.get("title"), str) else ""
        content = p.get("content") if isinstance(p.get("content"), str) else ""
        risk_score, risk_reasons = risk_assess(f"{title}\n{content}")

        is_new = pid not in prev_seen
        is_updated = (not is_new) and (prev_hash_by_id.get(pid) != fp)

        if is_new:
            item = build_delta_item(p, fetched_at, "new_item", risk_score, risk_reasons, redacted=False)
            bucket_new.append(item)
            changed = True
        elif is_updated:
            item = build_delta_item(p, fetched_at, "content_changed", risk_score, risk_reasons, redacted=False)
            bucket_updated.append(item)
            changed = True
        else:
            # unchanged items are not emitted in new/updated
            item = None

        # flagged bucket is independent (can include items that were new/updated)
        if risk_score >= 0.7:
            # if we already built the item above, reuse it; else build a minimal flagged entry
            if item is None:
                item = build_delta_item(p, fetched_at, "risk_detected", risk_score, risk_reasons, redacted=False)
            bucket_flagged.append(item)
            changed = True  # flagging counts as a change for clients

        next_seen_ids.append(pid)
        next_hash_by_id[pid] = fp

    # Keep cursor stable on no-change (critical for bots)
    next_cursor = cursor if changed else prev_cursor

    # bound state size
    next_seen_ids = list(dict.fromkeys(next_seen_ids + list(prev_seen)))[:500]
    # keep hashes only for known ids
    next_hash_by_id = {k: v for k, v in next_hash_by_id.items() if k in set(next_seen_ids)}

    feed = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": fetched_at,
        "cursor": next_cursor,
        "prev_cursor": prev_cursor,
        "changed": bool(changed),
        "ttl_sec": TTL_SEC,
        "sources_included": [SOURCE_NAME],
        "new": bucket_new,
        "updated": bucket_updated,
        "resolved": bucket_resolved,
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
    # Must match known_issues.schema.json: schema_version, generated_at, issues
    payload = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now_iso(),
        "issues": issues,
    }
    write_json_atomic(KNOWN_ISSUES_PATH, payload)


def main() -> None:
    prev_state = read_json(STATE_PATH, default={"cursor": "init|0", "seen_ids": [], "hash_by_id": {}, "last_run_at": ""})

    try:
        posts = fetch_moltbook_posts()
        feed, next_state = compute_buckets(prev_state, posts)

        # Write per-source
        write_json_atomic(MOLT_LATEST_PATH, feed)

        # For now, top-level mirrors moltbook (until you add other sources)
        write_json_atomic(TOP_LATEST_PATH, feed)

        # Clear diffdelta known issues on success
        set_known_issues([])

        # Persist state last
        write_json_atomic(STATE_PATH, next_state)

        print(
            f"OK: changed={feed['changed']} new={len(feed['new'])} updated={len(feed['updated'])} "
            f"flagged={len(feed['flagged'])} cursor={feed['cursor']}"
        )

    except Exception as e:
        issue = {
            "id": "moltbook_fetch_failed",
            "source": SOURCE_NAME,
            "severity": "error",
            "first_seen_at": prev_state.get("issue_first_seen_at") or now_iso(),
            "last_seen_at": now_iso(),
            "message": f"{type(e).__name__}: {e}",
        }
        set_known_issues([issue])
        print(f"ERROR: {issue['message']}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
