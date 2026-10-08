/**
 * First-frame (首帧) endpoints — 拆自原 shotStageController.ts。
 *
 * 覆盖 7 个 endpoint:
 *   - GET   /api/v2/shots/:sid/firstframe/preview-prompt
 *   - POST  /api/v2/shots/:sid/firstframe/import-image
 *   - POST  /api/v2/series/:slug/episodes/:epId/shots/:sid/stage/firstframe/generate
 *   - POST  /api/v2/shots/:sid/firstframe/generate
 *   - POST  /api/v2/shots/:sid/firstframe/regen-from-reject/:cid
 *   - PATCH /api/v2/series/:slug/episodes/:epId/shots/:sid/stage/firstframe/candidate/:cid
 *   - PATCH /api/v2/shots/:sid/firstframe/candidate/:cid
 *
 * scoped + flat 的 generate 共用 `dispatchFirstFrameGenerate`。
 */

import { Router, type Request, type Response } from "express";
import {
  readShot,
  updateShot,
  appendGeneration,
  pickGeneration,
  moveGenerationToTrash,
  restoreGenerationFromTrash,
  renameGenerationLabel,
  setFrameAnchor,
  type ShotGeneration,
  type ShotData,
} from "../seriesStore";
import {
  createPendingJob,
  updatePendingJob,
  failPendingJob,
} from "../../../jobs/pendingJobs";
import { orchestrator } from "../../../jobs/orchestrator";
import {
  compileShotImagePrompt,
} from "../../../application/generation/shotPromptCompiler";
import { buildShotPromptInput } from "../../../application/generation/shotPromptInput";
import { collectImplicitReferencesFromShot } from "../../../application/generation/implicitReferenceCollector";
import { providerIdFromModelRef } from "../../../application/generation/modelRef";
import { loggerSync } from "../../../../../../packages/core/src/logger";
// 2026-05-20 display_name 体系统一: 候选 rename 同步 assetMetaRepo
import { updateAssetMeta } from "../../../repositories/assetMetaRepo";
import {
  assertProviderSelectedOrErr,
  err,
  readScopedShot,
  resolveFlatShotLocatorOrErr,
  resolveMentionsToAssetIds,
} from "./shared";
import { dispatchFirstFrameGenerate } from "./dispatch";

export const firstframeRouter = Router();

// ───────── First frame: preview composed prompt (zero-cost) ─────────
//
// Returns the prompt string that would be sent to the image provider WITHOUT
// actually calling the provider. Lets the user (a) inspect what we'd send,
// (b) copy/paste it elsewhere, (c) download it as a .txt, or (d) tweak it
// before kicking off a real generation.
firstframeRouter.get("/shots/:sid/firstframe/preview-prompt", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    // 2026-07-22 X3-3 (A3-4): 安全定位替代裸 locateShotById — 歧义时 409 而非打到错分镜.
    const loc = await resolveFlatShotLocatorOrErr(req, res, sid);
    if (!loc) return;
    const shot = await readShot(loc.slug, loc.epId, loc.shotId);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);

    // 2026-05-19 Wave O Entity-first: 走 compileShotImagePrompt, 跟 orchestrator
    //   AutoPipeline 路径用的是同一个 compiler — 让"预览完整提示词"显示的内容
    //   跟 ChatGPT 实际看到的一致 (铁律 #2 可干预性).
    //   之前走简陋字符串拼接 (baseUser + enrichments), 跟 orchestrator 真实拼装
    //   不一致, 用户预览看到的跟实际生成的 prompt 不一样 — 现在统一.
    const compilerInput = await buildShotPromptInput(loc.slug, shot);
    const compiled = compileShotImagePrompt(compilerInput);
    const baseUser = String(shot.prompt_img ?? "").trim();

    // Wave B-2 (2026-05-16): 自动收集本镜引用素材的"主图"作为建议参考图,
    // 让前端与用户手选合并显示并提供取消按钮(铁律 #2 可干预性).
    // 后端 generate endpoint 不偷偷注入 — 前端拿到列表 + 用户确认 → trigger 时传 reference_images.
    const suggested_references = await collectImplicitReferencesFromShot(loc.slug, shot);

    res.json({
      ok: true,
      shot: { sid: shot.id, slug: loc.slug, ep_id: loc.epId },
      user_prompt: baseUser,
      // 2026-05-19 Wave O: enrichments / composed_prompt 现在都走 compiler 输出.
      //   保留这俩字段名是向后兼容前端 (BaseDialog 的 prompt-preview 拿这些字段渲染).
      enrichments: compiled.segments.map((s) => `${s.label}: ${s.text.slice(0, 80)}`),
      composed_prompt: compiled.full_prompt,
      negative_prompt: compiled.negative_prompt,
      segments: compiled.segments,
      image_model_ref: shot.image_model_ref ?? null,
      character_ids: shot.character_ids ?? [],
      reference_asset_ids: shot.reference_asset_ids ?? [],
      suggested_references,
      note: "此预览已走 shotPromptCompiler, 与一键自动生成实际发给模型的 prompt 一致",
    });
  } catch (e) { next(e); }
});

// ───────── First frame: manual import (user-supplied image) ─────────
//
// Lets the user upload an image they generated elsewhere (e.g. from ChatGPT
// web UI after pasting our preview prompt) and register it as a generation
// candidate for the shot. Body: { image_base64: string, mime?: string,
// note?: string }
firstframeRouter.post("/shots/:sid/firstframe/import-image", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    // 2026-07-22 X3-3 (A3-4): 安全定位 — 导入图不再可能落到跨系列同号的错分镜.
    const loc = await resolveFlatShotLocatorOrErr(req, res, sid);
    if (!loc) return;
    const shot = await readShot(loc.slug, loc.epId, loc.shotId);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);

    const { image_base64, mime = "image/png", note = "", as_anchor } = req.body ?? {};
    if (typeof image_base64 !== "string" || image_base64.length < 100) {
      return err(res, 400, "ValidationError", "需要 image_base64 (>=100 chars 的 base64 字符串)");
    }
    if (as_anchor !== undefined && as_anchor !== "first") {
      return err(res, 400, "ValidationError", "as_anchor 只支持 first");
    }
    const cleaned = image_base64.replace(/^data:[^,]+,/, "");
    let buffer: Buffer;
    try {
      buffer = Buffer.from(cleaned, "base64");
    } catch {
      return err(res, 400, "ValidationError", "image_base64 不是合法的 base64");
    }

    // Save into the vault using the same path other providers use.
    const { saveToVault } = await import("../../../../../../packages/library/src/assetVault");
    const vaultEntry = await saveToVault({
      buffer,
      kind: "image",
      mime,
      context: {
        kind: "shot_first_frame",
        series_slug: loc.slug,
        shot_id: loc.shotId,
      },
      provider_id: "manual_import",
      width: 0,
      height: 0,
      tags: ["manual_import", `note:${note.slice(0, 40)}`],
    });

    const generation: ShotGeneration = {
      generation_id: vaultEntry.vault_id,
      type: "first_frame",
      provider: "manual_import",
      vault_id: vaultEntry.vault_id,
      asset_id: vaultEntry.vault_id,
      status: "done",
      created_at: new Date().toISOString(),
      prompt: shot.prompt_img ?? "",
      prompt_used: shot.prompt_img ?? "",
      picked: false,
      cost_cny: 0,
    };

    // 2026-07-09 audit C10/C11 补漏 — 原子追加: 之前 readShot(锁外, 见上 line ~112)+updateShot(绝对
    // generations 数组). 同镜并发落盘(用户导入图与另一路首帧生成/重抽同时写)各自锁外读到同一基线,
    // 各自整段 updateShot → 后写覆盖先写丢候选(视频路径下丢的是已扣费候选). 改用
    // shotRepo.appendGeneration 锁内重读+append+write, 与 shotFirstFrameAdapter 同款迁移.
    // 导入图维持原行为不流转 status (不传 opts.status).
    // 2026-05-27 audit Agent#1 P2 #44: as_anchor === "first" 时一并写 picked_first_frame_generation_id
    //   (走 extraPatch), 否则 setFrameAnchor 只写 frame_anchors 而该字段仍空, i2v has_first_frame_ref
    //   判定拿不到 → 走纯 t2v, 用户"用这张作首帧"落空.
    const extraPatch: Partial<ShotData> = {};
    if (as_anchor === "first") {
      extraPatch.picked_first_frame_generation_id = generation.generation_id;
    }
    const updated = await appendGeneration(loc.slug, loc.epId, loc.shotId, generation, { extraPatch });
    if (!updated) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    if (as_anchor === "first") {
      await setFrameAnchor(loc.slug, loc.epId, loc.shotId, {
        role: "first",
        generation_id: generation.generation_id,
        vault_id: vaultEntry.vault_id,
        asset_id: vaultEntry.vault_id,
      });
    }

    res.json({
      ok: true,
      generation_id: vaultEntry.vault_id,
      vault_id: vaultEntry.vault_id,
      message: "图片已导入,作为候选加入首帧池",
    });
  } catch (e) { next(e); }
});

// ───────── First frame generate ─────────
//
// W3-A (2026-05-15): body 新增可选字段 (与 video/generate 对齐)
//   - prompt_override?: string         — 审核弹窗里用户修改过的完整 prompt; 优先级最高
//   - user_extra_instruction?: string  — 用户额外要求, 走 compiler 拼到 full_prompt
firstframeRouter.post("/series/:slug/episodes/:epId/shots/:sid/stage/firstframe/generate", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const shot = await readScopedShot(slug, epId, sid);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    await dispatchFirstFrameGenerate({
      slug, epId, shotId: sid, shot, req, res, next,
      // scoped 历史上不写 failures.jsonl, 维持旧行为
      appendFailureOnError: false,
    });
  } catch (e) { next(e); }
});

firstframeRouter.post("/shots/:sid/firstframe/generate", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    // 2026-07-22 X3-3 (A3-4): 付费首帧生成——歧义时 409 (不含糊定位), 杜绝扣错分镜的钱.
    const loc = await resolveFlatShotLocatorOrErr(req, res, sid);
    if (!loc) return;
    const shot = await readShot(loc.slug, loc.epId, loc.shotId);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    await dispatchFirstFrameGenerate({
      slug: loc.slug, epId: loc.epId, shotId: loc.shotId, shot, req, res, next,
      // flat 历史上写 failures.jsonl, 维持旧行为
      appendFailureOnError: true,
    });
  } catch (e) { next(e); }
});

// ───────── First frame regen from reject ─────────
//
// W3-A (2026-05-15): body 新增 extra_instruction?: string  — 用户对废案的微调意见
//   - 用废案图作为 i2i 参考 (cid 隐含)
//   - extra_instruction 通过 compiler 注入到 user_extra 段, 拼成新的 full_prompt
//   - prompt_override 优先级最高 (向后兼容)
firstframeRouter.post("/shots/:sid/firstframe/regen-from-reject/:cid", async (req: Request, res: Response, next) => {
  let attemptId: string | undefined;
  try {
    const sid = String(req.params.sid);
    const cid = String(req.params.cid);
    // 2026-07-22 X3-3 (A3-4): 付费废案再抽——安全定位, 歧义 409 不打到错分镜.
    const loc = await resolveFlatShotLocatorOrErr(req, res, sid);
    if (!loc) return;
    const { count = 4, model, extra_instruction, compact_mode } = req.body ?? {};
    // W7: 废案再抽也是 image 生成,同样不允许 silent fallback
    const shotForCheck = await readShot(loc.slug, loc.epId, loc.shotId);
    if (await assertProviderSelectedOrErr(res, "image", typeof model === "string" ? model : null, shotForCheck?.image_model_ref ?? null, loc.slug)) return;
    const trimmedExtra = typeof extra_instruction === "string" ? extra_instruction.trim() : "";
    const trimmedOverride = typeof req.body?.prompt_override === "string" ? req.body.prompt_override.trim() : "";
    const useCompactMode = compact_mode === true;

    // 2026-05-17 修复 Bug: 之前 regen-from-reject 完全没把"此图"作为 reference 发给模型,
    // 只是把 cid 字符串拼到 prompt 里。用户原话"没遵循原图"=模型根本没看到原图。
    // 修: ① cid 对应 image asset_id 加进 reference_asset_ids_extra 作 i2i 主参考
    //     ② prompt 文本不再暴露 "基于废案候选 cid 的修改意见" 技术 id(铁律 #9)
    const shotForRegen = await readShot(loc.slug, loc.epId, loc.shotId);
    const cidRefAssetId: string | undefined = (() => {
      if (!shotForRegen) return undefined;
      const allGens = [
        ...(shotForRegen.generations ?? []),
        ...(shotForRegen.trashed_generations ?? []),
      ];
      const cidGen = allGens.find((g) => g.generation_id === cid);
      return cidGen?.vault_id ?? cidGen?.asset_id ?? undefined;
    })();

    let finalPromptOverride: string | undefined;
    if (trimmedOverride) {
      finalPromptOverride = trimmedOverride;
    } else if (useCompactMode) {
      // 2026-05-17 简洁模式 (用户原话: "避免写大段初次生成的完整提示词,让模型误以为是重新生图")
      // 直接用 trimmedExtra 作 prompt;refs(原图 + @素材)通过 reference_asset_ids_extra 注入
      // 用户没写 trimmedExtra 时 finalPromptOverride 留 undefined,orchestrator 用 shot.prompt_img 兜底
      finalPromptOverride = trimmedExtra || undefined;
    } else if (trimmedExtra && shotForRegen) {
      // 完整模式 (默认): buildShotPromptInput 拼完整 prompt (分镜上下文+角色+参数+用户追加意见)
      // 修复 Bug 2: user_extra 只放用户真写的修改意见, 不再拼 cid 字符串
      const compilerInput = await buildShotPromptInput(loc.slug, shotForRegen, {
        user_extra: trimmedExtra,
        has_first_frame_ref: !!cidRefAssetId,
      });
      finalPromptOverride = compileShotImagePrompt(compilerInput).full_prompt;
    }

    const job = createPendingJob("shot.firstframe.regen_from_reject", {
      sid, cid, slug: loc.slug, epId: loc.epId, count, model,
      extra_instruction: trimmedExtra || undefined,
    });
    attemptId = job.attempt_id;
    updatePendingJob(job.attempt_id, { status: "running", progress: 0.2, eta_s: 6 });
    // 2026-05-17 严格做法: RegenModal "修改意见" 也支持 @ mention - 解析 extra_instruction 注入 reference
    // 同时扫 shot 主文本(用户可能在 prompt_img 也写过 @, 不应丢)
    const mentionRefs = await resolveMentionsToAssetIds(
      loc.slug,
      trimmedExtra,
      shotForRegen?.action,
      shotForRegen?.dialogue,
      shotForRegen?.voiceover,
      shotForRegen?.notes,
      shotForRegen?.prompt_img,
      shotForRegen?.prompt_vid,
    );
    // 修复 Bug 1: cid 对应 image 加进 reference_asset_ids_extra 首位 (i2i 主参考语义)
    const extraRefIds: string[] = [];
    if (cidRefAssetId) extraRefIds.push(cidRefAssetId);
    for (const id of mentionRefs.assetIds) {
      if (!extraRefIds.includes(id)) extraRefIds.push(id);
    }

    const result = await orchestrator.orchestrate({
      series_slug: loc.slug,
      episode_id: loc.epId,
      action: "generate_first_frames",
      count_per_shot: Math.max(1, Number(count) || 1),
      provider_override: providerIdFromModelRef(model),
      // B5: pass full ref so adapter gets model_id override.
      model_ref_override: typeof model === "string" && model ? model : undefined,
      prompt_override: finalPromptOverride,
      only_shot_ids: [loc.shotId],
      requestId: req.requestId,
      attempt_id: job.attempt_id,
      reference_asset_ids_extra: extraRefIds.length > 0 ? extraRefIds : undefined,
    });
    res.json({
      ok: true,
      attempt_id: job.attempt_id,
      job_id: result.job_id,
      tasks: result.tasks,
      // 2026-05-27 — @ mention 找不到的 token 也透给前端 toast (废案再抽路径)
      skipped_mentions: mentionRefs.skippedTokens.length > 0 ? mentionRefs.skippedTokens : undefined,
    });
  } catch (e) {
    if (attemptId) failPendingJob(attemptId, { code: "DispatchFailed", message: e instanceof Error ? e.message : String(e) });
    next(e);
  }
});

// ───────── First frame candidate action ─────────
firstframeRouter.patch("/series/:slug/episodes/:epId/shots/:sid/stage/firstframe/candidate/:cid", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const cid = String(req.params.cid);
    const { action, label } = req.body ?? {};
    const shot = await readScopedShot(slug, epId, sid);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    if (action === "select") {
      // 2026-05-22 P0-A entity-first 双事实修复: select 同时写
      //   1) shot.picked_first_frame_generation_id (主真理源, pickedAssetResolver 读这个)
      //   2) generation.picked 标志位 (legacy 冗余信号, 兼容老 caller / 老数据)
      // 若只写 (1) → 老数据上 generation.picked=true 留在另一张图上 → 双事实矛盾.
      // 参考 shotController.ts pickGeneration 的同款双写做法.
      // 2026-07-09 audit 修复 — 先校验候选真实存在再写 picked 指针 + approved/picked. 否则陈旧/多标签页
      // 传来的已删候选 id 会写成悬空 picked_first_frame_generation_id, 合成时 pickedAssetResolver 抛
      // generation-not-found (该镜首帧变占位). 与 shotController.pick 存在性校验补齐一致.
      // 2026-07-10 audit (终验揪出兄弟点) — 原子挑选: 锁内重读 generations 再翻 picked, 防同镜并发
      // appendGeneration 追加的已扣费候选被锁外陈旧快照绝对覆盖冲掉 (最高频手动挑卡路径).
      const picked = await pickGeneration(slug, epId, sid, cid, "first_frame", {
        status: shot.picked_video_generation_id ? "approved" : "picked",
      });
      if (!picked.ok) return err(res, 404, "GenerationNotFound", "该首帧候选不存在或已被移除,请刷新后重试");
    } else if (action === "reject") {
      await moveGenerationToTrash(slug, epId, sid, cid);
    } else if (action === "restore") {
      await restoreGenerationFromTrash(slug, epId, sid, cid);
    } else if (action === "rename") {
      await renameGenerationLabel(slug, epId, sid, cid, label);
      // 2026-05-20 display_name 体系统一: 双写到 assetMetaRepo (单一真理源).
      // 用 generation_id + vault_id + asset_id 三 key 都写, 让任一引用方都能查到.
      try {
        const updatedShot = await readScopedShot(slug, epId, sid);
        const gen = [
          ...(updatedShot?.active_generations ?? []),
          ...(updatedShot?.trashed_generations ?? []),
          ...(updatedShot?.generations ?? []),
        ].find((g) => g.generation_id === cid);
        const dn = typeof label === "string" && label.trim() ? label.trim() : undefined;
        await updateAssetMeta(cid, { display_name: dn });
        if (gen?.vault_id) await updateAssetMeta(gen.vault_id, { display_name: dn });
        if (gen?.asset_id) await updateAssetMeta(gen.asset_id, { display_name: dn });
      } catch (metaErr) {
        loggerSync().warn(`[firstframe candidate rename] assetMetaRepo 同步失败 (非致命): ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`);
      }
    } else {
      return err(res, 400, "ValidationError", `action 必须是 select|reject|restore|rename`);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

firstframeRouter.patch("/shots/:sid/firstframe/candidate/:cid", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    const cid = String(req.params.cid);
    const { action, label } = req.body ?? {};
    // 2026-07-22 X3-3 (A3-4): 安全定位 — 挑首帧/废弃不再可能作用到跨系列同号的错分镜.
    const loc = await resolveFlatShotLocatorOrErr(req, res, sid);
    if (!loc) return;
    if (action === "select") {
      const shot = await readShot(loc.slug, loc.epId, loc.shotId);
      // 2026-05-22 P0-A entity-first 双事实修复 (flat 路径同步 scoped):
      // 同时写 picked_first_frame_generation_id (主真理源) + generation.picked (legacy 冗余).
      // 2026-07-09 audit 修复 — 见 scoped 路径同款: 校验候选存在再写 picked, 防悬空指针.
      // 2026-07-10 audit (终验揪出兄弟点) — 原子挑选, 防并发丢已扣费候选 (同 scoped 路径).
      const picked = await pickGeneration(loc.slug, loc.epId, loc.shotId, cid, "first_frame", {
        status: shot?.picked_video_generation_id ? "approved" : "picked",
      });
      if (!picked.ok) return err(res, 404, "GenerationNotFound", "该首帧候选不存在或已被移除,请刷新后重试");
    } else if (action === "reject") {
      await moveGenerationToTrash(loc.slug, loc.epId, loc.shotId, cid);
    } else if (action === "restore") {
      await restoreGenerationFromTrash(loc.slug, loc.epId, loc.shotId, cid);
    } else if (action === "rename") {
      // 2026-05-27 — 补齐 flat 路径 rename 分支 (跟 scoped 路径 line 353-369 对齐).
      // 之前 flat 路径只有 select/reject/restore, rename 调用直接 400 "action 必须是
      // select|reject|restore" — 前端使用 flat URL rename 时报错, 用户改不了候选名.
      await renameGenerationLabel(loc.slug, loc.epId, loc.shotId, cid, label);
      try {
        const updatedShot = await readShot(loc.slug, loc.epId, loc.shotId);
        const gen = [
          ...(updatedShot?.active_generations ?? []),
          ...(updatedShot?.trashed_generations ?? []),
          ...(updatedShot?.generations ?? []),
        ].find((g) => g.generation_id === cid);
        const dn = typeof label === "string" && label.trim() ? label.trim() : undefined;
        await updateAssetMeta(cid, { display_name: dn });
        if (gen?.vault_id) await updateAssetMeta(gen.vault_id, { display_name: dn });
        if (gen?.asset_id) await updateAssetMeta(gen.asset_id, { display_name: dn });
      } catch (metaErr) {
        loggerSync().warn(`[firstframe candidate rename flat] assetMetaRepo 同步失败 (非致命): ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`);
      }
    } else {
      return err(res, 400, "ValidationError", `action 必须是 select|reject|restore|rename`);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});
