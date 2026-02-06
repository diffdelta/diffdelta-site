#!/usr/bin/env python3
"""
DiffDelta Reference Client — Python

Zero external dependencies. Uses only the Python standard library.
Implements the DiffDelta Feed Spec v1.1 polling protocol.

**Key behavior:** Every call to ``poll()`` or ``fetch_latest()`` goes
through head.json first, sends ``If-None-Match`` with the cached ETag,
and only fetches the full payload when content has actually changed.
This is not optional — it's how the protocol scales.  At 100,000 bots,
skipping head.json turns a 200-byte 304 into a 50 KB full fetch.

Usage:
    from diffdelta_client import DiffDeltaClient

    client = DiffDeltaClient("https://diffdelta.io")

    # Recommended: use poll() — it does head-first automatically
    result = client.poll("aws_whats_new")
    if result is not None:
        for item in result["buckets"]["new"]:
            print(item["headline"])
"""

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.request import Request, urlopen
from urllib.error import HTTPError

__version__ = "0.2.0"

# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

_DEFAULT_CACHE_DIR = Path.home() / ".cache" / "diffdelta"


class CursorCache:
    """Persists per-source ETags and cursors to a local JSON file."""

    def __init__(self, cache_dir: Optional[Path] = None) -> None:
        self._dir = cache_dir or _DEFAULT_CACHE_DIR
        self._path = self._dir / "cursor_cache.json"
        self._data: Dict[str, str] = {}
        self._load()

    # -- persistence --------------------------------------------------------

    def _load(self) -> None:
        if self._path.exists():
            try:
                self._data = json.loads(self._path.read_text("utf-8"))
            except (json.JSONDecodeError, OSError):
                self._data = {}

    def _save(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, indent=2), "utf-8")
        tmp.replace(self._path)

    # -- public API ---------------------------------------------------------

    def get(self, key: str) -> Optional[str]:
        return self._data.get(key)

    def set(self, key: str, value: str) -> None:
        self._data[key] = value
        self._save()


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

_USER_AGENT = f"diffdelta-python-client/{__version__}"


class DiffDeltaClient:
    """Minimal DiffDelta polling client with ETag/304 support.

    The client enforces the two-step polling pattern by default:

    1. Fetch ``head.json`` with ``If-None-Match``.
    2. If 304 → done.  If ``changed: false`` → done.
    3. Only then fetch ``latest.json``.

    This behavior is built into ``poll()`` and ``fetch_latest()``.
    Bot operators don't need to think about it.

    Parameters
    ----------
    base_url : str
        Origin of the DiffDelta server (e.g. ``https://diffdelta.io``).
    cache_dir : Path | None
        Directory for persisting cursors/ETags.  Defaults to
        ``~/.cache/diffdelta``.
    timeout : int
        HTTP timeout in seconds.
    """

    def __init__(
        self,
        base_url: str = "https://diffdelta.io",
        cache_dir: Optional[Path] = None,
        timeout: int = 15,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._cache = CursorCache(cache_dir)

    # -- HTTP helpers -------------------------------------------------------

    def _get(
        self, url: str, etag: Optional[str] = None
    ) -> Tuple[int, Optional[Dict[str, Any]], Optional[str]]:
        """HTTP GET with optional If-None-Match.

        Returns (status, body_dict_or_None, etag_from_response).
        """
        if not url.startswith("http"):
            url = self.base_url + ("" if url.startswith("/") else "/") + url

        headers: Dict[str, str] = {
            "User-Agent": _USER_AGENT,
            "Accept": "application/json",
        }
        if etag:
            headers["If-None-Match"] = f'"{etag}"'

        req = Request(url, headers=headers)
        try:
            resp = urlopen(req, timeout=self.timeout)  # noqa: S310
            body = json.loads(resp.read().decode("utf-8"))
            resp_etag = (resp.headers.get("ETag") or "").strip('" ')
            return resp.status, body, resp_etag
        except HTTPError as exc:
            if exc.code == 304:
                resp_etag = (exc.headers.get("ETag") or "").strip('" ')
                return 304, None, resp_etag
            raise

    # -- public API ---------------------------------------------------------

    def fetch_head(
        self, source_id: str
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """Poll the head pointer for *source_id*.

        Uses a locally cached ETag to send ``If-None-Match``.
        Returns ``(changed, head_json_or_None)``.

        * ``changed=False, head=None`` → 304, nothing new.
        * ``changed=True,  head={…}``  → new data available.
        * ``changed=False, head={…}``  → fetched but no semantic change.
        """
        cache_key = f"etag:{source_id}"
        stored_etag = self._cache.get(cache_key)

        url = f"/diff/source/{source_id}/head.json"
        status, body, resp_etag = self._get(url, etag=stored_etag)

        if status == 304:
            return False, None

        # Persist ETag for next poll
        if resp_etag:
            self._cache.set(cache_key, resp_etag)

        changed = (body or {}).get("changed", True)
        return changed, body

    def poll(
        self, source_id: str
    ) -> Optional[Dict[str, Any]]:
        """Head-first poll for a source.  Returns the feed or None.

        This is the recommended entry point.  It:
        1. Checks head.json (with If-None-Match).
        2. Returns ``None`` immediately on 304 or ``changed: false``.
        3. Fetches latest.json only when content has actually changed.

        Returns the full feed dict, or ``None`` if nothing changed.
        """
        changed, head = self.fetch_head(source_id)
        if not changed or head is None:
            return None
        if not head.get("changed", True):
            return None

        latest_url = head.get("latest_url", f"/diff/source/{source_id}/latest.json")
        return self._fetch_json(latest_url)

    def poll_global(self) -> Optional[Dict[str, Any]]:
        """Head-first poll for the global aggregated feed.

        Returns the full feed dict, or ``None`` if nothing changed.
        """
        cache_key = "etag:_global"
        stored_etag = self._cache.get(cache_key)

        status, body, resp_etag = self._get("/diff/head.json", etag=stored_etag)

        if status == 304:
            return None

        if resp_etag:
            self._cache.set(cache_key, resp_etag)

        changed = (body or {}).get("changed", True)
        if not changed:
            return None

        return self._fetch_json("/diff/latest.json")

    def fetch_latest(self, source_id: str) -> Optional[Dict[str, Any]]:
        """Fetch latest feed for *source_id*, head-first.

        Equivalent to ``poll(source_id)`` — exists for backward compat.
        """
        return self.poll(source_id)

    def fetch_latest_direct(self, url: str) -> Dict[str, Any]:
        """Fetch a feed URL directly (no head check).

        Use this ONLY when you already know the content has changed
        (e.g. after walking the archive).
        """
        return self._fetch_json(url)

    def fetch_global(self) -> Optional[Dict[str, Any]]:
        """Fetch the global aggregated feed, head-first."""
        return self.poll_global()

    def fetch_sources(
        self, tags: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """Fetch the source catalog and optionally filter by tags.

        Returns a list of source entries from ``/diff/sources.json``.
        If *tags* is provided, only sources matching **any** of the
        given tags are returned (OR logic).

        This is a setup-time call, not a polling call.  Cache the result
        and use the returned ``source_id`` values with ``poll()``.

        Example::

            # Get only security sources
            security = client.fetch_sources(tags=["security"])
            for src in security:
                feed = client.poll(src["source_id"])
        """
        data = self._fetch_json("/diff/sources.json")
        sources = data.get("sources", [])
        if tags:
            tag_set = set(tags)
            sources = [
                s for s in sources
                if tag_set.intersection(s.get("tags", []))
            ]
        return sources

    def walk_back(
        self,
        source_id: str,
        limit: int = 10,
    ) -> List[Dict[str, Any]]:
        """Walk the archive chain for historical snapshots.

        Fetches ``/archive/{source_id}/index.json`` and retrieves up to
        *limit* snapshots (newest first).  This is for onboarding / catchup,
        not for steady-state polling.
        """
        snapshots: List[Dict[str, Any]] = []

        try:
            index = self._fetch_json(f"/archive/{source_id}/index.json")
        except Exception:
            return snapshots

        entries = index.get("snapshots", [])
        # Newest first
        for entry in entries[-limit:][::-1]:
            url = entry.get("url")
            if not url:
                continue
            try:
                snap = self._fetch_json(url)
                snapshots.append(snap)
            except Exception:
                break

        return snapshots

    # -- internal -----------------------------------------------------------

    def _fetch_json(self, url: str) -> Dict[str, Any]:
        """Fetch a JSON URL directly (no ETag logic)."""
        status, body, _ = self._get(url)
        if body is None:
            raise RuntimeError(f"Empty response from {url}")
        return body


# ---------------------------------------------------------------------------
# CLI demo
# ---------------------------------------------------------------------------

def main() -> None:
    """Demonstrate the head-first polling loop."""
    base = os.environ.get("DIFFDELTA_BASE_URL", "https://diffdelta.io")
    source = sys.argv[1] if len(sys.argv) > 1 else "aws_whats_new"

    client = DiffDeltaClient(base)

    print(f"Polling {base} for source '{source}' …")
    feed = client.poll(source)

    if feed is None:
        print("Nothing new (304 or changed:false). Done.")
        return

    print(f"Changed! Cursor: {(feed.get('cursor') or 'null')[:24]}…")

    for bucket in ("new", "updated", "removed", "flagged"):
        items = feed.get("buckets", {}).get(bucket, [])
        if items:
            print(f"\n  [{bucket}] {len(items)} item(s):")
            for item in items[:5]:
                risk = (item.get("risk") or {}).get("score", 0)
                flag = " ⚠" if risk >= 0.4 else ""
                print(f"    • {item.get('headline', '(no headline)')}{flag}")
            if len(items) > 5:
                print(f"    … and {len(items) - 5} more")

    print("\nDone.")


if __name__ == "__main__":
    main()
