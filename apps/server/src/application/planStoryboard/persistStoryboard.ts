/**
 * persistStoryboard.ts — 分镜数据落盘 + entity upsert
 *
 * Wave Z-6: 从 planEpisodeStoryboard.ts 的 persistStoryboard 内联闭包拆出。
 *
 * 包含:
 *   - prompt 污染检测 & 清洗
 *   - entity 自动提取 & upsert (铁律 0 Entity-first)
 *   - shot 数据规范化落盘 (storyboard.json + shot JSON + StoryboardVersion)
 */

import path from "node:path";
import { z } from "zod";

import {
  listCharacters,
  listScenes,
  updateEpisode,
  trashEpisodeShotFiles,
  type ShotData,
} from "../../api/v2/seriesStore";
import { listElements, createElement } from "../../repositories/elementRepo";
import { createCharacter } from "../../repositories/characterRepo";
import { createScene } from "../../repositories/sceneRepo";
import { ensureDir, writeJson } from "../../../../../packages/core/src/index";
import { loggerSync } from "../../../../../packages/core/src/logger";
import { plainTextToNodes, nodesToPlainText } from "../../../../../packages/drama/src/shotText";
import { parseShortMentionTokensFromTexts } from "../../../../../packages/drama/src/mentionParser";
import { createStoryboardVersion } from "../../repositories/storyboardVersionsRepo";
import { getActiveScriptVersion } from "../../repositories/scriptVersionsRepo";
import { episodeBase } from "../../api/v2/orchestration/_shared/paths";
import {
  resolveReferenceOverrides,
  normalizeShotPlanShotTypes,
} from "./_shared";
import type { ShotPlanSchema } from "../../api/v2/orchestration/_shared/schemas";

// ─── Prompt pollution detection & cleaning ─────────────────────────

const POLLUTION_KEYWORDS = [
  "#",
  "##",
  ">",
  "|",
  "**",
  "大纲",
  "开场",
  "完整脚本",
  "时长预估",
  "风格:",
  "旁白:",
  "画面:",
  "center",
];

const isPolluted = (text: string | undefined | null): boolean => {
  if (!text || text.trim().length === 0) return false;
  return POLLUTION_KEYWORDS.some((kw) => text.includes(kw));
};

const extractCleanFirstSentence = (text: string | undefined | null): string => {
  if (!text || text.trim().length === 0) return "";
  const segments = text.split(/[\n\r]+/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed.length === 0) continue;
    if (!POLLUTION_KEYWORDS.some((kw) => trimmed.includes(kw))) {
      const sentences = trimmed.split(/[。！？；;]/);
      for (const sent of sentences) {
        const s = sent.trim();
        if (s.length >= 3 && !POLLUTION_KEYWORDS.some((kw) => s.includes(kw))) {
          return s;
        }
      }
    }
  }
  return "";
};

export const cleanPrompt = (prompt: string | undefined | null): string => {
  if (!prompt || prompt.trim().length === 0) return "";
  if (!isPolluted(prompt)) return prompt.trim();
  const cleaned = extractCleanFirstSentence(prompt);
  if (cleaned.length > 0) {
    console.warn(`[pollution] Stripped polluted prompt, kept: "${cleaned.slice(0, 80)}..."`);
    return cleaned;
  }
  console.warn(`[pollution] Prompt completely polluted, clearing: "${prompt.slice(0, 80)}..."`);
  return "";
};

// ─── Entity extraction & upsert (铁律 0: Entity-first) ──────────────

function dedupeStrings(arr: string[] | undefined | null): string[] {
  if (!arr || !Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 把所有 shot 的 auto_extracted_entities 三类 name 合并 dedupe. */
export function collectExtractedEntities(
  shots: z.infer<typeof ShotPlanSchema>,
): { characters: string[]; scenes: string[]; elements: string[] } {
  const characters = new Set<string>();
  const scenes = new Set<string>();
  const elements = new Set<string>();
  for (const s of shots) {
    const ext = s.auto_extracted_entities;
    if (!ext) continue;
    for (const n of ext.characters ?? []) if (typeof n === "string" && n.trim()) characters.add(n.trim());
    for (const n of ext.scenes ?? []) if (typeof n === "string" && n.trim()) scenes.add(n.trim());
    for (const n of ext.elements ?? []) if (typeof n === "string" && n.trim()) elements.add(n.trim());
  }
  return {
    characters: Array.from(characters),
    scenes: Array.from(scenes),
    elements: Array.from(elements),
  };
}

/**
 * Entity-first upsert: LLM 输出的 auto_extracted_entities → 占位素材.
 *
 * 不抛异常, 不覆盖既有, 已存在 skip.
 */
async function upsertExtractedEntities(
  slug: string,
  entities: { characters: string[]; scenes: string[]; elements: string[] },
): Promise<{ characters: string[]; scenes: string[]; elements: string[] }> {
  const created = { characters: [] as string[], scenes: [] as string[], elements: [] as string[] };
  // Characters
  try {
    const existing = await listCharacters(slug);
    const existingNames = new Set(existing.map(c => c.name));
    for (const name of dedupeStrings(entities.characters)) {
      if (existingNames.has(name)) continue;
      try {
        await createCharacter(slug, {
          name,
          role: "auto-extracted",
          appearance_prompt: "",
          personality: "",
          is_placeholder: true,
        });
        created.characters.push(name);
        existingNames.add(name);
      } catch (e) {
        loggerSync().warn(`[plan-storyboard][entity-upsert] createCharacter("${name}") 失败:`, e);
      }
    }
  } catch (e) {
    loggerSync().warn("[plan-storyboard][entity-upsert] character pass 失败:", e);
  }
  // Scenes
  try {
    const existing = await listScenes(slug);
    const existingNames = new Set(existing.map(s => s.name));
    for (const name of dedupeStrings(entities.scenes)) {
      if (existingNames.has(name)) continue;
      try {
        await createScene(slug, { name, description: "auto-extracted placeholder", is_placeholder: true });
        created.scenes.push(name);
        existingNames.add(name);
      } catch (e) {
        loggerSync().warn(`[plan-storyboard][entity-upsert] createScene("${name}") 失败:`, e);
      }
    }
  } catch (e) {
    loggerSync().warn("[plan-storyboard][entity-upsert] scene pass 失败:", e);
  }
  // Elements (默认建为 prop kind)
  try {
    const existing = await listElements(slug);
    const existingNames = new Set(existing.map(el => el.name));
    for (const name of dedupeStrings(entities.elements)) {
      if (existingNames.has(name)) continue;
      try {
        await createElement(slug, {
          kind: "prop",
          name,
          description: "auto-extracted placeholder",
          is_placeholder: true,
        });
        created.elements.push(name);
        existingNames.add(name);
      } catch (e) {
        loggerSync().warn(`[plan-storyboard][entity-upsert] createElement("${name}") 失败:`, e);
      }
    }
  } catch (e) {
    loggerSync().warn("[plan-storyboard][entity-upsert] element pass 失败:", e);
  }
  return created;
}

// ─── Main persist logic ────────────────────────────────────────────

/**
 * 将 LLM 产出的 ShotPlan 落盘为 ShotData + storyboard.json + StoryboardVersion.
 *
 * 原为 planEpisodeStoryboard() 的内联闭包, Wave Z-6 拆出为独立函数.
 *
 * @param slug - 系列 slug
 * @param episodeId - 集 ID
 * @param shots - LLM 产出的 ShotPlan 数组
 * @returns shotEntries (shot_id + index 列表)
 */
export async function persistStoryboard(
  slug: string,
  episodeId: string,
  shots: z.infer<typeof ShotPlanSchema>,
): Promise<Array<{ shot_id: string; index: number }>> {
  const epBase = episodeBase(slug, episodeId);
  const shotsToPersist = normalizeShotPlanShotTypes(shots, "persist");
  const shotsDir = path.join(epBase, "shots");
  await ensureDir(shotsDir);

  // 2026-07-10 Fable P0-1 — 重拆分镜前, 把旧 shot 文件"整批移入垃圾桶"(不再 fs.rm 硬删).
  // 旧硬删只为保证 listShots 干净防幽灵镜重复扣费, 却连带毁掉用户挑选劳动(picked/trim/帧锚点/
  // 命名/generation↔asset). 改用垃圾桶语义: listShots 仍不返回旧镜(已挪出 shots/ 目录), 但旧分镜
  // 成套可在垃圾桶恢复. batch_id 记进本次 StoryboardVersion, 让"回滚到旧分镜版本"能按批搬回.
  const trashBatch = await trashEpisodeShotFiles(slug, episodeId);
  const shotEntries: Array<{ shot_id: string; index: number }> = [];

  // ── Entity upsert: LLM auto_extracted_entities → 占位素材 ──
  const extracted = collectExtractedEntities(shotsToPersist);
  const totalExtracted = extracted.characters.length + extracted.scenes.length + extracted.elements.length;
  try {
    if (totalExtracted > 0) {
      const created = await upsertExtractedEntities(slug, extracted);
      const totalCreated = created.characters.length + created.scenes.length + created.elements.length;
      if (totalCreated > 0) {
        loggerSync().info(
          `[plan-storyboard][entity-upsert] series=${slug} ep=${episodeId} ` +
            `created characters=${created.characters.length} scenes=${created.scenes.length} elements=${created.elements.length} ` +
            `(extracted total ${totalExtracted})`,
        );
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    loggerSync().warn(
      "[plan-storyboard][entity-upsert] 整段 upsert 失败 (storyboard.json 仍然写盘 OK):",
      message,
    );
  }

  // ── Build name→id maps (upsert 之后 refresh) ──
  const allCharacters = await listCharacters(slug);
  const allScenes = await listScenes(slug);
  const characterNameToId = new Map<string, string>();
  const sceneNameToId = new Map<string, string>();
  for (const c of allCharacters) {
    characterNameToId.set(c.name, c.id);
    characterNameToId.set(c.name.toLowerCase().trim(), c.id);
    characterNameToId.set(c.id, c.id);
    characterNameToId.set(c.id.toLowerCase().trim(), c.id);
  }
  for (const sc of allScenes) {
    sceneNameToId.set(sc.name, sc.id);
    sceneNameToId.set(sc.name.toLowerCase().trim(), sc.id);
    sceneNameToId.set(sc.id, sc.id);
    sceneNameToId.set(sc.id.toLowerCase().trim(), sc.id);
  }

  const refreshedElements = await listElements(slug);
  const elementNameToId = new Map<string, string>();
  const refreshedPropsAndMisc = refreshedElements.filter(
    e => e.kind === "prop" || e.kind === "wardrobe" || e.kind === "reference" || e.kind === "misc",
  );
  for (const el of refreshedPropsAndMisc) {
    elementNameToId.set(el.name, el.id);
    elementNameToId.set(el.name.toLowerCase().trim(), el.id);
  }

  // ── Persist each shot ──
  for (let i = 0; i < shotsToPersist.length; i++) {
    const s = shotsToPersist[i];
    const shotId = `s${String(i + 1).padStart(4, "0")}`;
    let initialImgPrompt: string;
    let initialVidPrompt: string;
    const llmImg = s.prompt_img;
    const llmVid = s.prompt_vid;
    if (llmImg && llmImg.trim().length > 0) {
      initialImgPrompt = cleanPrompt(llmImg);
    } else {
      initialImgPrompt = cleanPrompt(`${s.visual_focus || ""} ${s.action} ${s.mood || ""}`.trim());
    }
    if (llmVid && llmVid.trim().length > 0) {
      initialVidPrompt = cleanPrompt(llmVid);
    } else {
      initialVidPrompt = cleanPrompt(`${s.visual_focus || ""} ${s.action} ${s.camera_movement} ${s.mood || ""}`.trim());
    }
    if (!initialImgPrompt) {
      initialImgPrompt = s.visual_focus || "";
    }
    if (!initialVidPrompt) {
      initialVidPrompt = `${s.visual_focus || ""} ${s.camera_movement || ""}`.trim();
    }

    // Resolve element_refs (name → id)
    const resolvedElementIds: string[] = [];
    const refs = s.element_refs ?? [];
    for (const ref of refs) {
      const name = String(ref).trim();
      if (!name) continue;
      const id = elementNameToId.get(name) ?? elementNameToId.get(name.toLowerCase());
      if (id) {
        if (!resolvedElementIds.includes(id)) resolvedElementIds.push(id);
      } else {
        loggerSync().warn(
          `[plan-storyboard] shot.element_refs name="${name}" 在 series 中找不到对应 element, 跳过`,
        );
      }
    }

    // Resolve character_refs (name → id)
    // 2026-05-27 — 之前找不到 silent skip → 用户感受"我看到林深在 action 文本里,
    // 但生图角色一致性丢失". 改为自动建 is_placeholder=true 角色, 跟 upsertExtractedEntities
    // 同语义 (工作流非线性 + entity-first 铁律: 不阻塞, 让用户后续给 placeholder 补全).
    const character_ids: string[] = [];
    for (const raw of (s.characters as string[] | undefined) ?? []) {
      const trimmed = String(raw).trim();
      if (!trimmed) continue;
      let resolved =
        characterNameToId.get(trimmed) ||
        characterNameToId.get(trimmed.toLowerCase());
      if (!resolved) {
        // 自动建 placeholder, 不 silent skip
        try {
          const created = await createCharacter(slug, {
            name: trimmed,
            role: "auto",
            personality: "",
            is_placeholder: true,
          });
          resolved = created.id;
          characterNameToId.set(trimmed, created.id);
          characterNameToId.set(trimmed.toLowerCase(), created.id);
          loggerSync().info(
            `[plan-storyboard][name-resolve] shot.characters name="${trimmed}" 找不到 → 自动建 is_placeholder character id=${created.id}`,
          );
        } catch (e) {
          loggerSync().warn(
            `[plan-storyboard][name-resolve] shot.characters name="${trimmed}" 找不到 + 建占位失败, 跳过:`,
            e instanceof Error ? e.message : String(e),
          );
          continue;
        }
      }
      if (!character_ids.includes(resolved)) character_ids.push(resolved);
    }

    // Resolve scene_id
    // 2026-05-27 — 之前找不到时透传原值 (string), 后续 readScene(slug, "酒馆夜晚") 返 null
    // → 生图时场景描述拿不到. 改自动建 is_placeholder scene, 用真 id.
    let scene_id: string | undefined = undefined;
    if (s.scene_id !== undefined && s.scene_id !== null) {
      const rawScene = String(s.scene_id).trim();
      if (!rawScene) {
        // empty — skip
      } else if (/^\d+$/.test(rawScene)) {
        // 2026-07-09 audit 修复 — 整数 scene_id 拼 scn_N 前先校验真存在(字符串路径找不到会自动建
        // placeholder, 整数路径之前直接假设 scn_N 存在). 不存在则置空降级(生图走 prompt-only), 不写悬空引用.
        const candidateId = `scn_${rawScene}`;
        if (allScenes.some((sc) => sc.id === candidateId)) {
          scene_id = candidateId;
        } else {
          loggerSync().warn(
            `[plan-storyboard][name-resolve] shot.scene_id="${rawScene}" 拼 ${candidateId} 但场景集合无此 id → 置空(降级, 不写悬空引用)`,
          );
        }
      } else {
        const resolved =
          sceneNameToId.get(rawScene) ||
          sceneNameToId.get(rawScene.toLowerCase());
        if (resolved) {
          scene_id = resolved;
        } else {
          // 自动建 placeholder scene
          try {
            const created = await createScene(slug, {
              name: rawScene,
              description: "",
              is_placeholder: true,
            });
            scene_id = created.id;
            sceneNameToId.set(rawScene, created.id);
            sceneNameToId.set(rawScene.toLowerCase(), created.id);
            loggerSync().info(
              `[plan-storyboard][name-resolve] shot.scene_id="${rawScene}" 找不到 → 自动建 is_placeholder scene id=${created.id}`,
            );
          } catch (e) {
            scene_id = rawScene;
            loggerSync().warn(
              `[plan-storyboard][name-resolve] shot.scene_id="${rawScene}" 找不到 + 建占位失败, fallback 透传原值:`,
              e instanceof Error ? e.message : String(e),
            );
          }
        }
      }
    }

    // @ mention 合并 (铁律 0: 文本 @ 是权威)
    const lookupCtx = {
      characters: allCharacters.map(c => ({ name: c.name, id: c.id })),
      scenes: allScenes.map(sc => ({ name: sc.name, id: sc.id })),
      elements: refreshedPropsAndMisc.map(el => ({ name: el.name, id: el.id })),
    };
    const mentionTokens = parseShortMentionTokensFromTexts(
      lookupCtx,
      s.action,
      s.dialogue,
      s.voiceover,
      s.visual_focus,
      s.prompt_img,
      s.prompt_vid,
    );

    for (const tok of mentionTokens) {
      if (tok.kind === "character") {
        const id = characterNameToId.get(tok.name) || characterNameToId.get(tok.name.toLowerCase());
        if (id && !character_ids.includes(id)) {
          character_ids.push(id);
          loggerSync().info(
            `[plan-storyboard][mention] shot ${shotId}: @${tok.name} → character_id=${id} (从文本反查合并)`,
          );
        }
      } else if (tok.kind === "scene") {
        if (!scene_id) {
          const id = sceneNameToId.get(tok.name) || sceneNameToId.get(tok.name.toLowerCase());
          if (id) {
            scene_id = id;
            loggerSync().info(
              `[plan-storyboard][mention] shot ${shotId}: @${tok.name} → scene_id=${id} (从文本反查兜底)`,
            );
          }
        }
      } else if (tok.kind === "element") {
        const id = elementNameToId.get(tok.name) || elementNameToId.get(tok.name.toLowerCase());
        if (id && !resolvedElementIds.includes(id)) {
          resolvedElementIds.push(id);
          loggerSync().info(
            `[plan-storyboard][mention] shot ${shotId}: @${tok.name} → element_id=${id} (从文本反查合并)`,
          );
        }
      }
    }

    // image_overrides → reference_overrides
    const referenceOverrides = resolveReferenceOverrides(
      s,
      { elementNameToId, characterNameToId, sceneNameToId },
      mentionTokens,
    );

    // 富文本节点
    const nodesCtx = {
      characters: character_ids
        .map((id) => allCharacters.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((c) => ({ name: c.name, id: c.id })),
      scenes: scene_id
        ? (() => {
            const sc = allScenes.find((x) => x.id === scene_id);
            return sc ? [{ name: sc.name, id: sc.id }] : [];
          })()
        : [],
      elements: resolvedElementIds
        .map((id) => refreshedPropsAndMisc.find((el) => el.id === id))
        .filter((el): el is NonNullable<typeof el> => Boolean(el))
        .map((el) => ({ name: el.name, id: el.id })),
    };
    const actionNodes = plainTextToNodes(s.action || "", nodesCtx);
    const dialogueNodes = plainTextToNodes(s.dialogue || "", nodesCtx);
    const voiceoverNodes = plainTextToNodes(s.voiceover || "", nodesCtx);
    const promptImgNodes = plainTextToNodes(initialImgPrompt, nodesCtx);
    const promptVidNodes = plainTextToNodes(initialVidPrompt, nodesCtx);

    const now = new Date().toISOString();
    const shotData: ShotData = {
      id: shotId,
      series_slug: slug,
      episode_id: episodeId,
      index: i + 1,
      // 2026-07-09 audit 修复 — 负/NaN duration 防护: Number(-3)||5 会放行负值(负数 truthy),
      // 负 duration_sec 落盘后坑合成时间轴 / xfade offset. clamp 到 (0,120], 非法值回落 5.
      duration_sec: (() => { const d = Number(s.duration_sec); return Number.isFinite(d) && d > 0 ? Math.min(d, 120) : 5; })(),
      character_ids,
      scene_id,
      element_ids: resolvedElementIds,
      reference_overrides: referenceOverrides.length > 0 ? referenceOverrides : undefined,
      shot_type: s.shot_type,
      camera_movement: s.camera_movement,
      action_nodes: actionNodes,
      dialogue_nodes: dialogueNodes,
      voiceover_nodes: voiceoverNodes,
      prompt_img_nodes: promptImgNodes,
      prompt_vid_nodes: promptVidNodes,
      action: nodesToPlainText(actionNodes),
      dialogue: nodesToPlainText(dialogueNodes),
      voiceover: nodesToPlainText(voiceoverNodes),
      prompt_img: nodesToPlainText(promptImgNodes),
      prompt_vid: nodesToPlainText(promptVidNodes),
      prompt_img_versions: [{ version: 1, content: nodesToPlainText(promptImgNodes), created_at: now, created_by: "ai" }],
      prompt_vid_versions: [{ version: 1, content: nodesToPlainText(promptVidNodes), created_at: now, created_by: "ai" }],
      status: "drafted",
      generations: [],
    };
    await writeJson(path.join(shotsDir, `${shotId}.json`), shotData);
    shotEntries.push({ shot_id: shotId, index: i + 1 });
  }

  // ── Write storyboard.json + update episode ──
  await writeJson(path.join(epBase, "storyboard.json"), {
    episode_id: episodeId,
    series_slug: slug,
    shots: shotEntries,
    updated_at: new Date().toISOString(),
  });
  await updateEpisode(slug, episodeId, {
    storyboard_path: `episodes/${episodeId}/storyboard.json`,
    status: "storyboarded",
  });

  // ── Create StoryboardVersion ──
  try {
    const activeScript = await getActiveScriptVersion(slug);
    await createStoryboardVersion({
      series_slug: slug,
      episode_id: episodeId,
      script_version_id: activeScript?.id ?? "legacy",
      shot_ids: shotEntries.map((e) => e.shot_id),
      // P0-1 减配版快照: 记本次重拆把上一版旧分镜整批移入垃圾桶的批次 id, 供回滚按批搬回.
      trashed_batch_id: trashBatch.moved.length > 0 ? trashBatch.batch_id : undefined,
      activate: true,
    });
  } catch (e: unknown) {
    loggerSync().warn(
      "[plan-storyboard] createStoryboardVersion failed (legacy storyboard.json still ok):",
      e instanceof Error ? e.message : e,
    );
  }

  return shotEntries;
}
