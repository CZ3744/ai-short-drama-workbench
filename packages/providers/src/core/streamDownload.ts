import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export interface StreamDownloadOptions {
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface StreamDownloadResult {
  filePath: string;
  bytes: number;
  sha256: string;
}

const DEFAULT_MAX_BYTES = 200_000_000; // 200MB
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min

/**
 * Stream-download a URL to a file with size limit and SHA-256 hash.
 * Throws if maxBytes is exceeded (aborts immediately, deletes partial file).
 */
export async function streamDownloadToFile(
  url: string,
  dest: string,
  opts: StreamDownloadOptions = {},
): Promise<StreamDownloadResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  void opts.timeoutMs; // 2026-05-19: 用户原话"禁止在本地设置主动超时" — opts.timeoutMs 不再生效.
  void DEFAULT_TIMEOUT_MS;

  // Ensure parent dir exists
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  // controller 仍保留 — 用于 size limit 超过时主动 abort (非本地"等响应超时").
  const controller = new AbortController();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: opts.headers,
    });

    if (!response.ok) {
      throw Object.assign(new Error(`Download failed: HTTP ${response.status}`), {
        error_type: "download_failed",
      });
    }

    // Content-Length pre-check
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > maxBytes) {
      throw Object.assign(
        new Error(`File too large: ${contentLength} bytes (limit: ${maxBytes})`),
        { error_type: "file_too_large" },
      );
    }

    if (!response.body) {
      throw Object.assign(new Error("Response body is null"), {
        error_type: "download_failed",
      });
    }

    // Stream to file with byte counting
    const nodeStream = Readable.fromWeb(response.body as any);
    const writeStream = fs.createWriteStream(dest);

    let bytesWritten = 0;
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256");

    const { Transform } = await import("node:stream");
    const sizeChecker = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesWritten += chunk.length;
        hash.update(chunk);
        if (bytesWritten > maxBytes) {
          // Abort and clean up
          controller.abort();
          callback(new Error(`Download exceeded maxBytes limit: ${bytesWritten} > ${maxBytes}`));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(nodeStream, sizeChecker, writeStream);
    } catch (err: any) {
      // Clean up partial file
      try { await fsp.unlink(dest); } catch { /* ignore */ }
      throw err;
    }

    const sha256 = hash.digest("hex");
    return { filePath: dest, bytes: bytesWritten, sha256 };
  } finally {
    // 2026-05-19: 已删除本地 timer — 无需 clearTimeout.
  }
}

/**
 * Save a buffer to vault using the fromFile pattern.
 * Writes to a temp file first, then renames to final location.
 */
export async function saveFromFile(
  sourcePath: string,
  destPath: string,
): Promise<void> {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.rename(sourcePath, destPath);
}
