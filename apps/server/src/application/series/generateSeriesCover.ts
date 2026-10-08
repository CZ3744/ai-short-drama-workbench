/**
 * generateSeriesCover.ts — 系列级封面图生成(2026-05-21).
 *
 * 历史: 首页 StudioHome 卡片只用 coverFor(slug) 6 套 CSS 渐变, 没有真图.
 * 用户问"首页项目的封面图在哪里生成?或者加上这个功能" → 加这个 use case.
 *
 * 流程(对齐 episodeUseCases.generateCover, 但语境是"整部剧"而非某一集):
 *   1. 读 series 拿 title / synopsis / defaults / 主角色信息
 *   2. buildCoverImagePrompt(ctx) — 编译可审核的图像创作说明
 *      (系列标题、简介、视觉风格与主要人物都直接进入生图提示词)
 *   3. generateImagesWithProvider 走付费 image provider 拿 buffer (1080x1920 竖屏)
 *   4. saveToVault(context.kind="mood_board", tags=["series_cover","generated"])
 *   5. updateSeries 写 cover_vault_id / cover_prompt_snapshot / cover_provider_id
 *   6. 返回 vault_id + url
 *
 * 红线 (与 episode 版同款):
 *   - 必须 provider_id (override 或 series.defaults.image_provider_id), 否则 HTTP 400
 *   - 失败不 silent fallback 到 local_card_image, 用户付费选 AI 模型, 失败必须返失败
 *   - prompt 落盘到 prompts/ 目录给用户审计 / 重新生成
 */

import path from "node:path";
import { writeJson, ensureDir, DATA_ROOT } from "../../../../../packages/core/src/index";
import { loggerSync, logProviderCall, scrubForClient } from "../../../../../packages/core/src/logger";
import { getRegistry } from "../../api/v2/orchestration/_shared/registry";
import { saveToVault } from "../../../../../packages/library/src/assetVault";
import { readSeries, updateSeries, listCharacters } from "../../api/v2/seriesStore";
import { validate, GenerateCoverSchema } from "../../api/v2/validators";
import { generateImagesWithProvider } from "../generation/imageGenerationService";
import { buildCoverImagePrompt } from "../generation/coverPrompt";

export interface GenerateSeriesCoverInput {
  slug: string;
  body: unknown;
}

export type GenerateSeriesCoverResult =
  | { kind: "json"; body: Record<string, unknown> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "validation"; status: number; errors: unknown };

export async function generateSeriesCover(
  input: GenerateSeriesCoverInput,
  deps: { requestId?: string; preview?: boolean } = {},
): Promise<GenerateSeriesCoverResult> {
  const v = validate(GenerateCoverSchema, input.body);
  if (!v.ok) return { kind: "validation", status: v.status, errors: v.errors };

  const series = await readSeries(input.slug);
  if (!series) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: "系列不存在" } },
    };
  }

  const defaults = (series.defaults ?? {}) as Record<string, any>;

  // provider 必选 — 跟 episodeUseCases 红线一致, 不允许 silent fallback
  const imageProviderId =
    v.data.provider_override ||
    (typeof defaults.image_provider_id === "string" && defaults.image_provider_id.trim()
      ? defaults.image_provider_id
      : "");
  if (!imageProviderId && !deps.preview) {
    return {
      kind: "error",
      status: 400,
      body: {
        error: {
          code: "provider_not_selected",
          message: "请先选择图像模型，或在设置中配置默认图像模型",
        },
      },
    };
  }

  if (v.data.reference_shot_id) {
    return { kind: "error", status: 400, body: { error: { code: "InvalidReference", message: "系列封面暂不支持分镜参考图，请在对应分集生成封面" } } };
  }

  // 收集主要人物，供封面创作说明使用。
  let keyCharactersText = "";
  try {
    const characters = await listCharacters(input.slug);
    // 取前 3 个主角 / 配角作 prompt 关键人物
    // 2026-05-28 audit P1 — Character interface 没声明 _deleted ad-hoc 字段, 走 unknown narrowing
    const mainCharacters = characters
      .filter((c) => !(c as unknown as { _deleted?: boolean })._deleted)
      .slice(0, 3);
    keyCharactersText = mainCharacters
      .map((c) => `${c.name}(${c.role || "角色"})`)
      .join("、");
  } catch (err) {
    loggerSync().warn(
      "[series-cover] listCharacters failed (continuing with empty key_characters):",
      err instanceof Error ? err.message : err,
    );
  }

  const ctx: Record<string, any> = {
    // 系列级上下文：用系列标题与简介，不指定单集。
    series_title: series.title,
    series_synopsis: series.synopsis || "",
    // 共用图像创作说明，系列封面省略重复的分集信息。
    episode_title: series.title,
    episode_index: 1,
    episode_synopsis: series.synopsis || "",
    content_type_phrase: defaults.content_type || "短剧",
    visual_style_phrase: v.data.style || defaults.visual_style || "cinematic",
    platform_phrase: defaults.platform || "B站",
    aspect_ratio: "9:16",
    key_characters: keyCharactersText,
    key_scene: "",
  };

  let promptText = buildCoverImagePrompt(ctx);

  if (v.data.title_text) promptText += `\n\n封面标题文字：${v.data.title_text}`;
  if (v.data.prompt_override !== undefined) promptText = v.data.prompt_override;
  // Preview has no provider/network calls, snapshot writes, or cover mutations.
  if (deps.preview) {
    return { kind: "json", body: { ok: true, prompt: promptText, reference_images: [], width: 1080, height: 1920, provider_id: imageProviderId } };
  }

  // prompt 落盘审计 (series-level prompts 目录跟 episode 平行)
  const promptsDir = path.join(DATA_ROOT, "series", input.slug, "prompts");
  await ensureDir(promptsDir);
  const ts = Date.now();
  const promptSnapshot = `${ts}_cover_designer.json`;
  await writeJson(path.join(promptsDir, promptSnapshot), { prompt: promptText, context: ctx });

  const registry = getRegistry();
  const startMs = Date.now();
  let providerIdUsed = imageProviderId;
  let images: Array<{ buffer: Buffer; mime: string; width: number; height: number }> = [];

  try {
    const result = await generateImagesWithProvider(
      {
        provider_id: imageProviderId,
        prompt: promptText,
        width: 1080,
        height: 1920,
        count: 1,
        series_slug: input.slug,
      },
      { registry },
    );
    providerIdUsed = result.provider_id;
    images = result.images || [];
    logProviderCall({
      requestId: deps.requestId,
      providerId: imageProviderId,
      kind: "image",
      durationMs: Date.now() - startMs,
      success: true,
      meta: { purpose: "series_cover_gen", series_slug: input.slug },
    }).catch((e) => loggerSync().warn("[series-cover] logProviderCall failed:", (e as Error)?.message ?? e));
  } catch (err) {
    loggerSync().warn(
      `[series-cover] provider ${imageProviderId} failed:`,
      err instanceof Error ? err.message : err,
    );
    logProviderCall({
      requestId: deps.requestId,
      providerId: imageProviderId,
      kind: "image",
      durationMs: Date.now() - startMs,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      meta: { purpose: "series_cover_gen", series_slug: input.slug },
    }).catch((e) => loggerSync().warn("[series-cover] logProviderCall failed:", (e as Error)?.message ?? e));
    return {
      kind: "error",
      status: 502,
      body: {
        error: {
          code: "GenerationFailed",
          message: `封面生成失败: ${scrubForClient(err instanceof Error ? err.message : "图像服务调用异常")}`,
        },
        prompt_snapshot: promptSnapshot,
      },
    };
  }

  if (images.length === 0) {
    return {
      kind: "error",
      status: 502,
      body: {
        error: {
          code: "GenerationFailed",
          message: "封面生成失败：图像服务未返回有效图片，请重试或更换模型",
        },
        prompt_snapshot: promptSnapshot,
      },
    };
  }

  const img = images[0];
  const vaultEntry = await saveToVault({
    buffer: img.buffer,
    kind: "image",
    mime: img.mime || "image/png",
    width: img.width || 1080,
    height: img.height || 1920,
    provider_id: providerIdUsed,
    context: {
      kind: "mood_board",
      series_slug: input.slug,
      prompt_digest_sha256: "",
    },
    tags: ["series_cover", "generated"],
  });

  // 写到 series.json — cover_vault_id 给 StudioHome 卡片读
  await updateSeries(input.slug, {
    cover_vault_id: vaultEntry.vault_id,
    cover_prompt_snapshot: promptSnapshot,
    cover_provider_id: providerIdUsed,
  });

  return {
    kind: "json",
    body: {
      ok: true,
      vault_id: vaultEntry.vault_id,
      url: `/api/v2/vault/${vaultEntry.vault_id}/raw`,
      width: vaultEntry.width,
      height: vaultEntry.height,
      provider_used: providerIdUsed,
      prompt_snapshot: promptSnapshot,
    },
  };
}
