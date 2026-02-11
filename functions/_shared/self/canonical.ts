// Deterministic canonical JSON stringification (stable key ordering).
// Why: cursors and signatures must be stable across runtimes.

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeysDeep(obj[key]);
    }
    return out;
  }

  return value;
}

