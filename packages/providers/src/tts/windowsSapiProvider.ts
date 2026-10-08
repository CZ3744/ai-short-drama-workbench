// P170 Wave 1A: Windows SAPI TTS Provider — new TtsProvider interface wrapper
// Uses PowerShell Add-Type -AssemblyName System.Speech

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PresetOption } from "../../../core/src/presetSchema";
import type {
  TtsProvider,
  TtsSynthesizeRequest,
  TtsSynthesizeResponse,
  ProviderContext,
  HealthCheckResult,
  TtsVoiceInfo,
} from "../core/types";
import { ProviderError } from "../core/errors";

const DEFAULT_SAPI_VOICES: TtsVoiceInfo[] = [
  { id: "Microsoft Huihui Desktop", gender: "female", language: "zh-CN" },
  { id: "Microsoft Kangkang Desktop", gender: "male", language: "zh-CN" },
  { id: "Microsoft Zira Desktop", gender: "female", language: "en-US" },
  { id: "Microsoft David Desktop", gender: "male", language: "en-US" },
];

export class WindowsSapiWrapper implements TtsProvider {
  readonly id: string = "windows_sapi";

  constructor(_cfg: PresetOption, _apiKey: string | null) {}

  async synthesize(
    req: TtsSynthesizeRequest,
    ctx: ProviderContext,
  ): Promise<TtsSynthesizeResponse> {
    const voice = req.voice_id || "Microsoft Huihui Desktop";

    // Validate voice name (security: prevent PowerShell injection)
    if (!/^[\w一-鿿\s.\-+()]+$/.test(voice) || voice.length > 80) {
      throw new ProviderError({
        message: `Rejected unsafe SAPI voice name: ${JSON.stringify(voice)}`,
        code: "invalid_request",
        provider_id: this.id,
        retriable: false,
      });
    }

    const tmpDir = path.join(process.cwd(), "outputs", "tts");
    await fs.mkdir(tmpDir, { recursive: true });
    const baseName = `sapi_${ctx.task_id}_${Date.now()}`;
    const wavPath = path.join(tmpDir, `${baseName}.wav`);
    const txtPath = path.join(tmpDir, `${baseName}.txt`);
    const outPath = path.join(tmpDir, `${baseName}.m4a`);

    try {
      // Write text to temp file (avoid command-line injection)
      await fs.writeFile(txtPath, req.text, "utf8");

      const safeWav = wavPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
      const safeTxt = txtPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
      if (/[\r\n;`$]/.test(safeWav) || /[\r\n;`$]/.test(safeTxt)) {
        throw new Error("Rejected unsafe path for SAPI output");
      }

      const psScript =
        `Add-Type -AssemblyName System.Speech; ` +
        `$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$synth.SelectVoice('${voice.replace(/'/g, "''")}'); ` +
        `$synth.SetOutputToWaveFile('${safeWav}'); ` +
        `$txt = [System.IO.File]::ReadAllText('${safeTxt}'); ` +
        `$synth.Speak($txt); ` +
        `$synth.Dispose();`;

      ctx.log("info", `TTS windows_sapi: synthesizing voice=${voice}`);

      await runPowerShell(psScript);

      // Convert WAV to M4A via ffmpeg
      await runFfmpeg(wavPath, outPath);

      const buffer = await fs.readFile(outPath);
      const duration = await getAudioDuration(outPath);

      ctx.log("info", `TTS windows_sapi: done duration=${duration.toFixed(2)}s`);

      return {
        audio: { buffer, mime: "audio/mp4", duration_sec: duration },
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
    } finally {
      // Clean up temp files
      await fs.unlink(wavPath).catch(() => {});
      await fs.unlink(txtPath).catch(() => {});
      await fs.unlink(outPath).catch(() => {});
    }
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    return DEFAULT_SAPI_VOICES;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (process.platform !== "win32") {
      return { ok: false, reason: "Windows SAPI 仅支持 Windows 平台" };
    }
    try {
      await runPowerShell(
        `Add-Type -AssemblyName System.Speech; ` +
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$s.Dispose();`
      );
      return { ok: true };
    } catch {
      return { ok: false, reason: "Windows SAPI 不可用" };
    }
  }
}

// ── helpers ──

function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, 120_000);
    // P1-NEW (2026-05-12): stderr ring buffer 16KB
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16 * 1024) stderr = stderr.slice(stderr.length - 16 * 1024);
    });
    child.on("error", (err) => { clearTimeout(timer); reject(new Error("PowerShell spawn error: " + err.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("PowerShell timed out after 120s"));
      else if (code !== 0) reject(new Error(`PowerShell exited ${code}: ${stderr.slice(-400)}`));
      else resolve();
    });
  });
}

function runFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-i", path.resolve(inputPath), "-c:a", "aac", "-b:a", "128k", path.resolve(outputPath)], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, 120_000);
    // P1-NEW (2026-05-12): stderr ring buffer 16KB
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16 * 1024) stderr = stderr.slice(stderr.length - 16 * 1024);
    });
    child.on("error", (err) => { clearTimeout(timer); reject(new Error("FFmpeg spawn error: " + err.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("FFmpeg convert timed out after 120s"));
      else if (code !== 0) reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-400)}`));
      else resolve();
    });
  });
}

function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, _reject) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-print_format", "json", "-show_format", filePath,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, 15_000);
    // 2026-05-18: stdout ring buffer 64KB — 防 ffprobe 异常输出导致 Node OOM.
    // 同文件 runPowerShell/runFfmpeg 都已限 16KB, 这里漏掉了 — 跟齐 64KB 即可.
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 64 * 1024) stdout = stdout.slice(stdout.length - 64 * 1024);
    });
    child.on("error", () => { clearTimeout(timer); resolve(0); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) { resolve(0); return; }
      try {
        const parsed = JSON.parse(stdout);
        resolve(Number(parsed.format?.duration ?? 0));
      } catch {
        resolve(0);
      }
    });
  });
}
