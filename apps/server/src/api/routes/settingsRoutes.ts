import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import {
  outputsRoot,
  getSecretStatus,
  saveSecrets,
  clearSecret,
  testProviderConnection,
  redactSecrets,
  type SaveSecretsInput,
  type SecretProvider
} from "../../../../../packages/core/src/index";
import {
  loadLlmConfig,
  loadPublicRuntimeSettings,
  MockLlmProvider,
  OpenAiCompatibleProvider,
  saveLocalSettings,
  type LocalSettingsInput
} from "../../../../../packages/providers/src/index";
import { createTtsProvider, getDefaultVoice, getAvailableVoices, getAudioDuration } from "../../../../../packages/providers/src/tts";
import { loadMimoConfig, MimoTextProvider, MimoMultimodalProvider } from "../../../../../packages/providers/src/mimo";
import { JobLogger } from "../../../../../packages/core/src/logger";

export const settingsRouter = express.Router();

/**
 * v0.2.4: Centralized, redacted 500-path used by every catch block that cannot
 * simply delegate to next(). Uses standardized { error: { code, message } } format.
 * Forces a minimum level of key scrubbing.
 */
function sendServerError(res: express.Response, error: unknown, fallbackCode: string = "SETTINGS_ERROR"): void {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = scrubErrorMessage(raw);
  res.status(500).json({ error: { code: fallbackCode, message: scrubbed } });
}

function scrubErrorMessage(raw: string): string {
  return raw
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._\-~+/=]{16,}/gi, "Bearer ***")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt_***]")
    .replace(/(["']?(?:api[_-]?key|x[_-]?api[_-]?key|dashscope[_-]?api[_-]?key|authorization)["']?\s*[:=]\s*["']?)([A-Za-z0-9._\-]{12,})/gi, "$1***");
}

async function readLocalSettingsFile(): Promise<Record<string, any>> {
  // 2026-05-27 — 改 async — 之前 readFileSync 在 settings 请求路径同步阻塞 event loop,
  // 高并发或文件大的极端场景会卡其他请求. 改成 fs/promises.readFile 不阻塞.
  // 2026-05-28 audit: 区分文件不存在 (新装机, return {}) 与 JSON 损坏 (silent skip 等于
  // 用户设置丢了 — 让 caller 看到). settingsController 已有 JSON corrupt 500 红线, 这里跟齐.
  const settingsPath = path.join(process.cwd(), "config", "local-settings.json");
  const { readFile } = await import("node:fs/promises");
  let content: string;
  try {
    content = await readFile(settingsPath, "utf8");
  } catch (e: unknown) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw e;
  }
  try {
    return JSON.parse(content);
  } catch (e: unknown) {
    throw new Error(
      `local-settings.json JSON 损坏, 无法解析: ${
        e instanceof Error ? e.message : String(e)
      } — 请检查 config/local-settings.json`,
    );
  }
}

/**
 * 2026-05-28 audit: 跟 readLocalSettingsFile 同款的 ENOENT/JSON 区分 — 用于
 * 路由处理器内 read+merge+write 场景, JSON 损坏一定要让 caller 看到, 不能 silent
 * 用 {} 覆盖整个文件 (= 用户设置全丢).
 */
async function readLocalSettingsForMerge(): Promise<Record<string, any>> {
  const settingsPath = path.join(process.cwd(), "config", "local-settings.json");
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    try {
      return JSON.parse(raw);
    } catch (parseErr) {
      throw new Error(
        `local-settings.json JSON 损坏, 拒绝覆盖以防数据丢失: ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        } — 请检查 config/local-settings.json 或手动修复`,
      );
    }
  } catch (e: unknown) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw e;
  }
}

// ====================================================================
// HEALTH & SETTINGS
// ====================================================================

async function commandAvailable(command: string) {
  const { spawn } = await import("node:child_process");
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, ["-version"], { windowsHide: true, shell: false });
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // best effort
      }
      resolve(false);
    }, 5_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16 * 1024);
    });
    child.stdout?.on("data", () => {
      // drain stdout without retaining it
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

settingsRouter.get("/health", async (_req, res) => {
  const config = loadLlmConfig();
  const { getRealVideoLockStatus } = await import("../../../../../packages/core/src/realVideoLock");
  const lockStatus = getRealVideoLockStatus();
  res.json({
    ok: true,
    service: "script-driven-ai-video-generate",
    time: new Date().toISOString(),
    llm_provider: config.provider,
    llm_base_url: config.baseUrl,
    llm_model: config.model,
    llm_api_key_present: Boolean(config.apiKey),
    mock_llm: config.mock,
    subtitle_mode: config.subtitleMode,
    tts_provider: config.ttsProvider,
    tts_enabled: config.ttsEnabled,
    ffmpeg: await commandAvailable("ffmpeg"),
    ffprobe: await commandAvailable("ffprobe"),
    real_video_lock: lockStatus
  });
});

settingsRouter.get("/settings", (_req, res) => {
  res.json({ settings: loadPublicRuntimeSettings() });
});

settingsRouter.post("/settings", express.json(), async (req, res, next) => {
  try {
    const payload = req.body as LocalSettingsInput;
    const settings = await saveLocalSettings(payload);
    res.json({
      settings,
      warning: "仅限本地开发环境使用，不要部署到公网；API Key 会写入本机 config/local-settings.json，已被 .gitignore 忽略。"
    });
  } catch (error) {
    next(error);
  }
});

// ====================================================================
// DEPRECATED SETTINGS ROUTES (kept for backward compatibility)
// ====================================================================

settingsRouter.delete("/settings/api-key", async (_req, res, next) => {
  try {
    const status = await clearSecret("ikuncode");
    res.json({ status, message: "已清除 API Key（deprecated，请使用 POST /api/settings/clear-secret）", deprecated: true });
  } catch (error) {
    next(error);
  }
});

settingsRouter.post("/settings/api-key/clear", async (_req, res, next) => {
  try {
    const status = await clearSecret("ikuncode");
    res.json({ status, message: "已清除 API Key（deprecated，请使用 POST /api/settings/clear-secret）", deprecated: true });
  } catch (error) {
    next(error);
  }
});

settingsRouter.post("/settings/mimo-api-key", express.json(), async (req, res, next) => {
  try {
    const apiKey = String(req.body.apiKey || "").trim();
    if (!apiKey) {
      res.status(400).json({ ok: false, message: "apiKey is required" });
      return;
    }
    await saveSecrets({ mimo: { api_key: apiKey } });
    res.json({ ok: true, message: "MiMo API Key 已保存（deprecated，请使用 POST /api/settings/save-secrets）", apiKeyPresent: true, deprecated: true });
  } catch (error) {
    next(error);
  }
});

settingsRouter.delete("/settings/mimo-api-key", async (_req, res, next) => {
  try {
    const status = await clearSecret("mimo");
    res.json({ ok: true, status, message: "MiMo API Key 已清除（deprecated，请使用 POST /api/settings/clear-secret）", deprecated: true });
  } catch (error) {
    next(error);
  }
});

// ====================================================================
// UNIFIED SETTINGS API
// ====================================================================

settingsRouter.get("/settings/secrets-status", (_req, res) => {
  try {
    res.json(getSecretStatus());
  } catch (error) {
    sendServerError(res, error);
  }
});

settingsRouter.post("/settings/save-secrets", express.json(), async (req, res, next) => {
  try {
    const input = req.body as SaveSecretsInput;
    const status = await saveSecrets(input);
    res.json({ ok: true, status, message: "配置已保存" });
  } catch (error) {
    next(error);
  }
});

settingsRouter.post("/settings/clear-secret", express.json(), async (req, res, next) => {
  try {
    const { provider } = req.body as { provider: SecretProvider };
    if (!provider || !["ikuncode", "mimo", "minimax", "video", "image", "aliyun_wan"].includes(provider)) {
      res.status(400).json({ error: { code: "ValidationError", message: "无效的 provider，支持: ikuncode, mimo, minimax, video, image, aliyun_wan" } });
      return;
    }
    const status = await clearSecret(provider);
    res.json({ ok: true, status, message: `已清除 ${provider} 的 API Key` });
  } catch (error) {
    next(error);
  }
});

settingsRouter.post("/settings/test-provider", express.json(), async (req, res, next) => {
  try {
    const { provider } = req.body as { provider: string };
    if (!provider) {
      res.status(400).json({ error: { code: "ValidationError", message: "请指定 provider" } });
      return;
    }
    const result = await testProviderConnection(provider);
    if (result.error) {
      result.error = redactSecrets(result.error) as string;
    }
    // Mark as zero-cost config check
    result.message = result.ok
      ? `${result.message}（仅检查配置，未创建视频任务，未扣费）`
      : result.message;
    res.json({ ...result, mode: "local_config_check_only", will_not_generate_video: true });
  } catch (error) {
    next(error);
  }
});

// ====================================================================
// LLM TEST
// ====================================================================

async function testLlmConnection() {
  const config = loadLlmConfig();
  const logger = new JobLogger(path.join(outputsRoot, "logs"));
  const provider = config.mock ? new MockLlmProvider(config, logger) : new OpenAiCompatibleProvider(config, logger);
  const publicSettings = loadPublicRuntimeSettings();
  try {
    const result = await provider.callJson<{ ok: boolean; message: string }>({
      agentName: "LLM Check Agent",
      promptFile: "inline-check",
      inputSummary: "LLM connectivity check",
      system: "Return JSON only.",
      user: "Return exactly this JSON object: {\"ok\":true,\"message\":\"ready\"}"
    });
    return {
      ok: Boolean(result.ok),
      message: result.message || "ready",
      settings: publicSettings,
      error: null,
      suggestion: config.mock
        ? "当前处于 mock LLM；保存真实 API Key 并关闭 MOCK_LLM 后可验证真实 gpt-5.5。"
        : "真实 LLM 连接已就绪。"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: "LLM connection failed",
      settings: publicSettings,
      error: message,
      suggestion: llmFailureSuggestion(message, config)
    };
  }
}

function llmFailureSuggestion(message: string, config: ReturnType<typeof loadLlmConfig>) {
  if (!config.apiKey) return "未检测到 API Key。请在设置页粘贴 IKunCode API Key，保存后重试。";
  if (/401|403|unauthorized|forbidden/i.test(message)) return "认证失败。请检查 API Key 是否正确，或者该 Key 是否有 gpt-5.5 权限。";
  if (/404|model/i.test(message)) return "模型或接口地址可能不匹配。请确认 LLM_BASE_URL 是 OpenAI-compatible /v1 地址，模型为 gpt-5.5。";
  if (/ENOTFOUND|ECONNREFUSED|timeout|fetch failed/i.test(message)) return "网络或服务不可达。请检查 base_url 是否能从本机访问。";
  return "请检查 base_url、model、temperature 和供应商返回的错误信息。";
}

settingsRouter.post("/settings/llm-test", async (_req, res) => {
  res.json(await testLlmConnection());
});

settingsRouter.get("/llm/check", async (_req, res) => {
  res.json(await testLlmConnection());
});

// ====================================================================
// TTS PROVIDERS & TEST
// ====================================================================

settingsRouter.get("/tts/providers", (_req, res) => {
  try {
    const providers = [
      { name: "silence", voices: [], defaultVoice: "" },
      { name: "edge_tts", voices: getAvailableVoices("edge_tts"), defaultVoice: getDefaultVoice("edge_tts") },
      { name: "windows_sapi", voices: getAvailableVoices("windows_sapi"), defaultVoice: getDefaultVoice("windows_sapi") },
      { name: "piper", voices: getAvailableVoices("piper"), defaultVoice: getDefaultVoice("piper") },
      { name: "mimo_tts", voices: getAvailableVoices("mimo_tts"), defaultVoice: getDefaultVoice("mimo_tts") }
    ];
    const config = loadLlmConfig();
    res.json({
      current: {
        provider: config.ttsProvider,
        voice: config.ttsVoice,
        rate: config.ttsRate,
        enabled: config.ttsEnabled
      },
      providers
    });
  } catch (error) {
    sendServerError(res, error);
  }
});

settingsRouter.post("/settings/tts-test", async (_req, res) => {
  try {
    const config = loadLlmConfig();
    const testText = "这是一段语音合成测试。";
    const outputDir = path.join(outputsRoot, "tts_test");
    const fsMod = await import("node:fs/promises");
    await fsMod.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, "tts_test_" + Date.now() + ".m4a");

    const provider = createTtsProvider({
      provider: config.ttsProvider,
      voice: config.ttsVoice,
      rate: config.ttsRate,
      enabled: true
    });

    const result = await provider.synthesize(testText, outputPath);

    let duration = result.duration_sec;
    if (result.ok && duration === 0) {
      try {
        duration = await getAudioDuration(outputPath);
      } catch { /* ignore */ }
    }

    res.json({
      ok: result.ok,
      provider: result.provider,
      model: config.ttsProvider === "mimo_tts" ? (loadMimoConfig().textModel || "mimo-v2.5-tts") : undefined,
      voice: result.voice,
      selected_mode: result.selected_mode ?? (config.ttsProvider === "mimo_tts" ? "chat_completions_audio" : "native"),
      selected_auth: result.selected_auth ?? "none",
      format: config.ttsProvider === "mimo_tts" ? "wav" : undefined,
      output_path: result.ok ? outputPath : null,
      duration_sec: Number(duration.toFixed(3)),
      fallback_used: result.fallback_used,
      error: result.error ?? null,
      error_type: result.error_type ?? null,
      suggestion: result.ok
        ? "TTS 测试成功。可以启用此 provider 生成带语音的视频。"
        : result.error ?? "TTS 测试失败，请检查 provider 配置。"
    });
  } catch (error) {
    res.json({
      ok: false,
      provider: "unknown",
      voice: "",
      output_path: null,
      duration_sec: 0,
      fallback_used: true,
      error: scrubErrorMessage(error instanceof Error ? error.message : String(error)),
      suggestion: "TTS 测试出错，请检查配置和依赖。"
    });
  }
});

// ====================================================================
// TTS SETTINGS
// ====================================================================

settingsRouter.get("/settings/tts", async (_req, res) => {
  try {
    const local = await readLocalSettingsFile();
    const config = loadLlmConfig();
    const mimoConfig = loadMimoConfig();
    res.json({
      TTS_PROVIDER: config.ttsProvider,
      TTS_ENABLED: config.ttsEnabled,
      TTS_RATE: config.ttsRate,
      TTS_VOICE: config.ttsVoice,
      MIMO_TTS_MODEL: local.MIMO_TTS_MODEL || "mimo-v2.5-tts",
      MIMO_TTS_VOICE: local.MIMO_TTS_VOICE || "mimo_default",
      MIMO_TTS_FORMAT: local.MIMO_TTS_FORMAT || "wav",
      MIMO_TTS_STYLE_PROMPT: local.MIMO_TTS_STYLE_PROMPT || "请使用自然、清晰、适合知识讲解的语气朗读。",
      mimoApiKeyPresent: Boolean(mimoConfig.apiKey)
    });
  } catch (error) {
    sendServerError(res, error);
  }
});

settingsRouter.post("/settings/tts", express.json(), async (req, res, next) => {
  try {
    const payload = req.body;
    const settingsInput: LocalSettingsInput = {};
    if (payload.TTS_PROVIDER !== undefined) settingsInput.TTS_PROVIDER = payload.TTS_PROVIDER;
    if (payload.TTS_ENABLED !== undefined) settingsInput.TTS_ENABLED = payload.TTS_ENABLED;
    if (payload.TTS_RATE !== undefined) settingsInput.TTS_RATE = payload.TTS_RATE;
    if (payload.TTS_VOICE !== undefined) settingsInput.TTS_VOICE = payload.TTS_VOICE;
    await saveLocalSettings(settingsInput);

    const settingsPath = path.join(process.cwd(), "config", "local-settings.json");
    const existing = await readLocalSettingsForMerge();
    if (payload.MIMO_TTS_MODEL !== undefined) existing.MIMO_TTS_MODEL = payload.MIMO_TTS_MODEL;
    if (payload.MIMO_TTS_VOICE !== undefined) existing.MIMO_TTS_VOICE = payload.MIMO_TTS_VOICE;
    if (payload.MIMO_TTS_FORMAT !== undefined) existing.MIMO_TTS_FORMAT = payload.MIMO_TTS_FORMAT;
    if (payload.MIMO_TTS_STYLE_PROMPT !== undefined) existing.MIMO_TTS_STYLE_PROMPT = payload.MIMO_TTS_STYLE_PROMPT;
    await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2) + "\n", "utf8");

    res.json({ ok: true, message: "TTS 设置已保存" });
  } catch (error) {
    next(error);
  }
});

// ====================================================================
// MIMO CONFIG & TESTS
// ====================================================================

settingsRouter.get("/mimo/config", (_req, res) => {
  try {
    const mimoConfig = loadMimoConfig();
    res.json({
      apiKeyPresent: Boolean(mimoConfig.apiKey),
      openaiBaseUrl: mimoConfig.openaiBaseUrl || mimoConfig.baseUrl || "https://token-plan-cn.xiaomimimo.com/v1",
      anthropicBaseUrl: mimoConfig.anthropicBaseUrl || "https://token-plan-cn.xiaomimimo.com/anthropic",
      textModel: mimoConfig.textModel || "mimo-v2.5-pro",
      multimodalModel: mimoConfig.multimodalModel || "mimo-v2.5-pro",
      ttsModel: mimoConfig.ttsModel || "mimo-v2.5-tts",
      ttsVoice: mimoConfig.ttsVoice || "mimo_default",
      ttsFormat: mimoConfig.ttsFormat || "wav",
      note: "MiMo 中国专属节点 (token-plan-cn.xiaomimimo.com)。OpenAI 兼容和 Anthropic 兼容双协议。"
    });
  } catch (error) {
    sendServerError(res, error);
  }
});

settingsRouter.post("/settings/mimo-reset-base-url", async (_req, res, next) => {
  try {
    const settingsPath = path.join(process.cwd(), "config", "local-settings.json");
    const existing = await readLocalSettingsForMerge();
    existing.MIMO_API_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
    existing.MIMO_OPENAI_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
    existing.MIMO_ANTHROPIC_BASE_URL = "https://token-plan-cn.xiaomimimo.com/anthropic";
    await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
    res.json({ ok: true, message: "MiMo Base URL 已恢复为默认 CN 地址", openaiBaseUrl: "https://token-plan-cn.xiaomimimo.com/v1", anthropicBaseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic" });
  } catch (error) {
    next(error);
  }
});

settingsRouter.post("/settings/mimo-test", async (_req, res) => {
  try {
    const mimoConfig = loadMimoConfig();
    const provider = new MimoTextProvider(mimoConfig);
    const result = await provider.test();
    res.json(result);
  } catch (error) {
    res.json({
      ok: false,
      provider: "mimo",
      model: "mimo-v2.5-pro",
      mode: "text" as const,
      message: "MiMo 文本测试出错",
      error: scrubErrorMessage(error instanceof Error ? error.message : String(error)),
      suggestion: "请检查 MiMo 配置和网络连接"
    });
  }
});

settingsRouter.post("/settings/mimo-multimodal-test", async (_req, res) => {
  try {
    const mimoConfig = loadMimoConfig();
    const provider = new MimoMultimodalProvider(mimoConfig);
    const result = await provider.test();
    res.json(result);
  } catch (error) {
    res.json({
      ok: false,
      provider: "mimo_multimodal",
      model: "mimo-v2.5-pro",
      mode: "multimodal" as const,
      message: "MiMo 多模态测试出错",
      error: scrubErrorMessage(error instanceof Error ? error.message : String(error)),
      suggestion: "请检查 MiMo 配置和网络连接"
    });
  }
});

settingsRouter.post("/settings/mimo-multimodal-image-test", async (_req, res) => {
  try {
    const mimoConfig = loadMimoConfig();
    if (!mimoConfig.apiKey) {
      res.json({
        ok: false,
        provider: "mimo_multimodal",
        model: mimoConfig.multimodalModel || "mimo-v2.5-pro",
        mode: "multimodal" as const,
        message: "MIMO_API_KEY 未配置",
        error: "key_missing",
        suggestion: "请在设置页配置 MiMo API Key"
      });
      return;
    }

    const { pathExists: pathExistsFn, samplesRoot } = await import("../../../../../packages/core/src/index");
    const testImagePath = path.join(samplesRoot, "test_multimodal.png");
    if (!(await pathExistsFn(testImagePath))) {
      res.json({
        ok: false,
        provider: "mimo_multimodal",
        mode: "multimodal" as const,
        message: "测试图片 samples/test_multimodal.png 不存在",
        error: "test_image_missing"
      });
      return;
    }

    const imageBuffer = await fs.readFile(testImagePath);
    const imageBase64 = imageBuffer.toString("base64");

    const provider = new MimoMultimodalProvider(mimoConfig);
    const result = await provider.analyze({
      text: "请描述这张图片中大概有什么内容。特别注意是否有\"文档\"、\"分镜\"、\"配音\"、\"视频\"这些关键词或流程。",
      images: [{ data: imageBase64, mimeType: "image/png" }]
    });

    const content = result.summary || "";
    const hasDoc = /文档/.test(content);
    const hasStoryboard = /分镜/.test(content);
    const hasVoice = /配音/.test(content);
    const hasVideo = /视频/.test(content);
    const keywordsFound = [hasDoc && "文档", hasStoryboard && "分镜", hasVoice && "配音", hasVideo && "视频"].filter(Boolean);

    res.json({
      ok: true,
      provider: "mimo_multimodal",
      model: mimoConfig.multimodalModel || "mimo-v2.5-pro",
      mode: "multimodal",
      message: "图片分析完成",
      content_length: content.length,
      keywords_found: keywordsFound,
      keywords_expected: ["文档", "分镜", "配音", "视频"],
      keywords_matched: keywordsFound.length,
      content_preview: content.slice(0, 600),
      confidence: result.confidence,
      note: keywordsFound.length < 4
        ? `模型未能完整识别图中流程关键词（${keywordsFound.length}/4）。api-key 认证不支持图片输入（返回 404），bearer 认证可用但模型可能未精确识别图中文字。`
        : "模型成功识别了图中所有流程关键词。"
    });
  } catch (error) {
    // 2026-05-28 audit P1 — error 上的 error_type 是 ad-hoc 增强字段, 用 unknown narrowing
    const errObj = error as { error_type?: unknown } | null | undefined;
    const errorType = typeof errObj?.error_type === "string" ? errObj.error_type : "";
    res.json({
      ok: false,
      provider: "mimo_multimodal",
      mode: "multimodal" as const,
      message: "MiMo 多模态图片测试失败",
      error: errorType || (error instanceof Error ? error.message : String(error)),
      suggestion: errorType === "auth_failed"
        ? "api-key 认证不支持图片输入，请确认 Bearer 认证可用"
        : "请检查 MiMo 配置和网络连接"
    });
  }
});
