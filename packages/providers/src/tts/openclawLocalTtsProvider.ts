// 2026-05-17: OpenClaw Local TTS Provider — subprocess 模型 + 用完释放 GPU.
//
// 与 OpenClawLocalVideoProvider 同一 pattern: provider.synthesize() 调
// runPythonScript() spawn venv-gpu Python → Python 跑推理 → 写 wav → 退出 → GPU 释放.
//
// Preset 需要的 extras (config/presets/tts_provider.json):
//   executor: {
//     python_path: string;       // venv-gpu Python
//     script_path: string;       // tts_gen_local.py 统一入口
//     engine?: string;           // "cosyvoice2" | "mock" (default: "cosyvoice2")
//     timeout_ms?: number;       // default 300000 (5 min)
//   }
//
// 设计原则 (与 video provider 一致):
//   1. 每次调用 spawn 新进程 → 进程退出 = GPU 显存归零 (用完即释放铁律)
//   2. 失败必 throw, 不允许 silent fallback (Python exit 0 + JSON error → throw)
//   3. 错误信息 toC 友好 (中文 + 用户能看懂的建议)

import fs from "node:fs/promises";
import path from "node:path";
import type { PresetOption } from "../../../core/src/presetSchema";
import type {
  TtsProvider,
  TtsSynthesizeRequest,
  TtsSynthesizeResponse,
  TtsVoiceInfo,
  ProviderContext,
  HealthCheckResult,
} from "../core/types";
import { ProviderError } from "../core/errors";
import { runPythonScript } from "../core/localExec";

export class OpenClawLocalTtsProvider implements TtsProvider {
  readonly id: string;
  private _cfg: PresetOption;
  private _executor: ExecutorConfig;

  constructor(cfg: PresetOption, _apiKey: string | null) {
    this.id = cfg.id;
    this._cfg = cfg;
    this._executor = (cfg as any).executor ?? {};
  }

  async synthesize(req: TtsSynthesizeRequest, ctx: ProviderContext): Promise<TtsSynthesizeResponse> {
    const { python_path, script_path, engine } = this._validateExecutor();

    // 文本长度 sanity check — CosyVoice2 单次推理上限约 200 字, 超过会截断或质量降
    if (req.text.length > 500) {
      throw new ProviderError({
        message: `本地 TTS 单次最多 500 字, 本镜 ${req.text.length} 字。建议拆分多段或用云端 TTS provider。`,
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }

    // Prepare output path
    const tmpDir = path.join(process.cwd(), "outputs", "tts");
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `openclaw_tts_${ctx.task_id}_${Date.now()}.wav`);

    const args: string[] = [
      "--engine", engine,
      "--out", outputPath,
      "--voice", req.voice_id || "default",
    ];
    if (req.rate !== undefined) {
      args.push("--rate", String(req.rate));
    }
    // prompt text 必须在最后 (positional)
    args.push(req.text);

    ctx.log("info", `[openclaw-local-tts] engine=${engine}, voice=${req.voice_id}, text_len=${req.text.length}`);

    const timeoutMs = this._executor.timeout_ms ?? 300_000; // 5 min

    try {
      const result = await runPythonScript({
        python_path,
        script_path,
        args,
        timeout_ms: timeoutMs,
        signal: ctx.signal,
        on_stdout: (line) => {
          if (line.includes("[INFO]") || line.includes("[WARN]")) {
            ctx.log("info", `[tts_gen] ${line}`);
          }
        },
        on_stderr: (line) => {
          ctx.log("warn", `[tts_gen:stderr] ${line}`);
        },
      });

      if (result.exit_code !== 0) {
        if (result.stderr.includes("No such file") || result.stderr.includes("No module")) {
          throw new ProviderError({
            message: `本地 TTS venv 环境异常: ${result.stderr.slice(-300)}`,
            code: "server",
            provider_id: this.id,
            retriable: false,
          });
        }
        throw new ProviderError({
          message: `tts_gen_local.py 失败 (exit ${result.exit_code}): ${result.stderr.slice(-300)}`,
          code: "server",
          provider_id: this.id,
          retriable: false,
        });
      }

      // 解析 stdout JSON — exit 0 但 error 字段存在也 throw (silent fallback 红线)
      let parsedResult: { output?: string; error?: string; engine?: string; duration_sec?: number } | null = null;
      const balancedMatch = extractLastJson(result.stdout);
      if (balancedMatch) {
        try {
          parsedResult = JSON.parse(balancedMatch);
        } catch { /* ignore */ }
      }
      if (parsedResult?.error) {
        throw new ProviderError({
          message: `本地 TTS 推理失败: ${parsedResult.error}`,
          code: "server",
          provider_id: this.id,
          retriable: false,
        });
      }

      const actualOutput = parsedResult?.output || outputPath;
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(actualOutput);
      } catch (readErr: any) {
        const stdoutTail = result.stdout.slice(-800).replace(/[\r\n]+/g, " | ");
        throw new ProviderError({
          message:
            `本地 TTS 进程退出 0 但未写出 wav (期望 ${path.basename(outputPath)})。` +
            `Python stdout 末段: ${stdoutTail}`,
          code: "server",
          provider_id: this.id,
          retriable: false,
          original: readErr,
        });
      }

      // 清理临时文件 (provider 调用方已经 copy buffer 到自己的 vault)
      await fs.unlink(actualOutput).catch(() => {});
      if (actualOutput !== outputPath) {
        await fs.unlink(outputPath).catch(() => {});
      }

      ctx.log("info", `[openclaw-local-tts] Done, ${buffer.length} bytes, ${result.duration_ms}ms`);

      return {
        audio: {
          buffer,
          mime: "audio/wav",
          duration_sec: parsedResult?.duration_sec ?? estimateDurationFromText(req.text),
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

  async listVoices(): Promise<TtsVoiceInfo[]> {
    // 2026-05-17: 按 engine 返回 voice 列表.
    //   gpt_sovits: 扫 C:/Projects/video-studio/OpenClaw/GPT-SoVITS/voices/<name>/ 子目录,
    //     每个子目录代表一个 voice pack (包含 gpt.ckpt + sovits.pth + ref.wav + ref.txt)
    //   mock: 1 个 "default" 占位音色
    //   cosyvoice2 (legacy): 7 个内置音色 (留兼容, 真接入要等模型 + SDK)
    const engine = this._executor.engine || "gpt_sovits";
    if (engine === "gpt_sovits") {
      return await this._scanGptSovitsVoices();
    }
    if (engine === "cosyvoice2") {
      return [
        { id: "中文女", gender: "female", language: "zh-CN", style: "标准女声" },
        { id: "中文男", gender: "male", language: "zh-CN", style: "标准男声" },
        { id: "粤语女", gender: "female", language: "zh-HK", style: "粤语女声" },
        { id: "英文女", gender: "female", language: "en-US", style: "英文女声" },
        { id: "英文男", gender: "male", language: "en-US", style: "英文男声" },
        { id: "日语男", gender: "male", language: "ja-JP", style: "日语男声" },
        { id: "韩语女", gender: "female", language: "ko-KR", style: "韩语女声" },
      ];
    }
    return [{ id: "default", gender: "female", language: "zh-CN", style: "测试" }];
  }

  /**
   * GPT-SoVITS voice pack 目录扫描.
   *
   * 目录约定: C:/Projects/video-studio/OpenClaw/GPT-SoVITS/voices/<voice_name>/
   *   ├── gpt.ckpt    (或 *.ckpt 任一个)
   *   ├── sovits.pth  (或 *.pth 任一个)
   *   ├── ref.wav     (5-10 秒参考音频)
   *   └── ref.txt     (参考音频的文字转录)
   *
   * 没装好任何 voice 时返回空数组 + provider.synthesize 会 throw 友好提示
   * 引导用户去 B 站社区下载 voice pack (派蒙 / 纳西妲等).
   */
  private async _scanGptSovitsVoices(): Promise<TtsVoiceInfo[]> {
    // Each installation owns its voice packs; never assume the author's disk layout.
    const voicesDir = this._executor.voices_dir || (this._executor.script_path
      ? path.resolve(path.dirname(this._executor.script_path), "..", "GPT-SoVITS", "voices")
      : "");
    if (!voicesDir) return [];
    try {
      const entries = await fs.readdir(voicesDir, { withFileTypes: true });
      const voices: TtsVoiceInfo[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(voicesDir, entry.name);
        const files = await fs.readdir(sub).catch(() => [] as string[]);
        const hasGpt = files.some((f) => f.endsWith(".ckpt"));
        const hasSovits = files.some((f) => f.endsWith(".pth"));
        const hasRefWav = files.some((f) => f.toLowerCase() === "ref.wav" || (f.endsWith(".wav") && f.includes("ref")));
        if (hasGpt && hasSovits && hasRefWav) {
          // 解析 voice meta (可选 meta.json 标 gender / language / style)
          let meta: { gender?: string; language?: string; style?: string } = {};
          try {
            const metaPath = path.join(sub, "meta.json");
            const metaText = await fs.readFile(metaPath, "utf8");
            meta = JSON.parse(metaText);
          } catch { /* 无 meta.json 走默认 */ }
          voices.push({
            id: entry.name,
            gender: meta.gender || "unknown",
            language: meta.language || "zh-CN",
            style: meta.style || "B 站社区 ckpt",
          });
        }
      }
      return voices;
    } catch {
      // voices 目录不存在 → 返空, UI 显示空状态引导用户下载
      return [];
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const { python_path } = this._validateExecutor();
    try {
      const fsSync = await import("node:fs");
      if (!fsSync.existsSync(python_path)) {
        return { ok: false, reason: `missing venv: python 不在路径 ${python_path}` };
      }
      // 不直接调脚本 (避免冷启动 5s), 只看 python 可执行性
      return { ok: true };
    } catch {
      return { ok: false, reason: "cannot verify python path" };
    }
  }

  // ─── internals ────────────────────────────────────────────────────

  private _validateExecutor(): { python_path: string; script_path: string; engine: string } {
    const exec = this._executor;
    if (!exec.python_path) {
      throw new ProviderError({
        message: `本地 TTS Provider "${this.id}" 缺 executor.python_path 配置 (检查 config/presets/tts_provider.json)`,
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }
    if (!exec.script_path) {
      throw new ProviderError({
        message: `本地 TTS Provider "${this.id}" 缺 executor.script_path 配置 (检查 config/presets/tts_provider.json)`,
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }
    return {
      python_path: exec.python_path,
      script_path: exec.script_path,
      engine: exec.engine ?? "cosyvoice2",
    };
  }
}

interface ExecutorConfig {
  python_path?: string;
  script_path?: string;
  voices_dir?: string;
  engine?: string;
  timeout_ms?: number;
}

/** 从 stdout 找最后一个平衡 JSON (与 video provider 同实现) */
function extractLastJson(text: string): string | null {
  if (!text) return null;
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
        if (depth === 0) return text.slice(start, end + 1);
      }
    }
  }
  return null;
}

/** 简单估算 TTS 时长 — 中文按 5 字/秒, 英文按 3 词/秒 (粗糙但够用, 真值由 wav header 给) */
function estimateDurationFromText(text: string): number {
  const cn = (text.match(/[一-龥]/g) || []).length;
  const en = (text.match(/[a-zA-Z]+/g) || []).length;
  return Math.max(1, Math.round(cn / 5 + en / 3));
}
