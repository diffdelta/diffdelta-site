/**
 * DiffDelta MCP — Identity persistence
 *
 * Stores agent identity (keypair, agent_id, seq) in ~/.diffdelta/identity.json.
 * Created on first self_bootstrap, reused on subsequent runs.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { generateIdentity, type Identity } from "./crypto.js";

const DIFFDELTA_DIR = path.join(os.homedir(), ".diffdelta");
const IDENTITY_FILE = path.join(DIFFDELTA_DIR, "identity.json");

interface StoredIdentity {
  agent_id: string;
  public_key_hex: string;
  private_key_pem: string;
  seq: number;
  created_at: string;
}

/**
 * Load existing identity from disk, or return null if none exists.
 */
export function loadIdentity(): { identity: Identity; seq: number } | null {
  try {
    if (!fs.existsSync(IDENTITY_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8")) as StoredIdentity;
    const private_key = crypto.createPrivateKey({
      key: raw.private_key_pem,
      format: "pem",
      type: "pkcs8",
    });
    return {
      identity: {
        agent_id: raw.agent_id,
        public_key_hex: raw.public_key_hex,
        private_key,
      },
      seq: raw.seq,
    };
  } catch {
    return null;
  }
}

/**
 * Create a new identity and persist it to disk.
 */
export function createAndSaveIdentity(): { identity: Identity; seq: number } {
  const identity = generateIdentity();
  const stored: StoredIdentity = {
    agent_id: identity.agent_id,
    public_key_hex: identity.public_key_hex,
    private_key_pem: identity.private_key
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    seq: 0,
    created_at: new Date().toISOString(),
  };

  fs.mkdirSync(DIFFDELTA_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(stored, null, 2), "utf-8");

  return { identity, seq: 0 };
}

/**
 * Increment seq and persist. Returns the new seq value.
 */
export function incrementSeq(): number {
  const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8")) as StoredIdentity;
  raw.seq += 1;
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(raw, null, 2), "utf-8");
  return raw.seq;
}

/**
 * Get the current seq without incrementing.
 */
export function currentSeq(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8")) as StoredIdentity;
    return raw.seq;
  } catch {
    return 0;
  }
}

/**
 * Get the identity directory path (for display purposes).
 */
export function getIdentityPath(): string {
  return IDENTITY_FILE;
}
