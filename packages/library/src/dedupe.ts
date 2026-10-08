import { createHash } from "node:crypto";

/**
 * Compute SHA-256 hex digest of a Buffer.
 */
export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Short prefix of SHA-256 for human-readable filenames (first 8 hex chars).
 */
export function sha256Prefix(full: string): string {
  return full.slice(0, 8);
}
