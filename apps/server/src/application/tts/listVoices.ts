/**
 * listTtsVoices — 列出可用 TTS 声线
 *
 * 2026-05-17 voice-sync v1: 给 ElementWorkbench 的角色"音色"下拉用.
 *
 * 数据源:
 *   1. config/presets/tts_voice.json (curated, 中文人话名 + 性别 + style 等)
 *   2. provider.listVoices() (动态查询, 用于 preset 没覆盖到的 voice id)
 *
 * 优先级:preset 覆盖的 voice 直接用 preset 元数据; provider 动态列表里
 * preset 没覆盖的 voice_id 增量加入(降级用,只有 id, 没有中文名).
 */

import { listPresets } from "../../../../../packages/core/src/presets";
import { getRegistry } from "../../api/v2/orchestration/_shared/registry";

export interface TtsVoiceListed {
  /** preset 选项 id (UI 下拉 value 用这个; 实际 voice_id 在 voice_id 字段) */
  id: string;
  /** 传给 TTS provider.synthesize 的 voice_id */
  voice_id: string;
  /** 所属 TTS provider id */
  provider_id: string;
  /** 中文展示名 (晓晓 / 云希 / MiMo 中文女声 / ...) */
  label_zh: string;
  /** male / female / null */
  gender?: string;
  /** 风格描述 (温和亲切 / 新闻播报 / ...) */
  style?: string;
  /** zh-CN / en-US / ... */
  language?: string;
  /** 该 provider 是否需要 Key (UI 用来给未配 Key 的声线打灰) */
  requires_key?: boolean;
  /** 来源:preset (curated 中文名) 还是 provider (动态拉取) */
  source: "preset" | "provider";
}

export interface ListTtsVoicesResult {
  voices: TtsVoiceListed[];
  /** 当 provider_id 过滤时返回该 provider 的中文标签 */
  provider_label?: string;
  /** 全部已知 provider 的简表, UI 头部 chip 用 */
  providers: Array<{ id: string; label_zh: string; requires_key: boolean }>;
}

/**
 * 列出 TTS 声线, 可按 provider_id 过滤.
 *
 * @param providerIdFilter 可选: 只返回该 provider 的声线
 */
export async function listTtsVoices(
  providerIdFilter?: string,
): Promise<ListTtsVoicesResult> {
  const providerPresets = listPresets("tts_provider");
  const providerMeta = new Map<string, { label_zh: string; requires_key: boolean }>();
  const providers: Array<{ id: string; label_zh: string; requires_key: boolean }> = [];
  for (const p of providerPresets) {
    if ((p as { enabled?: boolean }).enabled === false) continue;
    const meta = {
      label_zh: (p as { label_zh?: string }).label_zh || p.id,
      requires_key: !!(p as { requires_key?: boolean }).requires_key,
    };
    providerMeta.set(p.id, meta);
    providers.push({ id: p.id, ...meta });
  }

  const voicePresets = listPresets("tts_voice");
  const voices: TtsVoiceListed[] = [];
  const seenVoiceKey = new Set<string>(); // provider_id + ":" + voice_id

  for (const vp of voicePresets) {
    const v = vp as {
      id: string;
      label_zh?: string;
      enabled?: boolean;
      provider_id?: string;
      voice_id?: string;
      gender?: string;
      style?: string;
      language?: string;
    };
    if (v.enabled === false) continue;
    if (!v.provider_id || !v.voice_id) continue;
    if (providerIdFilter && v.provider_id !== providerIdFilter) continue;
    const key = `${v.provider_id}:${v.voice_id}`;
    seenVoiceKey.add(key);
    voices.push({
      id: v.id,
      voice_id: v.voice_id,
      provider_id: v.provider_id,
      label_zh: v.label_zh || v.voice_id,
      gender: v.gender,
      style: v.style,
      language: v.language,
      requires_key: providerMeta.get(v.provider_id)?.requires_key ?? false,
      source: "preset",
    });
  }

  // 动态补充: 调指定 provider.listVoices() 拿到的 voice id 如不在 preset 里则增量加入.
  // 用 try/catch 防止 provider 未注册 / Key 缺失等基础设施问题阻塞整张列表.
  if (providerIdFilter) {
    try {
      const registry = getRegistry();
      const prov = registry.getTts(providerIdFilter);
      if (prov.listVoices) {
        const dynamic = await prov.listVoices();
        for (const dv of dynamic) {
          const key = `${providerIdFilter}:${dv.id}`;
          if (seenVoiceKey.has(key)) continue;
          seenVoiceKey.add(key);
          voices.push({
            id: dv.id,
            voice_id: dv.id,
            provider_id: providerIdFilter,
            label_zh: dv.id,
            gender: dv.gender,
            language: dv.language,
            style: dv.style,
            requires_key: providerMeta.get(providerIdFilter)?.requires_key ?? false,
            source: "provider",
          });
        }
      }
    } catch {
      // provider 不可用 → 只返 preset, UI 仍能显示 curated 声线
    }
  }

  return {
    voices,
    provider_label: providerIdFilter ? providerMeta.get(providerIdFilter)?.label_zh : undefined,
    providers,
  };
}
