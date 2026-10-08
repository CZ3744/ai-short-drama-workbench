// P23: Kling JWT signing — Access Key + Secret Key → HS256 JWT
// Official doc: https://klingai.com/document-api/apiReference/model/imageToVideo

import crypto from "node:crypto";

export interface KlingJwtOptions {
  accessKey: string;
  secretKey: string;
  /** Token lifetime in seconds (default 1800 = 30min, API enforces ~5min effective) */
  ttlSeconds?: number;
}

export interface KlingJwtToken {
  token: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Base64url encode (RFC 7515)
 */
function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Create a HS256 JWT for Kling API authentication.
 *
 * JWT payload:
 *   iss: access_key
 *   iat: now
 *   nbf: now - 5
 *   exp: now + ttlSeconds
 *
 * Uses Node.js crypto (no external dependency).
 */
export function signKlingJwt(opts: KlingJwtOptions): KlingJwtToken {
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? 1800;

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: opts.accessKey,
    iat: now,
    nbf: now - 5,
    exp: now + ttl,
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = crypto
    .createHmac("sha256", opts.secretKey)
    .update(signingInput)
    .digest();

  const token = `${signingInput}.${base64url(signature)}`;

  return {
    token,
    issuedAt: now,
    expiresAt: now + ttl,
  };
}

/**
 * Check if a JWT token is expired (with 30s safety margin).
 */
export function isJwtExpired(jwt: KlingJwtToken, safetyMarginSec = 30): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now >= jwt.expiresAt - safetyMarginSec;
}

/**
 * KlingJwtManager — caches JWT and auto-refreshes when expired.
 */
export class KlingJwtManager {
  private _jwt: KlingJwtToken | null = null;
  private _accessKey: string;
  private _secretKey: string;
  private _ttlSeconds: number;

  constructor(accessKey: string, secretKey: string, ttlSeconds?: number) {
    this._accessKey = accessKey;
    this._secretKey = secretKey;
    this._ttlSeconds = ttlSeconds ?? 1800;
  }

  /** Get a valid JWT, refreshing if expired. */
  getToken(): KlingJwtToken {
    if (!this._jwt || isJwtExpired(this._jwt)) {
      this._jwt = signKlingJwt({
        accessKey: this._accessKey,
        secretKey: this._secretKey,
        ttlSeconds: this._ttlSeconds,
      });
    }
    return this._jwt;
  }

  /** Force a refresh (e.g. on 401). */
  refresh(): KlingJwtToken {
    this._jwt = signKlingJwt({
      accessKey: this._accessKey,
      secretKey: this._secretKey,
      ttlSeconds: this._ttlSeconds,
    });
    return this._jwt;
  }

  /** Current token (may be expired). */
  get current(): KlingJwtToken | null {
    return this._jwt;
  }
}
