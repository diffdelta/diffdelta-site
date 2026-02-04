#!/usr/bin/env python3
"""
DiffDelta Fleet Engine - Phase 1: SUBSTRATE LOCKDOWN PATCH

Deterministic, hash-based processing with change-only muting.
No LLM calls. No keyword scanning. No semantic logic.
"""

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple, Optional
from urllib.parse import urljoin, urlparse

import requests
import feedparser
from bs4 import BeautifulSoup

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CONFIG_PATH = os.path.join(ROOT, "sources.config.json")
TOP_LATEST_PATH = os.path.join(ROOT, "diff", "latest.json")
FLEET_STATE_PATH = os.path.join(ROOT, "diff", "_state.json")

SCHEMA_VERSION = "1.0.0"
GENERATOR_VERSION = "fleet-engine/1.0.0"

# User-Agent for all HTTP requests (prevents blocking during Phase 1 testing)
USER_AGENT = "DiffDelta-Bot/1.0 (+https://diffdelta.io)"


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


# --- hash helpers ---

def sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(obj: Any) -> bytes:
    """Generate canonical JSON bytes for deterministic hashing."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


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


# --- Risk v0: Integrity only ---

def calculate_risk_v0(item: Dict[str, Any], fetch_failed: bool = False, http_status: Optional[int] = None) -> Tuple[float, List[str]]:
    """
    Risk v0: Integrity checks only.
    - +0.2 if title missing/empty
    - +0.2 if url missing/empty
    - +0.2 if content missing/empty
    - +0.5 if HTTP request failed / exception / non-200
    - cap at 1.0
    """
    reasons: List[str] = []
    score = 0.0
    
    title = item.get("title") or ""
    url = item.get("url") or ""
    content = item.get("content") or ""
    
    if not title or not title.strip():
        reasons.append("missing_title")
        score += 0.2
    
    if not url or not url.strip():
        reasons.append("missing_url")
        score += 0.2
    
    if not content or not content.strip():
        reasons.append("missing_content")
        score += 0.2
    
    if fetch_failed or (http_status is not None and http_status != 200):
        reasons.append("fetch_error")
        score += 0.5
    
    score = min(1.0, score)
    return score, reasons[:10]


# --- Content hash ---

def compute_content_hash(item: Dict[str, Any]) -> str:
    """Compute deterministic hash of item's canonical content."""
    # Build canonical representation (exclude timestamps, IDs, etc.)
    canonical = {
        "title": (item.get("title") or "").strip(),
        "content": (item.get("content") or "").strip(),
        "url": (item.get("url") or "").strip(),
    }
    return sha256_bytes(canonical_json(canonical))


# --- Base adapter interface ---

class BaseAdapter:
    """Base class for all adapters. Defines the interface."""
    
    def __init__(self, config: Dict[str, Any], source_name: str):
        self.config = config
        self.source_name = source_name
        self.max_items = config.get("max_items", 50)
    
    def fetch(self) -> Tuple[List[Dict[str, Any]], int, Optional[str]]:
        """Fetch raw items from source. Returns: (items, http_status, error_message)"""
        raise NotImplementedError
    
    def normalize_item(self, raw_item: Dict[str, Any], fetched_at: str) -> Dict[str, Any]:
        """Normalize raw item to canonical form."""
        raise NotImplementedError
    
    def compute_source_hash(self, items: List[Dict[str, Any]]) -> str:
        """Compute deterministic hash of source content."""
        canonical_items = []
        for item in items[:self.max_items]:
            canonical_items.append({
                "id": item.get("id", ""),
                "url": item.get("url", ""),
                "title": (item.get("title") or "").strip(),
                "content": (item.get("content") or "").strip(),
            })
        canonical_items.sort(key=lambda x: x.get("id", ""))
        payload = {"source": self.source_name, "items": canonical_items}
        return sha256_bytes(canonical_json(payload))
    
    def best_effort_id(self, item: Dict[str, Any]) -> str:
        """Extract stable item ID."""
        # Try common ID fields (GitHub uses id/tag_name, RSS uses guid/id, etc.)
        for k in ("id", "post_id", "postId", "guid", "tag_name", "name"):
            v = item.get(k)
            if v:
                return str(v)
        # Fall back to hash of url + title
        url = item.get("url") or item.get("html_url") or item.get("link") or ""
        title = item.get("title") or ""
        return sha256(f"{url}\n{title}")[:32]
    
    def best_effort_url(self, item: Dict[str, Any], item_id: str) -> str:
        """Extract or construct URL."""
        # Try common URL fields (GitHub uses html_url, RSS uses link, etc.)
        url = item.get("url") or item.get("html_url") or item.get("link")
        if isinstance(url, str) and url.startswith("http"):
            return url
        return url or f"https://unknown/{item_id}"
    
    def best_effort_times(self, item: Dict[str, Any]) -> Tuple[str, str]:
        """Extract published_at and updated_at."""
        # Try various date fields (GitHub uses published_at/created_at, RSS uses published, etc.)
        created = (item.get("published_at") or item.get("created_at") or 
                  item.get("published") or item.get("pubDate") or item.get("date"))
        updated = (item.get("updated_at") or item.get("updated") or 
                  item.get("updated_parsed") or created)
        
        created_dt = None
        if isinstance(created, str):
            created_dt = parse_iso(created)
        elif hasattr(created, "tm_year"):  # time.struct_time from feedparser
            try:
                created_dt = datetime(*created[:6], tzinfo=timezone.utc)
            except Exception:
                pass
        
        updated_dt = None
        if isinstance(updated, str):
            updated_dt = parse_iso(updated)
        elif hasattr(updated, "tm_year"):  # time.struct_time
            try:
                updated_dt = datetime(*updated[:6], tzinfo=timezone.utc)
            except Exception:
                pass
        
        if not created_dt:
            created = now_iso()
        else:
            created = created_dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        
        if not updated_dt:
            updated = created
        else:
            updated = updated_dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        
        return created, updated


# --- RSS Adapter ---

class RSSAdapter(BaseAdapter):
    """Adapter for RSS/Atom feeds."""
    
    def fetch(self) -> Tuple[List[Dict[str, Any]], int, Optional[str]]:
        feed_url = self.config.get("feed_url", "")
        if not feed_url:
            return [], 0, "No feed_url specified"
        
        try:
            # Fetch feed content with User-Agent, then parse
            r = requests.get(feed_url, headers={"User-Agent": USER_AGENT}, timeout=20)
            status = int(r.status_code)
            
            if status != 200:
                return [], status, f"HTTP {status}"
            
            # Parse the feed content
            parsed = feedparser.parse(r.content)
            if parsed.bozo and parsed.bozo_exception:
                return [], status, f"Feed parse error: {parsed.bozo_exception}"
            
            items = []
            for entry in parsed.entries[:self.max_items]:
                items.append({
                    "title": entry.get("title", ""),
                    "link": entry.get("link", ""),
                    "description": entry.get("description", ""),
                    "summary": entry.get("summary", ""),
                    "published": entry.get("published", ""),
                    "published_parsed": entry.get("published_parsed"),
                    "updated": entry.get("updated", ""),
                    "updated_parsed": entry.get("updated_parsed"),
                    "guid": entry.get("id") or entry.get("guid", ""),
                })
            
            return items, status, None
        except requests.RequestException as e:
            return [], 0, f"Request failed: {type(e).__name__}: {e}"
        except Exception as e:
            return [], 0, f"RSS fetch error: {type(e).__name__}: {e}"
    
    def normalize_item(self, raw_item: Dict[str, Any], fetched_at: str) -> Dict[str, Any]:
        item_id = self.best_effort_id(raw_item)
        url = self.best_effort_url(raw_item, item_id)
        published_at, updated_at = self.best_effort_times(raw_item)
        
        title = raw_item.get("title") or ""
        content = raw_item.get("description") or raw_item.get("summary") or ""
        
        item = {
            "source": self.source_name,
            "id": item_id,
            "url": url,
            "title": title[:200] if title else None,
            "published_at": published_at,
            "updated_at": updated_at,
            "content": content,
        }
        
        if not item["title"]:
            item.pop("title", None)
        
        return item


# --- JSON API Adapter (GitHub, etc.) ---

class JSONAdapter(BaseAdapter):
    """Adapter for JSON APIs (GitHub releases, etc.)."""
    
    def fetch(self) -> Tuple[List[Dict[str, Any]], int, Optional[str]]:
        api_url = self.config.get("api_url", "")
        if not api_url:
            return [], 0, "No api_url specified"
        
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
        api_key_env = self.config.get("api_key_env", "")
        if api_key_env:
            key = os.environ.get(api_key_env)
            if key:
                headers["Authorization"] = f"Bearer {key}"
        
        try:
            r = requests.get(api_url, headers=headers, timeout=20)
            status = int(r.status_code)
            
            if status != 200:
                return [], status, f"HTTP {status}"
            
            data = r.json()
            
            # Handle different JSON structures
            items = []
            if isinstance(data, list):
                items = data
            elif isinstance(data, dict):
                # Try common keys
                for key in ["items", "releases", "data", "results", "posts"]:
                    if isinstance(data.get(key), list):
                        items = data[key]
                        break
                if not items:
                    # Single item
                    items = [data]
            
            return items[:self.max_items], status, None
        except requests.RequestException as e:
            return [], 0, f"Request failed: {type(e).__name__}: {e}"
        except Exception as e:
            return [], 0, f"JSON fetch error: {type(e).__name__}: {e}"
    
    def normalize_item(self, raw_item: Dict[str, Any], fetched_at: str) -> Dict[str, Any]:
        item_id = self.best_effort_id(raw_item)
        url = self.best_effort_url(raw_item, item_id)
        published_at, updated_at = self.best_effort_times(raw_item)
        
        title = raw_item.get("title") or raw_item.get("name") or raw_item.get("tag_name", "")
        content = raw_item.get("body") or raw_item.get("content") or raw_item.get("description") or ""
        
        item = {
            "source": self.source_name,
            "id": item_id,
            "url": url,
            "title": title[:200] if title else None,
            "published_at": published_at,
            "updated_at": updated_at,
            "content": content,
        }
        
        if not item["title"]:
            item.pop("title", None)
        
        return item


# --- HTML Adapter ---

class HTMLAdapter(BaseAdapter):
    """Adapter for HTML pages with CSS selectors."""
    
    def fetch(self) -> Tuple[List[Dict[str, Any]], int, Optional[str]]:
        url = self.config.get("url", "")
        if not url:
            return [], 0, "No url specified"
        
        selector_title = self.config.get("selector_title", "")
        selector_content = self.config.get("selector_content", "")
        selector_date = self.config.get("selector_date", "")
        selector_item = self.config.get("selector_item", "")  # Container for each item
        
        try:
            r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=20)
            status = int(r.status_code)
            
            if status != 200:
                return [], status, f"HTTP {status}"
            
            soup = BeautifulSoup(r.content, "lxml")
            items = []
            
            if selector_item:
                # Find item containers first
                containers = soup.select(selector_item)
                for container in containers[:self.max_items]:
                    item = {}
                    if selector_title:
                        title_elem = container.select_one(selector_title)
                        item["title"] = title_elem.get_text(strip=True) if title_elem else ""
                    if selector_content:
                        content_elem = container.select_one(selector_content)
                        item["content"] = content_elem.get_text(strip=True) if content_elem else ""
                    if selector_date:
                        date_elem = container.select_one(selector_date)
                        item["published"] = date_elem.get_text(strip=True) if date_elem else ""
                    
                    # Try to extract link
                    link_elem = container.find("a", href=True)
                    if link_elem:
                        href = link_elem["href"]
                        item["link"] = urljoin(url, href)
                    
                    if item.get("title") or item.get("content"):
                        items.append(item)
            else:
                # Single page, extract all matching elements
                if selector_title:
                    titles = soup.select(selector_title)
                    for i, title_elem in enumerate(titles[:self.max_items]):
                        item = {"title": title_elem.get_text(strip=True)}
                        link_elem = title_elem.find("a", href=True) if title_elem else None
                        if link_elem:
                            item["link"] = urljoin(url, link_elem["href"])
                        items.append(item)
            
            return items, status, None
        except requests.RequestException as e:
            return [], 0, f"Request failed: {type(e).__name__}: {e}"
        except Exception as e:
            return [], 0, f"HTML parse error: {type(e).__name__}: {e}"
    
    def normalize_item(self, raw_item: Dict[str, Any], fetched_at: str) -> Dict[str, Any]:
        item_id = self.best_effort_id(raw_item)
        url = self.best_effort_url(raw_item, item_id)
        published_at, updated_at = self.best_effort_times(raw_item)
        
        title = raw_item.get("title") or ""
        content = raw_item.get("content") or ""
        
        item = {
            "source": self.source_name,
            "id": item_id,
            "url": url,
            "title": title[:200] if title else None,
            "published_at": published_at,
            "updated_at": updated_at,
            "content": content,
        }
        
        if not item["title"]:
            item.pop("title", None)
        
        return item


# --- Moltbook adapter (legacy, extends JSONAdapter) ---

class MoltbookAdapter(JSONAdapter):
    """Adapter for Moltbook source (special case of JSON API)."""
    
    def fetch(self) -> Tuple[List[Dict[str, Any]], int, Optional[str]]:
        """Override to handle Moltbook's {posts:[...]} format."""
        api_url = self.config.get("api_url", "")
        if not api_url:
            return [], 0, "No api_url specified"
        
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
        api_key_env = self.config.get("api_key_env", "")
        if api_key_env:
            key = os.environ.get(api_key_env)
            if key:
                headers["Authorization"] = f"Bearer {key}"
        
        try:
            r = requests.get(api_url, headers=headers, timeout=20)
            status = int(r.status_code)
            
            if status != 200:
                return [], status, f"HTTP {status}"
            
            data = r.json()
            
            # Accept either {posts:[...]} or [...]
            if isinstance(data, dict) and isinstance(data.get("posts"), list):
                return data["posts"][:self.max_items], status, None
            if isinstance(data, list):
                return data[:self.max_items], status, None
            return [], status, f"Unexpected response shape: {type(data)}"
            
        except requests.RequestException as e:
            return [], 0, f"Request failed: {type(e).__name__}: {e}"
        except Exception as e:
            return [], 0, f"Unexpected error: {type(e).__name__}: {e}"


# --- Adapter Factory ---

def create_adapter(adapter_name: str, config: Dict[str, Any], source_name: str) -> BaseAdapter:
    """Factory function to create the appropriate adapter based on type."""
    adapter_map = {
        "rss": RSSAdapter,
        "json": JSONAdapter,
        "github_api": JSONAdapter,  # GitHub uses JSON API
        "github_releases": JSONAdapter,  # GitHub releases (alias for github_api)
        "html": HTMLAdapter,
        "moltbook": MoltbookAdapter,  # Legacy support
    }
    
    adapter_class = adapter_map.get(adapter_name)
    if not adapter_class:
        raise ValueError(f"Unknown adapter type: {adapter_name}")
    
    return adapter_class(config, source_name)


# --- Process source ---

def process_source(
    source_name: str,
    source_config: Dict[str, Any],
    fleet_state: Dict[str, Any],
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Process a single source.
    Returns: (source_result, updated_fleet_state_entry)
    """
    if not source_config.get("enabled", False):
        # Get previous cursor or use default
        prev_state = fleet_state.get(source_name, {})
        last_cursor = prev_state.get("last_cursor", "")
        if not last_cursor:
            last_cursor = "sha256:" + "0" * 64
        
        return {
            "status": "disabled",
            "changed": False,
            "cursor": last_cursor,
            "prev_cursor": last_cursor,
            "ttl_sec": source_config.get("config", {}).get("ttl_sec", 60),
            "error": None,
        }, {}
    
    adapter_name = source_config.get("adapter")
    if not adapter_name:
        prev_state = fleet_state.get(source_name, {})
        last_cursor = prev_state.get("last_cursor", "")
        if not last_cursor:
            last_cursor = "sha256:" + "0" * 64
        
        return {
            "status": "error",
            "changed": False,
            "cursor": last_cursor,
            "prev_cursor": last_cursor,
            "ttl_sec": 60,
            "error": "No adapter specified",
        }, {}
    
    config = source_config.get("config", {})
    
    try:
        adapter = create_adapter(adapter_name, config, source_name)
        
        # Fetch items
        items, http_status, error_msg = adapter.fetch()
        
        if error_msg or http_status != 200:
            # Error: don't update state, return error status
            prev_state = fleet_state.get(source_name, {})
            last_cursor = prev_state.get("last_cursor", "")
            if not last_cursor:
                last_cursor = "sha256:" + "0" * 64
            
            return {
                "status": "error",
                "changed": False,
                "cursor": last_cursor,
                "prev_cursor": last_cursor,
                "ttl_sec": config.get("ttl_sec", 60),
                "error": error_msg or f"HTTP {http_status}",
            }, {
                "last_error_at": now_iso(),
                "last_error": error_msg or f"HTTP {http_status}",
            }
        
        # Normalize items
        fetched_at = now_iso()
        normalized_items = []
        raw_items_map = {}  # Map normalized item id to raw item for source_payload preservation
        for p in items[:adapter.max_items]:
            normalized = adapter.normalize_item(p, fetched_at)
            normalized_items.append(normalized)
            # Preserve raw item for source_payload extraction
            raw_items_map[normalized["id"]] = p
        
        # Compute source hash
        source_hash = adapter.compute_source_hash(normalized_items)
        
        # Get previous state
        prev_state = fleet_state.get(source_name, {})
        last_hash = prev_state.get("last_hash", "")
        last_cursor = prev_state.get("last_cursor", "")
        
        # Initialize cursor if missing
        if not last_cursor:
            last_cursor = "sha256:" + "0" * 64
        
        # Change-only muting: if hash unchanged, no changes
        if source_hash == last_hash:
            # Cursor invariant: if changed==false, cursor MUST equal prev_cursor
            return {
                "status": "ok",
                "changed": False,
                "cursor": last_cursor,
                "prev_cursor": last_cursor,
                "ttl_sec": config.get("ttl_sec", 60),
                "error": None,
                "buckets": {
                    "new": [],
                    "updated": [],
                    "removed": [],
                    "flagged": [],
                },
            }, {
                "last_hash": source_hash,
                "last_cursor": last_cursor,
                "last_success_at": fetched_at,
            }
        
        # Hash changed: process items
        buckets = {
            "new": [],
            "updated": [],
            "removed": [],
            "flagged": [],
        }
        
        # Build items with risk v0 and provenance
        processed_items = []
        for item in normalized_items:
            risk_score, risk_reasons = calculate_risk_v0(item, fetch_failed=False, http_status=http_status)
            content_hash = compute_content_hash(item)
            
            # Preserve source_payload from raw item (opaque upstream data)
            raw_item = raw_items_map.get(item["id"], {})
            source_payload = raw_item.get("source_payload")
            if not source_payload and raw_item:
                # If no explicit source_payload, use the raw item itself (minus normalized fields)
                source_payload = {k: v for k, v in raw_item.items() 
                                if k not in ["id", "post_id", "postId", "url", "title", "content", 
                                            "created_at", "createdAt", "updated_at", "updatedAt"]}
                # Only include if there's actual data beyond normalized fields
                if not source_payload:
                    source_payload = None
            
            processed_item = {
                "source": item["source"],
                "id": item["id"],
                "url": item["url"],
                "title": item.get("title"),
                "published_at": item["published_at"],
                "updated_at": item["updated_at"],
                "signals": [],  # Empty in Phase 1
                "action_items": [],  # Empty in Phase 1
                "summary": item.get("title") or "Update detected.",
                "risk": {
                    "score": float(max(0.0, min(1.0, risk_score))),
                    "reasons": risk_reasons[:10]
                },
                "provenance": {
                    "fetched_at": fetched_at,
                    "evidence_urls": [item["url"]],
                    "content_hash": content_hash,
                },
            }
            
            # Add source_payload if available
            if source_payload:
                processed_item["source_payload"] = source_payload
            
            if not processed_item.get("title"):
                processed_item.pop("title", None)
            
            # Determine bucket (simplified: all new for now)
            is_flagged = risk_score >= 0.4
            if is_flagged:
                buckets["flagged"].append(processed_item)
            else:
                buckets["new"].append(processed_item)
            
            processed_items.append(processed_item)
        
        # Build canonical feed payload (exclude generated_at, timings)
        canonical_payload = {
            "schema_version": SCHEMA_VERSION,
            "sources_included": [source_name],
            "items": sorted([{"id": i["id"], "url": i["url"], "title": i.get("title", ""), "content_hash": i["provenance"]["content_hash"]} for i in processed_items], key=lambda x: x["id"]),
        }
        
        # Compute cursor from canonical payload
        cursor = "sha256:" + sha256_bytes(canonical_json(canonical_payload))
        
        # Update state
        new_state_entry = {
            "last_hash": source_hash,
            "last_cursor": cursor,
            "last_success_at": fetched_at,
        }
        
        return {
            "status": "ok",
            "changed": True,
            "cursor": cursor,
            "prev_cursor": last_cursor or ("sha256:" + "0" * 64),
            "ttl_sec": config.get("ttl_sec", 60),
            "error": None,
            "buckets": buckets,
        }, new_state_entry
        
    except Exception as e:
        prev_state = fleet_state.get(source_name, {})
        last_cursor = prev_state.get("last_cursor", "")
        if not last_cursor:
            last_cursor = "sha256:" + "0" * 64
        
        return {
            "status": "error",
            "changed": False,
            "cursor": last_cursor,
            "prev_cursor": last_cursor,
            "ttl_sec": config.get("ttl_sec", 60),
            "error": f"{type(e).__name__}: {e}",
        }, {
            "last_error_at": now_iso(),
            "last_error": f"{type(e).__name__}: {e}",
        }


# --- Main engine ---

def main() -> None:
    """Main entry point: load config and process all enabled sources."""
    if not os.path.exists(CONFIG_PATH):
        print(f"ERROR: Config file not found: {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    
    config_data = read_json(CONFIG_PATH, default={})
    sources = config_data.get("sources", {})
    
    if not sources:
        print("WARNING: No sources configured", file=sys.stderr)
        sys.exit(0)
    
    # Load fleet state
    fleet_state = read_json(FLEET_STATE_PATH, default={})
    
    # Process all sources
    source_results: Dict[str, Dict[str, Any]] = {}
    updated_fleet_state: Dict[str, Dict[str, Any]] = {}
    all_buckets = {
        "new": [],
        "updated": [],
        "removed": [],
        "flagged": [],
    }
    
    sources_included: List[str] = []
    global_changed = False
    
    for source_name, source_config in sources.items():
        result, state_update = process_source(source_name, source_config, fleet_state)
        source_results[source_name] = result
        sources_included.append(source_name)
        
        if state_update:
            updated_fleet_state[source_name] = state_update
        
        if result.get("changed"):
            global_changed = True
            # Merge buckets
            if "buckets" in result:
                for bucket_name in all_buckets:
                    all_buckets[bucket_name].extend(result["buckets"].get(bucket_name, []))
    
    # Build global cursor from all source results
    canonical_global = {
        "schema_version": SCHEMA_VERSION,
        "sources_included": sorted(sources_included),
        "sources": {k: {"changed": v.get("changed", False), "cursor": v.get("cursor", "")} for k, v in source_results.items()},
    }
    global_cursor = "sha256:" + sha256_bytes(canonical_json(canonical_global))
    
    # Get previous global cursor
    prev_global_cursor = fleet_state.get("_global", {}).get("last_cursor", "")
    if not prev_global_cursor:
        prev_global_cursor = "sha256:" + "0" * 64
    
    # Enforce cursor invariant: if changed==false, cursor MUST equal prev_cursor
    if not global_changed:
        global_cursor = prev_global_cursor
    
    # Generate batch_narrative (required per SPEC.md - max 30 words)
    total_changes = len(all_buckets["new"]) + len(all_buckets["updated"]) + len(all_buckets["removed"])
    flagged_count = len(all_buckets["flagged"])
    
    if not global_changed:
        batch_narrative = "No changes detected."
    elif total_changes == 0 and flagged_count > 0:
        # All changes are flagged
        if flagged_count == 1:
            batch_narrative = f"1 flagged item detected."
        else:
            batch_narrative = f"{flagged_count} flagged items detected."
    elif total_changes == 0:
        # Shouldn't happen if global_changed is True, but handle gracefully
        batch_narrative = "No changes detected."
    elif total_changes == 1:
        # Single change: describe it
        item = (all_buckets["new"] + all_buckets["updated"] + all_buckets["removed"])[0]
        title = item.get("title") or item.get("summary", "item")
        change_type = "new" if item in all_buckets["new"] else ("updated" if item in all_buckets["updated"] else "removed")
        batch_narrative = f"{change_type.capitalize()} '{title[:40]}'."
    else:
        # Multiple changes: summarize counts
        new_count = len(all_buckets["new"])
        updated_count = len(all_buckets["updated"])
        removed_count = len(all_buckets["removed"])
        # flagged_count already calculated above (line 545)
        parts = [f"{total_changes} changes"]
        if new_count > 0 and (updated_count > 0 or removed_count > 0):
            subparts = []
            if new_count > 0:
                subparts.append(f"{new_count} new")
            if updated_count > 0:
                subparts.append(f"{updated_count} updated")
            if removed_count > 0:
                subparts.append(f"{removed_count} removed")
            parts.append(f"({', '.join(subparts)})")
        elif new_count > 0:
            parts.append(f"({new_count} new)")
        elif updated_count > 0:
            parts.append(f"({updated_count} updated)")
        elif removed_count > 0:
            parts.append(f"({removed_count} removed)")
        if flagged_count > 0:
            parts.append(f"{flagged_count} flagged")
        batch_narrative = " ".join(parts) + "."
        # Enforce max 30 words per SPEC.md
        words = batch_narrative.split()
        if len(words) > 30:
            batch_narrative = " ".join(words[:30]) + "..."
    
    # Build feed
    generated_at = now_iso()
    feed = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "cursor": global_cursor,
        "prev_cursor": prev_global_cursor,
        "changed": global_changed,
        "ttl_sec": 60,  # Default, can be overridden per source
        "sources_included": sorted(sources_included),
        "batch_narrative": batch_narrative,
        "sources": {
            source_name: {
                "changed": result.get("changed", False),
                "cursor": (result.get("cursor") or "").strip() or ("sha256:" + "0" * 64),
                "prev_cursor": (result.get("prev_cursor") or "").strip() or ("sha256:" + "0" * 64),
                "ttl_sec": result.get("ttl_sec", 60),
                "status": result.get("status", "unknown"),
                "error": result.get("error"),
            }
            for source_name, result in source_results.items()
        },
        "buckets": all_buckets,
    }
    
    # Write feed if changed
    if global_changed:
        write_json_atomic(TOP_LATEST_PATH, feed)
    
    # Write per-source feeds for ALL sources (enabled and disabled)
    for source_name, source_config in sources.items():
        source_paths = source_config.get("paths", {})
        source_latest_path = source_paths.get("latest")
        if not source_latest_path:
            continue
        
        source_result = source_results.get(source_name, {})
        source_status = source_result.get("status", "unknown")
        
        # Build per-source feed
        if source_status == "disabled":
            # Disabled source: minimal valid feed
            source_feed = {
                "schema_version": SCHEMA_VERSION,
                "generated_at": generated_at,
                "cursor": source_result.get("cursor", "sha256:" + "0" * 64),
                "prev_cursor": source_result.get("prev_cursor", "sha256:" + "0" * 64),
                "changed": False,
                "ttl_sec": source_result.get("ttl_sec", source_config.get("config", {}).get("ttl_sec", 3600)),
                "sources_included": [source_name],
                "batch_narrative": f"{source_name}: Source disabled.",
                "sources": {
                    source_name: {
                        "changed": False,
                        "cursor": source_result.get("cursor", "sha256:" + "0" * 64),
                        "prev_cursor": source_result.get("prev_cursor", "sha256:" + "0" * 64),
                        "ttl_sec": source_result.get("ttl_sec", source_config.get("config", {}).get("ttl_sec", 3600)),
                        "status": "disabled",
                        "error": None,
                    }
                },
                "buckets": {
                    "new": [],
                    "updated": [],
                    "removed": [],
                    "flagged": [],
                },
            }
        elif source_status == "error":
            # Error source: minimal valid feed with error status
            source_feed = {
                "schema_version": SCHEMA_VERSION,
                "generated_at": generated_at,
                "cursor": source_result.get("cursor", "sha256:" + "0" * 64),
                "prev_cursor": source_result.get("prev_cursor", "sha256:" + "0" * 64),
                "changed": False,
                "ttl_sec": source_result.get("ttl_sec", source_config.get("config", {}).get("ttl_sec", 3600)),
                "sources_included": [source_name],
                "batch_narrative": f"{source_name}: Error - {source_result.get('error', 'Unknown error')}.",
                "sources": {
                    source_name: {
                        "changed": False,
                        "cursor": source_result.get("cursor", "sha256:" + "0" * 64),
                        "prev_cursor": source_result.get("prev_cursor", "sha256:" + "0" * 64),
                        "ttl_sec": source_result.get("ttl_sec", source_config.get("config", {}).get("ttl_sec", 3600)),
                        "status": "error",
                        "error": source_result.get("error"),
                    }
                },
                "buckets": {
                    "new": [],
                    "updated": [],
                    "removed": [],
                    "flagged": [],
                },
            }
        else:
            # Enabled source: full feed with actual buckets
            source_buckets = source_result.get("buckets", {
                "new": [],
                "updated": [],
                "removed": [],
                "flagged": [],
            })
            
            # Generate per-source batch_narrative
            source_total = len(source_buckets.get("new", [])) + len(source_buckets.get("updated", [])) + len(source_buckets.get("removed", []))
            source_flagged = len(source_buckets.get("flagged", []))
            
            if not source_result.get("changed", False):
                source_narrative = f"{source_name}: No changes detected."
            elif source_total == 0 and source_flagged > 0:
                source_narrative = f"{source_name}: {source_flagged} flagged item(s) detected."
            elif source_total == 0:
                source_narrative = f"{source_name}: No changes detected."
            elif source_total == 1:
                item = (source_buckets.get("new", []) + source_buckets.get("updated", []) + source_buckets.get("removed", []))[0]
                title = item.get("title") or item.get("summary", "item")
                change_type = "new" if item in source_buckets.get("new", []) else ("updated" if item in source_buckets.get("updated", []) else "removed")
                source_narrative = f"{source_name}: {change_type} '{title[:40]}'."
            else:
                new_count = len(source_buckets.get("new", []))
                updated_count = len(source_buckets.get("updated", []))
                removed_count = len(source_buckets.get("removed", []))
                parts = [f"{source_name}: {source_total} changes"]
                if new_count > 0 and (updated_count > 0 or removed_count > 0):
                    subparts = []
                    if new_count > 0:
                        subparts.append(f"{new_count} new")
                    if updated_count > 0:
                        subparts.append(f"{updated_count} updated")
                    if removed_count > 0:
                        subparts.append(f"{removed_count} removed")
                    parts.append(f"({', '.join(subparts)})")
                elif new_count > 0:
                    parts.append(f"({new_count} new)")
                elif updated_count > 0:
                    parts.append(f"({updated_count} updated)")
                elif removed_count > 0:
                    parts.append(f"({removed_count} removed)")
                if source_flagged > 0:
                    parts.append(f"{source_flagged} flagged")
                source_narrative = " ".join(parts) + "."
                words = source_narrative.split()
                if len(words) > 30:
                    source_narrative = " ".join(words[:30]) + "..."
            
            source_feed = {
                "schema_version": SCHEMA_VERSION,
                "generated_at": generated_at,
                "cursor": source_result.get("cursor", "sha256:" + "0" * 64),
                "prev_cursor": source_result.get("prev_cursor", "sha256:" + "0" * 64),
                "changed": source_result.get("changed", False),
                "ttl_sec": source_result.get("ttl_sec", source_config.get("config", {}).get("ttl_sec", 3600)),
                "sources_included": [source_name],
                "batch_narrative": source_narrative,
                "sources": {
                    source_name: {
                        "changed": source_result.get("changed", False),
                        "cursor": source_result.get("cursor", "sha256:" + "0" * 64),
                        "prev_cursor": source_result.get("prev_cursor", "sha256:" + "0" * 64),
                        "ttl_sec": source_result.get("ttl_sec", source_config.get("config", {}).get("ttl_sec", 3600)),
                        "status": source_result.get("status", "ok"),
                        "error": source_result.get("error"),
                    }
                },
                "buckets": source_buckets,
            }
        
        # Write per-source feed (always write, even if unchanged)
        source_latest_full_path = os.path.join(ROOT, source_latest_path)
        write_json_atomic(source_latest_full_path, source_feed)
    
    # Update fleet state
    for source_name, state_update in updated_fleet_state.items():
        if source_name not in fleet_state:
            fleet_state[source_name] = {}
        fleet_state[source_name].update(state_update)
    
    fleet_state["_global"] = {
        "last_cursor": global_cursor,
        "last_run_at": generated_at,
    }
    
    write_json_atomic(FLEET_STATE_PATH, fleet_state)
    
    # Print summary
    success_count = sum(1 for r in source_results.values() if r.get("status") == "ok")
    error_count = sum(1 for r in source_results.values() if r.get("status") == "error")
    
    print(
        f"OK: changed={global_changed} sources={len(sources_included)} "
        f"success={success_count} errors={error_count} "
        f"new={len(all_buckets['new'])} updated={len(all_buckets['updated'])} "
        f"flagged={len(all_buckets['flagged'])}"
    )
    
    if error_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
