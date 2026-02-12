/**
 * DiffDelta MCP — Configuration
 */

/**
 * Base URL for the DiffDelta API.
 * Defaults to https://diffdelta.io, overridable via DIFFDELTA_BASE_URL env var.
 */
export function getBaseUrl(): string {
  return process.env.DIFFDELTA_BASE_URL || "https://diffdelta.io";
}
