/**
 * planStoryboard 模块共享工具 — image_overrides 解析 + 图清单格式化 + shot type 归一化。
 *
 * planEpisodeStoryboard / planSeriesStoryboard / batchSeries / persistStoryboard 四路共享。
 *
 * Wave Z-6: shot type normalization 从 planEpisodeStoryboard.ts 移入, 供 persistStoryboard.ts 复用.
 */

/**
 * 2026-05-21 X-2 共享 helper — 给 LLM 看到每个 element 的"已有图清单",让它在分镜里
 * 用 `@角色名.img:image_id` 长格式或 `image_overrides` 数组精确指定某张图。
 *
 * 三处 caller 必须用这个函数 (保证 LLM 看到的内容 + 用户预览看到的内容一致):
 *   1. planEpisodeStoryboard.ts(集级一键)
 *   2. planSeriesStoryboard.ts(系列级一键) — V-37
 *   3. preview/previewPrompts.ts(查看完整提示词) — V-38
 */
export function formatImagesHint(opts: {
  refImageIds?: string[];
  // 2026-05-28 audit P1: 放宽 — Character/Scene.ref_image_meta 都带额外字段 (prompt_snapshot / origin
  // 等), 只用 display_name 就够, 用 readonly Partial 让 caller 不用强转.
  refImageMeta?: Record<string, { display_name?: string; [key: string]: unknown }>;
  images?: Array<{ image_id: string; display_name?: string; available_for_shot?: boolean; is_typical?: boolean }>;
  imageBriefs?: Array<{ angle?: string; image_id?: string }>;
  primaryId?: string;
}): string {
  const parts: string[] = [];
  if (opts.images?.length) {
    const briefByImageId = new Map<string, string>();
    for (const b of opts.imageBriefs ?? []) {
      if (b.image_id && b.angle) briefByImageId.set(b.image_id, b.angle);
    }
    for (let i = 0; i < opts.images.length; i++) {
      const im = opts.images[i];
      if (im.available_for_shot === false) continue;
      const label = im.display_name?.trim() || briefByImageId.get(im.image_id) || `第${i + 1}张`;
      const flags = [
        opts.primaryId && im.image_id === opts.primaryId ? "*主图" : "",
        im.is_typical ? "★典型" : "",
      ].filter(Boolean).join("");
      parts.push(`${im.image_id}=${label}${flags ? `[${flags}]` : ""}`);
    }
  } else if (opts.refImageIds?.length) {
    for (let i = 0; i < opts.refImageIds.length; i++) {
      const id = opts.refImageIds[i];
      const meta = opts.refImageMeta?.[id];
      const label = meta?.display_name?.trim() || `第${i + 1}张`;
      const flag = opts.primaryId === id ? "*主图" : "";
      parts.push(`${id}=${label}${flag ? `[${flag}]` : ""}`);
    }
  }
  if (parts.length === 0) return "";
  return `\n  已有图(可在 action/prompt_img 用 @角色名.img:id 精确指定): ${parts.join(", ")}`;
}

/**
 * 解析 LLM 输出的 image_overrides → shot.reference_overrides。
 *
 * 两路输入合并(取 union):
 *   A. LLM 输出的 image_overrides 显式数组 (ShotPlanSchema 字段)
 *   B. mention 长格式 `@角色:林深.img:asset_xxx` (mentionParser 已解析 imageId)
 *
 * @param shot — LLM 输出的 shot 对象(至少带可选的 image_overrides 数组)
 * @param nameMaps — element / character / scene 的 name→id 映射
 * @param mentionTokens — 可选, mentionParser 解析后的 token 列表(含 imageId 的)
 */
export function resolveReferenceOverrides(
  shot: { image_overrides?: Array<{ element_id: string; image_id: string; reason?: string }> },
  nameMaps: {
    elementNameToId: Map<string, string>;
    characterNameToId: Map<string, string>;
    sceneNameToId: Map<string, string>;
  },
  mentionTokens?: Array<{ kind: string; name: string; imageId?: string }>,
): Array<{ element_id: string; image_id: string }> {
  const { elementNameToId, characterNameToId, sceneNameToId } = nameMaps;
  const referenceOverrides: Array<{ element_id: string; image_id: string }> = [];

  // ── 路径 A: LLM 输出 image_overrides 显式数组 ──
  const sImageOverrides = shot.image_overrides;
  if (sImageOverrides?.length) {
    for (const ov of sImageOverrides) {
      const rawElementId = (ov.element_id || "").trim();
      const rawImageId = (ov.image_id || "").trim();
      if (!rawElementId || !rawImageId) continue;
      const elemId =
        elementNameToId.get(rawElementId) ??
        elementNameToId.get(rawElementId.toLowerCase()) ??
        characterNameToId.get(rawElementId) ??
        characterNameToId.get(rawElementId.toLowerCase()) ??
        sceneNameToId.get(rawElementId) ??
        sceneNameToId.get(rawElementId.toLowerCase()) ??
        rawElementId; // 找不到就透传(可能用户直接给了 id)
      if (!referenceOverrides.some((o) => o.element_id === elemId)) {
        referenceOverrides.push({ element_id: elemId, image_id: rawImageId });
      }
    }
  }

  // ── 路径 B: mention 长格式 @角色:林深.img:asset_xxx ──
  if (mentionTokens?.length) {
    for (const tok of mentionTokens) {
      if (!tok.imageId) continue;
      const elemId =
        tok.kind === "character"
          ? (characterNameToId.get(tok.name) ?? characterNameToId.get(tok.name.toLowerCase()))
          : tok.kind === "scene"
            ? (sceneNameToId.get(tok.name) ?? sceneNameToId.get(tok.name.toLowerCase()))
            : (elementNameToId.get(tok.name) ?? elementNameToId.get(tok.name.toLowerCase()));
      if (!elemId) continue;
      if (referenceOverrides.some((o) => o.element_id === elemId)) continue; // 路径 A 已有的 skip
      referenceOverrides.push({ element_id: elemId, image_id: tok.imageId });
    }
  }

  return referenceOverrides;
}

// ═══════════════════════════════════════════════════════════════════
// Shot type normalization (Wave Z-6: 从 planEpisodeStoryboard.ts 移入)
// ═══════════════════════════════════════════════════════════════════

import { loggerSync as _log } from "../../../../../packages/core/src/logger";
import type { ShotPlanSchema } from "../../api/v2/orchestration/_shared/schemas";
import { z } from "zod";

export const SHOT_TYPE_PRESET_VALUES = new Set([
  "extreme_close_up",
  "close_up",
  "medium_close_up",
  "medium_shot",
  "cowboy_shot",
  "medium_long_shot",
  "long_shot",
  "wide_shot",
  "extreme_wide_shot",
  "establishing",
  "over_the_shoulder",
  "two_shot",
  "insert",
  "pov",
  "reaction",
  "extreme_close",
  "medium",
  "full_shot",
  "extreme_long",
  "top_down",
  "low_angle",
]);

export const SHOT_TYPE_ALIASES: Record<string, string> = {
  "close-up": "close_up",
  "close up": "close_up",
  closeup: "close_up",
  "medium shot": "medium",
  "wide shot": "wide_shot",
  wide: "wide_shot",
  "long shot": "long_shot",
  long: "long_shot",
  "full shot": "full_shot",
  "extreme close-up": "extreme_close_up",
  "extreme close up": "extreme_close_up",
  "extreme wide shot": "extreme_wide_shot",
  "establishing shot": "establishing",
  "over shoulder": "over_the_shoulder",
  "over-the-shoulder": "over_the_shoulder",
  "two shot": "two_shot",
  "top down": "top_down",
  "bird eye": "top_down",
  "bird's eye": "top_down",
  "birds eye": "top_down",
};

export function normalizeShotType(raw: string | undefined | null, context: string): string {
  const trimmed = String(raw ?? "").trim();
  const snake = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  const aliasKey = trimmed.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
  const normalized = SHOT_TYPE_ALIASES[aliasKey] ?? snake;
  if (SHOT_TYPE_PRESET_VALUES.has(trimmed)) return trimmed;
  if (SHOT_TYPE_PRESET_VALUES.has(normalized)) return normalized;
  _log().warn(
    `[plan-storyboard][shot-type] ${context} shot_type="${trimmed || "(空)"}" 不在预设枚举内, fallback 到 "medium"`,
  );
  return "medium";
}

export function normalizeShotPlanShotTypes(
  shots: z.infer<typeof ShotPlanSchema>,
  source: string,
): z.infer<typeof ShotPlanSchema> {
  return shots.map((shot, index) => ({
    ...shot,
    shot_type: normalizeShotType(shot.shot_type, `${source}#${index + 1}`),
  }));
}
