/**
 * Jimeng Image Client — Low-level HTTP + HMAC-SHA256 signing for Volcengine/即梦 API
 *
 * Volcengine uses a Signature Version 4 style signing (similar to AWS SigV4).
 * Reference: https://www.volcengine.com/docs/6369/67269
 *
 * Endpoint: POST https://visual.volcengineapi.com
 * Action: CVProcess (即梦 4.0 image generation)
 * Region: cn-north-1 (default)
 */

import crypto from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────

export interface JimengClientConfig {
  accessKey: string;
  secretKey: string;
  region?: string;       // default "cn-north-1"
  service?: string;      // default "cv"
  host?: string;         // default "visual.volcengineapi.com"
  endpoint?: string;     // full override, default built from host
}

export interface JimengImageRequestBody {
  req_key: string;                   // e.g. "jimeng_high_aes_general_v40" (即梦4.0)
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  scale?: number;                    // guidance scale, 1-20, default 7.5
  seed?: number;
  steps?: number;                    // inference steps, default 30
  use_sr?: boolean;                  // super-resolution
  return_url?: boolean;              // return image URL instead of base64
  image_urls?: string[];             // reference image URLs
  binary_data_base64?: string[];     // reference image base64
  num_images?: number;               // batch size if API supports it
  model_version?: string;            // model version id
}

export interface JimengImageResponseItem {
  image_url?: string;
  binary_data_base64?: string;
  width?: number;
  height?: number;
  seed?: number;
}

export interface JimengApiResponse {
  code: number;            // 10000 = success
  message: string;
  data?: {
    binary_data_base64?: string[];
    image_urls?: string[];
    sub_codes?: string[];
  };
  response_metadata?: {
    request_id: string;
    status_code: number;
    error?: {
      code: string;
      message: string;
    };
  };
}

// ─── Signing constants ──────────────────────────────────────────────────

const ALGORITHM = "HMAC-SHA256";
const SIGNED_HEADERS = "content-type;host;x-content-sha256;x-date";
const SERVICE = "cv";
const REGION = "cn-north-1";
const HOST = "visual.volcengineapi.com";

// ─── JimengImageClient ──────────────────────────────────────────────────

export class JimengImageClient {
  private accessKey: string;
  private secretKey: string;
  private region: string;
  private service: string;
  private host: string;
  private endpoint: string;

  constructor(config: JimengClientConfig) {
    this.accessKey = config.accessKey;
    this.secretKey = config.secretKey;
    this.region = config.region ?? REGION;
    this.service = config.service ?? SERVICE;
    this.host = config.host ?? HOST;
    this.endpoint = config.endpoint ?? `https://${this.host}`;
  }

  /**
   * Submit an image generation request to 即梦 4.0.
   * Returns the parsed JSON response.
   */
  async generateImage(
    body: JimengImageRequestBody,
    signal?: AbortSignal,
  ): Promise<JimengApiResponse> {
    const action = "CVProcess";
    const version = "2022-08-31";
    const bodyStr = JSON.stringify(body);

    const now = new Date();
    const xDate = this._formatDate(now);
    const shortDate = this._formatShortDate(now);

    const bodyHash = this._sha256Hex(bodyStr);

    // Build query string with Action + Version
    const queryParams = new URLSearchParams({ Action: action, Version: version });
    const queryString = queryParams.toString();

    // Build canonical request
    const canonicalUri = "/";
    const canonicalQueryString = this._canonicalQueryString(queryParams);
    const canonicalHeaders = [
      `content-type:application/json`,
      `host:${this.host}`,
      `x-content-sha256:${bodyHash}`,
      `x-date:${xDate}`,
    ].join("\n") + "\n";

    const canonicalRequest = [
      "POST",
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      SIGNED_HEADERS,
      bodyHash,
    ].join("\n");

    // Build string to sign
    const credentialScope = `${shortDate}/${this.region}/${this.service}/request`;
    const stringToSign = [
      ALGORITHM,
      xDate,
      credentialScope,
      this._sha256Hex(canonicalRequest),
    ].join("\n");

    // Calculate signing key
    const signingKey = this._getSignatureKey(shortDate);

    // Calculate signature
    const signature = this._hmacHex(signingKey, stringToSign);

    // Build Authorization header
    const authorization = [
      `${ALGORITHM} Credential=${this.accessKey}/${credentialScope}`,
      `SignedHeaders=${SIGNED_HEADERS}`,
      `Signature=${signature}`,
    ].join(", ");

    const url = `${this.endpoint}?${queryString}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Host": this.host,
      "X-Content-Sha256": bodyHash,
      "X-Date": xDate,
      "Authorization": authorization,
    };

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
      // 删 AbortSignal.timeout(120_000) fallback, 只透传 signal (用户主动中止).
      signal,
    });

    const json = (await resp.json()) as JimengApiResponse;

    if (!resp.ok && !json.code) {
      // HTTP-level error without a proper API response
      return {
        code: resp.status,
        message: `HTTP ${resp.status}: ${resp.statusText}`,
        response_metadata: {
          request_id: "",
          status_code: resp.status,
          error: {
            code: String(resp.status),
            message: resp.statusText,
          },
        },
      };
    }

    return json;
  }

  /**
   * Download an image from a URL returned by the API.
   * Returns the raw Buffer.
   */
  async downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> {
    const resp = await fetch(url, {
      // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(60_000) fallback, 只透传 signal.
      signal,
    });
    if (!resp.ok) {
      throw new Error(`Image download failed: HTTP ${resp.status}`);
    }
    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ─── Signing helpers ──────────────────────────────────────────────────

  private _sha256Hex(data: string): string {
    return crypto.createHash("sha256").update(data, "utf8").digest("hex");
  }

  private _hmac(key: Buffer | string, data: string): Buffer {
    return crypto.createHmac("sha256", key).update(data, "utf8").digest();
  }

  private _hmacHex(key: Buffer | string, data: string): string {
    return crypto.createHmac("sha256", key).update(data, "utf8").digest("hex");
  }

  private _getSignatureKey(shortDate: string): Buffer {
    const kDate = this._hmac(this.secretKey, shortDate);
    const kRegion = this._hmac(kDate, this.region);
    const kService = this._hmac(kRegion, this.service);
    const kSigning = this._hmac(kService, "request");
    return kSigning;
  }

  private _formatDate(d: Date): string {
    // ISO 8601 basic format: YYYYMMDDTHHmmssZ
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }

  private _formatShortDate(d: Date): string {
    // YYYYMMDD
    return this._formatDate(d).slice(0, 8);
  }

  private _canonicalQueryString(params: URLSearchParams): string {
    const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
  }
}
