/**
 * Video (视频) endpoints — 拆自原 shotStageController.ts。
 *
 * 覆盖 7 个 endpoint:
 *   - POST  /api/v2/shots/:sid/video/import-local
 *   - POST  /api/v2/series/:slug/episodes/:epId/shots/:sid/stage/video/generate
 *   - POST  /api/v2/shots/:sid/video/generate
 *   - POST  /api/v2/series/:slug/episodes/:epId/shots/:sid/stage/video/generate/dry-run
 *   - POST  /api/v2/shots/:sid/video/generate/dry-run
 *   - PATCH /api/v2/series/:slug/episodes/:epId/shots/:sid/stage/video/candidate/:vid
 *   - PATCH /api/v2/shots/:sid/video/candidate/:vid
 *
 * scoped + flat 的 generate 共用 `dispatchVideoGenerate`。
 */

import { Router, type Request, type Response } from "express";
import {
  readShot,
  readSeries,
  updateShot,
  pickGeneration,
  appendGeneration,
  moveGenerationToTrash,
  restoreGenerationFromTrash,
  renameGenerationLabel,
  type ShotGeneration,
  type ShotData,
} from "../seriesStore";
import { buildVideoDryRunResult } from "../../../application/generation/videoDryRun";
import { loggerSync } from "../../../../../../packages/core/src/logger";
// 2026-05-20 display_name 体系统一: 候选 rename 同步 assetMetaRepo
import { updateAssetMeta } from "../../../repositories/assetMetaRepo";
import {
  ensureSourceVideoUsable,
  err,
  readScopedShot,
  resolveFlatShotLocatorOrErr,
} from "./shared";
import { dispatchVideoGenerate } from "./dispatch";

export const videoRouter = Router();

// ───────── Video import-local (POST /shots/:sid/video/import-local) ─────────
//
// 2026-05-18: 用户原话 "复制完整提示词到外部 AI 生成之后导入回来" 的 video 路径补全.
// 前面 firstframe/import-image 接 image, 这里接 mp4/webm/mov 等 video, 作为视频候选加入
// shot.video_candidates 池. 用户在外部 AI (Kling/Sora/Runway/Pika) 用我们 markdown
// 提示词生成的视频可以一键拖回候选区.
//
// Body: { video_base64: string, mime?: string ("video/mp4"), note?: string,
//         duration_sec?: number, width?: number, height?: number }
videoRouter.post("/shots/:sid/video/import-local", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    // 2026-07-22 X3-3 (A3-4): 安全定位 — 导入的外部视频不再可能落到跨系列同号的错分镜.
    const loc = await resolveFlatShotLocatorOrErr(req, res, sid);
    if (!loc) return;
    const shot = await readShot(loc.slug, loc.epId, loc.shotId);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);

    const {
      video_base64,
      mime = "video/mp4",
      note = "",
      duration_sec,
      width,
      height,
    } = req.body ?? {};
    if (typeof video_base64 !== "string" || video_base64.length < 100) {
      return err(res, 400, "ValidationError", "需要 video_base64 (>=100 chars 的 base64 字符串)");
    }
    const cleaned = video_base64.replace(/^data:[^,]+,/, "");
    let buffer: Buffer;
    try {
      buffer = Buffer.from(cleaned, "base64");
    } catch {
      return err(res, 400, "ValidationError", "video_base64 不是合法的 base64");
    }
    // 简单限流: 单视频最大 200MB (避免 OOM)
    const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
    if (buffer.byteLength > MAX_VIDEO_BYTES) {
      return err(res, 413, "PayloadTooLarge", `视频超出 ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB 限制 (当前 ${Math.round(buffer.byteLength / 1024 / 1024)}MB)`);
    }

    // 落 vault — 跟其他 video provider 走同样的 kind=video 路径
    const { saveToVault } = await import("../../../../../../packages/library/src/assetVault");
    const vaultEntry = await saveToVault({
      buffer,
      kind: "video",
      mime,
      context: {
        kind: "shot_video",
        series_slug: loc.slug,
        shot_id: loc.shotId,
      },
      provider_id: "manual_import",
      width: typeof width === "number" ? width : 0,
      height: typeof height === "number" ? height : 0,
      tags: ["manual_import", `note:${String(note).slice(0, 40)}`],
    });

    // 2026-05-22 (critical fix): 必须把视频拷贝到 series/assets/videos + addAsset 注册,
    // 否则 compose 路径 readAsset(slug, asset_id) 找不到 path → fallback mock,
    // 用户合成出来全是 mock 占位视频 (这是 user 反馈的真 bug).
    const fs = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const { ensureDir, DATA_ROOT } = await import("../../../../../../packages/core/src/index");
    const { addAsset } = await import("../../../repositories/assetRepo");
    const crypto = await import("node:crypto");
    const videosDir = pathMod.join(DATA_ROOT, "series", loc.slug, "assets", "videos");
    await ensureDir(videosDir);
    const ext = (mime === "video/webm" ? "webm" : "mp4");
    const filename = `shot_${loc.shotId}_import_${Date.now()}_${crypto.randomUUID().slice(0, 6)}.${ext}`;
    const seriesAssetPath = `assets/videos/${filename}`;
    await fs.writeFile(pathMod.join(videosDir, filename), buffer);
    const asset = await addAsset(loc.slug, {
      series_slug: loc.slug,
      kind: "video",
      tags: [`shot:${loc.shotId}`, "manual_import"],
      path: seriesAssetPath,
      filename,
      mime,
      size_bytes: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    });

    // 2026-05-22: 本地导入视频自动 picked (如果当前 shot 没 picked_video_generation_id),
    // 且 status 自动 → "approved" — 用户明确导入这个视频, 不需要再手动点"选定"+"审批".
    // 用户原话: "我五个视频都导入了... 难道必须有语音才能合成吗?
    // 为什么不让我进入下一步" — readiness 卡在没 picked + status≠approved.
    const shouldAutoPick = !shot.picked_video_generation_id;

    const generation: ShotGeneration = {
      generation_id: vaultEntry.vault_id,
      type: "video",
      provider: "manual_import",
      vault_id: vaultEntry.vault_id,
      asset_id: asset.asset_id,
      path: seriesAssetPath,
      status: "done",
      created_at: new Date().toISOString(),
      prompt: shot.prompt_vid ?? "",
      prompt_used: shot.prompt_vid ?? "",
      picked: shouldAutoPick,
      cost_cny: 0,
      duration_sec_actual: typeof duration_sec === "number" ? duration_sec : undefined,
    };

    // 2026-07-10 audit 补漏 — 原子追加: 之前 readShot(锁外, 见上 line 56)+updateShot(绝对
    // generations 数组). 同镜并发落盘(用户导入视频与另一路视频生成/重抽同时写)各自锁外读到
    // 同一基线, 各自整段 updateShot → 后写覆盖先写, 把已扣费候选视频冲掉. 改用
    // shotRepo.appendGeneration 锁内重读+append+write, 与 firstframe import-local / shotVideoAdapter 同款.
    const extraPatch: Partial<ShotData> = {};
    let statusPatch: ShotData["status"] | undefined;
    if (shouldAutoPick) {
      extraPatch.picked_video_generation_id = vaultEntry.vault_id;
      // 用户明确导入并选定这个视频 = 已审批
      statusPatch = "approved";
    }
    const updated = await appendGeneration(loc.slug, loc.epId, loc.shotId, generation, {
      ...(statusPatch !== undefined ? { status: statusPatch } : {}),
      extraPatch,
    });
    if (!updated) return err(res, 404, "NotFound", `shot ${sid} 未找到`);

    res.json({
      ok: true,
      generation_id: vaultEntry.vault_id,
      vault_id: vaultEntry.vault_id,
      asset_id: asset.asset_id,
      auto_picked: shouldAutoPick,
      message: shouldAutoPick
        ? "视频已导入并选定为本镜最终视频, 状态改为已审批"
        : "视频已导入,作为候选加入视频池",
    });
  } catch (e) { next(e); }
});

// ───────── Video generate ─────────
//
// W3-A (2026-05-15): body 新增可选字段
//   - prompt_override?: string         — 审核弹窗里用户修改过的完整 motion_prompt; 优先级最高
//   - user_extra_instruction?: string  — 用户额外要求, 喂给 compiler 拼到 full_prompt
//   - motion_prompt?: string           — 旧契约保留 (旧 caller 直接传一坨字符串)
//
// 取舍策略:
//   1) 有 prompt_override → 直接传 orchestrator.prompt_override
//   2) 否则 (有 motion_prompt 或 user_extra_instruction) → compiler 拼出 full_prompt
//      → 传 orchestrator.prompt_override
//   3) 都没有 → orchestrator 用 shot.prompt_vid 兜底 (legacy 行为)
videoRouter.post("/series/:slug/episodes/:epId/shots/:sid/stage/video/generate", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const shot = await readScopedShot(slug, epId, sid);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    await dispatchVideoGenerate({
      slug, epId, shotId: sid, shot, req, res, next,
      // 2026-05-27 P1-V4 — scoped 跟 flat 对齐, 失败都写 failures.jsonl 让 /cockpit/failures
      // 可见. 之前 scoped=false 让 ShotStage 单镜路径生视频失败时 cockpit 看不到,
      // flat 路径同样动作能看到, 不一致.
      appendFailureOnError: true,
    });
  } catch (e) { next(e); }
});

videoRouter.post("/shots/:sid/video/generate", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    // 2026-07-22 X3-3 (A3-4): 付费视频生成——歧义时 409 (不含糊定位), 这是"扣错分镜的钱"最直接的风险面.
    const loc = await resolveFlatShotLocatorOrErr(req, res, sid);
    if (!loc) return;
    const shot = await readShot(loc.slug, loc.epId, loc.shotId);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    await dispatchVideoGenerate({
      slug: loc.slug, epId: loc.epId, shotId: loc.shotId, shot, req, res, next,
      // flat 历史上写 failures.jsonl, 维持旧行为
      appendFailureOnError: true,
    });
  } catch (e) { next(e); }
});

// ───────── Video generate · dry-run (O3) ─────────
//
// 不调 provider, 不扣费, 不抢真实视频锁。仅:
//   - 解析 shot + model_ref (provider + model)
//   - 检查 provider key 是否存在 (不回显 key)
//   - 构造将要发出的 provider 请求 payload (敏感字段 redact 为 ****)
//   - 估算费用 (本地 mock 始终为 0)
//   - 返回 is_real_provider / will_acquire_real_lock / real_lock_held_by 供 UI 提示
//
// 真实 provider 在 key 缺失时返回 HTTP 400 + { error: "key_missing" }; 其他情况 HTTP 200。
videoRouter.post("/series/:slug/episodes/:epId/shots/:sid/stage/video/generate/dry-run", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const shot = await readScopedShot(slug, epId, sid);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);

    const { motion_prompt, duration_s, count, model, first_frame_id, seed, prompt_override, source_video_generation_id } = req.body ?? {};
    if (!ensureSourceVideoUsable(res, shot, source_video_generation_id)) return;
    // W7-sweep (2026-05-16): 与 generate 路径保持一致 — caller 传 series.defaults 作为最末层 fallback。
    // helper 已经在三层都空时 throw ProviderNotSelectedError(error middleware 自动转 400)。
    const seriesForDryRun = await readSeries(slug);
    const seriesDefaultVideoProvider = seriesForDryRun?.defaults?.video_provider_id?.trim() || undefined;
    const result = buildVideoDryRunResult(shot, {
      model,
      motion_prompt,
      prompt_override,
      duration_s,
      count,
      first_frame_id,
      source_video_generation_id,
      seed,
    }, { fallbackVideoModelRef: shot.video_model_ref?.trim() || seriesDefaultVideoProvider });

    if (!result.ok && result.error === "key_missing") {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (e) { next(e); }
});

videoRouter.post("/shots/:sid/video/generate/dry-run", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    // 2026-07-22 X3-3 (A3-4): dry-run 也走安全定位, 让预览的分镜与真实生成的目标分镜一致(歧义 409).
    const loc = await resolveFlatShotLocatorOrErr(req, res, sid);
    if (!loc) return;
    const shot = await readShot(loc.slug, loc.epId, loc.shotId);
    if (!shot) return err(res, 404, "NotFound", `shot ${sid} 未找到`);

    const { motion_prompt, duration_s, count, model, first_frame_id, seed, prompt_override, source_video_generation_id } = req.body ?? {};
    if (!ensureSourceVideoUsable(res, shot, source_video_generation_id)) return;
    // W7-sweep (2026-05-16): caller 传 series.defaults.video_provider_id 作为最末层 fallback。
    const seriesForDryRun = await readSeries(loc.slug);
    const seriesDefaultVideoProvider = seriesForDryRun?.defaults?.video_provider_id?.trim() || undefined;
    const result = buildVideoDryRunResult(shot, {
      model,
      motion_prompt,
      prompt_override,
      duration_s,
      count,
      first_frame_id,
      source_video_generation_id,
      seed,
    }, { fallbackVideoModelRef: shot.video_model_ref?.trim() || seriesDefaultVideoProvider });

    if (!result.ok && result.error === "key_missing") {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (e) { next(e); }
});

// ───────── Video candidate action ─────────
videoRouter.patch("/series/:slug/episodes/:epId/shots/:sid/stage/video/candidate/:vid", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const epId = String(req.params.epId);
    const sid = String(req.params.sid);
    const vid = String(req.params.vid);
    const { action, label } = req.body ?? {};
    const exists = await readScopedShot(slug, epId, sid);
    if (!exists) return err(res, 404, "NotFound", `shot ${sid} 未找到`);
    if (action === "select") {
      // 2026-05-22 P0-A entity-first 双事实修复: select 同时写
      //   1) shot.picked_video_generation_id (主真理源, pickedAssetResolver 读这个)
      //   2) generation.picked 标志位 (legacy 冗余信号)
      // 若只写 (1) → 老数据上 generation.picked=true 留在另一段视频上 → ffmpegBuilder /
      // pickedAssetResolver 老数据 fallback 路径会拿到错的, 出黑屏 bug.
      // 2026-07-09 audit 修复 — 先校验候选真实存在再写 picked 指针 + approved. 否则陈旧/多标签页传来
      // 的已删候选 id 会写成悬空 picked_video_generation_id 且 status=approved, 合成时 pickedAssetResolver
      // 抛 generation-not-found (该镜变占位). 与 shotController.pick 的存在性校验补齐一致.
      // 2026-07-10 audit (终验揪出兄弟点) — 原子挑选: 锁内重读 generations 再翻 picked, 防同镜并发
      // appendGeneration 追加的已扣费候选被锁外陈旧快照绝对覆盖冲掉 (最高频手动挑卡路径, 与 shotController.pick 同修法).
      const picked = await pickGeneration(slug, epId, sid, vid, "video", {
        status: "approved",
        extraPatch: { picked_generation_id: vid },
      });
      if (!picked.ok) return err(res, 404, "GenerationNotFound", "该视频候选不存在或已被移除,请刷新后重试");
    } else if (action === "reject") {
      await moveGenerationToTrash(slug, epId, sid, vid);
    } else if (action === "restore") {
      await restoreGenerationFromTrash(slug, epId, sid, vid);
    } else if (action === "rename") {
      await renameGenerationLabel(slug, epId, sid, vid, label);
      // 2026-05-20 display_name 体系统一: 双写到 assetMetaRepo (单一真理源).
      try {
        const updatedShot = await readScopedShot(slug, epId, sid);
        const gen = [
          ...(updatedShot?.active_generations ?? []),
          ...(updatedShot?.trashed_generations ?? []),
          ...(updatedShot?.generations ?? []),
        ].find((g) => g.generation_id === vid);
        const dn = typeof label === "string" && label.trim() ? label.trim() : undefined;
        await updateAssetMeta(vid, { display_name: dn });
        if (gen?.vault_id) await updateAssetMeta(gen.vault_id, { display_name: dn });
        if (gen?.asset_id) await updateAssetMeta(gen.asset_id, { display_name: dn });
      } catch (metaErr) {
        loggerSync().warn(`[video candidate rename] assetMetaRepo 同步失败 (非致命): ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`);
      }
    } else {
      return err(res, 400, "ValidationError", `action 必须是 select|reject|restore|rename`);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

videoRouter.patch("/shots/:sid/video/candidate/:vid", async (req: Request, res: Response, next) => {
  try {
    const sid = String(req.params.sid);
    const vid = String(req.params.vid);
    const { action } = req.body ?? {};
    // 2026-07-22 X3-3 (A3-4): 安全定位 — 挑视频/废弃不再可能作用到跨系列同号的错分镜.
    const loc = await resolveFlatShotLocatorOrErr(req, res, sid);
    if (!loc) return;
    if (action === "select") {
      // 2026-05-22 P0-A entity-first 双事实修复 (flat 路径同步 scoped):
      // 同时写 picked_video_generation_id (主真理源) + generation.picked (legacy 冗余).
      // 2026-07-10 audit (终验揪出兄弟点) — 原子挑选, 防并发丢已扣费候选 (同 scoped 路径).
      const picked = await pickGeneration(loc.slug, loc.epId, loc.shotId, vid, "video", {
        status: "approved",
        extraPatch: { picked_generation_id: vid },
      });
      if (!picked.ok) return err(res, 404, "GenerationNotFound", "该视频候选不存在或已被移除,请刷新后重试");
    } else if (action === "reject") {
      await moveGenerationToTrash(loc.slug, loc.epId, loc.shotId, vid);
    } else if (action === "restore") {
      await restoreGenerationFromTrash(loc.slug, loc.epId, loc.shotId, vid);
    } else if (action === "rename") {
      // 2026-05-27 audit P0 #3: flat 路径之前漏 rename 分支, 跟 scoped 路径 line 327-343 同款.
      // 用户在 flat URL 下 InlineLabel 重命名视频候选返 400 "action 必须是 select|reject|restore",
      // 跟首帧 flat / 视频 scoped 一致行为割裂.
      const { label } = req.body ?? {};
      await renameGenerationLabel(loc.slug, loc.epId, loc.shotId, vid, label);
      try {
        const updatedShot = await readScopedShot(loc.slug, loc.epId, loc.shotId);
        const gen = [
          ...(updatedShot?.active_generations ?? []),
          ...(updatedShot?.trashed_generations ?? []),
          ...(updatedShot?.generations ?? []),
        ].find((g) => g.generation_id === vid);
        const dn = typeof label === "string" && label.trim() ? label.trim() : undefined;
        await updateAssetMeta(vid, { display_name: dn });
        if (gen?.vault_id) await updateAssetMeta(gen.vault_id, { display_name: dn });
        if (gen?.asset_id) await updateAssetMeta(gen.asset_id, { display_name: dn });
      } catch (metaErr) {
        loggerSync().warn(`[video candidate rename flat] assetMetaRepo 同步失败 (非致命): ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`);
      }
    } else {
      return err(res, 400, "ValidationError", `action 必须是 select|reject|restore|rename`);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});
