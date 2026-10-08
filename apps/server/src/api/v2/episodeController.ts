/**
 * v2 Episode Controller — CRUD for episodes within a series
 *
 * Extended in P33: script editing, revision, version history, revert
 */

import { Router } from "express";
import { handleValidationError } from "./validateHelpers";
import fs from "node:fs/promises";
import path from "node:path";
import {
  listEpisodes, readEpisode, createEpisode, updateEpisode, deleteEpisode,
  saveVersionFile, listCharacters, listShots, readSeries,
  type EpisodeVersion, type EpisodeData,
} from "./seriesStore";
// 2026-07-22 X6-2 (A3-8): 分集软删恢复三件套 — 直接从 episodeRepo 引 (与本包 file ownership 对齐,
// 不动 seriesStore.ts barrel)。
import {
  listTrashedEpisodes, restoreTrashedEpisode, permanentDeleteTrashedEpisode,
} from "../../repositories/episodeRepo";
import { validate, CreateEpisodeSchema, PatchEpisodeSchema } from "./validators";
import { importStoryboardFromPaste } from "../../application/importStoryboard/importStoryboard";
// 2026-07-22 X3-2 (A4-15): revert 统一走磁盘版 use-case(去重, 见下 revert 路由注释)
import { revertEpisodeVersion } from "../../application/export/exportUseCases";
// 2026-07-22 X3-4 (A6-3): 粘贴导入确认门复用 plan-storyboard 同一 force 判据(解耦)
import { isStoryboardForceRequested } from "./orchestration/planStoryboardRoutes";
import { scrubForClient } from "../../../../../packages/core/src/logger";
import {
  loadLlmConfig, MockLlmProvider, OpenAiCompatibleProvider,
} from "../../../../../packages/providers/src/index";
import { JobLogger, pathExists, readJson, writeJson, DATA_ROOT } from "../../../../../packages/core/src/index";
import { revoiceEpisode } from "../../../../../packages/render/src/voiceReplacer";
import { z } from "zod";
import { buildRevisePromptParts } from "../../application/preview/previewPrompts";
import { getRegistry, resolveLlmProviderId } from "./orchestration/_shared/registry";

export const episodeRouter = Router();

/**
 * 2026-05-26 — 给单个 episode 聚合 shot 维度统计 (前端卡片时长 / 进度显示用).
 *
 * 字段语义:
 * - actual_shot_count: 真实分镜数 (vs target_shot_count = LLM 拆镜时的目标值)
 * - picked_video_count: 已选定视频的分镜数
 * - picked_video_total_duration_sec: 已选视频的真长累加 (优先 duration_sec_actual)
 *
 * 用户痛点修复 (2026-05-26): 分集卡片只看 target_duration_sec 显示"时长待定",
 * 即使用户每个分镜都选了视频也不更新. 现在前端可优先用 picked_video_total_duration_sec 真长.
 *
 * 性能: 每个 series episodes 数量有限 (一般 < 20), 串行 read 每集 shots 即可.
 */
export async function enrichEpisodeWithStats(slug: string, ep: EpisodeData): Promise<EpisodeData & {
  actual_shot_count?: number;
  picked_first_frame_count?: number;
  picked_video_count?: number;
  picked_video_total_duration_sec?: number;
}> {
  let shots: Awaited<ReturnType<typeof listShots>> = [];
  try {
    shots = await listShots(slug, ep.id);
  } catch {
    return ep;
  }
  let pickedDur = 0;
  let pickedVideoCount = 0;
  let pickedFirstFrameCount = 0;
  for (const shot of shots) {
    // 2026-05-27: 加 picked_first_frame_count — 一键生成 launcher 需要展示
    // "当前已有多少镜挑了首帧" 的进度统计.
    if (shot.picked_first_frame_generation_id) {
      pickedFirstFrameCount += 1;
    }
    const pickedId = shot.picked_video_generation_id ?? shot.picked_generation_id;
    if (!pickedId) continue;
    const gens = (shot.active_generations && shot.active_generations.length > 0)
      ? shot.active_generations
      : (shot.generations ?? []);
    const gen = gens.find((g: { generation_id: string; type?: string }) =>
      g.generation_id === pickedId && (g.type === "video" || !g.type),
    );
    if (!gen) continue;
    const dur = (gen as { duration_sec_actual?: number; duration_sec_requested?: number }).duration_sec_actual
      ?? (gen as { duration_sec_requested?: number }).duration_sec_requested
      ?? shot.duration_sec;
    if (typeof dur === "number" && dur > 0) {
      pickedDur += dur;
      pickedVideoCount += 1;
    }
  }
  return {
    ...ep,
    actual_shot_count: shots.length,
    picked_first_frame_count: pickedFirstFrameCount,
    picked_video_count: pickedVideoCount,
    ...(pickedDur > 0 ? { picked_video_total_duration_sec: pickedDur } : {}),
  };
}

// GET /series/:slug/episodes
episodeRouter.get("/series/:slug/episodes", async (req, res, next) => {
  try {
    const episodes = await listEpisodes(req.params.slug);
    const enriched = await Promise.all(
      episodes.map((ep) => enrichEpisodeWithStats(req.params.slug, ep)),
    );
    res.json({ episodes: enriched });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes
episodeRouter.post("/series/:slug/episodes", async (req, res, next) => {
  try {
    const v = validate(CreateEpisodeSchema, req.body);
    if (handleValidationError(res, v)) return;
    const episode = await createEpisode(req.params.slug, v.data);
    res.status(201).json({ episode });
  } catch (err) { next(err); }
});

// GET /series/:slug/episodes/:epId
episodeRouter.get("/series/:slug/episodes/:epId", async (req, res, next) => {
  try {
    const episode = await readEpisode(req.params.slug, req.params.epId);
    if (!episode) { res.status(404).json({ error: { code: "NotFound", message: "集不存在" } }); return; }
    res.json({ episode });
  } catch (err) { next(err); }
});

// PATCH /series/:slug/episodes/:epId
episodeRouter.patch("/series/:slug/episodes/:epId", async (req, res, next) => {
  try {
    const v = validate(PatchEpisodeSchema, req.body);
    if (handleValidationError(res, v)) return;
    const episode = await updateEpisode(req.params.slug, req.params.epId, v.data);
    if (!episode) { res.status(404).json({ error: { code: "NotFound", message: "集不存在" } }); return; }
    res.json({ episode });
  } catch (err) { next(err); }
});

// DELETE /series/:slug/episodes/:epId
episodeRouter.delete("/series/:slug/episodes/:epId", async (req, res, next) => {
  try {
    const ok = await deleteEpisode(req.params.slug, req.params.epId);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "集不存在" } }); return; }
    res.json({ ok: true, message: "集已删除" });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// 2026-07-22 X6-2 (A3-8): 分集回收站 — list / restore / permanent-delete.
// 历史 deleteEpisode 走软删到 episodes/.trash/<epId>_<ts> 但**只有删无恢复**, 前端却宣称"可恢复"=撒谎.
// 补齐恢复入口, 兑现铁律 #6 (软删必须真能恢复). 路径段 episodes-trash 与 episodes/:epId 天然区分, 无路由歧义.
// ═══════════════════════════════════════════════════════════════════

// GET /series/:slug/episodes-trash
episodeRouter.get("/series/:slug/episodes-trash", async (req, res, next) => {
  try {
    const episodes = await listTrashedEpisodes(req.params.slug);
    res.json({ episodes, total: episodes.length });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes-trash/:trashId/restore
episodeRouter.post("/series/:slug/episodes-trash/:trashId/restore", async (req, res, next) => {
  try {
    const result = await restoreTrashedEpisode(req.params.slug, req.params.trashId);
    if (!result.ok) {
      if (result.reason === "conflict") {
        res.status(409).json({
          error: {
            code: "EpisodeIdTaken",
            message: "这一集的编号已被后来新建的集占用,无法直接放回原位。请先删除或改动占用编号的新集后再恢复。",
          },
        });
        return;
      }
      res.status(404).json({ error: { code: "NotFound", message: "回收站里找不到这一集" } });
      return;
    }
    res.json({ ok: true, episode_id: result.episode_id, message: "这一集已恢复" });
  } catch (err) { next(err); }
});

// DELETE /series/:slug/episodes-trash/:trashId  (永久删除, 不可恢复)
episodeRouter.delete("/series/:slug/episodes-trash/:trashId", async (req, res, next) => {
  try {
    const ok = await permanentDeleteTrashedEpisode(req.params.slug, req.params.trashId);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "回收站里找不到这一集" } }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ====================================================================
// P33 — Script Canvas: revision, version history, revert
// ====================================================================

// PATCH /series/:slug/episodes/:epId  (script_md update — auto-save)
// This extends the existing PATCH above; the existing one handles general fields.
// script_md is handled via the PatchEpisodeSchema validator.

// GET /series/:slug/episodes/:epId/versions
episodeRouter.get("/series/:slug/episodes/:epId/versions", async (req, res, next) => {
  try {
    const episode = await readEpisode(req.params.slug, req.params.epId);
    if (!episode) { res.status(404).json({ error: { code: "NotFound", message: "集不存在" } }); return; }
    res.json({ versions: episode.versions || [] });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/revise
// Body: { user_note, scope: "global"|"paragraph"|"dialog_only", selection?: { start, end }, overrides? }
episodeRouter.post("/series/:slug/episodes/:epId/revise", async (req, res, next) => {
  try {
    const { slug, epId } = req.params;
    const episode = await readEpisode(slug, epId);
    if (!episode) { res.status(404).json({ error: { code: "NotFound", message: "集不存在" } }); return; }

    const { user_note, scope, selection, overrides, prompt_override } = req.body as {
      user_note?: string;
      scope?: "global" | "paragraph" | "dialog_only";
      selection?: { start: number; end: number };
      overrides?: Record<string, string>;
      /** 2026-05-21 — 接 PromptReview 修改后回填 (铁律 #12 批改+发送一致) */
      prompt_override?: { systemPrompt?: string; userPrompt?: string };
    };

    const note = String(user_note || "").trim();
    if (!note) { res.status(400).json({ error: { code: "ValidationError", message: "user_note 不能为空" } }); return; }

    const built = await buildRevisePromptParts({
      slug,
      episodeId: epId,
      user_note: note,
      scope,
      selection,
      overrides,
    });
    const reviseNote = built.note;
    // 2026-05-21 — prompt_override 优先 (铁律 #12), 没传走 helper 拼装
    const systemPrompt = prompt_override?.systemPrompt?.trim() || built.systemPrompt;
    const userPrompt = prompt_override?.userPrompt?.trim() || built.userPrompt;

    // 2026-05-21 — 删 silent mock fallback (红线 #1 禁伪 mock).
    // 历史 bug: config.mock=true 时 MockLlmProvider silent 返回假改写, 用户没填 Key
    //   得到假成功 → 写到 script_versions 假数据. W7 主流量已清, 这条 legacy v2 endpoint 漏了.
    // 改成跟主流量一致: 走 LLM provider chain + 严格无 Key 时 throw HTTP 400 + key_missing.
    const llmOverrideId = (overrides?.llm_provider_id as string | undefined)?.trim() || undefined;
    const registry = getRegistry();
    const series = await readSeries(slug);
    const resolvedProviderId = llmOverrideId || resolveLlmProviderId((series?.defaults ?? {}) as Record<string, any>);
    const llmChain = resolvedProviderId
      ? [resolvedProviderId, ...registry.listAvailable("llm").map((p) => p.id).filter((id) => id !== resolvedProviderId)]
      : registry.listAvailable("llm").map((p) => p.id);
    if (llmChain.length === 0) {
      res.status(400).json({ error: { code: "key_missing", message: "请先在设置中配置默认 LLM 模型,或在生成时选择 provider" } });
      return;
    }
    // 简单 fallback 链 — 第一个 provider 失败试下一个
    let result: string = "";
    let lastErr: unknown;
    for (const providerId of llmChain) {
      try {
        // 2026-05-28 audit P1 type-safety — LlmProvider 接口只有 complete/healthCheck, 这里走老 callText/callJson
        // (老 LLM 接口, ikunProvider 等仍提供), 用 unknown narrowing 替代 (provider as any)
        const provider = registry.getLlm(providerId) as unknown as {
          callText?: (input: { agentName: string; promptFile: string; inputSummary: string; system: string; user: string }) => Promise<string>;
          callJson?: (input: { agentName: string; promptFile: string; inputSummary: string; system: string; user: string }) => Promise<{ revised_script?: string }>;
        };
        if (typeof provider.callText === "function") {
          result = await provider.callText({
            agentName: "Script Revision Agent",
            promptFile: "script_revision.md",
            inputSummary: reviseNote.slice(0, 200),
            system: systemPrompt,
            user: userPrompt,
          });
        } else if (typeof provider.callJson === "function") {
          const jsonResult = await provider.callJson({
            agentName: "Script Revision Agent",
            promptFile: "script_revision.md",
            inputSummary: reviseNote.slice(0, 200),
            system: systemPrompt + "\n\n请返回 JSON: { \"revised_script\": \"修改后的完整剧本\" }",
            user: userPrompt,
          });
          result = jsonResult?.revised_script || "";
        } else {
          throw new Error(`Provider ${providerId} 既不支持 callText 也不支持 callJson`);
        }
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;

    const revisedScript = result.trim();
    // 2026-07-09 audit 修复 (铁律 #5 真实保存+状态精确) — LLM 返回空串 (内容审查拒答 / callJson
    // 缺 revised_script 键) 时 lastErr 为 undefined 不抛错, 旧代码会把当前剧本静默覆盖为空并报
    // ok:true, 用户看剧本凭空清空却被告知"修订成功". 空结果一律拒绝, 不动 script_md / 不推空版本.
    if (!revisedScript) {
      res.status(502).json({
        error: { code: "empty_llm_result", message: "AI 返回了空结果,未改动剧本。请重试,或换一个模型再试。" },
      });
      return;
    }
    const now = new Date().toISOString();
    const newVersion = (episode.version || 1) + 1;

    // Save version history (inline in episode.json)
    if (!episode.versions) episode.versions = [];
    const versionRecord: EpisodeVersion = {
      version: newVersion,
      created_at: now,
      source: "ai_revise",
      summary: reviseNote.slice(0, 100),
      script_md: revisedScript,
    };
    episode.versions.push(versionRecord);

    // Update episode (inline storage)
    episode.script_md = revisedScript;
    episode.version = newVersion;
    await updateEpisode(slug, epId, {
      script_md: revisedScript,
      version: newVersion,
      versions: episode.versions,
    });

    // Also persist version as file on disk (episodes/<epId>/versions/v<N>.json)
    await saveVersionFile(slug, epId, versionRecord);

    res.json({
      ok: true,
      revised_script: revisedScript,
      diff_summary: reviseNote,
      version: newVersion,
    });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/revert
// Body: { to_version }
//
// 2026-07-22 X3-2 (A4-15): revert 历史上重复注册两次 —— 此处(episodeController, index.ts 里先注册)
// 的内存版, 与 exportRoutes.ts 委托 revertEpisodeVersion 的磁盘版. Express 按注册顺序命中第一个,
// 磁盘版永远被遮蔽=死代码. 两实现行为差异(已核实, 写入执行日志):
//   · 版本查找: 内存版只看 episode.versions 数组; 磁盘版先 readVersionFile(磁盘)再回落内存数组 = 超集.
//   · 写入真理源: 内存版更新 episode.script_md **元数据**(GET episode / 脚本画布读它)但不写 script.md 文件;
//     磁盘版写 script.md **文件**(拆分镜/预览 episodeUseCases.ts:91 读它)但 createVersion 不回写元数据.
//     → 两实现各更一半, 是分脑; 任一单独用都会让"另一个消费者"读到回滚前的旧剧本.
// 去重方案: 统一走磁盘版 use-case(版本查找超集 + 写文件), 并在成功后补一次 updateEpisode({script_md})
// 收口元数据 —— 同时更新"文件"与"元数据"两来源, 顺带修掉历史分脑. 响应结构与旧内存版完全一致
// ({ok, version, script_md, message}). exportRoutes.ts 那份重复注册同步删除(见该文件).
episodeRouter.post("/series/:slug/episodes/:epId/revert", async (req, res, next) => {
  try {
    const { slug, epId } = req.params;
    const result = await revertEpisodeVersion(slug, epId, req.body);
    if (result.kind === "json") {
      const body = result.body as { ok?: boolean; version?: number; script_md?: string; message?: string };
      // 磁盘版只写 script.md 文件 + 版本文件, 不回写 episode.script_md 元数据(脚本画布真理源) → 这里补齐.
      if (body.ok && typeof body.script_md === "string") {
        await updateEpisode(slug, epId, { script_md: body.script_md });
      }
      res.json(body);
      return;
    }
    if (result.kind === "error") {
      res.status(result.status).json(result.body);
      return;
    }
    // revertEpisodeVersion 只返回 json | error, validation/file 不会出现 — 防御性兜底.
    res.status(500).json({ error: { code: "UnexpectedRevertResult", message: "回滚返回了非预期结果" } });
  } catch (err) { next(err); }
});

// POST /series/:slug/episodes/:epId/approve
episodeRouter.post("/series/:slug/episodes/:epId/approve", async (req, res, next) => {
  try {
    const { slug, epId } = req.params;
    const episode = await readEpisode(slug, epId);
    if (!episode) { res.status(404).json({ error: { code: "NotFound", message: "集不存在" } }); return; }

    await updateEpisode(slug, epId, { status: "approved" });

    res.json({ ok: true, message: "剧本已批准, 可进入分镜阶段" });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// Wave 3C: POST /series/:slug/episodes/:epId/revoice
// 后期统一烧录 — 扫描全剧本对白 → 按角色配音 → ffmpeg 替换音轨
// Body: { strategy: "overlay" | "replace", video_path?: string }
// ═══════════════════════════════════════════════════════════════════
const RevoiceSchema = z.object({
  strategy: z.enum(["overlay", "replace"]).default("overlay"),
  video_path: z.string().optional(),
  tts_provider: z.string().optional(),
});

episodeRouter.post("/series/:slug/episodes/:epId/revoice", async (req, res, next) => {
  try {
    const { slug, epId } = req.params;

    // Validate body
    const parsed = RevoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "ValidationError", message: "请求体校验失败", details: parsed.error.flatten() } });
      return;
    }
    const { strategy, video_path, tts_provider } = parsed.data;

    // Load episode
    const episode = await readEpisode(slug, epId);
    if (!episode) { res.status(404).json({ error: { code: "NotFound", message: "集不存在" } }); return; }

    const scriptText = episode.script_md || "";
    if (!scriptText.trim()) {
      res.status(400).json({ error: { code: "NoScript", message: "该集没有剧本内容" } });
      return;
    }

    // Load all characters for this series with voice_style_map
    const characters = await listCharacters(slug);
    const charVoiceMap = new Map<string, { voice_id?: string; voice_style_map?: Record<string, string | undefined> }>();
    for (const char of characters) {
      charVoiceMap.set(char.name, {
        voice_id: char.voice_id,
        voice_style_map: char.voice_style_map,
      });
    }

    // Determine target video path
    const composeDir = path.join(DATA_ROOT, "series", slug, "episodes", epId, "compose");
    let targetVideoPath = video_path || "";
    if (!targetVideoPath) {
      // Try to find final.mp4 in compose dir
      const finalPath = path.join(composeDir, "final.mp4");
      if (await pathExists(finalPath)) {
        targetVideoPath = finalPath;
      } else {
        // Try to find any mp4 in compose dir
        try {
          const files = await fs.readdir(composeDir);
          const firstMp4 = files.find(f => f.endsWith(".mp4"));
          if (firstMp4) {
            targetVideoPath = path.join(composeDir, firstMp4);
          }
        } catch { /* no compose dir */ }
      }
    }

    if (!targetVideoPath || !(await pathExists(targetVideoPath))) {
      res.status(400).json({
        error: { code: "NoVideo", message: "找不到可用的视频文件。请先跑一次「粗剪预览」或「合成成片」，或通过 video_path 指定视频路径。" },
      });
      return;
    }

    // Get Python path from config for edge_tts
    let pythonPath = "python";
    try {
      const settingsModule = await import("../../../../../packages/core/src/localSettings");
      pythonPath = settingsModule.getConfigValue?.("PYTHON_PATH", "python") ?? "python";
    } catch { /* use default */ }

    // Run revoice
    const result = await revoiceEpisode(scriptText, charVoiceMap, {
      strategy,
      videoPath: targetVideoPath,
      workDir: composeDir,
      ttsProvider: tts_provider || "edge_tts",
      pythonPath,
      defaultVoiceId: "zh-CN-YunxiNeural",
      rate: "+0%",
    });

    if (!result.ok) {
      res.status(500).json({
        error: { code: "RevoiceFailed", message: result.message },
        entries: result.entries.length,
        failed: result.failedEntries.length,
      });
      return;
    }

    res.json({
      ok: true,
      output_path: result.outputPath,
      total_lines: result.entries.length,
      failed_lines: result.failedEntries.length,
      total_duration_sec: result.totalDurationSec,
      message: result.message,
      strategy,
      strategy_hint: strategy === "replace"
        ? "已完全替换音轨（高质量配音，口型可能不匹配）"
        : "已叠加配音到原音频上（保留背景音，降低原音量）",
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// 2026-07-22 X3-4 (A6-3): 粘贴导入确认门 — 统计目标集现有分镜(与 plan-storyboard 确认门同口径).
// importStoryboardFromPaste 内部 trashEpisodeShotFiles 会无条件把该集旧分镜整批入垃圾桶(含已付费
// 挑选), 之前没有 409 确认门(与 plan-storyboard 两路由不一致, 违反铁律 #6"删除走二次确认").
// ═══════════════════════════════════════════════════════════════════
async function surveyEpisodeStoryboard(slug: string, epId: string): Promise<{
  shot_count: number; generation_count: number; has_content: boolean;
}> {
  const shots = await listShots(slug, epId).catch(() => []);
  let generationCount = 0;
  let hasContent = false;
  for (const s of shots) {
    if ((s.generations?.length ?? 0) > 0) generationCount++;
    if (!hasContent && (
      (s.action ?? "").trim().length > 0 ||
      (s.dialogue ?? "").trim().length > 0 ||
      (s.voiceover ?? "").trim().length > 0 ||
      (s.prompt_img ?? "").trim().length > 0
    )) hasContent = true;
  }
  return { shot_count: shots.length, generation_count: generationCount, has_content: hasContent };
}

/** 返 true = 已写 409 响应, caller 直接 return. force=true 或目标集无实质分镜时放行(返 false)。 */
function respondImportConfirmGate(
  res: import("express").Response,
  survey: { shot_count: number; generation_count: number; has_content: boolean },
): boolean {
  if (survey.shot_count > 0 && (survey.has_content || survey.generation_count > 0)) {
    const genNote = survey.generation_count > 0 ? `,其中 ${survey.generation_count} 镜已有生成结果` : "";
    res.status(409).json({
      error: {
        code: "StoryboardAlreadyExists",
        message: `这一集已有 ${survey.shot_count} 个分镜${genNote}。重新导入会把现有分镜整体移入分镜垃圾桶(可恢复),已生成的图片/视频文件仍保留在归档柜。确认要覆盖导入吗?`,
        details: { existing_count: survey.shot_count, generation_count: survey.generation_count },
      },
    });
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// 2026-05-18: POST /series/:slug/episodes/:epId/import-storyboard
// 把外部 AI (ChatGPT/Claude/Gemini) 生成的完整分镜 JSON 一键导入,
// 跳过本应用的灵感+剧本 LLM 调用 (灵感+剧本已在外部 AI 一站式完成)。
// 详见 apps/server/src/application/importStoryboard/importStoryboard.ts
// ═══════════════════════════════════════════════════════════════════
episodeRouter.post("/series/:slug/episodes/:epId/import-storyboard", async (req, res, next) => {
  try {
    // 2026-07-22 X3-4 (A6-3): 确认门 — 目标集 = req.params.epId. 已有实质分镜且未 force → 409.
    if (!isStoryboardForceRequested(req)) {
      const survey = await surveyEpisodeStoryboard(req.params.slug, req.params.epId);
      if (respondImportConfirmGate(res, survey)) return;
    }
    const result = await importStoryboardFromPaste({
      slug: req.params.slug,
      episodeId: req.params.epId,
      storyboard: req.body?.storyboard,
      requestId: req.requestId,
    });
    if (result.kind === "validation") {
      res.status(result.status).json({
        error: { code: "invalid_request", message: "粘贴的分镜 JSON 不符合预期结构", details: result.errors },
      });
      return;
    }
    if (result.kind === "error") {
      res.status(result.status).json(result.body);
      return;
    }
    res.json(result.body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: { code: "ImportFailed", message: scrubForClient(`导入分镜失败: ${msg}`) },
    });
  }
});

// series-level fallback — 前端 ScriptCanvasPage 在 epId 路由 404 时退路调用
episodeRouter.post("/series/:slug/import-storyboard", async (req, res, next) => {
  try {
    // 2026-07-22 X3-4 (A6-3): 确认门 — 系列级导入的目标集与 importStoryboardFromPaste 内部一致:
    // 优先 ep01, 否则第一集; 完全没集时=全新导入(无旧分镜可覆盖, 放行). 已有实质分镜且未 force → 409.
    if (!isStoryboardForceRequested(req)) {
      const eps = await listEpisodes(req.params.slug).catch(() => []);
      const targetEp = eps.find((e) => e.id === "ep01") ?? eps[0];
      if (targetEp) {
        const survey = await surveyEpisodeStoryboard(req.params.slug, targetEp.id);
        if (respondImportConfirmGate(res, survey)) return;
      }
    }
    const result = await importStoryboardFromPaste({
      slug: req.params.slug,
      episodeId: undefined,
      storyboard: req.body?.storyboard,
      requestId: req.requestId,
    });
    if (result.kind === "validation") {
      res.status(result.status).json({
        error: { code: "invalid_request", message: "粘贴的分镜 JSON 不符合预期结构", details: result.errors },
      });
      return;
    }
    if (result.kind === "error") {
      res.status(result.status).json(result.body);
      return;
    }
    res.json(result.body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: { code: "ImportFailed", message: scrubForClient(`导入分镜失败: ${msg}`) },
    });
  }
});
