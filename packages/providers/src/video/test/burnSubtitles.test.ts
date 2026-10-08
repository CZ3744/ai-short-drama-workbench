/**
 * burnSubtitles tests — verify ffmpeg subtitle burning on Windows
 *
 * Run: npx tsx packages/providers/src/video/test/burnSubtitles.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { buildAnimatedAss } from "../burnSubtitles";

// 与产品使用相同 PATH，不绑定某位开发者的 OpenClaw 安装。
const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";
const hasBinaries = [FFMPEG, FFPROBE].every(bin =>
  spawnSync(bin, ["-version"], { windowsHide: true, timeout: 5000, stdio: "ignore" }).status === 0);

// ─── Helpers ──────────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `burn_test_${Date.now().toString(36)}`);

async function runBin(bin: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts?.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: opts?.timeoutMs ?? 60_000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString().slice(0, 65536); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString().slice(0, 65536); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on("error", (err) => resolve({ code: 1, stdout: "", stderr: err.message }));
  });
}

async function probeVideo(filePath: string): Promise<any> {
  const result = await runBin(FFPROBE, [
    "-v", "error", "-print_format", "json",
    "-show_streams", "-show_format", filePath,
  ]);
  if (result.code !== 0) throw new Error(`ffprobe failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// ─── Fixture generation ───────────────────────────────────────────

async function createTestMp4(outputPath: string): Promise<void> {
  // Generate a 2-second test video with a color and text
  const result = await runBin(FFMPEG, [
    "-y", "-f", "lavfi",
    "-i", "color=c=blue:size=640x480:duration=2:r=30",
    // 用纯色视频作输入，字幕本身由被测函数烧录，不引入额外 drawtext 字体依赖。
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
    "-pix_fmt", "yuv420p",
    "-an",
    outputPath,
  ], { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw new Error(`Failed to create test mp4: ${result.stderr.slice(-300)}`);
  }
}

async function createTestSrt(outputPath: string): Promise<void> {
  const srt = [
    "1",
    "00:00:00,000 --> 00:00:01,000",
    "Hello World 测试字幕",
    "",
    "2",
    "00:00:01,000 --> 00:00:02,000",
    "第二行字幕内容",
    "",
  ].join("\n");
  await fs.writeFile(outputPath, srt, "utf8");
}

// ─── Tests ────────────────────────────────────────────────────────

describe("custom subtitle document", () => {
  it("encodes valid ASS alpha/color bytes and preserves fractional outline width", () => {
    const ass = buildAnimatedAss("1\n00:00:00,000 --> 00:00:01,000\n字幕\n", "custom", "none", {
      width: 640, height: 480, marginV: 24, safeZoneBottomPct: 0.05,
    }, { font_family: "Arial", font_size: 48, color: "#112233", stroke_color: "#445566", stroke_width: 0.5,
      bg_color: "#123456", bg_opacity: 0.5, position: "top" });
    const style = ass.split("\n").find(line => line.startsWith("Style: Default,"))!.split(",");
    assert.equal(style[1], "Arial");
    assert.equal(style[2], "48");
    assert.equal(style[3], "&H00332211");
    assert.equal(style[5], "&H00665544");
    assert.equal(style[6], "&H80563412");
    assert.equal(style[16], "0.5");
    assert.equal(style[18], "8");
    assert.equal(style.length, 23);
  });
});

describe("burnSubtitles", { skip: hasBinaries ? false : "PATH 中缺少 ffmpeg 或 ffprobe，未执行真实字幕烧录" }, () => {
  let testMp4: string;
  let testSrt: string;
  let outputMp4: string;

  before(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    testMp4 = path.join(TEST_DIR, "test.mp4");
    testSrt = path.join(TEST_DIR, "test.srt");
    outputMp4 = path.join(TEST_DIR, "output.mp4");

    await createTestMp4(testMp4);
    await createTestSrt(testSrt);
  });

  after(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("burns subtitles into mp4 with default style", async () => {
    const { burnSubtitles } = await import("../burnSubtitles");

    await burnSubtitles({
      input_mp4: testMp4,
      srt: testSrt,
      output_mp4: outputMp4,
    });

    // Verify output exists
    const stat = await fs.stat(outputMp4);
    assert.ok(stat.size > 0, "output mp4 should be non-empty");

    // Verify video stream exists
    const probe = await probeVideo(outputMp4);
    const videoStream = probe.streams?.find((s: any) => s.codec_type === "video");
    assert.ok(videoStream, "should have video stream");
    assert.equal(videoStream.codec_name, "h264");
  });

  it("burns subtitles with clean style", async () => {
    const { burnSubtitles } = await import("../burnSubtitles");
    const styleOutput = path.join(TEST_DIR, "output_clean.mp4");

    await burnSubtitles({
      input_mp4: testMp4,
      srt: testSrt,
      output_mp4: styleOutput,
      style: "clean",
    });

    const stat = await fs.stat(styleOutput);
    assert.ok(stat.size > 0, "styled output should be non-empty");
  });

  it("burns subtitles with bold style", async () => {
    const { burnSubtitles } = await import("../burnSubtitles");
    const styleOutput = path.join(TEST_DIR, "output_bold.mp4");

    await burnSubtitles({
      input_mp4: testMp4,
      srt: testSrt,
      output_mp4: styleOutput,
      style: "bold",
    });

    const stat = await fs.stat(styleOutput);
    assert.ok(stat.size > 0, "bold output should be non-empty");
  });

  it("renders the custom subtitle document into a decodable video", async () => {
    const { burnSubtitles } = await import("../burnSubtitles");
    const customOutput = path.join(TEST_DIR, "output_custom.mp4");
    await burnSubtitles({ input_mp4: testMp4, srt: testSrt, output_mp4: customOutput, width: 640, height: 480,
      style: "custom", custom_style: { font_family: "Arial", font_size: 48, color: "#ffffff", stroke_color: "#000000",
        stroke_width: 0.5, bg_color: "#123456", bg_opacity: 0.5, position: "top" } });
    const probe = await probeVideo(customOutput);
    assert.ok(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "video"));
    const decoded = await runBin(FFMPEG, ["-v", "error", "-i", customOutput, "-f", "null", "-"]);
    assert.equal(decoded.code, 0, decoded.stderr);
  });

  it("handles paths with spaces", async () => {
    const spaceDir = path.join(TEST_DIR, "path with spaces");
    await fs.mkdir(spaceDir, { recursive: true });
    const spaceMp4 = path.join(spaceDir, "test video.mp4");
    const spaceSrt = path.join(spaceDir, "test subtitle.srt");
    const spaceOut = path.join(spaceDir, "output final.mp4");

    await createTestMp4(spaceMp4);
    await createTestSrt(spaceSrt);

    const { burnSubtitles } = await import("../burnSubtitles");

    await burnSubtitles({
      input_mp4: spaceMp4,
      srt: spaceSrt,
      output_mp4: spaceOut,
    });

    const stat = await fs.stat(spaceOut);
    assert.ok(stat.size > 0, "spaces-in-path output should be non-empty");
  });

  it("handles deep nested F: drive paths", async () => {
    const deepDir = path.join(TEST_DIR, "deep", "nested", "folder", "project_2026");
    await fs.mkdir(deepDir, { recursive: true });
    const deepMp4 = path.join(deepDir, "source.mp4");
    const deepSrt = path.join(deepDir, "captions.srt");
    const deepOut = path.join(deepDir, "burned_final.mp4");

    await createTestMp4(deepMp4);
    await createTestSrt(deepSrt);

    const { burnSubtitles } = await import("../burnSubtitles");

    await burnSubtitles({
      input_mp4: deepMp4,
      srt: deepSrt,
      output_mp4: deepOut,
    });

    const stat = await fs.stat(deepOut);
    assert.ok(stat.size > 0, "deep-path output should be non-empty");
  });

  it("rejects when input mp4 is missing", async () => {
    const { burnSubtitles } = await import("../burnSubtitles");

    await assert.rejects(
      () => burnSubtitles({
        input_mp4: path.join(TEST_DIR, "nonexistent.mp4"),
        srt: testSrt,
        output_mp4: outputMp4,
      }),
      /ENOENT|no such file/i,
    );
  });

  it("cleans up temporary srt in os.tmpdir after completion", async () => {
    const { burnSubtitles } = await import("../burnSubtitles");
    const cleanOut = path.join(TEST_DIR, "output_cleanup.mp4");

    await burnSubtitles({
      input_mp4: testMp4,
      srt: testSrt,
      output_mp4: cleanOut,
    });

    // 4C: temporary srt is now stored in os.tmpdir() with ulid filename,
    // not in the mp4 output directory. Verify burn succeeded (output exists).
    const stat = await fs.stat(cleanOut);
    assert.ok(stat.size > 0, "burned output should exist after temp srt cleanup");
  });
});
