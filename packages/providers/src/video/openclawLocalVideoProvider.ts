// P25: OpenClaw Local Video Provider — exec-based, merges animatediff + wan via engine field

import fs from "node:fs/promises";
import path from "node:path";
import type { PresetOption } from "../../../core/src/presetSchema";
import type { VideoProvider, VideoGenerateRequest, VideoGenerateResponse, ProviderContext, HealthCheckResult } from "../core/types";
import { ProviderError } from "../core/errors";
import { runPythonScript } from "../core/localExec";

/**
 * Preset extras expected from video_provider.json:
 *   executor: {
 *     python_path: string;       // venv python
 *     script_path: string;       // video_gen_local.py (unified entry)
 *     engine?: string;           // "wan2.1" | "animatediff" | "mock" (default: "wan2.1")
 *     timeout_ms?: number;       // default 900000 (15 min)
 *   }
 */
export class OpenClawLocalVideoProvider implements VideoProvider {
  readonly id: string;
  // 2026-05-18 v3: mode 回 "t2v". OpenClaw 实际是"双模 provider"(有首帧走 i2v injection,
  //   无首帧走 t2v), 但 mode 字段 single 表达不了双模. 让 mode="t2v" 默认不强制首帧,
  //   配合 jobs/orchestrator.ts 加的 OpenClaw 特例 (local_animatediff* providers 即使
  //   mode="t2v" 也透传 first_frame 给 provider, provider 内 latent injection 代码
  //   根据有无 first_frame 自动决定走 i2v 或 t2v).
  //   - 用户没 pick 首帧 → mode="t2v" gate 不 throw → 走 t2v
  //   - 用户 pick 首帧 → OpenClaw 特例透传 → provider 走 i2v latent injection
  readonly mode: "t2v" = "t2v";
  private _cfg: PresetOption;
  private _executor: ExecutorConfig;

  constructor(cfg: PresetOption, _apiKey: string | null) {
    this.id = cfg.id;
    this._cfg = cfg;
    this._executor = (cfg as any).executor ?? {};
  }

  // 2026-05-21 X-1: request.last_frame 暂未接 — OpenClaw AnimateDiff 支持首帧 latent injection,
  // 但尾帧锚定需研究 animatediff_gen.py 是否支持两帧约束. TODO(animatediff-last-frame) 调研后接.
  async generate(req: VideoGenerateRequest, ctx: ProviderContext): Promise<VideoGenerateResponse> {
    const { python_path, script_path, engine } = this._validateExecutor();

    // 2026-05-18 i2v latent injection: animatediff_gen.py 加 --init-image 支持 i2v.
    // AnimateDiffPipeline 原生只 t2v, 通过传 latents 参数 (含首帧 latent 注入第 0 帧)
    // 实现 "伪 i2v" — 第 0 帧锚定首帧, 后续帧由 motion adapter 演化.
    // Lightning + LCM 4 步推理首帧锚定较弱 (每步噪声去得多), 用户视情况调 strength=0.6-0.9.
    // 早前版本是 silent drop 首帧 (req.first_frame 收到但 push args 只放 prompt), 红线 #1.
    let initImagePath: string | null = null;
    if (req.first_frame?.asset_id) {
      // videoGenerationService.ts:118 已 resolve, asset_id 字段填的是绝对文件路径
      const candidate = req.first_frame.asset_id;
      try {
        await fs.stat(candidate);
        initImagePath = candidate;
        ctx.log("info", `[openclaw-local-video] i2v: 首帧 ${candidate} → 透传给 animatediff_gen.py --init-image`);
      } catch {
        // 文件不存在 — 显式失败而非 silent drop. videoGenerationService 应该已 resolve 但万一漏
        throw new ProviderError({
          message: `本地 AnimateDiff i2v: 首帧文件不存在 (asset_id 字段填的应是绝对路径): ${candidate}`,
          code: "invalid_request",
          provider_id: this.id,
          retriable: false,
        });
      }
    }

    // Prepare output path
    const tmpDir = path.join(process.cwd(), "outputs", "video");
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `openclaw_${ctx.task_id}_${Date.now()}.mp4`);

    // Map aspect ratio to dimensions
    const { width, height } = this._aspectToDims(req.aspect_ratio);

    // 2026-05-17 fix: OpenClaw video_gen_local.py 的 prompt 是 positional 参数,
    // 之前 provider 传 `--prompt <text>` 跑起来直接 `error: unrecognized arguments: --prompt`,
    // animatediff_gen.py 也是 positional。统一改成 [options...] prompt 顺序。
    // 同样 --seed 不在 video_gen_local.py 顶层,只有 animatediff_gen.py 接;
    // 给 video_gen_local 路径不放 seed 也无害,脚本忽略。
    let frames = Math.round(req.duration_sec * 8);

    // 2026-05-17: AnimateDiff motion adapter v1-5-2 训练时序列固定 32 帧
    // (推理 >32 帧直接 tensor shape mismatch)。但 diffusers FreeNoise 滑窗能突破:
    //   pipe.enable_free_noise(context_length=16, context_stride=4) → 拆 16 帧 chunk + overlap blend
    //   pipe.enable_free_noise_split_inference() → VAE 分块, 8GB GPU 解 120 帧 512x320 不 OOM
    // animatediff_gen.py 在 frames > 32 时自动启用 FreeNoise, 这里只 cap 在 120 帧 (≈ 15s @8fps)
    // 防极端 case (用户填了 60s 视频, 滑窗也会跑爆 GPU + 等十几分钟)。
    const ANIMATEDIFF_MAX_FRAMES_FREENOISE = 120;
    if (engine === "animatediff" && frames > ANIMATEDIFF_MAX_FRAMES_FREENOISE) {
      throw new ProviderError({
        message:
          `本地 AnimateDiff (FreeNoise 滑窗) 单次最多 ${ANIMATEDIFF_MAX_FRAMES_FREENOISE} 帧 (≈ 15 秒 @8fps)。` +
          `本镜请求 ${req.duration_sec}s = ${frames} 帧, 超出 ${frames - ANIMATEDIFF_MAX_FRAMES_FREENOISE} 帧。` +
          `建议: 拆分多镜每个 ≤ 15 秒, 或选用在线视频 provider。`,
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }
    if (engine === "animatediff" && frames > 32) {
      ctx.log("info", `[openclaw-local-video] frames=${frames} > 32, animatediff_gen.py 将启用 FreeNoise 滑窗 (推理时间随帧数线性增长)`);
    }

    const args: string[] = [
      "--engine", engine,
      "--out", outputPath,
      "--width", String(width),
      "--height", String(height),
      "--fps", "8",
      "--frames", String(frames),
    ];
    // 2026-05-18 i2v: 把首帧绝对路径透传给 video_gen_local.py → animatediff_gen.py
    //   的 --init-image / --init-strength. strength 默认 0.85 (本地 Python 实测 0.85
    //   首帧色块结构能锁定, 0.6 太弱被 Lightning LCM 4 步去噪洗掉).
    if (initImagePath) {
      args.push("--init-image", initImagePath, "--init-strength", "0.85");
    }
    // prompt 必须在最后(positional)
    args.push(req.prompt);

    ctx.log("info", `[openclaw-local-video] Generating ${width}x${height}, engine=${engine}, frames=${frames}, duration=${req.duration_sec}s`);

    const timeoutMs = this._executor.timeout_ms ?? 900_000; // 15 min

    try {
      let lastStdoutLine = "";

      const result = await runPythonScript({
        python_path,
        script_path,
        args,
        timeout_ms: timeoutMs,
        signal: ctx.signal,
        on_stdout: (line) => {
          lastStdoutLine = line;
          if (line.includes("[INFO]") || line.includes("[WARN]")) {
            ctx.log("info", `[video_gen] ${line}`);
          }
        },
        on_stderr: (line) => {
          ctx.log("warn", `[video_gen:stderr] ${line}`);
        },
      });

      if (result.exit_code !== 0) {
        if (result.stderr.includes("No such file") || result.stderr.includes("not found") || result.stderr.includes("No module")) {
          throw new ProviderError({
            message: `OpenClaw video_gen failed (venv missing?): ${result.stderr.slice(-300)}`,
            code: "server",
            provider_id: this.id,
            retriable: false,
          });
        }
        throw new ProviderError({
          message: `video_gen_local.py exited ${result.exit_code}: ${result.stderr.slice(-300)}`,
          code: "server",
          provider_id: this.id,
          retriable: false,
        });
      }

      // video_gen_local.py returns JSON on stdout with the output path or error.
      // 2026-05-17 修 silent fallback 红线: exit 0 + JSON 含 "error" 字段时, 之前会进入
      // fs.readFile fallback → ENOENT 误以为是路径问题, 实际是推理失败被 swallow。
      // 现在显式解析 JSON, 含 error 字段直接 throw 带原始 Python 错误信息。
      let actualOutput = outputPath;
      let parsedResult: { output?: string; error?: string; engine?: string; stderr?: string } | null = null;
      // 尝试找最大的 JSON 对象 (动态 frame 报错时 stdout 含多层嵌套, 简单 {[^}]*output[^}]*} 不够)
      const balancedMatch = extractLastJson(result.stdout);
      if (balancedMatch) {
        try {
          parsedResult = JSON.parse(balancedMatch);
          if (parsedResult?.output) actualOutput = parsedResult.output;
        } catch {
          // ignore parse failure
        }
      }

      // 子脚本 exit 0 但实际报错 → 现在 stdout JSON 含 error 字段, throw
      if (parsedResult?.error) {
        throw new ProviderError({
          message: `本地视频生成失败: ${parsedResult.error}`,
          code: "server",
          provider_id: this.id,
          retriable: false,
        });
      }

      // Read the generated file - 不再 silent fallback 到 outputPath, 路径错就清晰报错
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(actualOutput);
      } catch (readErr: any) {
        // 两个路径都试不到 → 真实文件没产出, 错误信息带上 stdout 后 800 字符给用户排查
        const stdoutTail = result.stdout.slice(-800).replace(/[\r\n]+/g, " | ");
        throw new ProviderError({
          message:
            `本地视频生成进程退出 0 但未写出 mp4 (期望 ${path.basename(outputPath)}, 实际路径 ${path.basename(actualOutput)})。` +
            `Python stdout 末段: ${stdoutTail}`,
          code: "server",
          provider_id: this.id,
          retriable: false,
          original: readErr,
        });
      }

      // Clean up
      await fs.unlink(actualOutput).catch(() => {});
      if (actualOutput !== outputPath) {
        await fs.unlink(outputPath).catch(() => {});
      }

      ctx.log("info", `[openclaw-local-video] Done, ${buffer.length} bytes, ${result.duration_ms}ms`);

      return {
        video: {
          buffer,
          mime: "video/mp4",
          duration_sec: req.duration_sec,
          width,
          height,
          fps: 8,  // 2026-05-17: video_gen_local.py 写死传 --fps 8 给 animatediff_gen, provider 真实 fps 是 8 不是 24
        },
        cost: { currency: "CNY", amount: 0, basis: "measured" },
      };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError({
        message: err.message ?? String(err),
        code: "server",
        provider_id: this.id,
        retriable: false,
        original: err,
      });
    }
  }

  estimateCost(_req: VideoGenerateRequest): { cny: number; basis: "accurate" } {
    return { cny: 0, basis: "accurate" };
  }

  async cancel(_providerJobId: string, _ctx: ProviderContext): Promise<"cancelled" | "unsupported" | "failed"> {
    return "unsupported";
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const { python_path } = this._validateExecutor();

    try {
      const fsSync = await import("node:fs");
      if (!fsSync.existsSync(python_path)) {
        return { ok: false, reason: `missing venv: python not found at ${python_path}` };
      }
    } catch {
      return { ok: false, reason: "missing venv: cannot verify python path" };
    }

    try {
      const result = await runPythonScript({
        python_path,
        script_path: this._executor.script_path!,
        args: ["--help"],
        timeout_ms: 15_000,
      });
      if (result.exit_code !== 0 && result.stderr.includes("No module")) {
        return { ok: false, reason: "missing venv: required Python packages not installed" };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: `healthCheck failed: ${err.message}` };
    }
  }

  // ─── internals ──────────────────────────────────────────────────

  private _validateExecutor(): { python_path: string; script_path: string; engine: string } {
    const exec = this._executor;
    if (!exec.python_path) {
      throw new ProviderError({
        message: "OpenClaw video executor.python_path not configured in preset",
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }
    if (!exec.script_path) {
      throw new ProviderError({
        message: "OpenClaw video executor.script_path not configured in preset",
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }
    return {
      python_path: exec.python_path,
      script_path: exec.script_path,
      engine: exec.engine ?? "wan2.1",
    };
  }

  private _aspectToDims(aspect: string): { width: number; height: number } {
    // 2026-05-17: 本地 GPU AnimateDiff 推理时间随像素数大致线性放大,
    // 832x480 在 RTX 4060 8GB 上 25 步 = ~6 分钟,体验不可接受。
    // 改成小尺寸默认(像素降到 1/3-1/4),2 秒视频 ~30-60 秒可出。
    // 关键约束: backend orchestrator validateVideoFile 要求 >= 360x360,
    // 高度必须 >= 360 否则被当损坏文件 reject (这就是 512x320 失败的真因)。
    switch (aspect) {
      case "9:16": return { width: 384, height: 640 };
      case "1:1": return { width: 400, height: 400 };
      case "16:9":
      default: return { width: 640, height: 368 };  // 16:9 ≈ 1.74, height ≥ 360 满足 backend 校验
    }
  }
}

interface ExecutorConfig {
  python_path?: string;
  script_path?: string;
  engine?: string;
  timeout_ms?: number;
}

/**
 * 2026-05-17: 从 stdout 提取最后一个平衡的 JSON 对象。
 * video_gen_local.py 在 animatediff 子脚本失败时会 print 双层嵌套 JSON
 * (外层 video_gen_local 包内层 animatediff_gen result, 含 stdout/stderr 字符串),
 * 用简单的非贪婪 `\{[^}]*\}` 只能匹配最里层小段。
 * 这里走括号配对从末尾向前找第一个完整 JSON 对象。
 */
function extractLastJson(text: string): string | null {
  if (!text) return null;
  // 从右到左找第一个 } 然后向左配对 {
  for (let end = text.length - 1; end >= 0; end--) {
    if (text[end] !== "}") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let start = end; start >= 0; start--) {
      const c = text[start];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === "}") depth++;
      else if (c === "{") {
        depth--;
        if (depth === 0) {
          return text.slice(start, end + 1);
        }
      }
    }
  }
  return null;
}
