// P20: Local Mock Video Provider — new implementation using ffmpeg + local cards

import fs from "node:fs/promises";
import path from "node:path";
import type { PresetOption } from "../../../core/src/presetSchema";
import type { VideoProvider, VideoGenerateRequest, VideoGenerateResponse, ProviderContext, HealthCheckResult } from "../core/types";
import { ProviderError } from "../core/errors";

export class LocalMockVideoProvider implements VideoProvider {
  readonly id: string;
  readonly mode: "mock" = "mock";

  constructor(_cfg: PresetOption, _apiKey: string | null) {
    this.id = "local_mock_video";
  }

  // 2026-05-21 X-1: request.last_frame 在 mock provider 不适用, silent 忽略.
  async generate(req: VideoGenerateRequest, ctx: ProviderContext): Promise<VideoGenerateResponse> {
    // Use ffmpeg to create a simple mock video from a solid color
    const { spawn } = await import("node:child_process");
    const tmpDir = path.join(process.cwd(), "outputs", "mock_video");
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `mock_${ctx.task_id}_${Date.now()}.mp4`);

    const w = req.aspect_ratio === "9:16" ? 1080 : req.aspect_ratio === "1:1" ? 1080 : 1920;
    const h = req.aspect_ratio === "9:16" ? 1920 : req.aspect_ratio === "1:1" ? 1080 : 1080;
    const duration = req.duration_sec;

    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", [
        "-y", "-f", "lavfi",
        "-i", `color=c=0x1a1a2e:s=${w}x${h}:d=${duration}:r=30`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        outputPath,
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      let killed = false;
      // mock 视频是纯本地 ffmpeg color 滤镜, 5s 应该够任何分辨率渲完
      // 给 max(120s, duration*30s) 上限 (估 1s 视频最多耗 30s 渲染)
      const timer = setTimeout(() => {
        killed = true;
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
        reject(new Error(`mock_video ffmpeg timeout: ${stderr.slice(-200)}`));
      }, Math.max(120_000, duration * 30_000));
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (killed) return;
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg mock failed: ${stderr.slice(-300)}`));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        if (!killed) reject(err);
      });
    });

    const buffer = await fs.readFile(outputPath);
    // Clean up temp file
    await fs.unlink(outputPath).catch(() => {});

    return {
      video: {
        buffer,
        mime: "video/mp4",
        duration_sec: duration,
        width: w,
        height: h,
      },
      cost: { currency: "CNY", amount: 0, basis: "measured" },
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: true };
  }

  estimateCost(_req: VideoGenerateRequest): { cny: number; basis: "accurate" } {
    return { cny: 0, basis: "accurate" };
  }

  async cancel(_providerJobId: string, _ctx: ProviderContext): Promise<"cancelled" | "unsupported" | "failed"> {
    return "unsupported";
  }
}
