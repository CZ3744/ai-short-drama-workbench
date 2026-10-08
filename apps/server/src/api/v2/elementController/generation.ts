/**
 * Element generation endpoints — compile-prompt / generate-image / dry-run / autofill.
 *
 * 2026-05-21 P1 拆分: 抽自 elementController.ts §"图片: 导入 / 编译提示词 / 生图"
 * 和 §"LLM 智能填表 (autofill-from-text)" 两段, 实现与原文件一字不差.
 */

import { Router } from "express";
import { clientDisconnectSignal } from "../../../middleware/clientDisconnectSignal";
import type {
  ElementData,
  ElementImage,
} from "../../../repositories/elementRepo";
import { seriesExists } from "../../../repositories/elementRepo";
import { readSeries } from "../seriesStore";
import { getRegistry } from "../orchestrationController";
import { generateImagesForTarget } from "../../../application/generation/imageGenerationOrchestrator";
import { buildImageDryRunResult } from "../../../application/generation/imageDryRun";
import {
  compileImagePrompt,
  buildLlmPolishMessages,
  defaultNegativePrompt,
  type CompileImagePromptInput,
  type AssetElementKind,
} from "../../../application/generation/assetPromptCompiler";
import {
  autofillElementFromText,
  buildAutofillPrompt,
  type ElementKind as AutofillKind,
} from "../../../application/element/elementAutofill";
import { scrubForClient } from "../../../../../../packages/core/src/logger";
import { readAnyElement } from "../elementController.helpers";
import { callLlmPolish, err } from "./_shared";
import { assertProviderSelectedOrErr } from "../validateHelpers";

export const generationRouter = Router();

// ─── helper: 拼 element → CompileImagePromptInput ─────────────────────
function buildCompileInput(el: ElementData, body: any, baseImage?: ElementImage): CompileImagePromptInput {
  const i2i = baseImage
    ? {
        based_on_note: baseImage.note || baseImage.prompt_snapshot?.slice(0, 120) || "已有素材图",
        modification: typeof body.user_instruction === "string" ? body.user_instruction : "",
      }
    : undefined;
  return {
    element_kind: el.kind as AssetElementKind,
    element_name: el.name,
    element_description: el.description,
    element_tags: el.tags.map((t) => ({ axis: t.axis, value: t.value })),
    user_instruction: !baseImage && typeof body.user_instruction === "string" ? body.user_instruction : "",
    i2i: i2i && i2i.modification.trim() ? i2i : undefined,
    aspect_hint: typeof body.aspect_hint === "string" ? body.aspect_hint : "竖屏 9:16 短剧画幅",
    extra_negative: typeof body.extra_negative === "string" ? body.extra_negative : undefined,
  };
}

// POST /series/:slug/elements/:id/compile-prompt — 编译/润色提示词 (不生图)
// body: { user_instruction?, i2i_base_image_id?, llm_model_ref?, polish?, aspect_hint?, extra_negative? }
generationRouter.post("/series/:slug/elements/:id/compile-prompt", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const el = await readAnyElement(slug, id);
    if (!el) return err(res, 404, "NotFound", `素材 ${id} 不存在`);
    const body = req.body ?? {};

    let baseImage: ElementImage | undefined;
    if (typeof body.i2i_base_image_id === "string" && body.i2i_base_image_id) {
      baseImage = el.images.find((im) => im.image_id === body.i2i_base_image_id);
      if (!baseImage) return err(res, 404, "NotFound", `参考图 ${body.i2i_base_image_id} 不在该素材图库`);
    }

    const compileInput = buildCompileInput(el, body, baseImage);
    const template = compileImagePrompt(compileInput);

    // polish=true 且配了文字模型 → 调 LLM 润色; 否则用纯模板结果
    let fullPrompt = template.full_prompt;
    let polished = false;
    let polishError: string | undefined;
    if (body.polish === true) {
      try {
        const msgs = buildLlmPolishMessages(compileInput);
        const text = await callLlmPolish(msgs.system, msgs.user, body.llm_model_ref);
        if (text) { fullPrompt = text; polished = true; }
      } catch (e) {
        polishError = e instanceof Error ? e.message : String(e);
      }
    }

    res.json({
      ok: true,
      full_prompt: fullPrompt,
      negative_prompt: template.negative_prompt,
      segments: template.segments,
      is_i2i: template.is_i2i,
      polished,
      polish_error: polishError,
    });
  } catch (e) { next(e); }
});

// POST /series/:slug/elements/:id/generate-image — 生图 (PM: 提示词自包含, 累加候选)
// body: { full_prompt, negative_prompt?, image_model_ref?, count?, i2i_base_image_id?, width?, height? }
//
// W8 Phase 1 解耦 (2026-05-16): 53 行 post-处理已抽到 imageGenerationOrchestrator +
// elementAdapter, 这里只剩 input 校验 + 调 orchestrator + 拼 response. 保留 response
// 字段名(element/images/provider_id/cost/prompt_snapshot)给前端零感知.
generationRouter.post("/series/:slug/elements/:id/generate-image", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const el = await readAnyElement(slug, id);
    if (!el) return err(res, 404, "NotFound", `素材 ${id} 不存在`);
    const body = req.body ?? {};

    // W8-nightly: 不再 silent fallback 到 local_card_image。
    // B-P0-2 (2026-06-01): 统一走 assertProviderSelectedOrErr — 同时检查 default_image
    // (新建系列字段) 和 image_provider_id (旧字段), 行为与原实现完全一致。
    const requestedProvider = typeof body.image_model_ref === "string" ? body.image_model_ref.trim() : "";
    if (await assertProviderSelectedOrErr(res, "image", requestedProvider, null, slug)) return;
    // seriesDefault 供下方 generateImagesForTarget 的 default_provider_id 兜底 (series 已验证非空)
    const seriesForGenerate = await readSeries(slug);
    const seriesDefault =
      ((seriesForGenerate?.defaults as Record<string, any>)?.default_image?.trim?.())
      || seriesForGenerate?.defaults?.image_provider_id?.trim()
      || "";

    // full_prompt 必须由调用方提供 (前端要么用 compile-prompt 的结果, 要么用户在审核弹窗改过的);
    // 没传就现编一个 (保证「提示词自包含」永远成立).
    let fullPrompt = typeof body.full_prompt === "string" ? body.full_prompt.trim() : "";
    if (!fullPrompt) {
      fullPrompt = compileImagePrompt(buildCompileInput(el, body)).full_prompt;
    }
    const negativePrompt =
      typeof body.negative_prompt === "string" && body.negative_prompt.trim()
        ? body.negative_prompt.trim()
        : defaultNegativePrompt();

    // i2i 参考图 + 2026-05-19 #8: 自动累积当前 element 自身已有的 typical/primary 图
    // 用户原话:"n+1 次生图要连接前 n 次的生图或者主图,保证多张参考图五官统一"
    // 行为: 用户显式 i2i_base_image_id 永远第一优先级; 其余 typical/primary 图自动加入,
    //       去重 + 总上限 8 张防止 prompt 爆
    let baseImage: ElementImage | undefined;
    const referenceImages: Array<{ vault_id?: string; asset_id?: string }> = [];
    const seenIds = new Set<string>(); // 去重 (image_id)
    function pushRef(im: ElementImage) {
      if (seenIds.has(im.image_id)) return;
      if (referenceImages.length >= 8) return;
      seenIds.add(im.image_id);
      if (im.vault_id) referenceImages.push({ vault_id: im.vault_id });
      else if (im.asset_id) referenceImages.push({ asset_id: im.asset_id });
    }
    // 1) 用户显式 i2i_base
    if (typeof body.i2i_base_image_id === "string" && body.i2i_base_image_id) {
      baseImage = el.images.find((im) => im.image_id === body.i2i_base_image_id);
      if (!baseImage) return err(res, 404, "NotFound", `参考图 ${body.i2i_base_image_id} 不在该素材图库`);
      pushRef(baseImage);
    }
    // 2) 当前 element 自身已有的 typical 图(代表图,is_typical=true)— 自动接续
    //    用户没指定时,这些图自动作 reference 让模型保持五官/外形一致
    //    auto_chain_self_refs=false 时可显式禁用(批量重抽场景下可能不希望串联)
    const autoChainSelfRefs = body.auto_chain_self_refs !== false;
    if (autoChainSelfRefs) {
      const typicalImages = el.images.filter((im) => im.is_typical === true);
      for (const im of typicalImages) pushRef(im);
      // 3) 没 typical 时 fallback 到 primary 图
      if (typicalImages.length === 0 && el.primary_image_id) {
        const primary = el.images.find((im) => im.image_id === el.primary_image_id);
        if (primary) pushRef(primary);
      }
    }

    const count = Math.max(1, Math.min(Math.round(Number(body.count) || 1), 32));
    // 2026-05-20 Wave T Phase 5 — caller 传 image_brief_id 时, 反查 brief.angle 作落盘 display_name.
    //   用户在 ElementWorkbench 抽某个 brief (例如"标准像"/"伸手抢夺") 时, 落盘后该图就叫 brief.angle,
    //   不再是 "{element.name} #N" 通用兜底. 提升素材库辨识度.
    let briefAngle: string | undefined;
    if (typeof body.image_brief_id === "string" && body.image_brief_id.trim()) {
      const briefId = body.image_brief_id.trim();
      const brief = (el.image_briefs ?? []).find((b: any) => b.id === briefId || b.image_id === briefId);
      if (brief?.angle && typeof brief.angle === "string") briefAngle = brief.angle.trim() || undefined;
    }
    // orchestrator 一次调用最多 count 张; 内部 service 自己再切批次. 老逻辑里"16 张分批"
    // 已经在 imageGenerationService 内置(Math.min(count, 16)). 这里直接传完整 count.
    const result = await generateImagesForTarget(
      {
        prompt: fullPrompt,
        negative_prompt: negativePrompt,
        provider_id: requestedProvider || undefined,
        model_ref: requestedProvider || undefined,
        width: Number(body.width) || 1024,
        height: Number(body.height) || 1024,
        count,
        reference_images: referenceImages.length ? referenceImages : undefined,
        strict_reference_images: false,
        default_provider_id: seriesDefault || undefined,
        target: {
          kind: "element",
          series_slug: slug,
          target_id: id,
          meta: {
            element_kind: el.kind,
            element_name: el.name,
            // Phase 5: 透传 brief.angle 到 elementAdapter, 作落盘 display_name
            brief_angle: briefAngle,
          },
        },
        i2i_base: baseImage
          ? { image_id: baseImage.image_id, note: baseImage.note }
          : undefined,
      },
      { registry: getRegistry() },
    );

    // result.images = adapter 写盘 + addAnyElementImage 后的 PersistedImage[].
    // 给前端的 ElementImage[] 由 readAnyElement(target_state) 派生.
    const elementState = result.target_state as ElementData | null;
    // 仅返回本次新加的 N 张 (取 element.images 尾部 N 个, 严格按 result.images 顺序对齐).
    const newImages: ElementImage[] = elementState
      ? elementState.images.slice(-result.images.length)
      : [];

    res.json({
      ok: true,
      provider_id: result.provider_id,
      images: newImages,
      element: elementState,
      cost: result.cost,
      prompt_snapshot: fullPrompt,
    });
  } catch (e) { next(e); }
});

// POST /series/:slug/elements/:id/generate-image/dry-run — 批次 4.3 dry-run 预览
// 不调 provider, 不扣费. 返回打包 request + 估费, 供前端在批量抽卡前给用户审阅.
// body: { full_prompt?, negative_prompt?, image_model_ref?, count?, i2i_base_image_id?, width?, height? }
// response: { ok, dry_run, provider_id, model_id, key_present, request_preview, full_prompt_preview,
//             estimated_cost_cny, count, message }
// key_missing → HTTP 400 + { ok: false, error: "key_missing", provider_id, ... }
generationRouter.post("/series/:slug/elements/:id/generate-image/dry-run", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    const el = await readAnyElement(slug, id);
    if (!el) return err(res, 404, "NotFound", `素材 ${id} 不存在`);
    const body = req.body ?? {};

    // W8-nightly: dry-run 也不再 silent fallback 到 local_card_image。
    // B-P0-2 (2026-06-01): 统一走 assertProviderSelectedOrErr — 修复此路径原来只查
    // image_provider_id 漏查 default_image (新建系列字段) 的 bug。
    const requestedProvider = typeof body.image_model_ref === "string" ? body.image_model_ref.trim() : "";
    if (await assertProviderSelectedOrErr(res, "image", requestedProvider, null, slug)) return;

    // 复用 generate-image 的 prompt 拼装逻辑
    let fullPrompt = typeof body.full_prompt === "string" ? body.full_prompt.trim() : "";
    if (!fullPrompt) {
      fullPrompt = compileImagePrompt(buildCompileInput(el, body)).full_prompt;
    }

    // i2i 参考图 — 仅用于标记 has_reference_images (dry-run 不解 buffer)
    let hasReferenceImages = false;
    if (typeof body.i2i_base_image_id === "string" && body.i2i_base_image_id) {
      const baseImage = el.images.find((im) => im.image_id === body.i2i_base_image_id);
      if (!baseImage) return err(res, 404, "NotFound", `参考图 ${body.i2i_base_image_id} 不在该素材图库`);
      hasReferenceImages = true;
    }

    // W7-sweep (2026-05-16): 不再传 default_provider_id: "local_card_image" — 红线 #1。
    // 上面已 400 拦掉空 provider 路径,这里把 series.defaults 也传下去(helper 三层都空会 throw)。
    const seriesForDryRun = await readSeries(slug);
    const defaultImageProvider = seriesForDryRun?.defaults?.image_provider_id?.trim() || undefined;
    const result = buildImageDryRunResult(
      {
        model_ref: typeof body.image_model_ref === "string" ? body.image_model_ref : undefined,
        prompt: fullPrompt,
        negative_prompt: typeof body.negative_prompt === "string" ? body.negative_prompt : undefined,
        count: Number(body.count) || 1,
        width: Number(body.width) || 1024,
        height: Number(body.height) || 1024,
        has_reference_images: hasReferenceImages,
      },
      { registry: getRegistry(), default_provider_id: defaultImageProvider },
    );

    if (result.error === "key_missing") {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════════
// 2026-05-19 反馈 #2: LLM 智能填表 (autofill-from-text)
// ═══════════════════════════════════════════════════════════════════
//
// 用户原话:"素材创作界面也要允许做一个基于用户输入生成角色详情 json 的功能,
// 我直接在左上角的用户输入的聊天框输入我想要这个角色的简介..."
//
// 复用:
//   - 复用 tryWithFallback chain (同 plan-storyboard 风格)
//   - 复用 parseJsonFromLlm 容错 markdown 代码块
//   - 复用 scrubForClient 错误透传
//   - buildAutofillPrompt 同时给 preview-prompt 端点用 (单一 source of truth)
//
// 不接 element_id — 因为前端有两种使用场景:
//   1) 编辑既有素材时智能填 (有 id, 但服务不需要落盘, 前端拿到 fields 自己 patchElement)
//   2) 新建素材时预填 (尚无 id) → 用 kind 而非 id 寻路, 更通用

const AUTOFILL_KINDS: readonly AutofillKind[] = [
  "character",
  "scene",
  "prop",
  "wardrobe",
  "reference",
  "misc",
];

function isAutofillKind(kind: string): kind is AutofillKind {
  return (AUTOFILL_KINDS as readonly string[]).includes(kind);
}

// POST /series/:slug/elements/:elementKind/autofill-from-text
// body: { raw_text: string, model_ref?: string }
generationRouter.post("/series/:slug/elements/:elementKind/autofill-from-text", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const elementKind = String(req.params.elementKind);
    const body = req.body ?? {};
    const rawText = typeof body.raw_text === "string" ? body.raw_text : "";
    const modelRef = typeof body.model_ref === "string" ? body.model_ref : undefined;

    // zod 校验 (轻量内联, 不引第三方避免循环 import)
    if (!isAutofillKind(elementKind)) {
      return err(res, 400, "invalid_request", `不支持的素材类型: ${elementKind} (允许: ${AUTOFILL_KINDS.join(", ")})`);
    }
    if (!rawText || rawText.trim().length === 0) {
      return err(res, 400, "invalid_request", "raw_text 必填 — 请先在文字描述框输入内容");
    }
    if (rawText.length > 4000) {
      return err(res, 400, "invalid_request", "raw_text 过长 (>4000 字), 请精简描述");
    }
    if (!(await seriesExists(slug))) {
      return err(res, 404, "NotFound", `系列 ${slug} 不存在`);
    }

    const result = await autofillElementFromText({
      slug,
      elementKind,
      rawText,
      model_ref: modelRef,
      requestId: req.requestId,
      // 2026-05-20 P1 铁律 #1: 透传 req.signal — 客户端断开能真 abort LLM autofill
      signal: clientDisconnectSignal(req, res),
    });

    res.json({
      ok: true,
      fields: result.fields,
      provider_id: result.provider_id,
      raw_llm_output: result.raw_llm_output,
      prompt_used: result.prompt_used,
    });
  } catch (e) {
    // 错误透传走 scrubForClient (CLAUDE.md 安全设计点 — 过滤 Bearer / api-key 等敏感串)
    const msg = e instanceof Error ? e.message : String(e);
    const scrubbed = scrubForClient(msg);
    // LLM provider 类失败 → 502 (上游错), 校验失败已在前面 400.
    res.status(502).json({ error: { code: "AutofillFailed", message: scrubbed } });
  }
});

// GET /series/:slug/elements/:elementKind/autofill-from-text/preview-prompt?raw_text=...
// 给前端 "复制完整提示词" 按钮用 — 不调 LLM, 零成本, 仅返回拼好的 prompt 字符串.
// 与真生成走的是同一份 buildAutofillPrompt, 保证用户复制的 prompt 与系统真发送的一字不差.
generationRouter.get("/series/:slug/elements/:elementKind/autofill-from-text/preview-prompt", async (req, res, next) => {
  try {
    const elementKind = String(req.params.elementKind);
    const rawText = typeof req.query.raw_text === "string" ? req.query.raw_text : "";

    if (!isAutofillKind(elementKind)) {
      return err(res, 400, "invalid_request", `不支持的素材类型: ${elementKind}`);
    }
    if (!rawText || rawText.trim().length === 0) {
      return err(res, 400, "invalid_request", "raw_text 必填");
    }
    if (rawText.length > 4000) {
      return err(res, 400, "invalid_request", "raw_text 过长 (>4000 字)");
    }

    const prompt = buildAutofillPrompt({ elementKind, rawText });
    res.json({
      ok: true,
      system: prompt.system,
      user: prompt.user,
      combined: prompt.combined,
    });
  } catch (e) { next(e); }
});
