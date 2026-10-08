import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { repoRoot } from "./paths";
import { CURRENT_SCHEMA_VERSION, migrateToLatest } from "./migrations";
import {
  clearKeysForProvider,
  findSecretProvider,
  isNoKeyPreset,
  lookupKeysForProvider,
  resolveProviderAlias
} from "./secretRegistry";

const localSettingsPath = path.join(repoRoot, "config", "local-settings.json");
const envPath = path.join(repoRoot, ".env");
const envLocalPath = path.join(repoRoot, ".env.local");

// --- Types ---

export interface SecretsStatus {
  ikuncode: {
    key_present: boolean;
    base_url: string;
    model: string;
  };
  ikuncode_claude: {
    key_present: boolean;
    base_url: string;
    model: string;
  };
  mimo: {
    key_present: boolean;
    openai_base_url: string;
    anthropic_base_url: string;
    text_model: string;
    multimodal_model: string;
    tts_model: string;
    tts_voice: string;
    tts_format: string;
  };
  openai: {
    key_present: boolean;
    base_url: string;
    model: string;
  };
  anthropic: {
    key_present: boolean;
    base_url: string;
    model: string;
  };
  deepseek: {
    key_present: boolean;
    base_url: string;
    model: string;
  };
  custom_openai_compat: {
    key_present: boolean;
    base_url: string;
    model: string;
  };
  openrouter: {
    key_present: boolean;
    base_url: string;
  };
  codex: {
    key_present: boolean;
    base_url: string;
    model: string;
  };
  jimeng: {
    key_present: boolean;
    access_key_present: boolean;
    secret_key_present: boolean;
    base_url: string;
  };
  kling: {
    key_present: boolean;
    access_key_present: boolean;
    secret_key_present: boolean;
    base_url: string;
    model: string;
  };
  vidu: {
    key_present: boolean;
    base_url: string;
    model: string;
  };
  tts: {
    provider: string;
    fallback_provider: string;
    enabled: boolean;
    voice: string;
    rate: string;
  };
  video: {
    key_present: boolean;
    provider: string;
    base_url_present: boolean;
    model: string;
    aspect_ratio: string;
    duration_per_scene: string;
    resolution: string;
  };
  minimax: {
    key_present: boolean;
    base_url: string;
    model: string;
    duration: string;
    resolution: string;
    prompt_optimizer: boolean;
    fast_pretreatment: boolean;
    aigc_watermark: boolean;
    poll_interval_ms: string;
    poll_timeout_ms: string;
    download_timeout_ms: string;
  };
  image: {
    key_present: boolean;
    provider: string;
    base_url_present: boolean;
    model: string;
    resolution: string;
  };
  aliyun_wan: {
    key_present: boolean;
    base_url: string;
    region: string;
    model: string;
    resolution_tier: string;
    aspect_ratio: string;
    size: string;
    duration: string;
    prompt_extend: boolean;
    watermark: boolean;
    poll_interval_ms: string;
    poll_timeout_ms: string;
  };
  general: {
    global_model_provider: string;
    subtitle_mode: string;
  };
}

export interface SaveSecretsInput {
  ikuncode?: {
    api_key?: string;
    base_url?: string;
    model?: string;
    temperature?: number | string;
  };
  ikuncode_claude?: {
    api_key?: string;
    base_url?: string;
    model?: string;
  };
  mimo?: {
    api_key?: string;
    openai_base_url?: string;
    anthropic_base_url?: string;
    text_model?: string;
    multimodal_model?: string;
    tts_model?: string;
    tts_voice?: string;
    tts_format?: string;
  };
  openai?: {
    api_key?: string;
    base_url?: string;
    model?: string;
  };
  anthropic?: {
    api_key?: string;
    base_url?: string;
    model?: string;
  };
  deepseek?: {
    api_key?: string;
    base_url?: string;
    model?: string;
  };
  custom_openai_compat?: {
    api_key?: string;
    base_url?: string;
    model?: string;
  };
  openrouter?: {
    api_key?: string;
    base_url?: string;
  };
  codex?: {
    api_key?: string;
    base_url?: string;
    model?: string;
  };
  jimeng?: {
    api_key?: string;
    access_key?: string;
    secret_key?: string;
    base_url?: string;
  };
  kling?: {
    api_key?: string;
    access_key?: string;
    secret_key?: string;
    base_url?: string;
    model?: string;
  };
  vidu?: {
    api_key?: string;
    base_url?: string;
    model?: string;
  };
  tts?: {
    provider?: string;
    fallback_provider?: string;
    enabled?: boolean | string;
    voice?: string;
    rate?: string;
  };
  minimax?: {
    api_key?: string;
    base_url?: string;
    model?: string;
    duration?: string;
    resolution?: string;
    prompt_optimizer?: boolean | string;
    fast_pretreatment?: boolean | string;
    aigc_watermark?: boolean | string;
    poll_interval_ms?: string;
    poll_timeout_ms?: string;
    download_timeout_ms?: string;
  };
  video?: {
    provider?: string;
    api_key?: string;
    base_url?: string;
    model?: string;
    aspect_ratio?: string;
    duration_per_scene?: string;
    resolution?: string;
    concurrency?: string;
    max_retries?: string;
    poll_interval_ms?: string;
    timeout_ms?: string;
    fallback_provider?: string;
  };
  image?: {
    provider?: string;
    api_key?: string;
    base_url?: string;
    model?: string;
    resolution?: string;
  };
  aliyun_wan?: {
    api_key?: string;
    base_url?: string;
    region?: string;
    model?: string;
    resolution_tier?: string;
    aspect_ratio?: string;
    size?: string;
    duration?: string;
    prompt_extend?: boolean | string;
    watermark?: boolean | string;
    seed?: string;
    negative_prompt?: string;
    poll_interval_ms?: string;
    poll_timeout_ms?: string;
  };
  general?: {
    global_model_provider?: string;
    subtitle_mode?: string;
    mock_llm?: boolean | string;
  };
  clear_key?: string[]; // list of providers to clear key for
}

export type SecretProvider =
  | "ikuncode"
  | "ikuncode_claude"
  | "mimo"
  | "openai"
  | "anthropic"
  | "deepseek"
  | "custom_openai_compat"
  | "openrouter"
  | "codex"
  | "jimeng"
  | "kling"
  | "vidu"
  | "minimax"
  | "video"
  | "image"
  | "aliyun_wan";

// ── Reserved config keys (used by providerController, settingsController, etc.) ──
//
// LLM_PROVIDER_CHAIN — JSON-stringified array of provider IDs for fallback chain.
//   Written by POST/DELETE /providers/chain via writeLocalSettings.
//   Read by getChain() via getConfigValue("LLM_PROVIDER_CHAIN").
//   Format: '["ikuncode_gpt55","mimo_v25pro","openai_gpt5","claude_opus47","deepseek"]'
//
// CUSTOM_PROVIDERS — JSON-stringified array of custom provider configs.
// CUSTOM_PROVIDER_<ID>_API_KEY — individual custom provider API keys.
//
// GLOBAL_MODEL_PROVIDER — default LLM provider id.
//
// All keys go through the write queue in writeLocalSettings to prevent
// concurrent read-modify-write data loss.

// --- Core read/write ---

// Write queue to prevent concurrent read-modify-write from losing data.
// This is a process-level mutex; it does NOT protect against cross-process writes.
let _writeQueue: Promise<void> = Promise.resolve();

const SECRET_VALUE_PREFIX = "enc:v1:";

function getMachineKey(): Buffer {
  const identity = [
    os.hostname(),
    os.userInfo().username,
    process.platform,
  ].join("|");
  return crypto.createHash("sha256").update(identity).digest();
}

function xorBuffer(value: Buffer, key: Buffer): Buffer {
  const out = Buffer.allocUnsafe(value.length);
  for (let i = 0; i < value.length; i++) {
    out[i] = value[i] ^ key[i % key.length];
  }
  return out;
}

function isSensitiveLocalSettingKey(key: string): boolean {
  // ChatGPT OAuth tokens (CHATGPT_OAUTH_ACCESS_TOKEN / REFRESH_TOKEN / ID_TOKEN)
  // are bearer credentials that must be encrypted on disk like API keys.
  if (/^CHATGPT_OAUTH_(ACCESS|REFRESH|ID)_TOKEN$/i.test(key)) return true;
  return /(_API_KEY|_SECRET_KEY|_ACCESS_KEY|_SECRET_ID)$/i.test(key);
}

/**
 * Exported for v4 schema (localSettings.v2.ts) — same enc:v1: scheme so
 * v3 and v4 settings stay decryptable with the same machine-derived key.
 * DO NOT change algorithm without bumping the prefix to "enc:v2:".
 *
 * BUG-49: 这是混淆(obfuscation)而非加密(encryption).
 * XOR + machine-derived key 仅防止 casual 读取, 不提供真实机密性保护.
 * 安全保障依赖文件系统 ACL (OS 级权限). TODO: 中期替换为 AES-256-GCM.
 */
export function encryptSettingValue(value: string): string {
  if (value.startsWith(SECRET_VALUE_PREFIX)) return value;
  const cipher = xorBuffer(Buffer.from(value, "utf8"), getMachineKey());
  return `${SECRET_VALUE_PREFIX}${cipher.toString("base64")}`;
}

export function decryptSettingValue(value: string): string {
  if (!value.startsWith(SECRET_VALUE_PREFIX)) return value;
  const encoded = value.slice(SECRET_VALUE_PREFIX.length);
  try {
    const plain = xorBuffer(Buffer.from(encoded, "base64"), getMachineKey());
    return plain.toString("utf8");
  } catch (err) {
    // BUG-56: 解密失败时记录警告,不再静默返回空串
    console.warn("[localSettings] decryptSettingValue failed:", err instanceof Error ? err.message : String(err));
    return "";
  }
}

/** Exported so v4 callers can detect encrypted values. */
export const SECRET_PREFIX = SECRET_VALUE_PREFIX;

function sanitizeDiskSettings(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && isSensitiveLocalSettingKey(key)) {
      output[key] = decryptSettingValue(value);
      continue;
    }
    output[key] = value;
  }
  return output;
}

function prepareSettingsForDisk(input: Record<string, string>): Record<string, unknown> {
  const output: Record<string, unknown> = { schema_version: CURRENT_SCHEMA_VERSION };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    output[key] = isSensitiveLocalSettingKey(key) ? encryptSettingValue(value) : value;
  }
  return output;
}

// BUG-58: mtime 缓存，避免 getConfigValue 每次调用都读磁盘
let _localSettingsCache: Record<string, string> | null = null;
let _localSettingsMtime = 0;

export function readLocalSettings(strict = false): Record<string, string> {
  try {
    if (!fs.existsSync(localSettingsPath)) { _localSettingsCache = null; _localSettingsMtime = 0; return {}; }
    const stat = fs.statSync(localSettingsPath);
    if (_localSettingsCache !== null && stat.mtimeMs === _localSettingsMtime) {
      return { ..._localSettingsCache };
    }
    const parsed = JSON.parse(fs.readFileSync(localSettingsPath, "utf8")) as Record<string, unknown>;
    // E3: apply global schema version migration
    const migrated = migrateToLatest(parsed);
    const sanitized = sanitizeDiskSettings(migrated);
    const result = Object.fromEntries(
      Object.entries(sanitized)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, String(v)])
    );
    _localSettingsCache = result;
    _localSettingsMtime = stat.mtimeMs;
    return { ...result };
  } catch (error) {
    _localSettingsCache = null;
    _localSettingsMtime = 0;
    if (strict) throw error;
    return {};
  }
}

function readEnvFileSync(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, "utf8");
    const result: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) result[key] = val;
    }
    return result;
  } catch {
    return {};
  }
}

let _envCache: Record<string, string> | null = null;
let _envLocalCache: Record<string, string> | null = null;
let _envCacheMtime = 0;
let _envLocalCacheMtime = 0;

function getEnvFileValues(): Record<string, string> {
  try {
    const stat = fs.statSync(envPath);
    if (_envCache === null || stat.mtimeMs !== _envCacheMtime) {
      _envCache = readEnvFileSync(envPath);
      _envCacheMtime = stat.mtimeMs;
    }
  } catch {
    _envCache = {}; _envCacheMtime = 0;
  }
  return _envCache!;
}

function getEnvLocalFileValues(): Record<string, string> {
  try {
    const stat = fs.statSync(envLocalPath);
    if (_envLocalCache === null || stat.mtimeMs !== _envLocalCacheMtime) {
      _envLocalCache = readEnvFileSync(envLocalPath);
      _envLocalCacheMtime = stat.mtimeMs;
    }
  } catch {
    _envLocalCache = {}; _envLocalCacheMtime = 0;
  }
  return _envLocalCache!;
}

export function invalidateEnvCache(): void {
  _envCache = null;
  _envLocalCache = null;
  _envCacheMtime = 0;
  _envLocalCacheMtime = 0;
}

export async function writeLocalSettings(patch: Record<string, string | null>): Promise<SecretsStatus> {
  // Serialize writes through a queue to prevent concurrent read-modify-write data loss
  const result = await new Promise<SecretsStatus>((resolve, reject) => {
    _writeQueue = _writeQueue.then(async () => {
      try {
        const existing = readLocalSettings(true);
        const next: Record<string, string> = { ...existing };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) {
            // A deleted credential must not reappear from inherited env/.env on the next call or restart.
            if (isSensitiveLocalSettingKey(key)) next[key] = "";
            else delete next[key];
          } else {
            next[key] = value;
          }
        }
        await ensureConfigDir();
        // Atomic write: write to temp file first, then rename
        const tempPath = localSettingsPath + ".tmp";
        const onDisk = prepareSettingsForDisk(next);
        await fsp.writeFile(tempPath, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");
        await fsp.rename(tempPath, localSettingsPath);
        // BUG-58: 写入后失效缓存
        _localSettingsCache = null;
        _localSettingsMtime = 0;
        for (const [key, value] of Object.entries(patch)) {
          if (isSensitiveLocalSettingKey(key)) {
            if (value) process.env[key] = value;
            else delete process.env[key];
          }
        }
        resolve(getSecretStatus());
      } catch (err) {
        reject(err);
      }
    });
  });
  return result;
}

// --- Config value accessor with priority: process.env > local-settings > .env.local > .env > default ---

export function getConfigValue(key: string, defaultValue: string = ""): string {
  const local = readLocalSettings();
  // Explicitly saved credentials (including a deletion tombstone) take precedence over inherited values.
  if (isSensitiveLocalSettingKey(key) && local[key] !== undefined) return local[key];
  // 1. process.env (runtime override, highest priority)
  if (process.env[key] !== undefined && process.env[key] !== "") return process.env[key]!;
  // 2. config/local-settings.json
  if (local[key] !== undefined && local[key] !== "") return local[key];
  // 3. .env.local (local override, not committed)
  const envLocal = getEnvLocalFileValues();
  if (envLocal[key] !== undefined && envLocal[key] !== "") return envLocal[key];
  // 4. .env (project defaults)
  const env = getEnvFileValues();
  if (env[key] !== undefined && env[key] !== "") return env[key];
  // 5. default
  return defaultValue;
}

/**
 * Try multiple config keys in order, return the first non-empty value.
 * Useful for backward-compatible field names (e.g. IKUNCODE_API_KEY vs LLM_API_KEY).
 */
export function getConfigValueAny(keys: string[], defaultValue: string = ""): string {
  for (const key of keys) {
    const val = getConfigValue(key);
    if (val !== "") return val;
  }
  return defaultValue;
}

// --- Secrets status (desensitized) ---

export function getSecretStatus(): SecretsStatus {
  const s = readLocalSettings();
  // 2026-05-21 重构 (P1): key_present 走 secretRegistry.lookupKeysForProvider —
  // ENV 名集中在 secretRegistry.ts. 业务字段 (base_url / model / voice 等)
  // 仍内联, 因高度异质 driver 化收益低.
  const keyPresent = (id: string) => hasRealKeyAny(s, lookupKeysForProvider(id));
  const subKeyPresent = (envKey: string) => hasRealKey(s, envKey);

  return {
    ikuncode: {
      key_present: keyPresent("ikuncode"),
      base_url: getConfigValueAny(["IKUNCODE_LLM_BASE_URL", "LLM_BASE_URL"], "https://api.ikuncode.cc/v1"),
      model: getConfigValueAny(["IKUNCODE_LLM_MODEL", "LLM_MODEL"], "gpt-5.5")
    },
    ikuncode_claude: {
      key_present: keyPresent("ikuncode_claude"),
      base_url: getConfigValueAny(["IKUNCODE_CLAUDE_BASE_URL", "ANTHROPIC_BASE_URL"], "https://api.anthropic.com/v1"),
      model: getConfigValueAny(["IKUNCODE_CLAUDE_MODEL", "ANTHROPIC_MODEL"], "claude-sonnet-4-0")
    },
    mimo: {
      key_present: keyPresent("mimo"),
      openai_base_url: getConfigValue("MIMO_OPENAI_BASE_URL", "https://token-plan-cn.xiaomimimo.com/v1"),
      anthropic_base_url: getConfigValue("MIMO_ANTHROPIC_BASE_URL", "https://token-plan-cn.xiaomimimo.com/anthropic"),
      text_model: getConfigValue("MIMO_TEXT_MODEL", "mimo-v2.5-pro"),
      multimodal_model: getConfigValueAny(["MIMO_MULTIMODAL_MODEL", "MIMO_TEXT_MODEL"], "mimo-v2.5-pro"),
      tts_model: getConfigValue("MIMO_TTS_MODEL", "mimo-v2.5-tts"),
      tts_voice: getConfigValue("MIMO_TTS_VOICE", "mimo_default"),
      tts_format: getConfigValue("MIMO_TTS_FORMAT", "wav")
    },
    openai: {
      key_present: keyPresent("openai"),
      base_url: getConfigValue("OPENAI_BASE_URL", "https://api.openai.com/v1"),
      model: getConfigValue("OPENAI_MODEL", "gpt-5")
    },
    anthropic: {
      key_present: keyPresent("anthropic"),
      base_url: getConfigValue("ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1"),
      model: getConfigValue("ANTHROPIC_MODEL", "claude-sonnet-4-0")
    },
    deepseek: {
      key_present: keyPresent("deepseek"),
      base_url: getConfigValue("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
      model: getConfigValue("DEEPSEEK_MODEL", "deepseek-chat")
    },
    custom_openai_compat: {
      key_present: keyPresent("custom_openai_compat"),
      base_url: getConfigValue("CUSTOM_LLM_BASE_URL", ""),
      model: getConfigValue("CUSTOM_LLM_MODEL", "")
    },
    openrouter: {
      key_present: keyPresent("openrouter"),
      base_url: getConfigValue("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    },
    codex: {
      key_present: keyPresent("codex"),
      base_url: getConfigValue("CODEX_BASE_URL", ""),
      model: getConfigValue("CODEX_MODEL", "")
    },
    jimeng: {
      // jimeng 是多 key — key_present 看 lookupKeys (ACCESS_KEY / 兼容 API_KEY) 任一存在
      key_present: keyPresent("jimeng"),
      access_key_present: subKeyPresent("JIMENG_VOLC_ACCESS_KEY"),
      secret_key_present: subKeyPresent("JIMENG_VOLC_SECRET_KEY"),
      base_url: getConfigValue("JIMENG_BASE_URL", "")
    },
    kling: {
      // kling 是多 key — key_present 看 lookupKeys (ACCESS_KEY / 兼容 API_KEY) 任一存在
      key_present: keyPresent("kling"),
      access_key_present: subKeyPresent("KLING_ACCESS_KEY"),
      secret_key_present: subKeyPresent("KLING_SECRET_KEY"),
      base_url: getConfigValue("KLING_BASE_URL", "https://api.klingai.com"),
      model: getConfigValue("KLING_MODEL", "kling-v2-master")
    },
    vidu: {
      key_present: keyPresent("vidu"),
      base_url: getConfigValue("VIDU_BASE_URL", "https://api.vidu.cn/ent/v2"),
      model: getConfigValue("VIDU_MODEL", "viduq3")
    },
    tts: {
      provider: getConfigValue("TTS_PROVIDER", "edge_tts"),
      fallback_provider: getConfigValue("TTS_FALLBACK_PROVIDER", "edge_tts"),
      enabled: (() => { const v = getConfigValue("TTS_ENABLED", "true"); return v === "true" || v === "1"; })(),
      voice: getConfigValue("TTS_VOICE", "zh-CN-YunxiNeural"),
      rate: getConfigValue("TTS_RATE", "+0%")
    },
    video: {
      key_present: keyPresent("video"),
      provider: getConfigValue("VIDEO_PROVIDER", "local_mock_video"),
      base_url_present: Boolean(getConfigValue("VIDEO_API_BASE_URL")),
      model: getConfigValue("VIDEO_MODEL"),
      aspect_ratio: getConfigValue("VIDEO_ASPECT_RATIO", "16:9"),
      duration_per_scene: getConfigValue("VIDEO_DURATION_PER_SCENE", "6"),
      resolution: getConfigValue("VIDEO_RESOLUTION", "1920x1080")
    },
    minimax: {
      key_present: keyPresent("minimax"),
      base_url: getConfigValue("MINIMAX_BASE_URL", "https://api.minimaxi.com"),
      model: getConfigValue("MINIMAX_VIDEO_MODEL", "MiniMax-Hailuo-2.3"),
      duration: getConfigValue("MINIMAX_VIDEO_DURATION", "6"),
      resolution: getConfigValue("MINIMAX_VIDEO_RESOLUTION", "768P"),
      prompt_optimizer: getConfigValue("MINIMAX_PROMPT_OPTIMIZER", "true") === "true",
      fast_pretreatment: getConfigValue("MINIMAX_FAST_PRETREATMENT", "false") === "true",
      aigc_watermark: getConfigValue("MINIMAX_AIGC_WATERMARK", "false") === "true",
      poll_interval_ms: getConfigValue("MINIMAX_POLL_INTERVAL_MS", "10000"),
      poll_timeout_ms: getConfigValue("MINIMAX_POLL_TIMEOUT_MS", "900000"),
      download_timeout_ms: getConfigValue("MINIMAX_DOWNLOAD_TIMEOUT_MS", "300000")
    },
    image: {
      key_present: keyPresent("image"),
      provider: getConfigValue("IMAGE_PROVIDER", "local_card_image"),
      base_url_present: Boolean(getConfigValue("IMAGE_API_BASE_URL")),
      model: getConfigValue("IMAGE_MODEL"),
      resolution: getConfigValue("IMAGE_RESOLUTION", "1920x1080")
    },
    aliyun_wan: {
      key_present: keyPresent("aliyun_wan"),
      base_url: getConfigValue("ALIYUN_WAN_BASE_URL", "https://dashscope.aliyuncs.com"),
      region: getConfigValue("ALIYUN_WAN_REGION", "cn-beijing"),
      model: getConfigValue("ALIYUN_WAN_MODEL", "wan2.2-t2v-plus"),
      resolution_tier: getConfigValue("ALIYUN_WAN_RESOLUTION_TIER", "480P"),
      aspect_ratio: getConfigValue("ALIYUN_WAN_ASPECT_RATIO", "16:9"),
      size: getConfigValue("ALIYUN_WAN_SIZE", "832*480"),
      duration: getConfigValue("ALIYUN_WAN_DURATION", "5"),
      prompt_extend: getConfigValue("ALIYUN_WAN_PROMPT_EXTEND", "true").toLowerCase() === "true",
      watermark: getConfigValue("ALIYUN_WAN_WATERMARK", "false").toLowerCase() === "true",
      poll_interval_ms: getConfigValue("ALIYUN_WAN_POLL_INTERVAL_MS", "15000"),
      poll_timeout_ms: getConfigValue("ALIYUN_WAN_POLL_TIMEOUT_MS", "900000")
    },
    general: {
      global_model_provider: getConfigValue("GLOBAL_MODEL_PROVIDER", "ikuncode_gpt55"),
      subtitle_mode: getConfigValue("SUBTITLE_MODE", "both")
    }
  };
}

// --- Save secrets (sectional) ---

export async function saveSecrets(input: SaveSecretsInput): Promise<SecretsStatus> {
  const existing = readLocalSettings();
  const patch: Record<string, string | null> = {};

  // IkunCode
  if (input.ikuncode) {
    const ik = input.ikuncode;
    if (ik.base_url !== undefined) patch.IKUNCODE_LLM_BASE_URL = ik.base_url;
    if (ik.model !== undefined) patch.IKUNCODE_LLM_MODEL = ik.model;
    if (ik.temperature !== undefined) patch.LLM_TEMPERATURE = String(ik.temperature);
    // Only set key if explicitly provided and non-empty
    if (ik.api_key && ik.api_key.trim()) {
      patch.IKUNCODE_API_KEY = ik.api_key.trim();
      // Legacy LLM_API_KEY kept in .env reading only; save-secrets writes canonical key only
    }
    // Legacy LLM_BASE_URL / LLM_MODEL fields are read-only (see getConfigValueAny)
    // save-secrets writes canonical IKUNCODE_LLM_BASE_URL / IKUNCODE_LLM_MODEL only
  }

  if (input.ikuncode_claude) {
    const ic = input.ikuncode_claude;
    if (ic.api_key && ic.api_key.trim()) patch.IKUNCODE_CLAUDE_API_KEY = ic.api_key.trim();
    if (ic.base_url !== undefined) patch.IKUNCODE_CLAUDE_BASE_URL = ic.base_url;
    if (ic.model !== undefined) patch.IKUNCODE_CLAUDE_MODEL = ic.model;
  }

  // MiMo
  if (input.mimo) {
    const mi = input.mimo;
    if (mi.api_key && mi.api_key.trim()) patch.MIMO_API_KEY = mi.api_key.trim();
    if (mi.openai_base_url !== undefined) patch.MIMO_OPENAI_BASE_URL = mi.openai_base_url;
    if (mi.anthropic_base_url !== undefined) patch.MIMO_ANTHROPIC_BASE_URL = mi.anthropic_base_url;
    if (mi.text_model !== undefined) patch.MIMO_TEXT_MODEL = mi.text_model;
    if (mi.multimodal_model !== undefined) patch.MIMO_MULTIMODAL_MODEL = mi.multimodal_model;
    if (mi.tts_model !== undefined) patch.MIMO_TTS_MODEL = mi.tts_model;
    if (mi.tts_voice !== undefined) patch.MIMO_TTS_VOICE = mi.tts_voice;
    if (mi.tts_format !== undefined) patch.MIMO_TTS_FORMAT = mi.tts_format;
  }

  if (input.openai) {
    const o = input.openai;
    if (o.api_key && o.api_key.trim()) patch.OPENAI_API_KEY = o.api_key.trim();
    if (o.base_url !== undefined) patch.OPENAI_BASE_URL = o.base_url;
    if (o.model !== undefined) patch.OPENAI_MODEL = o.model;
  }

  if (input.anthropic) {
    const a = input.anthropic;
    if (a.api_key && a.api_key.trim()) patch.ANTHROPIC_API_KEY = a.api_key.trim();
    if (a.base_url !== undefined) patch.ANTHROPIC_BASE_URL = a.base_url;
    if (a.model !== undefined) patch.ANTHROPIC_MODEL = a.model;
  }

  if (input.deepseek) {
    const d = input.deepseek;
    if (d.api_key && d.api_key.trim()) patch.DEEPSEEK_API_KEY = d.api_key.trim();
    if (d.base_url !== undefined) patch.DEEPSEEK_BASE_URL = d.base_url;
    if (d.model !== undefined) patch.DEEPSEEK_MODEL = d.model;
  }

  if (input.custom_openai_compat) {
    const c = input.custom_openai_compat;
    if (c.api_key && c.api_key.trim()) patch.CUSTOM_LLM_API_KEY = c.api_key.trim();
    if (c.base_url !== undefined) patch.CUSTOM_LLM_BASE_URL = c.base_url;
    if (c.model !== undefined) patch.CUSTOM_LLM_MODEL = c.model;
  }

  if (input.openrouter) {
    const o = input.openrouter;
    if (o.api_key && o.api_key.trim()) patch.OPENROUTER_API_KEY = o.api_key.trim();
    if (o.base_url !== undefined) patch.OPENROUTER_BASE_URL = o.base_url;
  }

  if (input.codex) {
    const c = input.codex;
    if (c.api_key && c.api_key.trim()) patch.CODEX_API_KEY = c.api_key.trim();
    if (c.base_url !== undefined) patch.CODEX_BASE_URL = c.base_url;
    if (c.model !== undefined) patch.CODEX_MODEL = c.model;
  }

  if (input.jimeng) {
    const j = input.jimeng;
    if (j.api_key && j.api_key.trim()) patch.JIMENG_API_KEY = j.api_key.trim();
    if (j.access_key && j.access_key.trim()) patch.JIMENG_VOLC_ACCESS_KEY = j.access_key.trim();
    if (j.secret_key && j.secret_key.trim()) patch.JIMENG_VOLC_SECRET_KEY = j.secret_key.trim();
    if (j.base_url !== undefined) patch.JIMENG_BASE_URL = j.base_url;
  }

  if (input.kling) {
    const k = input.kling;
    if (k.api_key && k.api_key.trim()) patch.KLING_API_KEY = k.api_key.trim();
    if (k.access_key && k.access_key.trim()) patch.KLING_ACCESS_KEY = k.access_key.trim();
    if (k.secret_key && k.secret_key.trim()) patch.KLING_SECRET_KEY = k.secret_key.trim();
    if (k.base_url !== undefined) patch.KLING_BASE_URL = k.base_url;
    if (k.model !== undefined) patch.KLING_MODEL = k.model;
  }

  if (input.vidu) {
    const v = input.vidu;
    if (v.api_key && v.api_key.trim()) patch.VIDU_API_KEY = v.api_key.trim();
    if (v.base_url !== undefined) patch.VIDU_BASE_URL = v.base_url;
    if (v.model !== undefined) patch.VIDU_MODEL = v.model;
  }

  // TTS
  if (input.tts) {
    const t = input.tts;
    if (t.provider !== undefined) patch.TTS_PROVIDER = t.provider;
    if (t.fallback_provider !== undefined) patch.TTS_FALLBACK_PROVIDER = t.fallback_provider;
    if (t.enabled !== undefined) patch.TTS_ENABLED = String(t.enabled === true || t.enabled === "true");
    if (t.voice !== undefined) patch.TTS_VOICE = t.voice;
    if (t.rate !== undefined) patch.TTS_RATE = t.rate;
  }

  // MiniMax
  if (input.minimax) {
    const mm = input.minimax;
    if (mm.api_key && mm.api_key.trim()) patch.MINIMAX_API_KEY = mm.api_key.trim();
    if (mm.base_url !== undefined) patch.MINIMAX_BASE_URL = mm.base_url;
    if (mm.model !== undefined) patch.MINIMAX_VIDEO_MODEL = mm.model;
    if (mm.duration !== undefined) patch.MINIMAX_VIDEO_DURATION = String(mm.duration);
    if (mm.resolution !== undefined) patch.MINIMAX_VIDEO_RESOLUTION = mm.resolution;
    if (mm.prompt_optimizer !== undefined) patch.MINIMAX_PROMPT_OPTIMIZER = String(mm.prompt_optimizer === true || mm.prompt_optimizer === "true");
    if (mm.fast_pretreatment !== undefined) patch.MINIMAX_FAST_PRETREATMENT = String(mm.fast_pretreatment === true || mm.fast_pretreatment === "true");
    if (mm.aigc_watermark !== undefined) patch.MINIMAX_AIGC_WATERMARK = String(mm.aigc_watermark === true || mm.aigc_watermark === "true");
    if (mm.poll_interval_ms !== undefined) patch.MINIMAX_POLL_INTERVAL_MS = String(mm.poll_interval_ms);
    if (mm.poll_timeout_ms !== undefined) patch.MINIMAX_POLL_TIMEOUT_MS = String(mm.poll_timeout_ms);
    if (mm.download_timeout_ms !== undefined) patch.MINIMAX_DOWNLOAD_TIMEOUT_MS = String(mm.download_timeout_ms);
  }

  // Video
  if (input.video) {
    const v = input.video;
    if (v.provider !== undefined) patch.VIDEO_PROVIDER = v.provider;
    if (v.api_key && v.api_key.trim()) patch.VIDEO_API_KEY = v.api_key.trim();
    if (v.base_url !== undefined) patch.VIDEO_API_BASE_URL = v.base_url;
    if (v.model !== undefined) patch.VIDEO_MODEL = v.model;
    if (v.aspect_ratio !== undefined) patch.VIDEO_ASPECT_RATIO = v.aspect_ratio;
    if (v.duration_per_scene !== undefined) patch.VIDEO_DURATION_PER_SCENE = v.duration_per_scene;
    if (v.resolution !== undefined) patch.VIDEO_RESOLUTION = v.resolution;
    if (v.concurrency !== undefined) patch.VIDEO_CONCURRENCY = v.concurrency;
    if (v.max_retries !== undefined) patch.VIDEO_MAX_RETRIES = v.max_retries;
    if (v.poll_interval_ms !== undefined) patch.VIDEO_POLL_INTERVAL_MS = v.poll_interval_ms;
    if (v.timeout_ms !== undefined) patch.VIDEO_TIMEOUT_MS = v.timeout_ms;
    if (v.fallback_provider !== undefined) patch.VIDEO_FALLBACK_PROVIDER = v.fallback_provider;
  }

  // Image
  if (input.image) {
    const im = input.image;
    if (im.provider !== undefined) patch.IMAGE_PROVIDER = im.provider;
    if (im.api_key && im.api_key.trim()) patch.IMAGE_API_KEY = im.api_key.trim();
    if (im.base_url !== undefined) patch.IMAGE_API_BASE_URL = im.base_url;
    if (im.model !== undefined) patch.IMAGE_MODEL = im.model;
    if (im.resolution !== undefined) patch.IMAGE_RESOLUTION = im.resolution;
  }

  // Aliyun Wan
  if (input.aliyun_wan) {
    const aw = input.aliyun_wan;
    if (aw.api_key && aw.api_key.trim()) patch.ALIYUN_DASHSCOPE_API_KEY = aw.api_key.trim();
    if (aw.base_url !== undefined) patch.ALIYUN_WAN_BASE_URL = aw.base_url;
    if (aw.region !== undefined) patch.ALIYUN_WAN_REGION = aw.region;
    if (aw.model !== undefined) patch.ALIYUN_WAN_MODEL = aw.model;
    if (aw.resolution_tier !== undefined) patch.ALIYUN_WAN_RESOLUTION_TIER = aw.resolution_tier;
    if (aw.aspect_ratio !== undefined) patch.ALIYUN_WAN_ASPECT_RATIO = aw.aspect_ratio;
    if (aw.size !== undefined) patch.ALIYUN_WAN_SIZE = aw.size;
    if (aw.duration !== undefined) patch.ALIYUN_WAN_DURATION = String(aw.duration);
    if (aw.prompt_extend !== undefined) patch.ALIYUN_WAN_PROMPT_EXTEND = String(aw.prompt_extend === true || aw.prompt_extend === "true");
    if (aw.watermark !== undefined) patch.ALIYUN_WAN_WATERMARK = String(aw.watermark === true || aw.watermark === "true");
    if (aw.seed !== undefined) patch.ALIYUN_WAN_SEED = String(aw.seed);
    if (aw.negative_prompt !== undefined) patch.ALIYUN_WAN_NEGATIVE_PROMPT = aw.negative_prompt;
    if (aw.poll_interval_ms !== undefined) patch.ALIYUN_WAN_POLL_INTERVAL_MS = String(aw.poll_interval_ms);
    if (aw.poll_timeout_ms !== undefined) patch.ALIYUN_WAN_POLL_TIMEOUT_MS = String(aw.poll_timeout_ms);
  }

  // General
  if (input.general) {
    const g = input.general;
    if (g.global_model_provider !== undefined) patch.GLOBAL_MODEL_PROVIDER = g.global_model_provider;
    if (g.subtitle_mode !== undefined) patch.SUBTITLE_MODE = g.subtitle_mode;
    if (g.mock_llm !== undefined) patch.MOCK_LLM = String(g.mock_llm === true || g.mock_llm === "true");
  }

  // Clear keys
  if (input.clear_key) {
    for (const provider of input.clear_key) {
      clearProviderKey(patch, provider as SecretProvider);
    }
  }

  return writeLocalSettings(patch);
}

// --- Clear single provider key ---

export async function clearSecret(provider: SecretProvider): Promise<SecretsStatus> {
  const patch: Record<string, string | null> = {};
  clearProviderKey(patch, provider);
  return writeLocalSettings(patch);
}

function clearProviderKey(patch: Record<string, string | null>, provider: SecretProvider) {
  // 2026-05-21 重构 (P1): switch → registry driver. ENV 名集中在 secretRegistry.ts.
  // clearKeys 包含 lookup + 附加凭证 (kling/jimeng 的 SECRET_KEY, tencent 的 SECRET_KEY)
  for (const k of clearKeysForProvider(provider)) {
    patch[k] = null;
  }
}

// --- Test provider connection ---

export interface ProviderTestResult {
  ok: boolean;
  provider: string;
  message: string;
  error?: string;
  error_type?: string;
  details?: Record<string, unknown>;
}

export async function testProviderConnection(provider: string): Promise<ProviderTestResult> {
  switch (provider) {
    case "ikuncode": {
      const apiKey = getConfigValueAny(["IKUNCODE_API_KEY", "LLM_API_KEY"]);
      const baseUrl = getConfigValueAny(["IKUNCODE_LLM_BASE_URL", "LLM_BASE_URL"], "https://api.ikuncode.cc/v1");
      const model = getConfigValueAny(["IKUNCODE_LLM_MODEL", "LLM_MODEL"], "gpt-5.5");
      if (!apiKey) return { ok: false, provider: "ikuncode", message: "API Key 未配置", error_type: "key_missing" };
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: "Return JSON only." },
              { role: "user", content: "Return exactly: {\"ok\":true}" }
            ],
            response_format: { type: "json_object" },
            max_tokens: 20
          }),
          // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(10_000).
        });
        if (response.ok) return { ok: true, provider: "ikuncode", message: "连接成功", details: { model, base_url: baseUrl } };
        const errText = await response.text().catch(() => "");
        return { ok: false, provider: "ikuncode", message: `HTTP ${response.status}`, error: errText.slice(0, 200), error_type: response.status === 401 || response.status === 403 ? "auth_failed" : "connection_failed" };
      } catch (error) {
        return { ok: false, provider: "ikuncode", message: "连接失败", error: error instanceof Error ? error.message : String(error), error_type: "connection_failed" };
      }
    }

    case "mimo_text": {
      const apiKey = getConfigValue("MIMO_API_KEY");
      const baseUrl = getConfigValue("MIMO_OPENAI_BASE_URL", "https://token-plan-cn.xiaomimimo.com/v1");
      const model = getConfigValue("MIMO_TEXT_MODEL", "mimo-v2.5-pro");
      if (!apiKey) return { ok: false, provider: "mimo_text", message: "MIMO_API_KEY 未配置", error_type: "key_missing" };
      try {
        for (const authType of ["api-key", "bearer"] as const) {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (authType === "api-key") headers["api-key"] = apiKey;
          else headers["Authorization"] = `Bearer ${apiKey}`;
          const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model, messages: [{ role: "user", content: "Say ok" }], max_tokens: 10 }),
            // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(10_000).
          });
          if (response.ok) return { ok: true, provider: "mimo_text", message: "连接成功", details: { model, auth: authType } };
          if (response.status === 401 || response.status === 403) continue;
          return { ok: false, provider: "mimo_text", message: `HTTP ${response.status}`, error_type: `http_${response.status}` };
        }
        return { ok: false, provider: "mimo_text", message: "认证失败", error_type: "auth_failed" };
      } catch (error) {
        return { ok: false, provider: "mimo_text", message: "连接失败", error: error instanceof Error ? error.message : String(error), error_type: "connection_failed" };
      }
    }

    case "mimo_multimodal": {
      const apiKey = getConfigValue("MIMO_API_KEY");
      const baseUrl = getConfigValue("MIMO_OPENAI_BASE_URL", "https://token-plan-cn.xiaomimimo.com/v1");
      const model = getConfigValueAny(["MIMO_MULTIMODAL_MODEL", "MIMO_TEXT_MODEL"], "mimo-v2.5-pro");
      if (!apiKey) return { ok: false, provider: "mimo_multimodal", message: "MIMO_API_KEY 未配置", error_type: "key_missing" };
      try {
        for (const authType of ["api-key", "bearer"] as const) {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (authType === "api-key") headers["api-key"] = apiKey;
          else headers["Authorization"] = `Bearer ${apiKey}`;
          const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model, messages: [{ role: "user", content: "Say ok" }], max_tokens: 10 }),
            // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(10_000).
          });
          if (response.ok) return { ok: true, provider: "mimo_multimodal", message: "连接成功", details: { model, auth: authType } };
          if (response.status === 401 || response.status === 403) continue;
          return { ok: false, provider: "mimo_multimodal", message: `HTTP ${response.status}`, error_type: `http_${response.status}` };
        }
        return { ok: false, provider: "mimo_multimodal", message: "认证失败", error_type: "auth_failed" };
      } catch (error) {
        return { ok: false, provider: "mimo_multimodal", message: "连接失败", error: error instanceof Error ? error.message : String(error), error_type: "connection_failed" };
      }
    }

    case "mimo_tts": {
      const apiKey = getConfigValue("MIMO_API_KEY");
      const baseUrl = getConfigValue("MIMO_OPENAI_BASE_URL", "https://token-plan-cn.xiaomimimo.com/v1");
      const model = getConfigValue("MIMO_TTS_MODEL", "mimo-v2.5-tts");
      if (!apiKey) return { ok: false, provider: "mimo_tts", message: "MIMO_API_KEY 未配置", error_type: "key_missing" };
      return { ok: true, provider: "mimo_tts", message: "Key 已配置，TTS 可用性需实际调用验证", details: { model } };
    }

    case "edge_tts": {
      try {
        const result = await runBoundedCommand("python", ["-m", "edge_tts", "--list-voices"], 10_000);
        if (result.code === 0) return { ok: true, provider: "edge_tts", message: "edge_tts 可用" };
        return { ok: false, provider: "edge_tts", message: "edge_tts 不可用", error: result.stderr.slice(0, 200) };
      } catch (error) {
        return { ok: false, provider: "edge_tts", message: "edge_tts 检测失败", error: error instanceof Error ? error.message : String(error) };
      }
    }

    case "minimax": {
      const apiKey = getConfigValue("MINIMAX_API_KEY");
      const baseUrl = getConfigValue("MINIMAX_BASE_URL", "https://api.minimaxi.com");
      const model = getConfigValue("MINIMAX_VIDEO_MODEL", "MiniMax-Hailuo-2.3");
      if (!apiKey) return { ok: false, provider: "minimax_hailuo", message: "MiniMax API Key 未配置", error_type: "key_missing" };
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/query/video_generation?task_id=test`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(10_000).
        });
        if (response.status === 401 || response.status === 403) {
          return { ok: false, provider: "minimax_hailuo", message: "MiniMax API Key 认证失败", error_type: "auth_failed" };
        }
        // 404 on test task_id is expected — means key is valid and base URL is correct
        return { ok: true, provider: "minimax_hailuo", message: "MiniMax API Key 有效，连接成功", details: { model, base_url: baseUrl } };
      } catch (error) {
        return { ok: false, provider: "minimax_hailuo", message: "MiniMax 连接失败", error: error instanceof Error ? error.message : String(error), error_type: "connection_failed" };
      }
    }

    case "video": {
      const provider = getConfigValue("VIDEO_PROVIDER", "local_mock_video");
      if (provider === "local_mock_video") {
        return { ok: true, provider: "local_mock_video", message: "本地 mock 可用，不消耗额度" };
      }

      // 2026-05-21 重构 (P1): 8 个 sub-video-provider 的 "key_missing 检查 + ok"
      // 走 secretRegistry, 不再重复硬编码 ENV 名.
      //
      // minimax_hailuo 特殊: 成功消息含 model 详情, 其余 7 个只回简短消息.
      if (provider === "minimax_hailuo") {
        const apiKey = getConfigValue("MINIMAX_API_KEY");
        if (!apiKey) return { ok: false, provider, message: "MiniMax API Key 未配置", error_type: "key_missing" };
        return { ok: true, provider, message: "MiniMax 配置已就绪，单个分镜可生成", details: { model: getConfigValue("MINIMAX_VIDEO_MODEL", "MiniMax-Hailuo-2.3") } };
      }

      const subVideoProviders: ReadonlySet<string> = new Set([
        "aliyun_wan_t2v",
        "kling_3",
        "vidu_q3_ref",
        "jimeng_video_3pro",
        "zhipu_cogvideox",
        "baidu_qianfan_video",
        "tencent_hunyuan_video"
      ]);

      if (subVideoProviders.has(provider)) {
        const canonical = resolveProviderAlias(provider);
        const entry = findSecretProvider(canonical);
        if (!entry) {
          return { ok: false, provider, message: `provider ${provider} 未在 secretRegistry 注册`, error_type: "unknown_provider" };
        }
        // 多 key provider (kling / jimeng / tencent) 需要 access_key + secret_key 同时存在
        const multiKeyFields: Record<string, [string, string]> = {
          kling: ["KLING_ACCESS_KEY", "KLING_SECRET_KEY"],
          jimeng: ["JIMENG_VOLC_ACCESS_KEY", "JIMENG_VOLC_SECRET_KEY"],
          tencent_hunyuan_video: ["TENCENT_SECRET_ID", "TENCENT_SECRET_KEY"]
        };
        if (canonical in multiKeyFields) {
          const [aKey, sKey] = multiKeyFields[canonical];
          const aVal = getConfigValue(aKey);
          const sVal = getConfigValue(sKey);
          if (!aVal || !sVal) {
            return { ok: false, provider, message: `请在设置页填 ${aKey} 和 ${sKey}`, error_type: "key_missing" };
          }
          return { ok: true, provider, message: "Key 已配置，真实生成时会验证有效性" };
        }
        // 单 key: 走 lookupKeys 首个
        const primaryKey = entry.lookupKeys[0];
        const val = getConfigValue(primaryKey);
        if (!val) {
          return { ok: false, provider, message: `请在设置页填 ${primaryKey}`, error_type: "key_missing" };
        }
        return { ok: true, provider, message: "Key 已配置，真实生成时会验证有效性" };
      }

      // future_api fallback
      const apiKey = getConfigValue("VIDEO_API_KEY");
      const baseUrl = getConfigValue("VIDEO_API_BASE_URL");
      if (!apiKey) return { ok: false, provider, message: "VIDEO_API_KEY 未配置", error_type: "key_missing" };
      if (!baseUrl) return { ok: false, provider, message: "VIDEO_API_BASE_URL 未配置", error_type: "endpoint_missing" };
      return { ok: false, provider, message: "真实视频 API 尚未实现", error_type: "not_implemented" };
    }

    case "image": {
      const provider = getConfigValue("IMAGE_PROVIDER", "local_card_image");
      if (provider === "local_card_image") {
        return { ok: true, provider: "local_card_image", message: "本地卡片可用" };
      }
      const apiKey = getConfigValue("IMAGE_API_KEY");
      const baseUrl = getConfigValue("IMAGE_API_BASE_URL");
      if (!apiKey) return { ok: false, provider, message: "IMAGE_API_KEY 未配置", error_type: "key_missing" };
      if (!baseUrl) return { ok: false, provider, message: "IMAGE_API_BASE_URL 未配置", error_type: "endpoint_missing" };
      return { ok: false, provider, message: "真实图像 API 尚未实现", error_type: "not_implemented" };
    }

    case "aliyun_wan": {
      const apiKey = getConfigValue("ALIYUN_DASHSCOPE_API_KEY");
      const baseUrl = getConfigValue("ALIYUN_WAN_BASE_URL", "https://dashscope.aliyuncs.com");
      const model = getConfigValue("ALIYUN_WAN_MODEL", "wan2.2-t2v-plus");
      if (!apiKey) return { ok: false, provider: "aliyun_wan_t2v", message: "阿里云百炼 API Key 未配置", error_type: "key_missing" };
      try {
        // Test by querying a non-existent task — 404 or error with valid auth means key works
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/tasks/test-connection-probe`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(10_000).
        });
        if (response.status === 401 || response.status === 403) {
          return { ok: false, provider: "aliyun_wan_t2v", message: "阿里云百炼 API Key 认证失败", error_type: "auth_failed" };
        }
        return { ok: true, provider: "aliyun_wan_t2v", message: "阿里云百炼 API Key 有效，连接成功", details: { model, base_url: baseUrl, region: getConfigValue("ALIYUN_WAN_REGION", "cn-beijing") } };
      } catch (error) {
        return { ok: false, provider: "aliyun_wan_t2v", message: "阿里云百炼连接失败", error: error instanceof Error ? error.message : String(error), error_type: "connection_failed" };
      }
    }

    default:
      return { ok: false, provider, message: `未知 provider: ${provider}`, error_type: "unknown_provider" };
  }
}

// --- Redaction utility ---

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    // v0.2.4: tighten to avoid false-positives on model names / scene ids /
    // commit hashes. Require prefix markers for opaque strings to be masked.
    if (/^sk-[A-Za-z0-9_-]{10,}$/.test(value)) return "[REDACTED_TOKEN]";
    if (/^Bearer\s+/i.test(value)) return "[REDACTED]";
    // JWT (MiniMax): three base64url-ish parts joined by dots.
    if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)) return "[REDACTED_JWT]";
    // DashScope-style: sk-<hex> is already covered above. Drop the overly
    // broad "any >20-char base64-alpha" rule — it masked scene_ids like
    // `scn_1234567890abcdef`, model names like `mimo-v2.5-pro-20240910`,
    // and commit hashes in docs.
    //
    // T6: apply scrubForLog regex on strings that may contain embedded keys
    // (e.g. provider error messages like "Bearer sk-xxx is invalid").
    // Only scrub if the string actually contains a known key pattern to
    // avoid unnecessary regex work on every string.
    const hasEmbeddedKey =
      /Bearer\s+[A-Za-z0-9_\-]{16,}/.test(value) ||
      /sk-[A-Za-z0-9]{20,}/.test(value) ||
      /tp-[a-z0-9]{20,}/.test(value) ||
      /"(api_?key|token|secret)"\s*:\s*"[^"]{8,}"/i.test(value);
    if (hasEmbeddedKey) {
      return value
        .replace(/Bearer\s+[A-Za-z0-9_\-]{16,}/g, "Bearer [REDACTED]")
        .replace(/sk-[A-Za-z0-9]{20,}/g, "sk-[REDACTED]")
        .replace(/tp-[a-z0-9]{20,}/g, "tp-[REDACTED]")
        .replace(/"(api_?key|token|secret)"\s*:\s*"[^"]{8,}"/gi, '"$1":"[REDACTED]"');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const lower = k.toLowerCase();
        // v0.2.4: narrower key-name match — previously `lower.includes("key")`
        // masked `keywords:[...]`, `keyword`, and similar legit fields.
        const sensitive = /^(api[_-]?key|authorization|auth[_-]?key|secret[_-]?key|access[_-]?key|bearer|token|dashscope_api_key|minimax_api_key|x[_-]?api[_-]?key|ikuncode_api_key|mimo_api_key)$/i.test(lower);
        if (sensitive) {
          return [k, typeof v === "string" && v.length > 0 ? "[REDACTED]" : v];
        }
        return [k, redactSecrets(v)];
      })
    );
  }
  return value;
}

// --- Helpers ---

function hasRealKey(_settings: Record<string, string>, key: string): boolean {
  // Check all config sources via centralized accessor
  const val = getConfigValue(key);
  return val.trim().length > 0;
}

function hasRealKeyAny(_settings: Record<string, string>, keys: string[]): boolean {
  const val = getConfigValueAny(keys);
  return val.trim().length > 0;
}

async function ensureConfigDir() {
  const dir = path.dirname(localSettingsPath);
  if (!fs.existsSync(dir)) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

async function runBoundedCommand(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, shell: false });
    } catch (err: any) {
      resolve({ code: 1, stderr: `spawn ENOENT: ${command} not found (${err?.message || String(err)})` });
      return;
    }

    if (!child.pid) {
      resolve({ code: 1, stderr: "failed to spawn process" });
      return;
    }

    const MAX_BUF = 16 * 1024;
    let stderr = "";
    const append = (current: string, chunk: string) => {
      const next = current + chunk;
      return next.length > MAX_BUF ? next.slice(next.length - MAX_BUF) : next;
    };

    const timer = setTimeout(async () => {
      try {
        if (process.platform === "win32") {
          await new Promise<void>((done) => {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false });
            killer.on("close", () => done());
            killer.on("error", () => done());
          });
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // best effort
      }
      stderr = append(stderr, `\n[timeout] Process killed after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk.toString());
    });
    child.stdout?.on("data", () => {
      // drain stdout without retaining it
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stderr: stderr || err.message });
    });
  });
}

// --- P20: getKeyFor ---

/**
 * Resolve the API key for a given provider id.
 * Maps preset env_key_name → config value.
 * Returns null if no key is configured.
 *
 * 2026-05-21 重构 (P1):
 *   原 envKeyMap (30+ provider 硬编码 ENV 名) 已收口到 secretRegistry.ts.
 *   本 fn 现在只做:
 *     1. 无 Key preset (本地子进程 / OAuth) 快速返回 null
 *     2. preset id → canonical provider id 别名解析 (resolveProviderAlias)
 *     3. 多 key 组合 provider (jimeng / tencent) 包成 JSON 字符串
 *     4. 单 key provider 走 registry lookupKeys 取首个非空
 *     5. 未注册 provider 回退到 CUSTOM_PROVIDER_<ID>_API_KEY
 */
export function getKeyFor(providerId: string): string | null {
  // 1. 无 Key preset (本地子进程 / OAuth token via 其他机制)
  if (isNoKeyPreset(providerId)) return null;

  // 2. preset id → canonical provider id
  const canonicalId = resolveProviderAlias(providerId);

  // 3. 多 key 组合: jimeng (preset 已被 alias 解析为 canonical "jimeng")
  if (canonicalId === "jimeng") {
    const ak = getConfigValue("JIMENG_VOLC_ACCESS_KEY", "");
    const sk = getConfigValue("JIMENG_VOLC_SECRET_KEY", "");
    if (ak && sk) return JSON.stringify({ access_key: ak, secret_key: sk });
    const single = getConfigValue("JIMENG_API_KEY", "");
    return single || null;
  }

  // 3-bis. 多 key 组合: tencent_hunyuan_video (secret_id + secret_key + region)
  if (canonicalId === "tencent_hunyuan_video") {
    const secretId = getConfigValue("TENCENT_SECRET_ID", "");
    const secretKey = getConfigValue("TENCENT_SECRET_KEY", "");
    const region = getConfigValue("TENCENT_REGION", "ap-guangzhou");
    if (secretId && secretKey) return JSON.stringify({ secret_id: secretId, secret_key: secretKey, region });
    return null;
  }

  // 4. 单 key: 走 registry lookupKeys 顺序找第一个非空
  const keys = lookupKeysForProvider(canonicalId);
  if (keys.length > 0) {
    for (const k of keys) {
      const v = getConfigValue(k, "");
      if (v) return v;
    }
  }

  // 5. 未注册 / registry 中无 lookupKeys → 回退到自定义 provider 命名空间
  const customKey = getConfigValue(`CUSTOM_PROVIDER_${providerId.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_API_KEY`, "");
  return customKey || null;
}
