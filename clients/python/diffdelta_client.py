#!/usr/bin/env python3
"""
DiffDelta Reference Client — Python

Zero external dependencies. Uses only the Python standard library.
Implements the DiffDelta Feed Spec v1 polling protocol with ETag/304 support
and local cursor caching.

Usage:
    from diffdelta_client import DiffDeltaClient

    client = DiffDeltaClient("https://diffdelta.io")
    changed, head = client.fetch_head("aws_whats_new")
    if changed:
        feed = client.fetch_latest(head["latest_url"])
        for item in feed["buckets"]["new"]:
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

__version__ = "0.1.0"

# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

_DEFAULT_CACHE_DIR = Path.home() / ".cache" / "diffdelta"


class CursorCache:
    """Persists per-source ETags/cursors to a local JSON file."""

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

    def set(self, key: str, cursor: str) -> None:
        self._data[key] = cursor
        self._save()


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

_USER_AGENT = f"diffdelta-python-client/{__version__}"


class DiffDeltaClient:
    """Minimal DiffDelta polling client with ETag/304 support.

    Parameters
    ----------
    base_url : str
        Origin of the DiffDelta server (e.g. ``https://diffdelta.io``).
    cache_dir : Path | None
        Directory for persisting cursors.  Defaults to ``~/.cache/diffdelta``.
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

        headers = {"User-Agent": _USER_AGENT, "Accept": "application/json"}
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

        Uses a locally cached cursor to send ``If-None-Match``.
        Returns ``(changed, head_json_or_None)``.

        * ``changed=False`` + ``head=None`` → 304, nothing new.
        * ``changed=True``  + ``head={…}``  → new data available.
        * ``changed=False`` + ``head={…}``  → server says ``changed: false``
          (content fetched but no semantic change).
        """
        cache_key = f"head:{source_id}"
        stored_cursor = self._cache.get(cache_key)

        url = f"/diff/source/{source_id}/head.json"
        status, body, resp_etag = self._get(url, etag=stored_cursor)

        if status == 304:
            return False, None

        # Update cached cursor
        cursor = (body or {}).get("cursor", resp_etag)
        if cursor:
            self._cache.set(cache_key, cursor)

        changed = (body or {}).get("changed", True)
        return changed, body

    def fetch_latest(
        self, url_or_source_id: str
    ) -> Dict[str, Any]:
        """Fetch the full latest feed.

        *url_or_source_id* can be a relative URL (``/diff/…/latest.json``)
        or a bare source ID (``aws_whats_new``).
        """
        if "/" not in url_or_source_id:
            url = f"/diff/source/{url_or_source_id}/latest.json"
        else:
            url = url_or_source_id

        _status, body, _etag = self._get(url)
        if body is None:
            raise RuntimeError(f"Empty response from {url}")
        return body

    def fetch_global(self) -> Dict[str, Any]:
        """Fetch the global aggregated feed."""
        _status, body, _etag = self._get("/diff/latest.json")
        if body is None:
            raise RuntimeError("Empty response from /diff/latest.json")
        return body

    def walk_back(
        self,
        source_id: str,
        limit: int = 10,
    ) -> List[Dict[str, Any]]:
        """Walk the prev_cursor chain via archive snapshots.

        Starts from the current ``latest.json`` and follows ``prev_cursor``
        links up to *limit* steps.  Returns a list of feed snapshots
        (newest first).

        Note: requires the server to expose ``/archive/`` endpoints.
        """
        snapshots: List[Dict[str, Any]] = []
        feed = self.fetch_latest(source_id)
        snapshots.append(feed)

        zero = "sha256:" + "0" * 64
        prev = feed.get("prev_cursor", zero)

        for _ in range(limit - 1):
            if not prev or prev == zero:
                break
            # Derive archive URL from prev_cursor
            # Convention: /archive/{source_id}/prev_{hash}.json
            cursor_hex = prev.replace("sha256:", "")[:12]
            archive_url = f"/archive/{source_id}/prev_{cursor_hex}.json"
            try:
                _status, body, _etag = self._get(archive_url)
                if body is None:
                    break
                snapshots.append(body)
                prev = body.get("prev_cursor", zero)
            except HTTPError:
                break  # Archive not available

        return snapshots


# ---------------------------------------------------------------------------
# CLI demo
# ---------------------------------------------------------------------------

def main() -> None:
    """Demonstrate the polling loop."""
    base = os.environ.get("DIFFDELTA_BASE_URL", "https://diffdelta.io")
    source = sys.argv[1] if len(sys.argv) > 1 else "aws_whats_new"

    client = DiffDeltaClient(base)

    print(f"Polling {base} for source '{source}' …")
    changed, head = client.fetch_head(source)

    if not changed:
        print("304 — nothing new. Stopping.")
        return

    if head and head.get("changed") is False:
        print("Server says changed:false — no semantic change.")
        return

    print(f"Changed! Cursor: {head['cursor'][:24]}…")
    feed = client.fetch_latest(head.get("latest_url", source))

    for bucket in ("new", "updated", "removed", "flagged"):
        items = feed.get("buckets", {}).get(bucket, [])
        if items:
            print(f"\n  [{bucket}] {len(items)} item(s):")
            for item in items[:5]:
                risk = item.get("risk", {}).get("score", 0)
                flag = " ⚠" if risk >= 0.4 else ""
                print(f"    • {item.get('headline', '(no headline)')}{flag}")
            if len(items) > 5:
                print(f"    … and {len(items) - 5} more")

    print("\nDone.")


if __name__ == "__main__":
    main()
