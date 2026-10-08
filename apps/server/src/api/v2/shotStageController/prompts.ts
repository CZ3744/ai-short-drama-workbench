/**
 * Shot detail / prompt update / prompt-preview / polish-prompt endpoints — 拆自原 shotStageController.ts。
 *
 * 覆盖 5 个 endpoint:
 *   - GET  /api/v2/series/:slug/episodes/:epId/shots/:sid/stage
 *   - GET  /api/v2/shots/:sid
 *   - PUT  /api/v2/shots/:sid/prompt
 *   - GET  /api/v2/series/:slug/episodes/:epId/shots/:sid/stage/prompt-preview
 *   - POST /api/v2/shots/:sid/stage/polish-prompt   (D-P1: AI 润色提示词)
 *
 * (注: firstframe/preview-prompt 在 firstframe.ts。)
 */

import { Router, type Request, type Response } from "express";
import { clientDisconnectSignal } from "../../../middleware/clientDisconnectSignal";
import {
  readShot,
  readShotById,
  updateShotById,
  appendPromptVersion,
  type ShotData,
} from "../seriesStore";
import { readElement } from "../../../repositories/elementRepo";
import { readAsset } from "../../../repositories/assetRepo";
import {
  compileShotImagePrompt,
  compileShotVideoPrompt,
  buildShotLlmPolishMessages,
} from "../../../application/generation/shotPromptCompiler";
import { buildShotPromptInput } from "../../../application/generation/shotPromptInput";
import { collectImplicitReferencesFromShot } from "../../../application/generation/implicitReferenceCollector";
import { getRegistry } from "../orchestrationController";
import { getConfigValue, getKeyFor } from "../../../../../../packages/core/src/localSettings";
import { scrubForClient } from "../../../../../../packages/core/src/logger";
import { resolveChain, tryWithFallback } from "../../../../../../packages/providers/src/core/queue";
import type { CostInfo, ProviderContext } from "../../../../../../packages/providers/src/core/types";
import { providerIdFromModelRef } from "../../../application/generation/modelRef";
import {
  err,
  readScopedShot,
  resolveFlatShotLocatorOrErr,
  shotDetailDto,
  readScene,
  readCharacter,
} from "./shared";

export const promptsRouter = Router();

// ───────── Shot detail ─────────
promptsRouter.get("/series/:slug/episodes/:epId/shots/:sid/stage", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const shot = await readScopedShot(slug, epId, sid);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    res.json(await shotDetailDto(shot));
  } catch (e) { next(e); }
});

promptsRouter.get("/shots/:sid", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    const shot = await readShotById(sid);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    res.json(await shotDetailDto(shot));
  } catch (e) { next(e); }
});

// ───────── Prompt update ─────────
promptsRouter.put("/shots/:sid/prompt", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const shot = await readShotById(sid);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    const updated = await updateShotById(sid, {
      prompt_img: text,
      prompt_img_versions: appendPromptVersion(shot.prompt_img_versions, text, "user"),
    });
    if (!updated) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    res.json({ ok: true, shot: { sid: updated.id, prompt: updated.prompt_img ?? "" } });
  } catch (e) { next(e); }
});

// ───────── Stage prompt-preview (image|video kind) ─────────
//
// 2026-07-22 X3-1 (A4-13): 抽出 buildStagePromptPreview 供 scoped + flat 两路由共用.
// 之前只注册了 scoped 版本; 前端 previewShotPrompt(sid, "video") 请求的是扁平
// GET /shots/:sid/stage/prompt-preview → 必然 404 (批量视频 dry-run 弹窗"审核提示词"断腿,
// 铁律 #13 完整提示词审核恰好死在最高风险的批量付费确认路径上). 现补扁平注册, 与
// firstframe.ts:62 preview-prompt 的兄弟模式一致 (同一 handler 逻辑, scoped + flat 两注册).
async function buildStagePromptPreview(
  slug: string,
  shot: ShotData,
  kind: "image" | "video",
  userExtra: string,
): Promise<Record<string, unknown>> {
  const anchors = shot.frame_anchors ?? [];
  // 2026-05-27 fix — has_first_frame_ref 必须看 picked_first_frame_generation_id.
  //   90% 用户旅程 (生完首帧 → 挑一张 → 生视频) 走 picked, orchestrator 真把图发给
  //   i2v provider; 之前审核弹窗 preamble 写"无首帧"但实发了 → 铁律 #13 违反.
  const hasFirstFrameRef = anchors.some((a) => a.role === "first") || !!shot.picked_first_frame_generation_id;
  const hasEndFrameRef = anchors.some((a) => a.role === "end");

  // 2026-05-15: W3-A — prompt-preview 走 shotPromptCompiler, 让 UI 拿到的 composed_prompt
  // 就是真正会发给模型的 full_prompt (自包含 + 关键参数进主体)。
  const compilerInput = await buildShotPromptInput(slug, shot, {
    user_extra: userExtra,
    has_first_frame_ref: kind === "video" ? hasFirstFrameRef : false,
    has_end_frame_ref: kind === "video" ? hasEndFrameRef : false,
  });
  const compiled = kind === "image"
    ? compileShotImagePrompt(compilerInput)
    : compileShotVideoPrompt(compilerInput);

  // connected_assets 仍按 UI 旧契约返回, 给左栏 chips 用
  const connectedAssets: Array<{ id: string; kind: "character" | "scene" | "reference"; name: string }> = [];
  for (const id of shot.character_ids ?? []) {
    const character = await readCharacter(slug, id);
    connectedAssets.push({ id, kind: "character", name: character?.name ?? id });
  }
  if (shot.scene_id) {
    const scene = await readScene(slug, shot.scene_id);
    connectedAssets.push({ id: shot.scene_id, kind: "scene", name: scene?.name ?? shot.scene_id });
  }
  const refNotes = shot.reference_notes ?? {};
  const refIds = shot.reference_asset_ids ?? [];
  for (let i = 0; i < refIds.length; i++) {
    const id = refIds[i];
    // Y2 人话名 (UP-2 + display_name 铁律#2): chip 名字优先级 —
    //   用户备注 → 素材 display_name → 位置兜底 "参考图 · 第 N 张"。
    // 绝不回退成裸 asset_id (journey F: chip 直接显示 asset_1784699642689... 糊脸)。
    const note = refNotes[id]?.trim();
    let name = note;
    if (!name) {
      const asset = await readAsset(slug, id).catch(() => null);
      name = asset?.display_name?.trim() || `参考图 · 第 ${i + 1} 张`;
    }
    connectedAssets.push({ id, kind: "reference", name });
  }
  for (const id of shot.element_ids ?? []) {
    const element = await readElement(slug, id);
    connectedAssets.push({ id, kind: "reference", name: element?.name ?? id });
  }

  const base = kind === "image" ? (shot.prompt_img ?? "") : (shot.prompt_vid ?? shot.action ?? "");

  // Wave B-2 (2026-05-16): suggested_references — 系统从 character/scene/element
  // 主图自动收集的"建议参考图".
  // 2026-05-27 fix — 视频模式不再写死空数组. orchestrator 视频路径实发 character/scene/
  //   wardrobe/prop typical pool + picked first frame + end/key anchor + reference_asset_ids;
  //   审核弹窗写 [] 会导致用户看到"无参考图"但实发 N 张, 违反铁律 #13.
  const suggested_references = await collectImplicitReferencesFromShot(slug, shot);

  return {
    ok: true,
    kind,
    base,
    segments: compiled.segments,
    connected_assets: connectedAssets,
    composed_prompt: compiled.full_prompt,
    negative_prompt: compiled.negative_prompt,
    suggested_references,
  };
}

function parsePreviewKind(req: Request): "image" | "video" | null {
  return req.query.kind === "image" || req.query.kind === "video" ? req.query.kind : null;
}

function parsePreviewUserExtra(req: Request): string {
  return typeof req.query.user_extra === "string" ? String(req.query.user_extra) : "";
}

promptsRouter.get("/series/:slug/episodes/:epId/shots/:sid/stage/prompt-preview", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const kind = parsePreviewKind(req);
    if (!kind) return err(res, 400, "ValidationError", "kind 必须是 image|video");
    const shot = await readScopedShot(slug, epId, sid);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    res.json(await buildStagePromptPreview(slug, shot, kind, parsePreviewUserExtra(req)));
  } catch (e) { next(e); }
});

// 2026-07-22 X3-1 (A4-13): 扁平版本 — 前端 previewShotPrompt(sid, "image"|"video") 走这条.
// 用 resolveFlatShotLocatorOrErr 安全定位 (X3-3): 跨系列同号 s000N 歧义时 409 不打到错分镜.
promptsRouter.get("/shots/:sid/stage/prompt-preview", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    const kind = parsePreviewKind(req);
    if (!kind) return err(res, 400, "ValidationError", "kind 必须是 image|video");
    const loc = await resolveFlatShotLocatorOrErr(req, res, sid);
    if (!loc) return;
    const shot = await readShot(loc.slug, loc.epId, loc.shotId);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    res.json(await buildStagePromptPreview(loc.slug, shot, kind, parsePreviewUserExtra(req)));
  } catch (e) { next(e); }
});

// ───────── AI 润色提示词 (D-P1: 2026-06-01) ─────────
// 后端 buildShotLlmPolishMessages 已实现(shotPromptCompiler.ts:717), 但全仓库仅测试调用。
// 本端点: buildShotPromptInput → buildShotLlmPolishMessages → LLM provider → 返回润色文本。
// 用户看到润色结果后, 可预览/编辑/确认后才回填到 prompt_img (可干预铁律)。

function buildLlmProviderContext(purpose: string, req: Request): ProviderContext {
  // 2026-06-01 修: 透传 req.signal — 客户端断开 / 用户取消能真 abort LLM 润色调用.
  // 之前 void req + signal: undefined 导致用户关弹窗后 LLM 继续跑完浪费额度.
  // 与 aiController.ts / seriesController.ts 等 12 处 callsite 对齐 (铁律 #1).
  return {
    series_slug: "polish-prompt",
    job_id: `polish_${Date.now().toString(36)}`,
    task_id: `task_${purpose}_${Date.now().toString(36)}`,
    log: () => {},
    signal: clientDisconnectSignal(req, req.res!),
  };
}

function resolveLlmChain(requestedProviderId?: string): string[] {
  const registry = getRegistry();
  const all = registry.listAvailable("llm").map((p: { id: string }) => p.id);
  const lead = requestedProviderId || getConfigValue("GLOBAL_MODEL_PROVIDER", "ikuncode_gpt55");
  return resolveChain(
    lead,
    all,
    (id: string) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );
}

function costToCny(cost?: CostInfo): number {
  if (!cost) return 0;
  return cost.currency === "CNY" ? cost.amount : 0;
}

promptsRouter.post("/shots/:sid/stage/polish-prompt", async (req: Request, res: Response) => {
  try {
    const sid = String(req.params.sid);
    const mode = req.body?.mode === "video" ? "video" as const : "image" as const;
    const llmProviderId = typeof req.body?.llm_provider_id === "string" ? req.body.llm_provider_id : undefined;

    const shot = await readShotById(sid);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);

    const slug = shot.locator.slug;
    const compilerInput = await buildShotPromptInput(slug, shot, {});
    const messages = buildShotLlmPolishMessages(compilerInput, mode);

    const chain = resolveLlmChain(providerIdFromModelRef(llmProviderId));
    const ctx = buildLlmProviderContext("polish-prompt", req);
    const result = await tryWithFallback(
      chain,
      (id: string) => getRegistry().getLlm(id),
      {
        prompt: messages.user,
        system: messages.system,
        response_format: "text",
        max_tokens: 1200,
      },
      ctx,
    );

    res.json({
      ok: true,
      polished_prompt: result.text.trim(),
      cost_cny: costToCny(result.cost),
    });
  } catch (error) {
    res.status(503).json({
      error: {
        code: "LlmUnavailable",
        message: scrubForClient(error instanceof Error ? error.message : String(error)),
      },
    });
  }
});
