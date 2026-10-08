/**
 * effectiveVoice — Cast/Series 合并 voice 解析 (W6 2026-05-26).
 *
 * 给"series 视角下某角色合成 TTS"提供统一 voice_id 解析, 不论 voice 来自:
 *   - cast.voice_assets (新, 跨 series 共享, 优先级高)
 *   - character.voice_style_map / voice_id (老, series-local)
 *   - shot.tts_voice_override (单镜级覆盖, 最高)
 *
 * 设计原则:
 *   - 纯函数, 不读盘 (caller 一次性 readSeries + readCast + readCharacter, 复用对象 resolve N 镜)
 *   - 接受 partial 输入 — 任何环节缺失自然 fallback 下一级
 *
 * 解析优先级 (从高到低):
 *   1. shotOverride                 (shot.tts_voice_override, 单镜级)
 *   2. cast.voice_style_map[emotion]   (cast 层情绪映射)
 *   3. cast.provider_voice_ids[provider]  (cast 层 provider voice)
 *   4. character.voice_style_map[emotion]  (series-local)
 *   5. character.voice_id          (series-local 默认)
 *   6. seriesDefaultVoiceId        (系列默认)
 *   7. globalDefault               (全局兜底)
 *
 * 调用方: compose/tts.ts 的 voice resolver 直接复用本函数,
 *        避免每个调用方各自重复"cast → series → 默认"链.
 */

import type {
  Cast,
  CastVoiceAsset,
  Character,
} from "../../../../../packages/drama/src/types";

export interface ResolveVoiceInput {
  /** 当前镜的 tts_voice_override (最高优先级) */
  shotOverride?: string;
  /** 角色对象 (series-local; 拼 voice_style_map / voice_id fallback) */
  character?: Character | null;
  /** cast 对象 (W6 跨 series 共享 voice_assets) */
  cast?: Cast | null;
  /** 当前 TTS provider id (用于 cast.voice_assets.provider_voice_ids 查表) */
  provider?: string;
  /** 当前对白情绪 (如 "crying" / "angry"; 用于 voice_style_map 查表) */
  emotion?: string | null;
  /** 系列默认 voice */
  seriesDefaultVoiceId?: string;
  /** 全局默认 voice (e.g. "zh-CN-XiaoxiaoNeural") */
  globalDefault?: string;
}

export interface ResolveVoiceResult {
  voice_id: string;
  /** 决策来源 — 调试用 (前端可 toast "本镜用了 cast 层配音" 让用户知道) */
  source:
    | "shot_override"
    | "cast_style_map"
    | "cast_provider_map"
    | "character_style_map"
    | "character_voice_id"
    | "series_default"
    | "global_default";
}

function pickFromStyleMap(
  map: Record<string, string | undefined> | undefined,
  emotion?: string | null,
): string | undefined {
  if (!map) return undefined;
  if (emotion && map[emotion]) return map[emotion];
  if (map.default) return map.default;
  return undefined;
}

/**
 * 解析"这个镜头这个角色应该用什么 voice_id 合成 TTS".
 *
 * 返回 voice_id + 来源标记. voice_id 最次也会是 globalDefault (永远非空).
 */
export function resolveEffectiveVoiceForCharacter(
  input: ResolveVoiceInput,
): ResolveVoiceResult {
  // 1. 单镜级最高
  if (input.shotOverride && input.shotOverride.trim()) {
    return { voice_id: input.shotOverride.trim(), source: "shot_override" };
  }

  // 找 cast 中对应 member 的 voice asset
  let castAsset: CastVoiceAsset | undefined;
  if (input.cast?.voice_assets && input.character) {
    castAsset = input.cast.voice_assets.find(
      (v) => v.member_element_id === input.character!.id,
    );
  }

  // 2. cast 情绪映射
  if (castAsset?.voice_style_map) {
    const pick = pickFromStyleMap(castAsset.voice_style_map, input.emotion);
    if (pick) return { voice_id: pick, source: "cast_style_map" };
  }

  // 3. cast provider voice_id 查表
  if (castAsset?.provider_voice_ids && input.provider) {
    const pick = castAsset.provider_voice_ids[input.provider];
    if (pick) return { voice_id: pick, source: "cast_provider_map" };
  }

  // 4. character 情绪映射 (series-local)
  if (input.character?.voice_style_map) {
    const pick = pickFromStyleMap(
      input.character.voice_style_map as Record<string, string | undefined>,
      input.emotion,
    );
    if (pick) return { voice_id: pick, source: "character_style_map" };
  }

  // 5. character.voice_id
  if (input.character?.voice_id) {
    return { voice_id: input.character.voice_id, source: "character_voice_id" };
  }

  // 6. series default
  if (input.seriesDefaultVoiceId) {
    return { voice_id: input.seriesDefaultVoiceId, source: "series_default" };
  }

  // 7. 全局兜底
  return { voice_id: input.globalDefault || "zh-CN-XiaoxiaoNeural", source: "global_default" };
}
