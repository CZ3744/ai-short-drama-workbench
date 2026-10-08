/**
 * ttsApi — 前端 TTS 声线列表 + 试听 helper.
 *
 * 2026-05-17 voice-sync v1: 给 ElementWorkbench / SettingsPage 用.
 */

import { apiGet } from "./api";

export interface TtsVoiceListed {
  /** preset 选项 id 或 voice_id (UI 当 React key 用) */
  id: string;
  /** 实际传给后端 synthesize 的 voice_id */
  voice_id: string;
  /** 所属 TTS provider id */
  provider_id: string;
  /** 中文展示名 (晓晓 / 云希 / MiMo 中文女声 ...) */
  label_zh: string;
  gender?: string;
  style?: string;
  language?: string;
  /** 该 provider 是否需要 Key (UI 给未配 Key 的声线打灰提示) */
  requires_key?: boolean;
  source: "preset" | "provider";
}

export interface ListTtsVoicesResult {
  voices: TtsVoiceListed[];
  provider_label?: string;
  providers: Array<{ id: string; label_zh: string; requires_key: boolean }>;
}

/** 列出可用声线 (按 provider_id 可选过滤) */
export async function listTtsVoices(providerId?: string): Promise<ListTtsVoicesResult> {
  const url = providerId
    ? `/api/v2/tts/voices?provider_id=${encodeURIComponent(providerId)}`
    : "/api/v2/tts/voices";
  return apiGet<ListTtsVoicesResult>(url);
}

/**
 * 试听某个 voice — 后端合成 1 秒样本返回 audio buffer.
 *
 * 注意:这里直接走 fetch (不走 apiPost),因为返回是 audio blob 不是 JSON.
 * 失败时后端返 JSON,我们解析 error.message 当 toC msg 抛出.
 */
export async function previewTtsVoice(opts: {
  voice_id: string;
  text: string;
  provider_id?: string;
}): Promise<Blob> {
  const resp = await fetch("/api/v2/tts/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!resp.ok) {
    let msg = `TTS 试听失败 (HTTP ${resp.status})`;
    try {
      const errBody = await resp.json();
      if (errBody?.error?.message) {
        msg = errBody.error.message;
      } else if (errBody?.errors) {
        msg = `参数错误: ${JSON.stringify(errBody.errors)}`;
      }
    } catch {
      /* response 不是 JSON, 用默认 msg */
    }
    throw new Error(msg);
  }
  return await resp.blob();
}
