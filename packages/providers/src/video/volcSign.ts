/**
 * P22: Shared Volcengine HMAC-SHA256 signing module
 *
 * Extracted from jimengImageClient.ts (P21) so P21 and P22 share the same
 * signing logic. Volcengine uses a Signature Version 4 style algorithm.
 *
 * Reference: https://www.volcengine.com/docs/6369/67269
 */

import crypto from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────

export interface VolcSignConfig {
  accessKey: string;
  secretKey: string;
  region?: string;       // default "cn-north-1"
  service?: string;      // default "cv"
  host?: string;         // default "visual.volcengineapi.com"
  endpoint?: string;     // full override, default built from host
}

export interface VolcSignResult {
  url: string;
  headers: Record<string, string>;
}

// ─── Constants ──────────────────────────────────────────────────────────

const ALGORITHM = "HMAC-SHA256";
const SIGNED_HEADERS = "content-type;host;x-content-sha256;x-date";
const DEFAULT_SERVICE = "cv";
const DEFAULT_REGION = "cn-north-1";
const DEFAULT_HOST = "visual.volcengineapi.com";

// ─── Signing helpers ────────────────────────────────────────────────────

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer | string, data: string): string {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest("hex");
}

function getSignatureKey(secretKey: string, shortDate: string, region: string, service: string): Buffer {
  const kDate = hmac(secretKey, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "request");
}

function formatDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function formatShortDate(d: Date): string {
  return formatDate(d).slice(0, 8);
}

function canonicalQueryString(params: URLSearchParams): string {
  const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Build a signed Volcengine API request.
 *
 * @param config - Signing credentials and endpoint config
 * @param action - API action name (e.g. "CVProcess", "CVSync2AsyncSubmitTask")
 * @param version - API version (e.g. "2022-08-31")
 * @param bodyStr - JSON-serialized request body
 * @returns Signed URL and headers ready for fetch()
 */
export function buildSignedRequest(
  config: VolcSignConfig,
  action: string,
  version: string,
  bodyStr: string,
): VolcSignResult {
  const region = config.region ?? DEFAULT_REGION;
  const service = config.service ?? DEFAULT_SERVICE;
  const host = config.host ?? DEFAULT_HOST;
  const endpoint = config.endpoint ?? `https://${host}`;

  const now = new Date();
  const xDate = formatDate(now);
  const shortDate = formatShortDate(now);
  const bodyHash = sha256Hex(bodyStr);

  // Build query string with Action + Version
  const queryParams = new URLSearchParams({ Action: action, Version: version });
  const queryString = queryParams.toString();

  // Build canonical request
  const canonicalUri = "/";
  const canonicalQueryStr = canonicalQueryString(queryParams);
  const canonicalHeaders = [
    `content-type:application/json`,
    `host:${host}`,
    `x-content-sha256:${bodyHash}`,
    `x-date:${xDate}`,
  ].join("\n") + "\n";

  const canonicalRequest = [
    "POST",
    canonicalUri,
    canonicalQueryStr,
    canonicalHeaders,
    SIGNED_HEADERS,
    bodyHash,
  ].join("\n");

  // Build string to sign
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = [
    ALGORITHM,
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // Calculate signature
  const signingKey = getSignatureKey(config.secretKey, shortDate, region, service);
  const signature = hmacHex(signingKey, stringToSign);

  // Build Authorization header
  const authorization = [
    `${ALGORITHM} Credential=${config.accessKey}/${credentialScope}`,
    `SignedHeaders=${SIGNED_HEADERS}`,
    `Signature=${signature}`,
  ].join(", ");

  const url = `${endpoint}?${queryString}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Host": host,
    "X-Content-Sha256": bodyHash,
    "X-Date": xDate,
    "Authorization": authorization,
  };

  return { url, headers };
}

/**
 * Redact Authorization header value for logging.
 */
export function redactAuthHeader(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization") {
      result[k] = "HMAC-SHA256 [REDACTED]";
    } else {
      result[k] = v;
    }
  }
  return result;
}
