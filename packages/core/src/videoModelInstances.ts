// videoModelInstances — 2 级"渠道 + 自定义模型实例"持久化层
//
// 用户痛点 (2026-05-18):
//   - "一定要选 3.0 吗?能不能只保留接入渠道,我自己添加模型?"
//   - "我需要只保留 keling 渠道, 默认名称不要写 3.0, 允许我自己添加模型,
//      你同时做好二级菜单管理, 一个提供商可以添加多个模型, 不要和提供商并列"
//
// 设计:
//   - 5 个 channel 写死 (kling / vidu / jimeng / minimax / aliyun_wan)
//   - 用户在每个 channel 下加任意数量的 instance, 每个 instance 自填 model_id / api_key / display_name
//   - instance 走自己的 storage key (VIDEO_MODEL_INSTANCES JSON array), 不污染 secrets
//   - api_key / secret_key 用 localSettings 已有的 enc:v1: 加密 (与现有 KLING_ACCESS_KEY 一致)
//
// 解耦: 本模块仅持久化 + CRUD. resolve "instance:<id>" → provider 调用,
//       由 server 端 videoGenerationService 处理 (不在这里做 fetch).

import crypto from "node:crypto";
import {
  readLocalSettings,
  writeLocalSettings,
  encryptSettingValue,
  decryptSettingValue,
  SECRET_PREFIX,
} from "./localSettings";

// ─── Channel 定义 ──────────────────────────────────────────────────

export type VideoChannelId =
  | "kling"
  | "vidu"
  | "jimeng"
  | "minimax"
  | "aliyun_wan"
  // 2026-05-20 Wave T S25: 把另外 3 个 builtin 也升到 instance 架构
  | "zhipu"
  | "baidu_qianfan"
  | "tencent_hunyuan";

export type VideoAuthType =
  | "bearer"           // Vidu / MiniMax / 阿里万相 DashScope / 智谱 / 百度千帆
  | "jwt_aksk"         // 可灵 (AK + SK 拼 JWT)
  | "volc_aksk_signed" // 即梦 / 火山引擎 (AK + SK 4 段 V4 签名)
  | "tencent_tc3_signed" // 腾讯混元 (SecretId + SecretKey + Region 三段, TC3-HMAC-SHA256 签名)
  ;

export interface VideoChannelDef {
  id: VideoChannelId;
  label: string;
  default_base_url: string;
  auth: VideoAuthType;
  needs_secret: boolean;
  /** Modal 模型名搜索下拉里给的建议. 用户输入任意字符串都允许, 不是限制 */
  suggested_models: string[];
  /** Modal 上"查看官方文档"链接 */
  doc_url: string;
  /** Modal 上的字段说明 */
  hint?: string;
}

export const VIDEO_CHANNELS: Record<VideoChannelId, VideoChannelDef> = {
  kling: {
    id: "kling",
    label: "可灵 AI",
    default_base_url: "https://api-beijing.klingai.com",
    auth: "jwt_aksk",
    needs_secret: true,
    suggested_models: [
      "kling-v3-i2v-pro",
      "kling-v3-i2v",
      "kling-v2-1-master",
      "kling-v2-master",
      "kling-v1-6",
    ],
    doc_url: "https://klingai.com/document-api/quickStart/productIntroduction/overview",
    hint: "AK + SK 拼 JWT 签名鉴权,接入地址默认 https://api-beijing.klingai.com",
  },
  vidu: {
    id: "vidu",
    label: "Vidu",
    default_base_url: "https://api.vidu.com",
    auth: "bearer",
    needs_secret: false,
    suggested_models: ["viduq3", "vidu-q3", "vidu-q2", "vidu-1.5"],
    doc_url: "https://platform.vidu.com/docs",
    hint: "Bearer Token 鉴权,接入地址默认 https://api.vidu.com (国内为 https://api.vidu.cn/ent/v2)",
  },
  jimeng: {
    id: "jimeng",
    label: "即梦 (火山引擎)",
    default_base_url: "https://visual.volcengineapi.com",
    auth: "volc_aksk_signed",
    needs_secret: true,
    suggested_models: [
      "doubao-seedance-1.0-pro",
      "doubao-seedance-1.0-lite",
      "doubao-seaweed",
    ],
    doc_url: "https://www.volcengine.com/docs/82379",
    hint: "火山引擎 AK + SK,V4 签名,模型 id 在火山控制台开通后填",
  },
  minimax: {
    id: "minimax",
    label: "MiniMax 海螺",
    default_base_url: "https://api.minimaxi.com",
    auth: "bearer",
    needs_secret: false,
    suggested_models: [
      "MiniMax-Hailuo-2.3",
      "MiniMax-Hailuo-02",
      "MiniMax-Hailuo-01",
      "MiniMax-Hailuo-01-Director",
    ],
    doc_url: "https://platform.minimaxi.com/document/Video",
    hint: "Bearer Token 鉴权,接入地址默认 https://api.minimaxi.com",
  },
  aliyun_wan: {
    id: "aliyun_wan",
    label: "阿里万相",
    default_base_url: "https://dashscope.aliyuncs.com",
    auth: "bearer",
    needs_secret: false,
    suggested_models: [
      "wan2.2-t2v-plus",
      "wan2.1-t2v-turbo",
      "wan2.1-t2v-plus",
      "wan2.2-i2v-plus",
    ],
    doc_url: "https://help.aliyun.com/zh/dashscope/developer-reference/text-to-video-api",
    hint: "DashScope Bearer Token 鉴权,接入地址默认 https://dashscope.aliyuncs.com",
  },
  // 2026-05-20 Wave T S25 — 新增 3 个 channel,从单 key builtin 模式迁到多实例架构
  zhipu: {
    id: "zhipu",
    label: "智谱 CogVideoX",
    default_base_url: "https://open.bigmodel.cn",
    auth: "bearer",
    needs_secret: false,
    suggested_models: [
      "cogvideox-3",
      "cogvideox-2",
      "cogvideox-flash",
    ],
    doc_url: "https://open.bigmodel.cn/dev/api/videomodel/cogvideox",
    hint: "智谱 Bearer Token 鉴权,接入地址默认 https://open.bigmodel.cn",
  },
  baidu_qianfan: {
    id: "baidu_qianfan",
    label: "百度千帆 VQ3",
    default_base_url: "https://qianfan.baidubce.com",
    auth: "bearer",
    needs_secret: false,
    suggested_models: [
      "VQ3-Pro",
      "VQ3-Lite",
    ],
    doc_url: "https://cloud.baidu.com/doc/qianfan-api",
    hint: "千帆 Bearer Token 鉴权,接入地址默认 https://qianfan.baidubce.com",
  },
  tencent_hunyuan: {
    id: "tencent_hunyuan",
    label: "腾讯混元视频",
    default_base_url: "https://vclm.tencentcloudapi.com",
    auth: "tencent_tc3_signed",
    needs_secret: true,
    suggested_models: [
      "HY-Video-1.5",
      "HY-Video-1.0",
    ],
    doc_url: "https://cloud.tencent.com/document/product/1729",
    hint: "腾讯云 SecretId + SecretKey + Region 三段,TC3-HMAC-SHA256 签名;region 必填(如 ap-guangzhou)",
  },
};

export function listVideoChannels(): VideoChannelDef[] {
  return Object.values(VIDEO_CHANNELS);
}

export function getVideoChannel(id: string): VideoChannelDef | null {
  return (VIDEO_CHANNELS as Record<string, VideoChannelDef>)[id] ?? null;
}

// ─── Instance 定义 ─────────────────────────────────────────────────

export interface VideoModelInstance {
  /** UUID, 在 model_ref 里用 "instance:<id>" */
  id: string;
  /** 用户填的显示名 (跟"显示在 ModelPicker 下拉里"挂钩), 必填 */
  display_name: string;
  channel: VideoChannelId;
  /** 真实 API 字段 (kling-v3-i2v-pro / MiniMax-Hailuo-2.3 / wan2.2-t2v-plus / 等) */
  model_id: string;
  /** 留空 = 走 channel default_base_url */
  api_base_url?: string;
  /** 主 key (Bearer 或 AK) */
  api_key: string;
  /** 双 key 情况下的 SK */
  secret_key?: string;
  /** 阿里某些 region 需要 */
  region?: string;
  /** ISO 时间 */
  created_at: string;
  updated_at: string;
}

export interface VideoModelInstancePublic extends Omit<VideoModelInstance, "api_key" | "secret_key"> {
  api_key_present: boolean;
  secret_key_present: boolean;
}

// ─── Persistence ───────────────────────────────────────────────────

const STORAGE_KEY = "VIDEO_MODEL_INSTANCES";

interface DiskEntry {
  id: string;
  display_name: string;
  channel: VideoChannelId;
  model_id: string;
  api_base_url?: string;
  /** 已加密 (enc:v1:...) */
  api_key_enc?: string;
  /** 已加密 (enc:v1:...) */
  secret_key_enc?: string;
  region?: string;
  created_at: string;
  updated_at: string;
}

function readDisk(): DiskEntry[] {
  try {
    const raw = readLocalSettings()[STORAGE_KEY];
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is DiskEntry =>
      x && typeof x === "object" && typeof x.id === "string" && typeof x.channel === "string"
    );
  } catch {
    return [];
  }
}

async function writeDisk(entries: DiskEntry[]): Promise<void> {
  await writeLocalSettings({ [STORAGE_KEY]: JSON.stringify(entries) });
}

function diskToInternal(entry: DiskEntry): VideoModelInstance {
  return {
    id: entry.id,
    display_name: entry.display_name,
    channel: entry.channel,
    model_id: entry.model_id,
    api_base_url: entry.api_base_url,
    api_key: entry.api_key_enc ? decryptSettingValue(entry.api_key_enc) : "",
    secret_key: entry.secret_key_enc ? decryptSettingValue(entry.secret_key_enc) : undefined,
    region: entry.region,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}

function diskToPublic(entry: DiskEntry): VideoModelInstancePublic {
  return {
    id: entry.id,
    display_name: entry.display_name,
    channel: entry.channel,
    model_id: entry.model_id,
    api_base_url: entry.api_base_url,
    region: entry.region,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    api_key_present: !!entry.api_key_enc,
    secret_key_present: !!entry.secret_key_enc,
  };
}

// ─── Public API ────────────────────────────────────────────────────

/** 列出所有 instance (内部使用, 含解密的 api_key) */
export function listVideoModelInstancesInternal(): VideoModelInstance[] {
  return readDisk().map(diskToInternal);
}

/** 列出所有 instance (对外, 不暴露 api_key 明文) */
export function listVideoModelInstances(): VideoModelInstancePublic[] {
  return readDisk().map(diskToPublic);
}

export function getVideoModelInstance(id: string): VideoModelInstance | null {
  const entry = readDisk().find((e) => e.id === id);
  return entry ? diskToInternal(entry) : null;
}

export function getVideoModelInstancePublic(id: string): VideoModelInstancePublic | null {
  const entry = readDisk().find((e) => e.id === id);
  return entry ? diskToPublic(entry) : null;
}

export interface CreateInstanceInput {
  display_name: string;
  channel: VideoChannelId;
  model_id: string;
  api_base_url?: string;
  api_key: string;
  secret_key?: string;
  region?: string;
}

export async function createVideoModelInstance(
  input: CreateInstanceInput,
): Promise<VideoModelInstancePublic> {
  const channelDef = getVideoChannel(input.channel);
  if (!channelDef) throw new Error(`未知渠道: ${input.channel}`);
  if (!input.display_name?.trim()) throw new Error("显示名称必填");
  if (!input.model_id?.trim()) throw new Error("模型 ID 必填");
  if (!input.api_key?.trim()) throw new Error("API Key 必填");
  if (channelDef.needs_secret && !input.secret_key?.trim()) {
    throw new Error(`${channelDef.label} 需要 Secret Key`);
  }

  const now = new Date().toISOString();
  const entry: DiskEntry = {
    id: `vmi_${crypto.randomUUID().slice(0, 8)}_${Date.now().toString(36)}`,
    display_name: input.display_name.trim(),
    channel: input.channel,
    model_id: input.model_id.trim(),
    api_base_url: input.api_base_url?.trim() || undefined,
    api_key_enc: encryptSettingValue(input.api_key.trim()),
    secret_key_enc: input.secret_key?.trim() ? encryptSettingValue(input.secret_key.trim()) : undefined,
    region: input.region?.trim() || undefined,
    created_at: now,
    updated_at: now,
  };

  const all = readDisk();
  all.push(entry);
  await writeDisk(all);
  return diskToPublic(entry);
}

export interface PatchInstanceInput {
  display_name?: string;
  model_id?: string;
  api_base_url?: string | null;
  /** 留空 = 保留旧 key */
  api_key?: string;
  secret_key?: string;
  region?: string | null;
}

export async function patchVideoModelInstance(
  id: string,
  patch: PatchInstanceInput,
): Promise<VideoModelInstancePublic | null> {
  const all = readDisk();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) return null;

  const cur = all[idx];
  const next: DiskEntry = { ...cur };

  if (patch.display_name !== undefined) {
    const trimmed = patch.display_name.trim();
    if (!trimmed) throw new Error("显示名称不能空");
    next.display_name = trimmed;
  }
  if (patch.model_id !== undefined) {
    const trimmed = patch.model_id.trim();
    if (!trimmed) throw new Error("模型 ID 不能空");
    next.model_id = trimmed;
  }
  if (patch.api_base_url !== undefined) {
    next.api_base_url = patch.api_base_url?.trim() || undefined;
  }
  if (patch.region !== undefined) {
    next.region = patch.region?.trim() || undefined;
  }
  // 留空 = 保留, 显式 set = 替换
  if (patch.api_key !== undefined && patch.api_key.trim()) {
    next.api_key_enc = encryptSettingValue(patch.api_key.trim());
  }
  if (patch.secret_key !== undefined && patch.secret_key.trim()) {
    next.secret_key_enc = encryptSettingValue(patch.secret_key.trim());
  }

  next.updated_at = new Date().toISOString();
  all[idx] = next;
  await writeDisk(all);
  return diskToPublic(next);
}

export async function deleteVideoModelInstance(id: string): Promise<boolean> {
  const all = readDisk();
  const next = all.filter((e) => e.id !== id);
  if (next.length === all.length) return false;
  await writeDisk(next);
  return true;
}

/**
 * 一次性 legacy migration: 把已经填好的 KLING_x / MINIMAX_x / VIDU_x / JIMENG_x / ALIYUN_WAN_x
 * env 自动迁入成对应 channel 的 1 个 instance, 让老用户进新 UI 时直接看到自己已配的 key.
 *
 * 幂等: 如果 STORAGE_KEY 里已经有对应 channel 的 instance, 跳过该 channel 不重复迁.
 */
export async function migrateLegacyVideoInstances(): Promise<{
  migrated: VideoChannelId[];
  skipped: VideoChannelId[];
}> {
  const existing = readDisk();
  const existingChannels = new Set(existing.map((e) => e.channel));
  const migrated: VideoChannelId[] = [];
  const skipped: VideoChannelId[] = [];
  const settings = readLocalSettings();
  const now = new Date().toISOString();
  const newEntries: DiskEntry[] = [];

  // Kling
  if (!existingChannels.has("kling")) {
    const ak = readDecrypted(settings, "KLING_ACCESS_KEY");
    const sk = readDecrypted(settings, "KLING_SECRET_KEY");
    if (ak && sk) {
      newEntries.push({
        id: `vmi_legacy_kling_${Date.now().toString(36)}`,
        display_name: "可灵 AI (从老配置迁入)",
        channel: "kling",
        model_id: settings.KLING_MODEL?.trim() || "kling-v2-master",
        api_base_url: settings.KLING_BASE_URL?.trim() || undefined,
        api_key_enc: encryptSettingValue(ak),
        secret_key_enc: encryptSettingValue(sk),
        created_at: now,
        updated_at: now,
      });
      migrated.push("kling");
    }
  } else skipped.push("kling");

  // Vidu
  if (!existingChannels.has("vidu")) {
    const key = readDecrypted(settings, "VIDU_API_KEY");
    if (key) {
      newEntries.push({
        id: `vmi_legacy_vidu_${Date.now().toString(36)}`,
        display_name: "Vidu (从老配置迁入)",
        channel: "vidu",
        model_id: settings.VIDU_MODEL?.trim() || "viduq3",
        api_base_url: settings.VIDU_BASE_URL?.trim() || undefined,
        api_key_enc: encryptSettingValue(key),
        created_at: now,
        updated_at: now,
      });
      migrated.push("vidu");
    }
  } else skipped.push("vidu");

  // Jimeng
  if (!existingChannels.has("jimeng")) {
    const ak = readDecrypted(settings, "JIMENG_VOLC_ACCESS_KEY");
    const sk = readDecrypted(settings, "JIMENG_VOLC_SECRET_KEY");
    if (ak && sk) {
      newEntries.push({
        id: `vmi_legacy_jimeng_${Date.now().toString(36)}`,
        display_name: "即梦 (从老配置迁入)",
        channel: "jimeng",
        model_id: settings.PROVIDER_JIMENG_VIDEO_3PRO_MODEL?.trim() || "doubao-seedance-1.0-pro",
        api_base_url: settings.JIMENG_BASE_URL?.trim() || undefined,
        api_key_enc: encryptSettingValue(ak),
        secret_key_enc: encryptSettingValue(sk),
        created_at: now,
        updated_at: now,
      });
      migrated.push("jimeng");
    }
  } else skipped.push("jimeng");

  // MiniMax
  if (!existingChannels.has("minimax")) {
    const key = readDecrypted(settings, "MINIMAX_API_KEY");
    if (key) {
      newEntries.push({
        id: `vmi_legacy_minimax_${Date.now().toString(36)}`,
        display_name: "MiniMax 海螺 (从老配置迁入)",
        channel: "minimax",
        model_id: settings.MINIMAX_VIDEO_MODEL?.trim() || "MiniMax-Hailuo-2.3",
        api_base_url: settings.MINIMAX_BASE_URL?.trim() || undefined,
        api_key_enc: encryptSettingValue(key),
        created_at: now,
        updated_at: now,
      });
      migrated.push("minimax");
    }
  } else skipped.push("minimax");

  // Aliyun Wan
  if (!existingChannels.has("aliyun_wan")) {
    const key = readDecrypted(settings, "ALIYUN_DASHSCOPE_API_KEY");
    if (key) {
      newEntries.push({
        id: `vmi_legacy_aliyun_wan_${Date.now().toString(36)}`,
        display_name: "阿里万相 (从老配置迁入)",
        channel: "aliyun_wan",
        model_id: settings.ALIYUN_WAN_MODEL?.trim() || "wan2.2-t2v-plus",
        api_base_url: settings.ALIYUN_WAN_BASE_URL?.trim() || undefined,
        api_key_enc: encryptSettingValue(key),
        region: settings.ALIYUN_WAN_REGION?.trim() || undefined,
        created_at: now,
        updated_at: now,
      });
      migrated.push("aliyun_wan");
    }
  } else skipped.push("aliyun_wan");

  // 2026-05-20 Wave T S25 — 智谱 / 百度千帆 / 腾讯混元 三个 channel 的老配置自动迁入
  // Zhipu
  if (!existingChannels.has("zhipu")) {
    const key = readDecrypted(settings, "ZHIPU_API_KEY");
    if (key) {
      newEntries.push({
        id: `vmi_legacy_zhipu_${Date.now().toString(36)}`,
        display_name: "智谱 CogVideoX (从老配置迁入)",
        channel: "zhipu",
        model_id: settings.ZHIPU_VIDEO_MODEL?.trim() || "cogvideox-3",
        api_base_url: settings.ZHIPU_BASE_URL?.trim() || undefined,
        api_key_enc: encryptSettingValue(key),
        created_at: now,
        updated_at: now,
      });
      migrated.push("zhipu");
    }
  } else skipped.push("zhipu");

  // Baidu Qianfan
  if (!existingChannels.has("baidu_qianfan")) {
    const key = readDecrypted(settings, "BAIDU_QIANFAN_API_KEY");
    if (key) {
      newEntries.push({
        id: `vmi_legacy_baidu_qianfan_${Date.now().toString(36)}`,
        display_name: "百度千帆 (从老配置迁入)",
        channel: "baidu_qianfan",
        model_id: settings.BAIDU_QIANFAN_MODEL?.trim() || "VQ3-Pro",
        api_base_url: settings.BAIDU_QIANFAN_BASE_URL?.trim() || undefined,
        api_key_enc: encryptSettingValue(key),
        created_at: now,
        updated_at: now,
      });
      migrated.push("baidu_qianfan");
    }
  } else skipped.push("baidu_qianfan");

  // Tencent Hunyuan (三段 key: secret_id 走 api_key 字段 / secret_key 走 secret_key 字段 / region)
  if (!existingChannels.has("tencent_hunyuan")) {
    const secretId = readDecrypted(settings, "TENCENT_SECRET_ID");
    const secretKey = readDecrypted(settings, "TENCENT_SECRET_KEY");
    if (secretId && secretKey) {
      newEntries.push({
        id: `vmi_legacy_tencent_hunyuan_${Date.now().toString(36)}`,
        display_name: "腾讯混元视频 (从老配置迁入)",
        channel: "tencent_hunyuan",
        model_id: settings.TENCENT_HUNYUAN_MODEL?.trim() || "HY-Video-1.5",
        api_base_url: settings.TENCENT_HUNYUAN_BASE_URL?.trim() || undefined,
        api_key_enc: encryptSettingValue(secretId),
        secret_key_enc: encryptSettingValue(secretKey),
        region: settings.TENCENT_REGION?.trim() || "ap-guangzhou",
        created_at: now,
        updated_at: now,
      });
      migrated.push("tencent_hunyuan");
    }
  } else skipped.push("tencent_hunyuan");

  if (newEntries.length > 0) {
    await writeDisk([...existing, ...newEntries]);
  }
  return { migrated, skipped };
}

/**
 * 读出 setting 字段, 自动解密 enc:v1:.
 * (sanitizeDiskSettings 已在 readLocalSettings() 里做了, 但 secret_key_enc 这种自定义字段
 *  在 STORAGE_KEY 内部, 不走 sanitize 流程, 需要这里独立解密)
 */
function readDecrypted(settings: Record<string, string>, key: string): string {
  const raw = settings[key];
  if (!raw) return "";
  if (raw.startsWith(SECRET_PREFIX)) return decryptSettingValue(raw);
  return raw;
}
