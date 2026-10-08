/**
 * v2 Shot Controller — CRUD for shots + generation actions (first-frame, video, pick, approve, retake)
 * Wave 1C: 分镜规划闭环 — 废案箱、一键重试N次、文/图生视频切换
 */

import { Router } from "express";
import { handleValidationError, assertProviderSelectedOrErr } from "./validateHelpers";
import path from "node:path";
import fs from "node:fs/promises";
import {
  listShots, readShot, readSeries, updateShot, addShot, addAsset,
  moveGenerationToTrash, restoreGenerationFromTrash, permanentlyDeleteGeneration,
  trashShot, restoreTrashedShot, listTrashedShots, permanentlyDeleteTrashedShot, reorderShots,
  readCharacter, readScene, getMoodBoardRefImages,
  appendPromptVersion, pickGeneration,
  listEpisodes,
} from "./seriesStore";
import { countReferenceImages } from "../../../../../packages/drama/src/consistency/referenceSet";
import { getPreset } from "../../../../../packages/core/src/presets";
import {
  validate, CreateShotSchema, PatchShotSchema, GenerateFirstFrameSchema, GenerateVideoSchema,
  PickGenerationSchema, RetakeSchema, BatchToggleLastFrameSchema, RetryUntilSatisfiedSchema,
} from "./validators";
import { orchestrator } from "../../jobs/orchestrator";
import type { ShotGeneration, ShotData } from "./seriesStore";
// 2026-05-22 P0-B: PATCH 路径接收 *_nodes 改动后必须重算 character_ids / scene_id / element_ids
// (entity-first 铁律: nodes 是真理源, ids 是 derived). 不重算 → orchestrator 用老 ids 收参考图,
// silent 漏掉用户新加的 mention. 详见 deriveMentionIds.ts 文档.
import { applyDerivedMentionIdsToPatch } from "./deriveMentionIds";

export const shotRouter = Router();

// ─── Candidate DTO ───────────────────────────────────────────────
// 2026-05-29 audit P0-1: 删本地简化版, import shotStageController/shared.ts 完整版
// (支持 display_name / type / duration_sec)
import { toCandidate } from "./shotStageController/shared";

// GET /series/:slug/episodes/:epId/shots
// A-11 (2026-05-12): 之前每次 GET 都把全部 candidates inline. 一个分镜重试 10 次后,
// shot JSON 包含 10 个 candidate × { url, vault_id, score, ... }, 整集 payload 雪球.
// 现在默认只返回 candidate 数量 + picked id; 加 query ?include=candidates 时才完整内联.
// 前端 useShots.ts 早期版本默认会拿 candidates, 因此保持默认开启 (兼容), 但新增 ?slim=1
// 让 Library / dashboard 等不需要候选预览的视图可显式瘦身.
shotRouter.get("/series/:slug/episodes/:epId/shots", async (req, res, next) => {
  try {
    const shots = await listShots(req.params.slug, req.params.epId);
    const reqLog = req.log;
    if (reqLog) reqLog.info({ shot_count: shots.length, series_slug: req.params.slug, episode_id: req.params.epId }, "GET shots");
    const slim = req.query.slim === "1" || req.query.slim === "true";
    const transformed = shots.map(shot => {
      // U9: active_generations 为空时从 generations 过滤掉废案箱,不统计 trashed
      const trashedGens = shot.trashed_generations ?? [];
      const trashedIds = new Set(trashedGens.map((g) => g.generation_id));
      const activeGens = (shot.active_generations && shot.active_generations.length > 0)
        ? shot.active_generations
        : (shot.generations ?? []).filter((g) => !trashedIds.has(g.generation_id));
      const ffGens = activeGens.filter(g => g.type === "first_frame");
      const vidGens = activeGens.filter(g => g.type === "video");
      const base = {
        ...shot,
        picked_first_frame_id: shot.picked_first_frame_generation_id ?? null,
        picked_video_id: shot.picked_video_generation_id ?? shot.picked_generation_id ?? null,
        video_mode: shot.video_mode ?? "i2v",
        // C4: 透传 prompt 版本历史到前端
        prompt_img_versions: shot.prompt_img_versions ?? [],
        prompt_vid_versions: shot.prompt_vid_versions ?? [],
      };
      if (slim) {
        // A-11: slim 模式只返回计数, 前端按需 GET /shots/:shotId 拿完整 candidates
        return {
          ...base,
          first_frame_candidate_count: ffGens.length,
          video_candidate_count: vidGens.length,
          trashed_candidate_count: trashedGens.length,
        };
      }
      return {
        ...base,
        first_frame_candidates: ffGens.map((g) => toCandidate(req.params.slug, g)),
        video_candidates: vidGens.map((g) => toCandidate(req.params.slug, g)),
        trashed_candidates: trashedGens.map((g) => toCandidate(req.params.slug, g)),
      };
    });
    res.json({ shots: transformed });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/shots
shotRouter.post("/series/:slug/episodes/:epId/shots", async (req, res, next) => {
  try {
    const v = validate(CreateShotSchema, req.body);
    if (handleValidationError(res, v)) return;

    let shot = await addShot(req.params.slug, req.params.epId, v.data);
    // 2026-07-22 X3-5 (A4-14): addShot 的 param 契约不含 reference_notes / reference_overrides,
    // 这两字段在 CreateShotSchema 新补 (与 PatchShot 对称) — 建分镜时若带了, 落库经 updateShot
    // (与 PATCH 同一写路径), 不改 shotRepo.addShot 的既有契约. 无这两字段时零额外写盘.
    const refNotes = v.data.reference_notes;
    const refOverrides = v.data.reference_overrides;
    if ((refNotes && Object.keys(refNotes).length > 0) || (refOverrides && refOverrides.length > 0)) {
      const patched = await updateShot(req.params.slug, req.params.epId, shot.id, {
        ...(refNotes ? { reference_notes: refNotes } : {}),
        ...(refOverrides ? { reference_overrides: refOverrides } : {}),
      });
      if (patched) shot = patched;
    }
    const reqLog = req.log;
    if (reqLog) reqLog.info({ shot_id: shot.id, series_slug: req.params.slug, episode_id: req.params.epId }, "POST shot created");

    res.status(201).json({
      shot: {
        ...shot,
        first_frame_candidates: [],
        video_candidates: [],
        trashed_candidates: [],
        picked_first_frame_id: null,
        picked_video_id: null,
        video_mode: shot.video_mode ?? "i2v",
        prompt_img_versions: shot.prompt_img_versions ?? [],
        prompt_vid_versions: shot.prompt_vid_versions ?? [],
      },
    });
  } catch (err) { next(err); }
});

// GET /series/:slug/episodes/:epId/shots/:shotId
shotRouter.get("/series/:slug/episodes/:epId/shots/:shotId", async (req, res, next) => {
  try {
    const shot = await readShot(req.params.slug, req.params.epId, req.params.shotId);
    if (!shot) { res.status(404).json({ error: { code: "NotFound", message: "分镜不存在" } }); return; }
    res.json({ shot });
  } catch (err) { next(err); }
});

// PATCH /series/:slug/episodes/:epId/shots/:shotId
shotRouter.patch("/series/:slug/episodes/:epId/shots/:shotId", async (req, res, next) => {
  try {
    const v = validate(PatchShotSchema, req.body);
    if (handleValidationError(res, v)) return;
    const patchData: Record<string, unknown> = { ...v.data };

    // C4: 用户手改 prompt 时 append 版本
    const existingShot = await readShot(req.params.slug, req.params.epId, req.params.shotId);
    if (existingShot) {
      if (typeof patchData.prompt_img === "string" && patchData.prompt_img !== existingShot.prompt_img) {
        patchData.prompt_img_versions = appendPromptVersion(
          existingShot.prompt_img_versions, patchData.prompt_img, "user"
        );
      }
      if (typeof patchData.prompt_vid === "string" && patchData.prompt_vid !== existingShot.prompt_vid) {
        patchData.prompt_vid_versions = appendPromptVersion(
          existingShot.prompt_vid_versions, patchData.prompt_vid, "user"
        );
      }

      // 2026-05-22 P0-B entity-first: PATCH 动了任一 *_nodes 字段时, 重新从合并后的
      // nodes 集合 derive character_ids / scene_id / element_ids 覆盖 patch (nodes 是真理源).
      // 修 bug: 用户在 ScriptCanvas 加 @新角色 → action_nodes 写盘但 character_ids 不更新
      // → orchestrator 用老 character_ids 收参考图 → silent 漏新角色.
      const derived = applyDerivedMentionIdsToPatch(
        {
          action_nodes: existingShot.action_nodes,
          dialogue_nodes: existingShot.dialogue_nodes,
          voiceover_nodes: existingShot.voiceover_nodes,
          prompt_img_nodes: existingShot.prompt_img_nodes,
          prompt_vid_nodes: existingShot.prompt_vid_nodes,
        },
        v.data,
      );
      if ("character_ids" in derived && derived.character_ids) {
        patchData.character_ids = derived.character_ids;
      }
      if ("scene_id" in derived) {
        // scene_id 可能为 null (no scene mention) → 此时不动老 scene_id, 因为用户可能没在
        // 文本里 @ 场景但 shot.scene_id 是结构化设置的. 仅在 nodes 含 scene mention 时覆盖.
        if (derived.scene_id) patchData.scene_id = derived.scene_id;
      }
      if ("element_ids" in derived && derived.element_ids) {
        patchData.element_ids = derived.element_ids;
      }
    }

    const shot = await updateShot(req.params.slug, req.params.epId, req.params.shotId, patchData as Partial<ShotData>);
    if (!shot) { res.status(404).json({ error: { code: "NotFound", message: "分镜不存在" } }); return; }
    res.json({ shot });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/shots/:shotId/generate-first-frame
shotRouter.post("/series/:slug/episodes/:epId/shots/:shotId/generate-first-frame", async (req, res, next) => {
  try {
    const v = validate(GenerateFirstFrameSchema, req.body);
    if (handleValidationError(res, v)) return;

    const shot = await readShot(req.params.slug, req.params.epId, req.params.shotId);
    if (!shot) { res.status(404).json({ error: { code: "NotFound", message: "分镜不存在" } }); return; }

    // W7 (2026-05-15) — Bug 1: 必须显式选了 image provider,否则 400。
    // B-P0-2 (2026-06-01): 统一走 assertProviderSelectedOrErr (validateHelpers.ts),
    // 同时修复原来只查 image_provider_id 漏查 default_image 的 bug。
    if (await assertProviderSelectedOrErr(res, "image", v.data.provider_override, shot.image_model_ref, req.params.slug)) return;

    // Use orchestrator for single-shot generation
    // 2026-05-20 P1 audit Bug 7: 与 shotStageController flat endpoint 对齐 — 接受 model_ref_override
    // (provider:model 形) 透传, orchestrator 内部走 providerIdFromModelRef + modelIdFromModelRef 拆分.
    // 旧 caller 传 provider_override 兼容仍可用.
    const result = await orchestrator.orchestrate({
      series_slug: req.params.slug,
      episode_id: req.params.epId,
      action: "generate_first_frames",
      count_per_shot: v.data.count,
      provider_override: v.data.provider_override,
      model_ref_override: v.data.model_ref_override,
      prompt_override: v.data.prompt_override,
      seed_override: v.data.seed,
      only_shot_ids: [req.params.shotId],
      requestId: req.requestId,
    });

    res.json({ ok: true, job_id: result.job_id, tasks: result.tasks });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/shots/:shotId/generate-video
shotRouter.post("/series/:slug/episodes/:epId/shots/:shotId/generate-video", async (req, res, next) => {
  try {
    const v = validate(GenerateVideoSchema, req.body);
    if (handleValidationError(res, v)) return;

    const shot = await readShot(req.params.slug, req.params.epId, req.params.shotId);
    if (!shot) { res.status(404).json({ error: { code: "NotFound", message: "分镜不存在" } }); return; }

    // W7 (2026-05-15) — Bug 1: 必须显式选了 video provider,否则 400。
    // B-P0-2 (2026-06-01): 统一走 assertProviderSelectedOrErr (validateHelpers.ts)。
    if (await assertProviderSelectedOrErr(res, "video", v.data.provider_override, shot.video_model_ref, req.params.slug)) return;

    // 2026-05-20 P1 audit Bug 7: 加 model_ref_override 透传, 与 generate-first-frame 一致
    const result = await orchestrator.orchestrate({
      series_slug: req.params.slug,
      episode_id: req.params.epId,
      action: "generate_videos",
      count_per_shot: v.data.count,
      provider_override: v.data.provider_override,
      model_ref_override: v.data.model_ref_override,
      prompt_override: v.data.prompt_override,
      seed_override: v.data.seed,
      only_shot_ids: [req.params.shotId],
      requestId: req.requestId,
    });

    res.json({ ok: true, job_id: result.job_id, tasks: result.tasks });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/shots/:shotId/pick
shotRouter.post("/series/:slug/episodes/:epId/shots/:shotId/pick", async (req, res, next) => {
  try {
    // 同时兼容两种字段名: generation_id (后端) / candidate_id (前端)
    const targetGenId = req.body?.generation_id || req.body?.candidate_id;
    const v = validate(PickGenerationSchema, req.body);
    if (handleValidationError(res, v)) return;

    const shot = await readShot(req.params.slug, req.params.epId, req.params.shotId);
    if (!shot) { res.status(404).json({ error: { code: "NotFound", message: "分镜不存在" } }); return; }
    const allGens = [...(shot.generations||[]), ...(shot.active_generations||[]), ...(shot.trashed_generations||[])];
    const gen = allGens.find(g => g.generation_id === targetGenId);
    if (!gen) { res.status(404).json({ error: { code: "NotFound", message: "生成记录不存在" } }); return; }

    const reqLog = req.log;
    if (reqLog) reqLog.info({ picked_generation_id: targetGenId, kind: req.body?.kind || v.data.kind, shot_id: req.params.shotId }, "PICK generation");

    // 2026-07-10 audit 补漏 — 原子挑选: 锁内重读 generations 再翻 picked 标志, 防同镜并发
    // appendGeneration 追加的已扣费候选被锁外陈旧快照绝对覆盖冲掉 (同 autoPickGenerations 的修法).
    const pickKind: "first_frame" | "video" = v.data.kind === "first_frame" ? "first_frame" : "video";
    const picked = await pickGeneration(req.params.slug, req.params.epId, req.params.shotId, targetGenId, pickKind, {
      // 挑选首帧后进入 picked 状态(等待生成视频), 挑选视频后标记为 approved
      status: pickKind === "first_frame" ? "picked" : "approved",
      extraPatch: { picked_generation_id: targetGenId }, // legacy 冗余字段
    });
    if (!picked.ok) { res.status(409).json({ error: { code: "Conflict", message: "该候选已被移除，请刷新后重挑" } }); return; }

    res.json({ ok: true, shot: picked.shot, picked_generation: gen, kind: pickKind });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/shots/:shotId/approve
shotRouter.post("/series/:slug/episodes/:epId/shots/:shotId/approve", async (req, res, next) => {
  try {
    const shot = await readShot(req.params.slug, req.params.epId, req.params.shotId);
    if (!shot) { res.status(404).json({ error: { code: "NotFound", message: "分镜不存在" } }); return; }

    const updated = await updateShot(req.params.slug, req.params.epId, req.params.shotId, {
      status: "approved",
    });

    res.json({ ok: true, shot: updated });
  } catch (err) { next(err); }
});

// U8: DELETE /series/:slug/episodes/:epId/shots/:shotId — 软删分镜
shotRouter.delete("/series/:slug/episodes/:epId/shots/:shotId", async (req, res, next) => {
  try {
    const result = await trashShot(req.params.slug, req.params.epId, req.params.shotId);
    if (!result.ok) { res.status(404).json({ error: { code: "NotFound", message: "分镜不存在或删除失败" } }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/shots/:shotId/retake
shotRouter.post("/series/:slug/episodes/:epId/shots/:shotId/retake", async (req, res, next) => {
  try {
    const v = validate(RetakeSchema, req.body);
    if (handleValidationError(res, v)) return;

    const shot = await readShot(req.params.slug, req.params.epId, req.params.shotId);
    if (!shot) { res.status(404).json({ error: { code: "NotFound", message: "分镜不存在" } }); return; }

    // Mark for retake
    const updated = await updateShot(req.params.slug, req.params.epId, req.params.shotId, {
      status: "needs_regen",
      failures: [...(shot.failures || []), { at: new Date().toISOString(), stage: "retake", error: v.data.note || "user retake" }],
    });

    res.json({ ok: true, shot: updated, message: "分镜已标记为重新生成" });
  } catch (err) { next(err); }
});

// ─── Wave 1C: 废案箱操作 ─────────────────────────────────────────

// POST /series/:slug/episodes/:epId/shots/:shotId/generations/:genId/trash
shotRouter.post("/series/:slug/episodes/:epId/shots/:shotId/generations/:genId/trash", async (req, res, next) => {
  try {
    const result = await moveGenerationToTrash(req.params.slug, req.params.epId, req.params.shotId, req.params.genId);
    if (!result.ok) { res.status(404).json({ error: { code: "NotFound", message: "分镜或生成记录不存在" } }); return; }
    res.json({ ok: true, shot: result.shot, message: "已移入废案箱" });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/shots/:shotId/generations/:genId/restore
shotRouter.post("/series/:slug/episodes/:epId/shots/:shotId/generations/:genId/restore", async (req, res, next) => {
  try {
    const result = await restoreGenerationFromTrash(req.params.slug, req.params.epId, req.params.shotId, req.params.genId);
    if (!result.ok) { res.status(404).json({ error: { code: "NotFound", message: "废案记录不存在或已恢复" } }); return; }
    res.json({ ok: true, shot: result.shot, message: "已从废案箱恢复" });
  } catch (err) { next(err); }
});

// DELETE /series/:slug/episodes/:epId/shots/:shotId/generations/:genId (永久删除)
shotRouter.delete("/series/:slug/episodes/:epId/shots/:shotId/generations/:genId", async (req, res, next) => {
  try {
    const result = await permanentlyDeleteGeneration(req.params.slug, req.params.epId, req.params.shotId, req.params.genId);
    if (!result.ok) { res.status(404).json({ error: { code: "NotFound", message: "废案记录不存在" } }); return; }
    res.json({ ok: true, shot: result.shot, message: "已永久删除" });
  } catch (err) { next(err); }
});

// ─── B5: Retry-until-satisfied 正式化 ──────────────────────────────

// POST /series/:slug/episodes/:epId/shots/:shotId/retry-until-satisfied
shotRouter.post("/series/:slug/episodes/:epId/shots/:shotId/retry-until-satisfied", async (req, res, next) => {
  try {
    const v = validate(RetryUntilSatisfiedSchema, req.body);
    if (handleValidationError(res, v)) return;

    const shot = await readShot(req.params.slug, req.params.epId, req.params.shotId);
    if (!shot) { res.status(404).json({ error: { code: "NotFound", message: "分镜不存在" } }); return; }

    let startRetryJob: typeof import("../../jobs/retryJob").startRetryJob;
    try {
      ({ startRetryJob } = await import("../../jobs/retryJob"));
    } catch (importErr) {
      console.error("[shotController] Failed to load retryJob module:", importErr);
      res.status(500).json({ error: { code: "ModuleLoadError", message: "重试模块加载失败，请检查服务端日志" } }); return;
    }
    const job = await startRetryJob({
      series_slug: req.params.slug,
      episode_id: req.params.epId,
      shot_id: req.params.shotId,
      action: v.data.action === "generate_first_frames" ? "generate_first_frames" : "generate_videos",
      max_attempts: v.data.max_attempts,
      quality_threshold: v.data.quality_threshold,
      budget_cap_cny: v.data.budget_cap_cny,
      stop_on_first_green: v.data.stop_on_first_green,
      auto_pick_best: v.data.auto_pick_best,
    });

    res.json({
      ok: true,
      job_id: job.id,
      status: job.status,
      max_attempts: job.max_attempts,
      quality_threshold: job.quality_threshold,
      budget_cap_cny: job.budget_cap_cny,
      message: `已开始重试到满意 (最多 ${job.max_attempts} 次, 阈值 ${job.quality_threshold}, 预算 ¥${job.budget_cap_cny})`,
    });
  } catch (err) { next(err); }
});

// GET /series/:slug/episodes/:epId/shots/:shotId/retry-job — 查询 retry job 状态
shotRouter.get("/series/:slug/episodes/:epId/shots/:shotId/retry-job", async (req, res, next) => {
  try {
    let listRetryJobs: typeof import("../../jobs/retryJob").listRetryJobs;
    try {
      ({ listRetryJobs } = await import("../../jobs/retryJob"));
    } catch (importErr) {
      console.error("[shotController] Failed to load retryJob module:", importErr);
      res.status(500).json({ error: { code: "ModuleLoadError", message: "重试模块加载失败，请检查服务端日志" } }); return;
    }
    const jobs = await listRetryJobs({
      series_slug: req.params.slug,
      shot_id: req.params.shotId,
    });
    res.json({ jobs });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/shots/:shotId/retry-job/:jobId/cancel — 取消 retry job
shotRouter.post("/series/:slug/episodes/:epId/shots/:shotId/retry-job/:jobId/cancel", async (req, res, next) => {
  try {
    let cancelRetryJob: typeof import("../../jobs/retryJob").cancelRetryJob;
    try {
      ({ cancelRetryJob } = await import("../../jobs/retryJob"));
    } catch (importErr) {
      console.error("[shotController] Failed to load retryJob module:", importErr);
      res.status(500).json({ error: { code: "ModuleLoadError", message: "重试模块加载失败，请检查服务端日志" } }); return;
    }
    const job = await cancelRetryJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: { code: "NotFound", message: "重试任务不存在" } });
      return;
    }
    res.json({ ok: true, job });
  } catch (err) { next(err); }
});

// ─── Wave 2E: 参考图预览 ───────────────────────────────────────────

// GET /series/:slug/episodes/:epId/shots/:shotId/reference-preview
shotRouter.get("/series/:slug/episodes/:epId/shots/:shotId/reference-preview", async (req, res, next) => {
  try {
    const { slug, epId, shotId } = req.params;
    const shot = await readShot(slug, epId, shotId);
    if (!shot) { res.status(404).json({ error: { code: "NotFound", message: "分镜不存在" } }); return; }

    // 读取角色数据 (保持与 shot.character_ids 相同顺序)
    const charDataMap = new Map<string, { reference_image_set?: string[]; name: string }>();
    if (shot.character_ids && shot.character_ids.length > 0) {
      for (const charId of shot.character_ids) {
        const char = await readCharacter(slug, charId);
        if (char) {
          charDataMap.set(charId, {
            reference_image_set: char.reference_image_set,
            name: char.name,
          });
        }
      }
    }

    // 读取场景数据
    let sceneData: { reference_image_set?: string[]; name: string } | null = null;
    if (shot.scene_id) {
      const s = await readScene(slug, shot.scene_id);
      if (s) {
        sceneData = { reference_image_set: s.reference_image_set, name: s.name };
      }
    }

    // 读取风格板数量
    let moodBoardCount = 0;
    try {
      const moodRefs = await getMoodBoardRefImages(slug, 3);
      moodBoardCount = moodRefs.length;
    } catch {
      // 风格板不可用，静默
    }

    // 默认 supportsMultiReference=true (大多数 provider 支持多图)
    const supportsMultiRef = true;

    const characters = Array.from(charDataMap.values());
    const scene = sceneData ? { reference_image_set: sceneData.reference_image_set } : null;

    const summary = countReferenceImages({
      characters,
      scene,
      moodBoardCount,
      supportsMultiReference: supportsMultiRef,
    });

    // 构建来源清单
    const sources: Array<{ source_type: string; source_id: string; source_label: string; count: number }> = [];

    if (summary.character_refs > 0 && shot.character_ids) {
      for (const charId of shot.character_ids) {
        const charData = charDataMap.get(charId);
        const refCount = charData?.reference_image_set?.length ?? 0;
        if (refCount > 0) {
          sources.push({
            source_type: "character",
            source_id: charId,
            source_label: charData!.name || charId,
            count: supportsMultiRef ? refCount : 1,
          });
        }
      }
    }

    if (summary.scene_refs > 0 && shot.scene_id && sceneData) {
      const refCount = sceneData.reference_image_set?.length ?? 0;
      if (refCount > 0) {
        sources.push({
          source_type: "scene",
          source_id: shot.scene_id,
          source_label: sceneData.name || shot.scene_id,
          count: supportsMultiRef ? refCount : 1,
        });
      }
    }

    if (summary.mood_board_refs > 0) {
      sources.push({
        source_type: "mood_board",
        source_id: slug,
        source_label: "风格板",
        count: summary.mood_board_refs,
      });
    }

    res.json({
      shot_id: shotId,
      summary,
      sources,
      supports_multi_reference: supportsMultiRef,
    });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/shots/batch-toggle-last-frame (Wave 3B)
shotRouter.post("/series/:slug/episodes/:epId/shots/batch-toggle-last-frame", async (req, res, next) => {
  try {
    const v = validate(BatchToggleLastFrameSchema, req.body);
    if (handleValidationError(res, v)) return;

    const shots = await listShots(req.params.slug, req.params.epId);
    const updated: ShotData[] = [];
    for (const shot of shots) {
      const patched = await updateShot(req.params.slug, req.params.epId, shot.id, {
        use_prev_last_frame: v.data.use_prev_last_frame,
      });
      if (patched) updated.push(patched);
    }

    res.json({ ok: true, updated_count: updated.length, use_prev_last_frame: v.data.use_prev_last_frame });
  } catch (err) { next(err); }
});

// ─── W5-C: Shot Reorder ──────────────────────────────────────────────────────

// POST /series/:slug/episodes/:epId/shots/reorder
// Body: { shot_ids: string[] }  — 新的顺序数组（完整 ID 列表）
shotRouter.post("/series/:slug/episodes/:epId/shots/reorder", async (req, res, next) => {
  try {
    const { shot_ids } = req.body;
    if (!Array.isArray(shot_ids) || !shot_ids.every(id => typeof id === "string")) {
      res.status(400).json({ error: { code: "ValidationError", message: "shot_ids 必须是字符串数组" } });
      return;
    }
    const result = await reorderShots(req.params.slug, req.params.epId, shot_ids);
    if (!result.ok) {
      res.status(500).json({ error: { code: "ReorderFailed", message: "重排失败" } });
      return;
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── W5-C: Shot Trash (软删) / 恢复 / 列表 / 永久删 ──────────────────────────

// POST /series/:slug/episodes/:epId/shots/:shotId/trash
shotRouter.post("/series/:slug/episodes/:epId/shots/:shotId/trash", async (req, res, next) => {
  try {
    const result = await trashShot(req.params.slug, req.params.epId, req.params.shotId);
    if (!result.ok) { res.status(404).json({ error: { code: "NotFound", message: "分镜不存在或移入垃圾桶失败" } }); return; }
    res.json({ ok: true, message: "分镜已移入垃圾桶" });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/shots/:shotId/restore  (从垃圾桶恢复)
shotRouter.post("/series/:slug/episodes/:epId/shots/:shotId/restore", async (req, res, next) => {
  try {
    const result = await restoreTrashedShot(req.params.slug, req.params.epId, req.params.shotId);
    if (!result.ok) {
      // 2026-07-10 Fable P0-1 — 冲突: 这一集已有同编号在用分镜(多为重拆后新生成的), 恢复会覆盖它.
      // 绝不静默覆盖, 明确告知让用户先处理再恢复(铁律 #6 数据保留).
      if (result.reason === "conflict") {
        res.status(409).json({
          error: {
            code: "ShotIdConflict",
            message: "这一集已经有同编号的分镜在用了(可能是重新拆分后新生成的)。请先删除或移走它,再从垃圾桶恢复这一条。",
          },
        });
        return;
      }
      res.status(404).json({ error: { code: "NotFound", message: "垃圾桶中找不到该分镜" } });
      return;
    }
    res.json({ ok: true, shot: result.shot, message: "分镜已恢复" });
  } catch (err) { next(err); }
});

// GET /series/:slug/trash[?epId=<epId>]  — 列出系列或指定集的垃圾桶
shotRouter.get("/series/:slug/trash", async (req, res, next) => {
  try {
    const epId = typeof req.query.epId === "string" ? req.query.epId : undefined;
    const shots = await listTrashedShots(req.params.slug, epId);
    // P0-2 (2026-05-29): 铁律 #9 toC 兜底 — 附上 episode_index, 让前端渲染"第 N 集"而非 ULID.
    // 构建 episode_id → episode.index 映射, O(episodes) 一次查找覆盖所有分镜.
    let episodeIndexMap: Map<string, number> = new Map();
    try {
      const episodes = await listEpisodes(req.params.slug);
      for (const ep of episodes) {
        episodeIndexMap.set(ep.id, ep.index);
      }
    } catch { /* 查集列表失败不阻塞, episode_index 缺失前端会 fallback */ }
    const shotsWithEpIdx = shots.map((s) => ({
      ...s,
      episode_index: s.episode_id ? (episodeIndexMap.get(s.episode_id) ?? undefined) : undefined,
    }));
    res.json({ shots: shotsWithEpIdx });
  } catch (err) { next(err); }
});

// DELETE /series/:slug/episodes/:epId/shots/:shotId/trash  (永久删除垃圾桶中的分镜)
shotRouter.delete("/series/:slug/episodes/:epId/shots/:shotId/trash", async (req, res, next) => {
  try {
    const result = await permanentlyDeleteTrashedShot(req.params.slug, req.params.epId, req.params.shotId);
    if (!result.ok) { res.status(404).json({ error: { code: "NotFound", message: "垃圾桶中找不到该分镜" } }); return; }
    res.json({ ok: true, message: "已永久删除" });
  } catch (err) { next(err); }
});
