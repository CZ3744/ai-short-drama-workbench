// P170 Wave 1A: MiMo TTS Provider — new TtsProvider interface wrapper
// Calls MiMo TTS API (free period, base_url from localSettings)

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
import { getConfigValue, getConfigValueAny } from "../../../core/src/index";

const DEFAULT_MIMO_VOICES: TtsVoiceInfo[] = [
  { id: "mimo_default", gender: "female", language: "zh-CN" },
];

export class MiMoTtsWrapper implements TtsProvider {
  readonly id: string = "mimo_tts";
  private _apiKey: string | null;
  private static _cachedAuth: "api-key" | "bearer" | null = null;

  constructor(_cfg: PresetOption, apiKey: string | null) {
    this._apiKey = apiKey;
  }

  async synthesize(
    req: TtsSynthesizeRequest,
    ctx: ProviderContext,
  ): Promise<TtsSynthesizeResponse> {
    // M8: use constructor-injected apiKey first, fallback to config
    const apiKey = this._apiKey ?? getConfigValue("MIMO_API_KEY");
    if (!apiKey) {
      throw new ProviderError({
        message: "MIMO_API_KEY 未配置",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    const baseUrl = getConfigValueAny(
      ["MIMO_OPENAI_BASE_URL", "MIMO_API_BASE_URL"],
      "https://token-plan-cn.xiaomimimo.com/v1",
    ).replace(/\/$/, "");
    const model = getConfigValue("MIMO_TTS_MODEL", "mimo-v2.5-tts");
    const voice = req.voice_id || "mimo_default";
    const format = req.format === "m4a" ? "mp3" : (req.format ?? "wav");

    ctx.log("info", `TTS mimo_tts: synthesizing voice=${voice} model=${model}`);

    // Try 1: /audio/speech (simpler endpoint)
    const speechBuf = await this.tryAudioSpeech(baseUrl, apiKey, model, voice, format, req.text, ctx);
    if (speechBuf) {
      // 2026-05-28 audit P1-18: duration_sec=0 写死违反铁律 #4 (字幕对齐用这个数算时间轴).
      // 把 buffer 落到临时文件 ffprobe 探真长, 失败 fallback 0.
      const durationSec = await this._probeBufferDuration(speechBuf, format);
      return {
        audio: { buffer: speechBuf, mime: format === "wav" ? "audio/wav" : "audio/mpeg", duration_sec: durationSec },
        cost: { currency: "CNY", amount: 0, basis: "measured" },
      };
    }

    // Try 2: /chat/completions with audio modality
    const chatBuf = await this.tryChatCompletions(baseUrl, apiKey, model, voice, format, req.text, ctx);
    if (chatBuf) {
      const durationSec = await this._probeBufferDuration(chatBuf, format);
      return {
        audio: { buffer: chatBuf, mime: format === "wav" ? "audio/wav" : "audio/mpeg", duration_sec: durationSec },
        cost: { currency: "CNY", amount: 0, basis: "measured" },
      };
    }

    throw new ProviderError({
      message: "MiMo TTS 所有端点均失败",
      code: "server",
      provider_id: this.id,
      retriable: true,
    });
  }

  /**
   * 2026-05-28 audit P1-18: 把 audio buffer 落到临时文件 ffprobe 探真长.
   * ffprobe 失败 / 二进制损坏 → 返 0 (caller 自己看 buffer 为空走 fallback).
   */
  private async _probeBufferDuration(buffer: Buffer, format: string): Promise<number> {
    try {
      const fsp = await import("node:fs/promises");
      const path = await import("node:path");
      const os = await import("node:os");
      const ext = format === "wav" ? ".wav" : format === "mp3" ? ".mp3" : ".bin";
      const tmpPath = path.join(os.tmpdir(), `mimo_tts_probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
      await fsp.writeFile(tmpPath, buffer);
      try {
        const { probeVideoFile } = await import("../../../render/src/ffprobe");
        const probe = await probeVideoFile(tmpPath);
        return probe.duration_sec > 0 ? probe.duration_sec : 0;
      } finally {
        await fsp.unlink(tmpPath).catch(() => {});
      }
    } catch {
      return 0;
    }
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    return DEFAULT_MIMO_VOICES;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    // M8: use constructor-injected apiKey first, fallback to config
    const apiKey = this._apiKey ?? getConfigValue("MIMO_API_KEY");
    if (!apiKey) {
      return { ok: false, reason: "MIMO_API_KEY 未配置" };
    }
    // Key exists — actual TTS availability requires a real call
    return { ok: true };
  }

  // ── internal ──

  private async tryAudioSpeech(
    baseUrl: string,
    apiKey: string,
    model: string,
    voice: string,
    format: string,
    text: string,
    ctx: ProviderContext,
  ): Promise<Buffer | null> {
    const authOrder: Array<"api-key" | "bearer"> = MiMoTtsWrapper._cachedAuth
      ? [MiMoTtsWrapper._cachedAuth]
      : ["api-key", "bearer"];

    for (const authType of authOrder) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (authType === "api-key") headers["api-key"] = apiKey;
        else headers["Authorization"] = `Bearer ${apiKey}`;

        ctx.log("info", `TTS mimo_tts: trying /audio/speech with ${authType}`);
        const response = await fetch(`${baseUrl}/audio/speech`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, input: text, voice, response_format: format }),
          // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(30_000).
          signal: ctx.signal,
        });

        // 2026-05-28 audit P1-17: 第一个 401/403 立即 throw missing_key — 之前 silent continue
        // 试下个 auth scheme + 下个 endpoint, 用户根本不知道是 Key 错了, 只看到"所有端点均失败".
        // 真出现 Key 错时立刻 friendly toast "MIMO_API_KEY 已配置但服务返回 401, 请检查 Key 是否有效".
        if (response.status === 401 || response.status === 403) {
          throw new ProviderError({
            message: `MIMO_API_KEY 已配置但 /audio/speech 返回 ${response.status} (${authType} auth). 请检查 Key 是否有效, 或换 auth 方案.`,
            code: "missing_key",
            provider_id: "mimo_tts",
            retriable: false,
          });
        }
        if (response.status === 404) return null;
        if (!response.ok) continue;

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length > 100) {
          MiMoTtsWrapper._cachedAuth = authType;
          ctx.log("info", `TTS mimo_tts: success via /audio/speech ${authType}`);
          return buffer;
        }
      } catch (err) {
        // P1-17: ProviderError 是显式 throw, 直接抛上去, 不要 silent log+continue.
        if (err instanceof ProviderError) throw err;
        ctx.log("warn", `TTS mimo_tts: /audio/speech ${authType} error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return null;
  }

  private async tryChatCompletions(
    baseUrl: string,
    apiKey: string,
    model: string,
    voice: string,
    format: string,
    text: string,
    ctx: ProviderContext,
  ): Promise<Buffer | null> {
    const authOrder: Array<"api-key" | "bearer"> = MiMoTtsWrapper._cachedAuth
      ? [MiMoTtsWrapper._cachedAuth]
      : ["api-key", "bearer"];

    for (const authType of authOrder) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (authType === "api-key") headers["api-key"] = apiKey;
        else headers["Authorization"] = `Bearer ${apiKey}`;

        ctx.log("info", `TTS mimo_tts: trying /chat/completions with ${authType}`);
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            modalities: ["text", "audio"],
            messages: [
              { role: "system", content: "请使用自然、清晰、适合知识讲解的语气朗读。" },
              { role: "user", content: text },
            ],
            audio: { voice, format },
          }),
          // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(30_000).
          signal: ctx.signal,
        });

        // 2026-05-28 audit P1-17: 同 tryAudioSpeech, 第一个 401/403 立即 throw missing_key.
        if (response.status === 401 || response.status === 403) {
          throw new ProviderError({
            message: `MIMO_API_KEY 已配置但 /chat/completions 返回 ${response.status} (${authType} auth). 请检查 Key 是否有效, 或换 auth 方案.`,
            code: "missing_key",
            provider_id: "mimo_tts",
            retriable: false,
          });
        }
        if (response.status === 404) return null;
        if (!response.ok) continue;

        const data = (await response.json()) as any;
        const b64 = this.extractBase64(data);
        if (b64) {
          const buffer = this.decodeBase64Audio(b64);
          if (buffer) {
            MiMoTtsWrapper._cachedAuth = authType;
            ctx.log("info", `TTS mimo_tts: success via /chat/completions ${authType}`);
            return buffer;
          }
        }
      } catch (err) {
        // P1-17: ProviderError 是显式 throw, 直接抛上去.
        if (err instanceof ProviderError) throw err;
        ctx.log("warn", `TTS mimo_tts: /chat/completions ${authType} error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return null;
  }

  private extractBase64(data: any): string | null {
    if (data?.choices?.[0]?.message?.audio?.data) return data.choices[0].message.audio.data;
    if (data?.response?.audio?.data) return data.response.audio.data;
    if (data?.audio?.data) return data.audio.data;
    if (data?.data && typeof data.data === "string" && data.data.length > 100) return data.data;
    return null;
  }

  private decodeBase64Audio(b64: string): Buffer | null {
    let raw = b64;
    const m = /^data:audio\/[\w.+-]+;base64,(.+)$/.exec(raw);
    if (m) raw = m[1];
    if (!/^[A-Za-z0-9+/=\s]+$/.test(raw) || raw.length < 100) return null;
    try {
      return Buffer.from(raw, "base64");
    } catch {
      return null;
    }
  }
}
