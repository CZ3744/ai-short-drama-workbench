import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// sharp is a peer dependency — imported lazily so tests can mock
let _sharp: (typeof import("sharp"))["default"] | null = null;
async function getSharp() {
  if (!_sharp) {
    _sharp = (await import("sharp")).default;
  }
  return _sharp;
}

/**
 * Resolve ffmpeg path.  Tries:
 *   1. FFMPEG_PATH env var
 *   2. Well-known Windows path
 *   3. Falls back to "ffmpeg" on PATH
 */
let _ffmpegPath: string | null = null;
export async function getFfmpegPath(): Promise<string> {
  if (_ffmpegPath) return _ffmpegPath;
  if (process.env.FFMPEG_PATH) {
    try {
      await fs.access(process.env.FFMPEG_PATH);
      _ffmpegPath = process.env.FFMPEG_PATH;
      return _ffmpegPath;
    } catch {
      // env path not accessible, continue
    }
  }
  try {
    const { getConfigValue } = await import("../../core/src/localSettings.js");
    const cfgPath = getConfigValue("FFMPEG_PATH", "");
    if (cfgPath) {
      try {
        await fs.access(cfgPath);
        _ffmpegPath = cfgPath;
        return _ffmpegPath;
      } catch { /* not on disk */ }
    }
  } catch { /* localSettings not available */ }
  _ffmpegPath = "ffmpeg";
  return _ffmpegPath;
}

/**
 * Generate a thumbnail for an image file.
 * Returns the absolute path to the generated .webp file.
 */
export async function thumbnailImage(
  srcPath: string,
  destDir: string,
  size: 64 | 256
): Promise<string> {
  const sharp = await getSharp();
  const outName = path.basename(srcPath, path.extname(srcPath)) + `_${size}.webp`;
  const outPath = path.join(destDir, String(size), outName);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await sharp(srcPath)
    .resize(size, size, { fit: "cover" })
    .webp({ quality: 80 })
    .toFile(outPath);
  return outPath;
}

/**
 * Generate a thumbnail for a video file by extracting the frame at 1 second.
 * Returns the absolute path to the generated .webp file.
 */
export async function thumbnailVideo(
  srcPath: string,
  destDir: string,
  size: 64 | 256
): Promise<string> {
  const ffmpeg = await getFfmpegPath();
  const sharp = await getSharp();
  const baseName = path.basename(srcPath, path.extname(srcPath));
  const tmpFrame = path.join(destDir, `${baseName}_frame.png`);
  const outName = `${baseName}_${size}.webp`;
  const outPath = path.join(destDir, String(size), outName);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  // Extract frame at 1 second
  try {
    await execFileAsync(ffmpeg, [
      "-y", "-ss", "1", "-i", srcPath,
      "-frames:v", "1", "-q:v", "2", tmpFrame,
    ], { timeout: 30_000, windowsHide: true });
  } catch {
    // If frame extraction fails (e.g. video < 1s), try 0s
    await execFileAsync(ffmpeg, [
      "-y", "-ss", "0", "-i", srcPath,
      "-frames:v", "1", "-q:v", "2", tmpFrame,
    ], { timeout: 30_000, windowsHide: true });
  }

  // Resize extracted frame
  await sharp(tmpFrame)
    .resize(size, size, { fit: "cover" })
    .webp({ quality: 80 })
    .toFile(outPath);

  // Clean up temp frame
  await fs.unlink(tmpFrame).catch(() => {});

  return outPath;
}

/**
 * Generate a placeholder SVG path for audio thumbnails.
 * Returns the absolute path to a small SVG icon file.
 */
export async function thumbnailAudioPlaceholder(
  destDir: string,
  size: 64 | 256
): Promise<string> {
  const outDir = path.join(destDir, String(size));
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "audio_placeholder.svg");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#e2e8f0" rx="8"/>
  <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-size="${Math.round(size * 0.3)}" fill="#64748b">♪</text>
</svg>`;
  await fs.writeFile(outPath, svg, "utf-8");
  return outPath;
}
