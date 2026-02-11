"""
DiffDelta Self Capsule v0 — Reference Client (Python)

Goal: minimal, copy-pasteable implementation for bots.

Notes:
- Python stdlib does NOT provide Ed25519 signing. This reference client uses `cryptography`.
  Install: `pip install cryptography`
- This is a reference client for the spec, not a published SDK.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple


def canonical_json(value: Any) -> str:
    """Deterministic JSON (sorted keys)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def b64url_decode(s: str) -> bytes:
    s = s.replace("-", "+").replace("_", "/")
    pad = "=" * ((4 - (len(s) % 4)) % 4)
    return base64.b64decode(s + pad)


@dataclass
class Identity:
    agent_id: str            # 64 hex
    public_key_hex: str      # 32-byte hex
    private_key: Any         # cryptography key object


def generate_identity() -> Identity:
    """
    Generate Ed25519 identity:
    - agent_id = sha256(raw_public_key_bytes)
    - public_key_hex = raw 32 bytes hex
    """
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives import serialization
    except Exception as e:
        raise RuntimeError("Missing dependency: cryptography (pip install cryptography)") from e

    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key()
    pub_bytes = pub.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    public_key_hex = pub_bytes.hex()
    agent_id = sha256_hex(pub_bytes)
    return Identity(agent_id=agent_id, public_key_hex=public_key_hex, private_key=priv)


def bootstrap(base_url: str, public_key_hex: str) -> Dict[str, Any]:
    req = urllib.request.Request(
        base_url.rstrip("/") + "/api/v1/self/bootstrap",
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps({"public_key": public_key_hex}).encode("utf-8"),
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


def sign_capsule(identity: Identity, capsule: Dict[str, Any], seq: int) -> Dict[str, Any]:
    """
    v0 message to sign:
      msg_hash = sha256(canonical_json({agent_id, seq, capsule}))
      signature = Ed25519.sign(msg_hash_bytes)
    """
    msg_hash_hex = sha256_hex(
        canonical_json({"agent_id": identity.agent_id, "seq": seq, "capsule": capsule}).encode("utf-8")
    )
    msg_bytes = bytes.fromhex(msg_hash_hex)
    sig = identity.private_key.sign(msg_bytes)

    return {
        "agent_id": identity.agent_id,
        "public_key": identity.public_key_hex,
        "seq": seq,
        "signature_alg": "ed25519",
        "signature": sig.hex(),
        "capsule": capsule,
    }


def put_capsule(base_url: str, envelope: Dict[str, Any], pro_key: Optional[str] = None) -> Dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if pro_key:
        headers["X-DiffDelta-Key"] = pro_key
    url = f"{base_url.rstrip('/')}/self/{envelope['agent_id']}/capsule.json"
    req = urllib.request.Request(
        url,
        method="PUT",
        headers=headers,
        data=canonical_json(envelope).encode("utf-8"),
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


def get_head(
    base_url: str, agent_id: str, etag: Optional[str] = None, pro_key: Optional[str] = None
) -> Tuple[int, Optional[str], Optional[Dict[str, Any]]]:
    headers: Dict[str, str] = {}
    if etag:
        headers["If-None-Match"] = etag
    if pro_key:
        headers["X-DiffDelta-Key"] = pro_key
    url = f"{base_url.rstrip('/')}/self/{agent_id}/head.json"
    req = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            new_etag = r.headers.get("ETag")
            body = json.loads(r.read().decode("utf-8"))
            return (r.status, new_etag, body)
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return (304, e.headers.get("ETag"), None)
        raise


def batching_example_loop(base_url: str) -> None:
    """
    Illustrative loop:
    - rehydrate on start
    - do work
    - update local capsule
    - publish rarely (debounced)
    """
    ident = generate_identity()
    _ = bootstrap(base_url, ident.public_key_hex)

    capsule: Dict[str, Any] = {
        "schema_version": "self_capsule_v0",
        "agent_id": ident.agent_id,
        "policy": {
            "policy_version": "v0",
            "rehydrate_mode": "strict",
            "deny_external_instructions": True,
            "deny_tool_instructions_in_text": True,
            "memory_budget": {"max_rehydrate_tokens": 900, "max_objectives": 8},
        },
        "objectives": [
            {"id": "boot", "status": "open", "title": "Test capsule write", "checkpoint": "start"}
        ],
    }

    seq = 1
    put_capsule(base_url, sign_capsule(ident, capsule, seq))

    etag = None
    dirty = False
    dirty_since = 0.0
    debounce_sec = 5 * 60

    while True:
        # Poll head cheaply
        status, etag2, head = get_head(base_url, ident.agent_id, etag=etag)
        if status == 200 and head:
            etag = etag2 or head.get("cursor")
        # Do some work... then mark dirty
        if not dirty:
            dirty = True
            dirty_since = time.time()
            capsule["objectives"][0]["checkpoint"] = "progress made"

        # Debounced publish
        if dirty and (time.time() - dirty_since) > debounce_sec:
            seq += 1
            put_capsule(base_url, sign_capsule(ident, capsule, seq))
            dirty = False

        time.sleep(30)

