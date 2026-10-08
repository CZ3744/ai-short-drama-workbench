/**
 * elementBriefDefaults — 手建素材自动补默认 image_briefs.
 *
 * 背景 (2026-05-20):
 *   batchSeries 已有 ensureBriefs(private) 逻辑: LLM 没给 briefs 时塞 1 张兜底.
 *   手建素材路径 (elementController POST /elements) 同样需要, 复用同款:
 *   - character:  2 张 (正面 + 侧面) — 角色需要多角度参考图
 *   - scene/其他: 1 张 (标准像)
 *
 * 使用规则:
 *   - 只在 image_briefs 缺失 / 空数组时塞默认值
 *   - 用户已填 briefs 时原样返回, 不覆盖
 *   - 所有默认 brief 打 auto_generated=true, 便于 UI 区分「用户填的」vs「系统默认」
 *
 * 调用方: elementController.ts (三条创建路径: character / scene / repo-kind)
 */

import type { ImageBrief } from "../../../../../packages/drama/src/types";

/**
 * 确保素材有 image_briefs — 若缺失/空则返回对应 kind 的默认列表.
 *
 * @param rawBriefs  用户传入的 briefs (可能 undefined / 空)
 * @param kind       "character" 给 2 张, 其他给 1 张
 * @param name       素材名称, 用于生成语义化 description
 * @param hint       可选补充描述 (appearance / visual_style / description 等), 丰富 description
 */
export function ensureDefaultBriefs(
  rawBriefs: ImageBrief[] | undefined,
  kind: string,
  name: string,
  hint?: string,
): ImageBrief[] {
  // 用户已填 — 原样返回, 不覆盖
  if (rawBriefs && rawBriefs.length > 0) {
    return rawBriefs;
  }

  const baseName = name.trim() || "素材";
  const hintSuffix = hint ? `，${hint.trim()}` : "";

  if (kind === "character") {
    // 角色给 2 张: 正面全身 + 侧面半身
    return [
      {
        angle: "正面",
        description: `${baseName} 正面全身标准像${hintSuffix}，清晰展示面部特征与整体造型`,
        generated: false,
        auto_generated: true,
      },
      {
        angle: "侧面",
        description: `${baseName} 侧面半身像${hintSuffix}，展示轮廓与发型细节`,
        generated: false,
        auto_generated: true,
      },
    ];
  }

  // scene / prop / wardrobe / reference / misc — 1 张标准像兜底
  return [
    {
      angle: "标准像",
      description: `${baseName} 的代表图${hintSuffix}`,
      generated: false,
      auto_generated: true,
    },
  ];
}
