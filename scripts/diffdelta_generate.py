import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

STATE_PATH = os.path.join(ROOT, "diff", "source", "moltbook", "_state.json")
MOLT_LATEST_PATH = os.path.join(ROOT, "diff", "source", "moltbook", "latest.json")
TOP_LATEST_PATH = os.path.join(ROOT, "diff", "latest.json")
KNOWN_ISSUES_PATH = os.path.join(ROOT, "known_issues.json")

MOLTBOOK_POSTS_URL = "https://www.moltbook.com/api/v1/posts?sort=new&limit=50"

TTL_SEC = 60
MAX_ITEMS = 50


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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


def parse_iso(ts: str) -> datetime:
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    return datetime.fromisoformat(ts)


def make_cursor(ts_iso: str, stable_id: str) -> str:
    return f"{ts_iso}|{stable_id}"


def cursor_parts(cur: str) -> Tuple[Optional[datetime], Optional[str]]:
    if not cur or "|" not in cur:
        return None, None
    ts, sid = cur.split("|", 1)
    try:
        return parse_iso(ts), sid
    except Exception:
        return None, sid


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
    if isinstance(data, dict) and "posts" in data and isinstance(data["posts"], list):
        return data["posts"]
    if isinstance(data, list):
        return data
    raise ValueError(f"Unexpected Moltbook response shape: {type(data)}")


def normalize_post(p: Dict[str, Any]) -> Dict[str, Any]:
    pid = p.get("id") or p.get("post_id")
    url = p.get("url") or (f"https://www.moltbook.com/post/{pid}" if pid else None)

    created = p.get("created_at") or p.get("createdAt")
    updated = p.get("updated_at") or p.get("updatedAt") or created

    if not pid:
        fallback = url or f"{p.get('title','')}\n{created or ''}"
        pid = sha256(fallback)[:32]

    ts = updated or created or now_iso()

    return {
        "id": str(pid),
        "ts": ts,
        "created_at": created,
        "updated_at": updated,
        "url": url,
        "title": p.get("title"),
        "content_preview": (p.get("content") or "")[:280] if isinstance(p.get("content"), str) else None,
        "author": (p.get("author") or {}).get("name") if isinstance(p.get("author"), dict) else p.get("author"),
        "submolt": p.get("submolt") or p.get("community"),
        "score": p.get("score") or p.get("upvotes"),
        "comment_count": p.get("comment_count") or p.get("comments"),
    }


def compute_changed(prev_state: Dict[str, Any], items: List[Dict[str, Any]]) -> Tuple[bool, str, List[Dict[str, Any]]]:
    prev_cursor = prev_state.get("cursor", "")
    prev_seen = set(prev_state.get("seen_ids", []))

    items_sorted = sorted(
        items,
        key=lambda x: (parse_iso(x["ts"]) if x.get("ts") else datetime.min.replace(tzinfo=timezone.utc), x["id"]),
        reverse=True,
    )[:MAX_ITEMS]

    if not items_sorted:
        return False, prev_cursor or make_cursor(now_iso(), "empty"), []

    newest = items_sorted[0]
    new_cursor = make_cursor(newest["ts"], newest["id"])

    prev_ts, _ = cursor_parts(prev_cursor)
    changed = False

    for it in items_sorted:
        if it["id"] not in prev_seen:
            changed = True
            continue
        if prev_ts and it.get("ts"):
            try:
                if parse_iso(it["ts"]) > prev_ts:
                    changed = True
            except Exception:
                pass

    final_cursor = new_cursor if changed else (prev_cursor or new_cursor)

    next_seen = list(dict.fromkeys([it["id"] for it in items_sorted] + list(prev_seen)))[:500]
    next_state = {"cursor": final_cursor, "seen_ids": next_seen, "last_run_at": now_iso()}
    write_json_atomic(STATE_PATH, next_state)

    return changed, final_cursor, items_sorted


def set_known_issues(issues: List[Dict[str, Any]]) -> None:
    write_json_atomic(KNOWN_ISSUES_PATH, {"issues": issues, "updated_at": now_iso()})


def build_feed(source: str, cursor: str, changed: bool, items: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "schema_version": "v1",
        "source": source,
        "generated_at": now_iso(),
        "ttl_sec": TTL_SEC,
        "cursor": cursor,
        "changed": changed,
        "items": items,
    }


def main() -> None:
    prev_state = read_json(STATE_PATH, default={})
    try:
        raw_posts = fetch_moltbook_posts()
        norm = [normalize_post(p) for p in raw_posts]
        changed, cursor, items = compute_changed(prev_state, norm)

        molt_feed = build_feed("moltbook", cursor, changed, items)
        write_json_atomic(MOLT_LATEST_PATH, molt_feed)

        top_feed = build_feed("all", cursor, changed, [{"source": "moltbook", **it} for it in items])
        write_json_atomic(TOP_LATEST_PATH, top_feed)

        set_known_issues([])
        print(f"OK: changed={changed} items={len(items)} cursor={cursor}")
    except Exception as e:
        issue = {
            "id": "moltbook_fetch_failed",
            "source": "moltbook",
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
