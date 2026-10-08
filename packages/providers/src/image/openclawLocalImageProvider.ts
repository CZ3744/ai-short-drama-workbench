// P25: OpenClaw Local SDXL Image Provider — exec-based, no cloud API key needed

import fs from "node:fs/promises";
import path from "node:path";
import type { PresetOption } from "../../../core/src/presetSchema";
import type { ImageProvider, ImageGenerateRequest, ImageGenerateResponse, ProviderContext, HealthCheckResult } from "../core/types";
import { ProviderError } from "../core/errors";
import { runPythonScript } from "../core/localExec";

/**
 * Preset extras expected from image_provider.json:
 *   executor: {
 *     python_path: string;       // e.g. C:/Projects/video-studio\OpenClaw\resources\venvs\imagegen\.venv\Scripts\python.exe
 *     script_path: string;       // e.g. C:/Projects/video-studio\OpenClaw\scripts\imggen_local.py
 *     default_model_variant?: string; // "lightning" | "dreamshaper" | "realistic"
 *     steps?: number;            // default 4
 *     default_negative_prompt?: string;
 *     timeout_ms?: number;       // default 300000 (5 min)
 *   }
 */
export class OpenClawLocalImageProvider implements ImageProvider {
  readonly id: string;
  private _cfg: PresetOption;
  private _executor: ExecutorConfig;

  constructor(cfg: PresetOption, _apiKey: string | null) {
    this.id = cfg.id;
    this._cfg = cfg;
    this._executor = (cfg as any).executor ?? {};
  }

  async generate(req: ImageGenerateRequest, ctx: ProviderContext): Promise<ImageGenerateResponse> {
    const { python_path, script_path } = this._validateExecutor();

    // Prepare output path
    const tmpDir = path.join(process.cwd(), "outputs", "images");
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `sdxl_${ctx.task_id}_${Date.now()}.png`);

    // Build CLI args — no quoting needed: spawn uses shell:false by default,
    // so each arg is passed directly to the process as a single argv element.
    const args: string[] = [
      req.prompt,
      "--output", outputPath,
      "--width", String(req.width),
      "--height", String(req.height),
    ];

    const steps = this._executor.steps ?? 4;
    args.push("--steps", String(steps));

    if (req.seed !== undefined) {
      args.push("--seed", String(req.seed));
    }

    const negPrompt = req.negative_prompt ?? this._executor.default_negative_prompt;
    if (negPrompt) {
      args.push("--negative-prompt", negPrompt);
    }

    const modelVariant = this._executor.default_model_variant ?? "lightning";
    args.push("--model", modelVariant);

    ctx.log("info", `[openclaw-local-image] Generating ${req.width}x${req.height}, model=${modelVariant}, steps=${steps}`);

    const timeoutMs = this._executor.timeout_ms ?? 300_000;

    try {
      const result = await runPythonScript({
        python_path,
        script_path,
        args,
        timeout_ms: timeoutMs,
        signal: ctx.signal,
        on_stdout: (line) => {
          if (line.includes("[INFO]") || line.includes("[WARN]")) {
            ctx.log("info", `[imggen] ${line}`);
          }
        },
        on_stderr: (line) => {
          ctx.log("warn", `[imggen:stderr] ${line}`);
        },
      });

      if (result.exit_code !== 0) {
        // Check for venv missing error
        if (result.stderr.includes("No such file") || result.stderr.includes("not found") || result.stderr.includes("No module")) {
          throw new ProviderError({
            message: `OpenClaw imggen failed (venv missing?): ${result.stderr.slice(-300)}`,
            code: "server",
            provider_id: this.id,
            retriable: false,
          });
        }
        throw new ProviderError({
          message: `imggen_local.py exited ${result.exit_code}: ${result.stderr.slice(-300)}`,
          code: "server",
          provider_id: this.id,
          retriable: false,
        });
      }

      // Check stdout for [INFO] Saved to: <path>
      const savedMatch = result.stdout.match(/\[INFO\]\s*Saved to:\s*(.+)$/m);
      const actualOutput = savedMatch ? savedMatch[1].trim() : outputPath;

      // Read the generated file
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(actualOutput);
      } catch {
        // Try the original outputPath
        buffer = await fs.readFile(outputPath);
      }

      // Clean up temp file
      await fs.unlink(actualOutput).catch(() => {});
      if (actualOutput !== outputPath) {
        await fs.unlink(outputPath).catch(() => {});
      }

      ctx.log("info", `[openclaw-local-image] Done, ${buffer.length} bytes, ${result.duration_ms}ms`);

      return {
        images: [{
          buffer,
          mime: "image/png",
          width: req.width,
          height: req.height,
          seed: req.seed,
        }],
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

  // B3: 预估成本(本地免费)
  estimateCost(_req: ImageGenerateRequest): { cny: number; basis: "accurate" } {
    return { cny: 0, basis: "accurate" };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    let python_path: string;
    try {
      ({ python_path } = this._validateExecutor());
    } catch (err: any) {
      return { ok: false, reason: err.message ?? String(err) };
    }

    // Quick check: does the python executable exist?
    try {
      const fsSync = await import("node:fs");
      if (!fsSync.existsSync(python_path)) {
        return { ok: false, reason: `missing venv: python not found at ${python_path}` };
      }
    } catch {
      return { ok: false, reason: "missing venv: cannot verify python path" };
    }

    // Try --help to see if the venv works
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

  private _validateExecutor(): { python_path: string; script_path: string } {
    const exec = this._executor;
    // UP-1(b) 人话化: 到达用户眼前的 message 必须是中文人话,不含 executor.python_path /
    // script_path 等英文配置键。code 保留 invalid_request(→HTTP 400);"打开设置"action 与
    // 统一脱敏由 Y5(errorTranslate.ts / sourceLabels.ts / logger.scrubForClient) 映射,不在本包。
    // 本包只负责错误"产生"处的 message 干净(scrubForClient 只脱 secret,不译,故此 message 原样到用户)。
    if (!exec.python_path || !exec.script_path) {
      throw new ProviderError({
        message: "本地 SDXL 图像模型还没配置好运行环境,暂时用不了。请到设置页补全本地图像模型的配置后再试,或先选「本地卡片图 · 免费」这类无需配置的渠道出图。",
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }
    return { python_path: exec.python_path, script_path: exec.script_path };
  }
}

interface ExecutorConfig {
  python_path?: string;
  script_path?: string;
  default_model_variant?: string;
  steps?: number;
  default_negative_prompt?: string;
  timeout_ms?: number;
}
