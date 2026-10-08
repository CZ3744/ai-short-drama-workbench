/**
 * importStoryboard.ts — 把用户从外部 AI (ChatGPT/Claude/Gemini) 生成的完整分镜 JSON
 * 一键导入到当前 series + episode,跳过本应用的灵感+剧本 LLM 调用。
 *
 * 调用合约 (前端 ScriptCanvasPage 粘贴对话框):
 *   POST /api/v2/series/:slug/episodes/:epId/import-storyboard
 *   POST /api/v2/series/:slug/import-storyboard   (series-level fallback)
 *   Body: { storyboard: { episodes: [{ title?, synopsis?, shots: [...] }] } }
 *
 * 处理策略:
 *   - 单 episode: 直接用作当前 epId 的分镜
 *   - 多 episode: 第一个用作当前 epId, 其余 skip + 发 SSE 提示 (不静默创建,避免误生数据)
 *   - 落盘: shotRepo + storyboardVersionsRepo + 必要时 stub scriptVersion
 *
 * 错误兜底 (铁律 #1 — 不允许 silent fallback):
 *   - zod 校验失败 → ValidationResult.kind="validation"
 *   - series/episode 不存在 → NotFound 错误
 *   - shots 数量为 0 → ValidationResult.kind="error" status=400
 *   - 写盘失败 → 直接 throw, 走 next(err) 走全局 scrubForClient
 */

import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

import { readSeries, readEpisode, updateEpisode, createEpisode, listEpisodes, trashEpisodeShotFiles } from "../../api/v2/seriesStore";
import { listCharacters } from "../../repositories/characterRepo";
import { listScenes } from "../../repositories/sceneRepo";
import { sseBroker } from "../../api/v2/sseBroker";
import { episodeBase } from "../../api/v2/orchestration/_shared/paths";
import { ensureDir, writeJson } from "../../../../../packages/core/src/index";
import { loggerSync } from "../../../../../packages/core/src/logger";
import type { ShotData, PromptVersion } from "../../../../../packages/drama/src/types";
import { createStoryboardVersion } from "../../repositories/storyboardVersionsRepo";
import { getActiveScriptVersion, createScriptVersion } from "../../repositories/scriptVersionsRepo";
import { plainTextToNodes, nodesToPlainText } from "../../../../../packages/drama/src/shotText";

// ─── Zod schema ────────────────────────────────────────────────────

const ImportShotSchema = z.object({
  index: z.number().int().min(1).max(9999),
  action: z.string().min(1).max(2000),
  shot_type: z.string().max(50).optional(),
  camera_movement: z.string().max(50).optional(),
  duration_sec: z.number().min(1).max(120).optional(),
  dialogue: z.string().max(2000).optional(),
  voiceover: z.string().max(2000).optional(),
  /**
   * 2026-05-19: 引用素材库中已建好的角色/场景 name, 落盘时映射成 character_ids/scene_id.
   * 用户原话: "一键导入的分镜里应该配好这些引用关系", 让一键抽首帧能复用素材库 typical 图.
   */
  character_refs: z.array(z.string().max(100)).max(20).optional(),
  scene_ref: z.string().max(100).optional(),
  /**
   * 2026-05-20 Wave T Phase 4 — 跟 plan-storyboard 路径对齐:
   *   - visual_focus / prompt_img / prompt_vid 也接受 (用户外部 AI 可能输出)
   *   - element_refs 数组 (跟 character_refs 同款,接 prop/wardrobe/reference/misc)
   *   - image_overrides 显式指定某 element 的某张图作 reference (跟 plan-storyboard 同款)
   * action/dialogue/voiceover/visual_focus/prompt_img/prompt_vid 里的短格式 @ 也会被解析.
   */
  visual_focus: z.string().max(2000).optional(),
  prompt_img: z.string().max(2000).optional(),
  prompt_vid: z.string().max(2000).optional(),
  element_refs: z.array(z.string().max(100)).max(20).optional(),
  image_overrides: z.array(z.object({
    element_id: z.string().max(100),
    image_id: z.string().max(100),
    reason: z.string().max(200).optional(),
  })).max(20).optional(),
});

const ImportEpisodeSchema = z.object({
  title: z.string().min(1).max(200),
  synopsis: z.string().max(2000).optional(),
  shots: z.array(ImportShotSchema).min(1).max(200),
});

const ImportStoryboardSchema = z.object({
  episodes: z.array(ImportEpisodeSchema).min(1).max(50),
});

export type ImportStoryboardBody = z.infer<typeof ImportStoryboardSchema>;

// ─── Result types ──────────────────────────────────────────────────

export type ImportStoryboardResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | {
      kind: "ok";
      body: {
        ok: true;
        episode_id: string;
        version_id: string;
        imported_shots: number;
        created_script_stub: boolean;
        skipped_extra_episodes: number;
      };
    };

export interface ImportStoryboardInput {
  slug: string;
  /** 当前 epId; 若为 undefined 走 series-level fallback 自动选 / 创建 ep01 */
  episodeId?: string;
  storyboard: unknown;
  requestId?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function newShotId(index: number): string {
  const rand = crypto.randomBytes(2).toString("hex");
  return `s${String(index).padStart(4, "0")}_${rand}`;
}

// ─── Main entry ────────────────────────────────────────────────────

export async function importStoryboardFromPaste(
  input: ImportStoryboardInput,
): Promise<ImportStoryboardResult> {
  // 1. Zod 校验
  const parsed = ImportStoryboardSchema.safeParse(input.storyboard);
  if (!parsed.success) {
    return {
      kind: "validation",
      status: 400,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    };
  }
  const body = parsed.data;

  // 2. series 存在性
  const series = await readSeries(input.slug);
  if (!series) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: "系列不存在" } },
    };
  }

  // 3. 选定目标 episode
  // - epId 给了 → 必须存在 (前端 epId 模式)
  // - epId 为 undefined → series-level fallback: 优先选 ep01, 不存在则自动创建
  let targetEpId: string;
  if (input.episodeId) {
    const ep = await readEpisode(input.slug, input.episodeId);
    if (!ep) {
      return {
        kind: "error",
        status: 404,
        body: { error: { code: "NotFound", message: `集 ${input.episodeId} 不存在` } },
      };
    }
    targetEpId = ep.id;
  } else {
    // series-level fallback
    const eps = await listEpisodes(input.slug);
    const ep01 = eps.find((e) => e.id === "ep01");
    if (ep01) {
      targetEpId = ep01.id;
    } else if (eps.length > 0) {
      // 已有别的 episode 但没 ep01 - 用第一个
      targetEpId = eps[0].id;
    } else {
      // 完全没集 - 自动创建一个
      const firstImportedEpisode = body.episodes[0];
      const created = await createEpisode(input.slug, {
        title: firstImportedEpisode.title,
        index: 1,
      });
      targetEpId = created.id;
    }
  }

  // 4. 取第一个 episode 的 shots,其余 skip + 发 SSE 提示
  const firstEp = body.episodes[0];
  const skippedExtra = Math.max(0, body.episodes.length - 1);
  if (skippedExtra > 0) {
    sseBroker.broadcast(
      "import-storyboard.skipped",
      {
        series_slug: input.slug,
        episode_id: targetEpId,
        message: `JSON 含 ${body.episodes.length} 集,仅导入第 1 集到当前 episode (${targetEpId});其余 ${skippedExtra} 集已跳过。如需多集导入请逐个粘贴。`,
        skipped_count: skippedExtra,
      },
    );
  }

  if (firstEp.shots.length === 0) {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "EmptyShots", message: "粘贴的分镜中没有可识别的镜头数据" } },
    };
  }

  // 5. 准备 script_version_id — 没有 active script 时写一个 stub
  let scriptVersionId: string;
  let createdScriptStub = false;
  const activeScript = await getActiveScriptVersion(input.slug);
  if (activeScript) {
    scriptVersionId = activeScript.id;
  } else {
    const stub = await createScriptVersion({
      series_slug: input.slug,
      title: "剧本占位 (用户粘贴分镜)",
      content_md: firstEp.synopsis
        ? `# ${firstEp.title}\n\n${firstEp.synopsis}\n\n> 注：用户从外部 AI 粘贴分镜导入，本剧本为占位记录，未经 LLM 生成。`
        : `# ${firstEp.title}\n\n> 注：用户从外部 AI 粘贴分镜导入，本剧本为占位记录，未经 LLM 生成。`,
      source_inspirations: [],
      user_prompt: "[paste_stub] 用户直接粘贴分镜,未生成剧本",
      activate: true,
    });
    scriptVersionId = stub.id;
    createdScriptStub = true;
  }

  // 6. 排序 shots 并落盘
  const sortedShots = [...firstEp.shots].sort((a, b) => a.index - b.index);
  const epBase = episodeBase(input.slug, targetEpId);
  const shotsDir = path.join(epBase, "shots");
  await ensureDir(shotsDir);

  // 2026-07-10 Fable P0-1 — 重新导入分镜前把旧 shot 文件"整批移入垃圾桶"(不再 fs.rm 硬删),
  // 与 plan 重拆同款: listShots 仍不返回旧镜(已挪出 shots/ 目录)继续防幽灵镜重复扣费, 但旧分镜
  // (含挑选/裁剪/命名/generation↔asset)成套可在垃圾桶恢复. 兼容 plan 的 s0001.json 与
  // import 的 s0001_xxxx.json 跨路径残留.
  // 2026-07-22 U-fix1 (X6-1 补线): 接住这批"落停批次"id, 下面建 StoryboardVersion 时带上 trashed_batch_id,
  // 与 plan 路径 persistStoryboard.ts:544 同款语义 —— 否则粘贴产生的版本没有可回滚的镜头快照, 用户点
  // "回滚到旧版本"必得 409 StoryboardSnapshotMissing, 分镜纹丝不动 (EVIDENCE-api 项 4)。
  const trashBatch = await trashEpisodeShotFiles(input.slug, targetEpId);

  // 2026-05-19: 从 series 已有的 characters/scenes 建 name→id 映射,
  // 让 shot.character_refs/scene_ref (LLM/外部 AI 输出的 name) 解析成真 ID,
  // 一键抽首帧时 implicitReferenceCollector 才能拿 typical 图作 reference.
  // 2026-05-20 Wave T Phase 4 — 同样加 elements,跟 plan-storyboard 路径行为一致.
  const nameToCharacterId = new Map<string, string>();
  const nameToSceneId = new Map<string, string>();
  const nameToElementId = new Map<string, string>();
  let allCharactersForCtx: Array<{ name: string; id: string }> = [];
  let allScenesForCtx: Array<{ name: string; id: string }> = [];
  let allElementsForCtx: Array<{ name: string; id: string }> = [];
  try {
    for (const c of await listCharacters(input.slug)) {
      nameToCharacterId.set(c.name, c.id);
      nameToCharacterId.set(c.name.toLowerCase().trim(), c.id);
      allCharactersForCtx.push({ name: c.name, id: c.id });
    }
  } catch { /* 忽略读取失败 */ }
  try {
    for (const s of await listScenes(input.slug)) {
      nameToSceneId.set(s.name, s.id);
      nameToSceneId.set(s.name.toLowerCase().trim(), s.id);
      allScenesForCtx.push({ name: s.name, id: s.id });
    }
  } catch { /* 忽略读取失败 */ }
  try {
    const { listElements } = await import("../../repositories/elementRepo");
    for (const el of await listElements(input.slug)) {
      if (el.kind === "character" || el.kind === "scene") continue;
      nameToElementId.set(el.name, el.id);
      nameToElementId.set(el.name.toLowerCase().trim(), el.id);
      allElementsForCtx.push({ name: el.name, id: el.id });
    }
  } catch { /* 忽略读取失败 */ }
  function resolveCharacterIds(refs: string[] | undefined): string[] {
    if (!refs || refs.length === 0) return [];
    const ids: string[] = [];
    for (const ref of refs) {
      const name = ref.trim();
      if (!name) continue;
      const id = nameToCharacterId.get(name) ?? nameToCharacterId.get(name.toLowerCase());
      if (id) {
        if (!ids.includes(id)) ids.push(id);
      } else {
        loggerSync().warn(
          `[import-storyboard] shot.character_refs name="${name}" 在 series 中找不到对应 character, 跳过 (用户需先在素材库建该角色)`,
        );
      }
    }
    return ids;
  }
  function resolveSceneId(ref: string | undefined): string | undefined {
    if (!ref) return undefined;
    const name = ref.trim();
    if (!name) return undefined;
    const id = nameToSceneId.get(name) ?? nameToSceneId.get(name.toLowerCase());
    if (id) return id;
    loggerSync().warn(
      `[import-storyboard] shot.scene_ref name="${name}" 在 series 中找不到对应 scene, 跳过`,
    );
    return undefined;
  }

  const shotEntries: Array<{ shot_id: string; index: number }> = [];
  for (let i = 0; i < sortedShots.length; i++) {
    const s = sortedShots[i];
    const shotId = newShotId(i + 1);

    // 构造首版 prompt — 粘贴入参以 action / shot_type / camera_movement / dialogue
    // 合成成纯文本提示词。用户后续可在 ShotStagePage 编辑。
    const initialImgPrompt = [s.shot_type, s.action, s.camera_movement]
      .filter((x) => typeof x === "string" && x.trim().length > 0)
      .join(", ")
      .trim();
    const initialVidPrompt = [s.action, s.camera_movement]
      .filter((x) => typeof x === "string" && x.trim().length > 0)
      .join(", ")
      .trim();

    const promptImgVersions: PromptVersion[] = initialImgPrompt
      ? [{ version: 1, content: initialImgPrompt, created_at: nowISO(), created_by: "user" }]
      : [];
    const promptVidVersions: PromptVersion[] = initialVidPrompt
      ? [{ version: 1, content: initialVidPrompt, created_at: nowISO(), created_by: "user" }]
      : [];

    const character_ids = resolveCharacterIds(s.character_refs);
    let scene_id = resolveSceneId(s.scene_ref);
    const element_ids: string[] = [];
    // 解析 element_refs(显式数组)
    for (const ref of s.element_refs ?? []) {
      const name = ref.trim();
      if (!name) continue;
      const id = nameToElementId.get(name) ?? nameToElementId.get(name.toLowerCase());
      if (id && !element_ids.includes(id)) element_ids.push(id);
      else if (!id) {
        loggerSync().warn(
          `[import-storyboard] shot.element_refs name="${name}" 在 series 中找不到对应 element, 跳过`,
        );
      }
    }

    // 2026-05-20 Wave T Phase 4 — 跟 plan-storyboard 路径对齐:
    //   - 扫 action/dialogue/voiceover/visual_focus/prompt_img/prompt_vid 短格式 @ → 合并 ids
    //   - 解析 mention 长格式 .img:xxx + s.image_overrides 显式 → 合并 reference_overrides
    const { parseShortMentionTokensFromTexts } = await import("../../../../../packages/drama/src/mentionParser");
    const mentionTokens = parseShortMentionTokensFromTexts(
      { characters: allCharactersForCtx, scenes: allScenesForCtx, elements: allElementsForCtx },
      s.action, s.dialogue, s.voiceover, s.visual_focus, s.prompt_img, s.prompt_vid,
    );
    for (const tok of mentionTokens) {
      if (tok.kind === "character") {
        const id = nameToCharacterId.get(tok.name) || nameToCharacterId.get(tok.name.toLowerCase());
        if (id && !character_ids.includes(id)) character_ids.push(id);
      } else if (tok.kind === "scene" && !scene_id) {
        const id = nameToSceneId.get(tok.name) || nameToSceneId.get(tok.name.toLowerCase());
        if (id) scene_id = id;
      } else if (tok.kind === "element") {
        const id = nameToElementId.get(tok.name) || nameToElementId.get(tok.name.toLowerCase());
        if (id && !element_ids.includes(id)) element_ids.push(id);
      }
    }

    // image_overrides:显式数组 + mention 长格式 .img: 合并
    const reference_overrides: Array<{ element_id: string; image_id: string }> = [];
    for (const ov of s.image_overrides ?? []) {
      const rawElem = (ov.element_id || "").trim();
      const rawImg = (ov.image_id || "").trim();
      if (!rawElem || !rawImg) continue;
      const elemId = nameToElementId.get(rawElem) || nameToElementId.get(rawElem.toLowerCase())
        || nameToCharacterId.get(rawElem) || nameToCharacterId.get(rawElem.toLowerCase())
        || nameToSceneId.get(rawElem) || nameToSceneId.get(rawElem.toLowerCase())
        || rawElem;
      if (!reference_overrides.some(o => o.element_id === elemId)) {
        reference_overrides.push({ element_id: elemId, image_id: rawImg });
      }
    }
    for (const tok of mentionTokens) {
      if (!tok.imageId) continue;
      const elemId = tok.kind === "character"
        ? (nameToCharacterId.get(tok.name) || nameToCharacterId.get(tok.name.toLowerCase()))
        : tok.kind === "scene"
          ? (nameToSceneId.get(tok.name) || nameToSceneId.get(tok.name.toLowerCase()))
          : (nameToElementId.get(tok.name) || nameToElementId.get(tok.name.toLowerCase()));
      if (!elemId) continue;
      if (reference_overrides.some(o => o.element_id === elemId)) continue;
      reference_overrides.push({ element_id: elemId, image_id: tok.imageId });
    }

    // 2026-05-21 Wave Y — 富文本节点: ctx 用 nameToXxxId 反查 id
    const importNodesCtx = {
      characters: Array.from(nameToCharacterId.entries()).map(([name, id]) => ({ name, id })),
      scenes: Array.from(nameToSceneId.entries()).map(([name, id]) => ({ name, id })),
      elements: Array.from(nameToElementId.entries()).map(([name, id]) => ({ name, id })),
    };
    const actionNodes = plainTextToNodes(s.action || "", importNodesCtx);
    const dialogueNodes = plainTextToNodes(s.dialogue || "", importNodesCtx);
    const voiceoverNodes = plainTextToNodes(s.voiceover || "", importNodesCtx);
    const promptImgNodes = plainTextToNodes(initialImgPrompt || "", importNodesCtx);
    const promptVidNodes = plainTextToNodes(initialVidPrompt || "", importNodesCtx);

    const shotData: ShotData = {
      id: shotId,
      series_slug: input.slug,
      episode_id: targetEpId,
      index: i + 1,
      duration_sec: s.duration_sec ?? 5,
      character_ids,
      element_ids,
      scene_id,
      reference_overrides: reference_overrides.length > 0 ? reference_overrides : undefined,
      shot_type: s.shot_type,
      camera_movement: s.camera_movement,
      action_nodes: actionNodes,
      dialogue_nodes: dialogueNodes,
      voiceover_nodes: voiceoverNodes,
      prompt_img_nodes: promptImgNodes,
      prompt_vid_nodes: promptVidNodes,
      action: nodesToPlainText(actionNodes) || s.action || "",
      dialogue: nodesToPlainText(dialogueNodes) || s.dialogue || "",
      voiceover: nodesToPlainText(voiceoverNodes) || s.voiceover || "",
      prompt_img: nodesToPlainText(promptImgNodes) || initialImgPrompt || undefined,
      prompt_vid: nodesToPlainText(promptVidNodes) || initialVidPrompt || undefined,
      prompt_img_versions: promptImgVersions.map((v) => {
        const vNodes = plainTextToNodes(v.content || "", importNodesCtx);
        return { ...v, content: nodesToPlainText(vNodes) || v.content };
      }),
      prompt_vid_versions: promptVidVersions.map((v) => {
        const vNodes = plainTextToNodes(v.content || "", importNodesCtx);
        return { ...v, content: nodesToPlainText(vNodes) || v.content };
      }),
      status: "drafted",
      generations: [],
      active_generations: [],
      trashed_generations: [],
    };

    await writeJson(path.join(shotsDir, `${shotId}.json`), shotData);
    shotEntries.push({ shot_id: shotId, index: i + 1 });
  }

  // 7. 旧 storyboard.json 镜像 (兼容老前端读法)
  await writeJson(path.join(epBase, "storyboard.json"), {
    episode_id: targetEpId,
    series_slug: input.slug,
    shots: shotEntries,
    updated_at: nowISO(),
  });

  // 8. 同步 episode 元数据 (title / synopsis 如果 episode 还没填 / status)
  const existingEp = await readEpisode(input.slug, targetEpId);
  const patch: Record<string, unknown> = {
    storyboard_path: `episodes/${targetEpId}/storyboard.json`,
    status: "storyboarded",
  };
  if (existingEp) {
    if (!existingEp.title || existingEp.title === `第${existingEp.index}集`) {
      patch.title = firstEp.title;
    }
    if (!existingEp.synopsis && firstEp.synopsis) {
      patch.synopsis = firstEp.synopsis;
    }
  }
  await updateEpisode(input.slug, targetEpId, patch);

  // 9. 写入新的 StoryboardVersion 并激活
  const sbv = await createStoryboardVersion({
    series_slug: input.slug,
    episode_id: targetEpId,
    name: `分镜 (粘贴导入 · ${new Date().toLocaleString("zh-CN", { hour12: false })})`,
    script_version_id: scriptVersionId,
    shot_ids: shotEntries.map((e) => e.shot_id),
    // 2026-07-22 U-fix1 — 记本次重导把上一版旧分镜整批移入垃圾桶的批次 id, 供"回滚到旧版本"按批搬回
    // (与 plan-storyboard persistStoryboard.ts:544 同款; moved 为空表示本集原先无分镜, 无需记批次)。
    trashed_batch_id: trashBatch.moved.length > 0 ? trashBatch.batch_id : undefined,
    activate: true,
  });

  // 10. 发 SSE 完成事件
  sseBroker.broadcast(
    "import-storyboard.done",
    {
      series_slug: input.slug,
      episode_id: targetEpId,
      version_id: sbv.id,
      shot_count: shotEntries.length,
      created_script_stub: createdScriptStub,
    },
  );

  return {
    kind: "ok",
    body: {
      ok: true,
      episode_id: targetEpId,
      version_id: sbv.id,
      imported_shots: shotEntries.length,
      created_script_stub: createdScriptStub,
      skipped_extra_episodes: skippedExtra,
    },
  };
}
