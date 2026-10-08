// P20: Edge TTS Provider wrapper — adapts existing tts.ts EdgeTtsProvider to TtsProvider interface

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PresetOption } from "../../../core/src/presetSchema";
import type { TtsProvider, TtsSynthesizeRequest, TtsSynthesizeResponse, ProviderContext, HealthCheckResult, TtsVoiceInfo } from "../core/types";
import { ProviderError } from "../core/errors";

const DEFAULT_VOICES: TtsVoiceInfo[] = [
  { id: "zh-CN-YunxiNeural", gender: "male", language: "zh-CN" },
  { id: "zh-CN-XiaoxiaoNeural", gender: "female", language: "zh-CN" },
  { id: "zh-CN-YunjianNeural", gender: "male", language: "zh-CN" },
  { id: "zh-CN-YunyangNeural", gender: "male", language: "zh-CN" },
  { id: "zh-CN-XiaoyiNeural", gender: "female", language: "zh-CN" },
  { id: "zh-CN-YunxiaNeural", gender: "male", language: "zh-CN" },
  { id: "en-US-AriaNeural", gender: "female", language: "en-US" },
  { id: "en-US-GuyNeural", gender: "male", language: "en-US" },
];

export class EdgeTtsWrapper implements TtsProvider {
  readonly id: string = "edge_tts";

  constructor(_cfg: PresetOption, _apiKey: string | null) {}

  async synthesize(req: TtsSynthesizeRequest, ctx: ProviderContext): Promise<TtsSynthesizeResponse> {
    const tmpDir = path.join(process.cwd(), "outputs", "tts");
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `edge_tts_${ctx.task_id}_${Date.now()}.m4a`);

    const rate = req.rate ? `${req.rate > 0 ? "+" : ""}${req.rate}%` : "+0%";

    try {
      const duration = await runEdgeTts(req.text, req.voice_id, rate, outputPath);
      const buffer = await fs.readFile(outputPath);
      await fs.unlink(outputPath).catch(() => {});

      return {
        audio: {
          buffer,
          mime: "audio/mp4",
          duration_sec: duration,
        },
        cost: { currency: "CNY", amount: 0, basis: "measured" },
      };
    } catch (err: any) {
      throw new ProviderError({
        message: err.message ?? String(err),
        code: "server",
        provider_id: this.id,
        retriable: false,
        original: err,
      });
    }
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    return DEFAULT_VOICES;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
        const child = spawn("python", ["-m", "edge_tts", "--list-voices"], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          resolve({ code: null, timedOut: true });
        }, 15_000);
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, timedOut: false }); });
        child.on("error", () => { clearTimeout(timer); resolve({ code: null, timedOut: false }); });
      });
      if (result.timedOut) return { ok: false, reason: "health_check_timeout" };
      if (result.code === 0) return { ok: true };
      return { ok: false, reason: "edge_tts not available" };
    } catch {
      return { ok: false, reason: "edge_tts not available" };
    }
  }
}

// V-6: stderr ring buffer — 防止 edge-tts / ffprobe 日志无限增长
const MAX_STDERR = 16 * 1024; // 16KB

function createStderrRing(): { buf: string; push(chunk: string): void } {
  let buf = "";
  return {
    get buf() { return buf; },
    push(chunk: string) {
      buf += chunk;
      if (buf.length > MAX_STDERR * 2) {
        // 超过 2x 上限时裁剪:保留末尾 MAX_STDERR
        buf = buf.slice(-MAX_STDERR);
      }
    },
  };
}

function runEdgeTts(text: string, voice: string, rate: string, outputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = ["-m", "edge_tts", "--voice", voice, "--rate", rate, "--text", text, "--write-media", outputPath];
    const child = spawn("python", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stderr = createStderrRing();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
      // Clean up partial output file on timeout
      fs.unlink(outputPath).catch(() => {});
    }, 60_000);
    child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk.toString()); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", async (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("edge-tts timed out"));
      if (code !== 0) return reject(new Error(`edge-tts exited ${code}: ${stderr.buf.slice(-300)}`));
      // Probe duration with ffprobe
      try {
        const dur = await getAudioDuration(outputPath);
        resolve(dur);
      } catch {
        resolve(0);
      }
    });
  });
}

function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-print_format", "json", "-show_format", filePath,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const stderr = createStderrRing();
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("ffprobe timeout")); }, 15_000);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr.push(d.toString()); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      try {
        const parsed = JSON.parse(stdout);
        resolve(Number(parsed.format?.duration ?? 0));
      } catch {
        reject(new Error("ffprobe parse error"));
      }
    });
    child.on("error", reject);
  });
}
