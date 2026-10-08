/** @deprecated Use tts/edgeTtsProvider.ts with core/types TtsProvider interface instead */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { ensureDir, pathExists, readLocalSettings, getConfigValue, getConfigValueAny, type JobLogger } from "../../core/src/index";

export type TtsProviderName = "silence" | "edge_tts" | "windows_sapi" | "piper" | "mimo_tts";

export interface TtsConfig {
  provider: TtsProviderName;
  voice: string;
  rate: string;
  enabled: boolean;
  fallbackVoice?: string;
  fallbackRate?: string;
}

export interface TtsOptions {
  voice?: string;
  rate?: string;
}

export interface TtsResult {
  ok: boolean;
  provider: string;
  voice: string;
  duration_sec: number;
  output_path: string;
  fallback_used: boolean;
  error?: string;
  error_type?: string;
  selected_auth?: string;
  selected_mode?: string;
}

export interface TtsProvider {
  readonly name: TtsProviderName;
  synthesize(text: string, outputPath: string, options?: TtsOptions): Promise<TtsResult>;
}

const AVAILABLE_VOICES: Record<string, string[]> = {
  edge_tts: [
    "zh-CN-YunxiNeural",
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-YunjianNeural",
    "zh-CN-YunyangNeural",
    "zh-CN-XiaoyiNeural",
    "zh-CN-YunxiaNeural",
    "en-US-AriaNeural",
    "en-US-GuyNeural"
  ],
  windows_sapi: ["Microsoft Huihui Desktop", "Microsoft Kangkang Desktop"],
  piper: ["zh_CN-huayan-medium"],
  mimo_tts: ["mimo_default"]
};

export function getDefaultVoice(provider: TtsProviderName): string {
  if (provider === "edge_tts") return "zh-CN-YunxiNeural";
  if (provider === "windows_sapi") return "Microsoft Huihui Desktop";
  if (provider === "piper") return "zh_CN-huayan-medium";
  if (provider === "mimo_tts") return "mimo_default";
  return "";
}

export function getAvailableVoices(provider: TtsProviderName): string[] {
  return AVAILABLE_VOICES[provider] ?? [];
}

export function createTtsProvider(config: TtsConfig, logger?: JobLogger): TtsProvider {
  switch (config.provider) {
    case "edge_tts":
      return new EdgeTtsProvider(config, logger);
    case "windows_sapi":
      return new WindowsSapiProvider(config, logger);
    case "piper":
      return new PiperPlaceholderProvider(config, logger);
    case "mimo_tts":
      return new MiMoTtsProvider(config, logger);
    case "silence":
    default:
      return new SilenceTtsProvider(config, logger);
  }
}

class EdgeTtsProvider implements TtsProvider {
  readonly name: TtsProviderName = "edge_tts";
  constructor(private config: TtsConfig, private logger?: JobLogger) {}

  async synthesize(text: string, outputPath: string, options?: TtsOptions): Promise<TtsResult> {
    const rawVoice = options?.voice ?? this.config.voice ?? "";
    const voice = rawVoice && isValidEdgeVoice(rawVoice) ? rawVoice : getDefaultVoice("edge_tts");
    const rate = options?.rate ?? this.config.rate ?? "+0%";
    await ensureDir(path.dirname(outputPath));

    try {
      await this.logger?.line("TTS edge_tts: synthesizing with voice=" + voice + ", rate=" + rate + (rawVoice !== voice ? " (corrected from " + rawVoice + ")" : ""));
      const duration = await runEdgeTts(text, voice, rate, outputPath);
      await this.logger?.line("TTS edge_tts: output " + outputPath + ", duration=" + duration.toFixed(2) + "s");
      return {
        ok: true,
        provider: "edge_tts",
        voice,
        duration_sec: Number(duration.toFixed(3)),
        output_path: outputPath,
        fallback_used: false
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.logger?.line("TTS edge_tts failed: " + msg);
      return {
        ok: false,
        provider: "edge_tts",
        voice,
        duration_sec: 0,
        output_path: outputPath,
        fallback_used: true,
        error: msg
      };
    }
  }
}

class WindowsSapiProvider implements TtsProvider {
  readonly name: TtsProviderName = "windows_sapi";
  constructor(private config: TtsConfig, private logger?: JobLogger) {}

  async synthesize(text: string, outputPath: string, options?: TtsOptions): Promise<TtsResult> {
    const voice = options?.voice ?? this.config.voice ?? getDefaultVoice("windows_sapi");
    await ensureDir(path.dirname(outputPath));

    try {
      await this.logger?.line("TTS windows_sapi: synthesizing with voice=" + voice);
      const wavPath = outputPath.replace(/\.[^.]+$/, ".wav");
      // Text goes through a temp file (never the command line) so user-provided
      // text cannot escape PowerShell string quoting.
      const tempTextPath = outputPath.replace(/\.[^.]+$/, ".txt");
      await fs.writeFile(tempTextPath, text, "utf8");

      // v0.2.4: harden against voice name / path injection.
      // Previously only single quotes were doubled, but PowerShell also reacts
      // to backticks (escape), semicolons (command separator), `$(...)`
      // (subexpressions), and newline/CR. Whitelist validation is safer than
      // trying to escape every possible metachar.
      if (!/^[\w一-鿿\s.\-+()]+$/.test(voice) || voice.length > 80) {
        throw new Error(`Rejected unsafe SAPI voice name: ${JSON.stringify(voice)}`);
      }
      const safeWav = wavPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
      const safeTempText = tempTextPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
      if (/[\r\n;`$]/.test(safeWav) || /[\r\n;`$]/.test(safeTempText)) {
        throw new Error("Rejected unsafe path for SAPI output");
      }
      const psScript = "Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.SelectVoice('" + voice.replace(/'/g, "''") + "'); $synth.SetOutputToWaveFile('" + safeWav + "'); $txt = [System.IO.File]::ReadAllText('" + safeTempText + "'); $synth.Speak($txt); $synth.Dispose();";
      await runPowerShell(psScript);
      // Clean up temp file
      try { await fs.unlink(tempTextPath); } catch { /* ignore */ }
      await runFfmpegConvert(wavPath, outputPath);
      const duration = await getAudioDuration(outputPath);
      await this.logger?.line("TTS windows_sapi: output " + outputPath + ", duration=" + duration.toFixed(2) + "s");
      return {
        ok: true,
        provider: "windows_sapi",
        voice,
        duration_sec: Number(duration.toFixed(3)),
        output_path: outputPath,
        fallback_used: false
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.logger?.line("TTS windows_sapi failed: " + msg);
      return {
        ok: false,
        provider: "windows_sapi",
        voice,
        duration_sec: 0,
        output_path: outputPath,
        fallback_used: true,
        error: msg
      };
    }
  }
}

class PiperPlaceholderProvider implements TtsProvider {
  readonly name: TtsProviderName = "piper";
  constructor(private config: TtsConfig, private logger?: JobLogger) {}

  async synthesize(_text: string, outputPath: string, _options?: TtsOptions): Promise<TtsResult> {
    await this.logger?.line("TTS piper: not yet implemented; using silence fallback.");
    return {
      ok: false,
      provider: "piper",
      voice: this.config.voice ?? getDefaultVoice("piper"),
      duration_sec: 0,
      output_path: outputPath,
      fallback_used: true,
      error: "Piper TTS is not yet implemented. Use edge_tts or silence instead."
    };
  }
}

class SilenceTtsProvider implements TtsProvider {
  readonly name: TtsProviderName = "silence";
  constructor(private config: TtsConfig, private logger?: JobLogger) {}

  async synthesize(_text: string, _outputPath: string, _options?: TtsOptions): Promise<TtsResult> {
    return {
      ok: false,
      provider: "silence",
      voice: "",
      duration_sec: 0,
      output_path: _outputPath,
      fallback_used: true,
      error: "TTS is disabled (provider=silence)."
    };
  }
}

interface MiMoTtsConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  format: string;
  stylePrompt: string;
}

function loadMiMoTtsConfig(): MiMoTtsConfig {
  return {
    apiKey: getConfigValue("MIMO_API_KEY"),
    baseUrl: getConfigValueAny(["MIMO_OPENAI_BASE_URL", "MIMO_API_BASE_URL"], "https://token-plan-cn.xiaomimimo.com/v1").replace(/\/$/, ""),
    model: getConfigValue("MIMO_TTS_MODEL", "mimo-v2.5-tts"),
    voice: getConfigValue("MIMO_TTS_VOICE", "mimo_default"),
    format: getConfigValue("MIMO_TTS_FORMAT", "wav"),
    stylePrompt: getConfigValue("MIMO_TTS_STYLE_PROMPT", "请使用自然、清晰、适合知识讲解的语气朗读。")
  };
}

class MiMoTtsProvider implements TtsProvider {
  readonly name: TtsProviderName = "mimo_tts";
  /**
   * Cache the first successfully-negotiated auth scheme across all instances
   * within one process. Without this, each scene re-probes api-key → bearer,
   * which multiplied by two endpoints ballooned a 17-scene batch into up to
   * 204 HTTP requests (a key cause of rate-limit + all-silence fallback).
   */
  static _cachedAuth: "api-key" | "bearer" | null = null;
  constructor(private config: TtsConfig, private logger?: JobLogger) {}

  async synthesize(text: string, outputPath: string, options?: TtsOptions): Promise<TtsResult> {
    const mimoConfig = loadMiMoTtsConfig();
    const voice = options?.voice ?? this.config.voice ?? mimoConfig.voice;
    const format = mimoConfig.format;

    if (!mimoConfig.apiKey) {
      await this.logger?.line("TTS mimo_tts: no API key configured");
      return {
        ok: false,
        provider: "mimo_tts",
        voice,
        duration_sec: 0,
        output_path: outputPath,
        fallback_used: true,
        error: "MIMO_API_KEY 未配置",
        error_type: "key_missing"
      } as TtsResult & { error_type: string };
    }

    await ensureDir(path.dirname(outputPath));

    // Try 1: POST /chat/completions with audio
    const chatResult = await this.tryChatCompletions(mimoConfig, text, voice, format, outputPath);
    if (chatResult) return chatResult;

    // Try 2: POST /audio/speech
    const speechResult = await this.tryAudioSpeech(mimoConfig, text, voice, format, outputPath);
    if (speechResult) return speechResult;

    // Both failed
    await this.logger?.line("TTS mimo_tts: all endpoints failed, using silence fallback");
    return {
      ok: false,
      provider: "mimo_tts",
      voice,
      duration_sec: 0,
      output_path: outputPath,
      fallback_used: true,
      error: "MiMo TTS 所有端点均失败",
      error_type: "endpoint_not_found"
    } as TtsResult & { error_type: string };
  }

  private async tryChatCompletions(config: MiMoTtsConfig, text: string, voice: string, format: string, outputPath: string): Promise<TtsResult | null> {
    const url = `${config.baseUrl}/chat/completions`;
    // Fix v0.2.4: body previously put text in assistant role and omitted modalities.
    // OpenAI audio-out spec requires modalities:["text","audio"] and text in user role.
    // This was the root cause of 17/17 batch TTS falling back to silence.
    const body = {
      model: config.model,
      modalities: ["text", "audio"],
      messages: [
        { role: "system", content: config.stylePrompt },
        { role: "user", content: text }
      ],
      audio: { voice, format }
    };

    // Cache the first working auth type so later scenes skip the doomed attempts.
    const authOrder: Array<"api-key" | "bearer"> = MiMoTtsProvider._cachedAuth
      ? [MiMoTtsProvider._cachedAuth]
      : ["api-key", "bearer"];

    for (const authType of authOrder) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (authType === "api-key") {
          headers["api-key"] = config.apiKey;
        } else {
          headers["Authorization"] = `Bearer ${config.apiKey}`;
        }

        await this.logger?.line(`TTS mimo_tts: trying /chat/completions with ${authType} auth`);
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(30_000).
        });

        if (!response.ok) {
          const status = response.status;
          await this.logger?.line(`TTS mimo_tts: /chat/completions ${authType} returned ${status}`);
          if (status === 401 || status === 403) continue; // try next auth
          if (status === 404) return null; // try next endpoint
          if (status === 429) {
            // respect Retry-After if any, then give up this endpoint
            const retryAfter = Number(response.headers.get("retry-after") || 0);
            if (retryAfter > 0 && retryAfter < 30) {
              await new Promise(r => setTimeout(r, retryAfter * 1000));
            }
            return null;
          }
          continue;
        }

        const data = await response.json() as any;
        const audioData = this.extractAudioData(data);
        if (audioData) {
          await this.writeAudioFile(audioData, format, outputPath);
          const duration = await this.measureDuration(outputPath);
          await this.logger?.line(`TTS mimo_tts: success via /chat/completions ${authType}, duration=${duration.toFixed(2)}s`);
          MiMoTtsProvider._cachedAuth = authType;
          return {
            ok: true,
            provider: "mimo_tts",
            voice,
            duration_sec: Number(duration.toFixed(3)),
            output_path: outputPath,
            fallback_used: false,
            selected_auth: authType,
            selected_mode: "chat_completions_audio"
          } as TtsResult;
        }
        await this.logger?.line("TTS mimo_tts: /chat/completions response missing audio data");
      } catch (error) {
        await this.logger?.line(`TTS mimo_tts: /chat/completions ${authType} error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return null;
  }

  private async tryAudioSpeech(config: MiMoTtsConfig, text: string, voice: string, format: string, outputPath: string): Promise<TtsResult | null> {
    const url = `${config.baseUrl}/audio/speech`;
    const body = {
      model: config.model,
      input: text,
      voice,
      response_format: format
    };

    const authOrder: Array<"api-key" | "bearer"> = MiMoTtsProvider._cachedAuth
      ? [MiMoTtsProvider._cachedAuth]
      : ["api-key", "bearer"];

    for (const authType of authOrder) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (authType === "api-key") {
          headers["api-key"] = config.apiKey;
        } else {
          headers["Authorization"] = `Bearer ${config.apiKey}`;
        }

        await this.logger?.line(`TTS mimo_tts: trying /audio/speech with ${authType} auth`);
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(30_000).
        });

        if (!response.ok) {
          await this.logger?.line(`TTS mimo_tts: /audio/speech ${authType} returned ${response.status}`);
          if (response.status === 401 || response.status === 403) continue;
          if (response.status === 404) return null;
          if (response.status === 429) {
            const retryAfter = Number(response.headers.get("retry-after") || 0);
            if (retryAfter > 0 && retryAfter < 30) {
              await new Promise(r => setTimeout(r, retryAfter * 1000));
            }
            return null;
          }
          continue;
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length > 100) {
          await fs.writeFile(outputPath, buffer);
          const duration = await this.measureDuration(outputPath);
          await this.logger?.line(`TTS mimo_tts: success via /audio/speech ${authType}, duration=${duration.toFixed(2)}s`);
          MiMoTtsProvider._cachedAuth = authType;
          return {
            ok: true,
            provider: "mimo_tts",
            voice,
            duration_sec: Number(duration.toFixed(3)),
            output_path: outputPath,
            fallback_used: false,
            selected_auth: authType,
            selected_mode: "audio_speech"
          } as TtsResult;
        }
      } catch (error) {
        await this.logger?.line(`TTS mimo_tts: /audio/speech ${authType} error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return null;
  }

  private extractAudioData(data: any): string | null {
    // Format 1: choices[0].message.audio.data
    if (data?.choices?.[0]?.message?.audio?.data) return data.choices[0].message.audio.data;
    // Format 2: response.audio.data
    if (data?.response?.audio?.data) return data.response.audio.data;
    // Format 3: data.audio
    if (data?.audio?.data) return data.audio.data;
    // Format 4: data field at top level
    if (data?.data && typeof data.data === "string" && data.data.length > 100) return data.data;
    return null;
  }

  private async writeAudioFile(base64Data: string, format: string, outputPath: string): Promise<void> {
    // v0.2.4: strip data-URI prefix ("data:audio/mp3;base64,...") if present —
    // some MiMo endpoints return the whole data URI not just the payload,
    // and Buffer.from(b64, "base64") silently corrupts with leading junk.
    let b64 = base64Data;
    const dataUriMatch = /^data:audio\/[\w.+-]+;base64,(.+)$/.exec(b64);
    if (dataUriMatch) b64 = dataUriMatch[1];
    // Sanity: base64 chars only + length > 100 (otherwise it's not real audio)
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64) || b64.length < 100) {
      throw new Error(`writeAudioFile: payload does not look like base64 audio (${b64.slice(0, 40)}..., len=${b64.length})`);
    }
    const buffer = Buffer.from(b64, "base64");
    if (format === "wav" && outputPath.endsWith(".m4a")) {
      const wavPath = outputPath.replace(/\.m4a$/, ".wav");
      await fs.writeFile(wavPath, buffer);
      await runFfmpegConvert(wavPath, outputPath);
    } else {
      await fs.writeFile(outputPath, buffer);
    }
  }

  private async measureDuration(filePath: string): Promise<number> {
    try {
      return await getAudioDuration(filePath);
    } catch {
      return 0;
    }
  }
}

function isValidEdgeVoice(voice: string): boolean {
  const valid = AVAILABLE_VOICES.edge_tts;
  return valid.includes(voice);
}

async function runEdgeTts(text: string, voice: string, rate: string, outputPath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const args = [
      "-m", "edge_tts",
      "--voice", voice,
      "--rate", rate,
      "--text", text,
      "--write-media", outputPath
    ];
    const child = spawn("python", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    // v0.2.4: bound edge-tts runtime. A single scene should not take >60s and
    // without this the whole batch can hang if python / the edge-tts library
    // gets stuck on a network call.
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, 60_000);
    // P1-NEW (2026-05-12): stderr ring buffer 16KB
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16 * 1024) stderr = stderr.slice(stderr.length - 16 * 1024);
    });
    child.on("error", (err) => { clearTimeout(timer); reject(new Error("edge-tts spawn error: " + err.message)); });
    child.on("close", async (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("edge-tts timed out after 60s"));
        return;
      }
      if (code !== 0) {
        reject(new Error("edge-tts exited " + code + ": " + stderr.slice(-400)));
        return;
      }
      try {
        const duration = await getAudioDuration(outputPath);
        resolve(duration);
      } catch (err) {
        reject(new Error("edge-tts output not readable: " + (err instanceof Error ? err.message : String(err))));
      }
    });
  });
}

async function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, 120_000);
    // P1-NEW (2026-05-12): stderr ring buffer 16KB
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16 * 1024) stderr = stderr.slice(stderr.length - 16 * 1024);
    });
    child.on("error", (err) => { clearTimeout(timer); reject(new Error("PowerShell spawn error: " + err.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("PowerShell timed out after 120s"));
      else if (code !== 0) reject(new Error("PowerShell exited " + code + ": " + stderr.slice(-400)));
      else resolve();
    });
  });
}

async function runFfmpegConvert(inputPath: string, outputPath: string): Promise<void> {
  // 4C: resolve paths to handle Unicode/spaces
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-i", resolvedInput, "-c:a", "aac", "-b:a", "128k", resolvedOutput], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, 120_000);
    // P1-NEW (2026-05-12): stderr ring buffer 16KB
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16 * 1024) stderr = stderr.slice(stderr.length - 16 * 1024);
    });
    child.on("error", (err) => { clearTimeout(timer); reject(new Error("FFmpeg spawn error: " + err.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("FFmpeg convert timed out after 120s"));
      else if (code !== 0) reject(new Error("FFmpeg convert exited " + code + ": " + stderr.slice(-400)));
      else resolve();
    });
  });
}

export async function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      filePath
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    // P1-NEW (2026-05-12): stderr ring buffer 16KB
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16 * 1024) stderr = stderr.slice(stderr.length - 16 * 1024);
    });
    child.on("error", (err) => { clearTimeout(timer); reject(new Error("ffprobe spawn error: " + err.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("ffprobe timed out after 15s"));
        return;
      }
      if (code !== 0) {
        reject(new Error("ffprobe exited " + code + ": " + stderr.slice(-200)));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(Number(parsed.format?.duration ?? 0));
      } catch {
        reject(new Error("ffprobe output not parseable: " + stdout.slice(0, 200)));
      }
    });
  });
}
