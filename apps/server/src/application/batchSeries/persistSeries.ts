/**
 * persistSeries.ts — 批量生成系列落盘逻辑
 *
 * 从 batchSeries.ts 拆出。将 LLM 输出的 BatchEnvelope 持久化为
 * series + episodes + shots + characters + scenes。
 *
 * 复用单项目 (single) 和多项目 (multi) 两种模式。
 */

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import type { BatchEnvelope, BatchProjectInput } from "./batchSeries";

import {
  createSeries,
  createEpisode,
  updateEpisode,
} from "../../api/v2/seriesStore";
import { listElements } from "../../repositories/elementRepo";
import { resolveReferenceOverrides } from "../planStoryboard/_shared";
import { plainTextToNodes, nodesToPlainText } from "../../../../../packages/drama/src/shotText";
import { createVersion as createEpisodeVersion } from "../../repositories/episodeRepo";
import { createCharacter, updateCharacter } from "../../repositories/characterRepo";
import { createScene, updateScene } from "../../repositories/sceneRepo";
import {
  episodeBase,
  seriesBase,
  saveSeriesPromptSnapshot,
} from "../../api/v2/orchestration/_shared/paths";
import { ensureDir, writeJson } from "../../../../../packages/core/src/index";
import { loggerSync } from "../../../../../packages/core/src/logger";
import type { ShotData, PromptVersion } from "../../../../../packages/drama/src/types";
import { createScriptVersion } from "../../repositories/scriptVersionsRepo";
import { createStoryboardVersion } from "../../repositories/storyboardVersionsRepo";
import { isSupportingElement } from "../../../../../packages/drama/src/elementKinds";

// ─── Helpers ───────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function newShotId(index: number): string {
  const rand = crypto.randomBytes(2).toString("hex");
  return `s${String(index).padStart(4, "0")}_${rand}`;
}

/**
 * 通用 ensureBriefs helper — 没 brief 时塞 1 张兜底 (复用 single + multi).
 */
function ensureBriefs(
  rawBriefs: ReadonlyArray<{ angle: string; description: string }> | undefined,
  fallbackDescription: string,
): import("../../../../../packages/drama/src/types").ImageBrief[] {
  if (rawBriefs && rawBriefs.length > 0) {
    return rawBriefs.map((b) => ({
      angle: b.angle,
      description: b.description,
      generated: false,
    }));
  }
  const desc = fallbackDescription.trim() || "标准代表像";
  return [{ angle: "标准像", description: desc, generated: false }];
}

/**
 * Build a stub ScriptVersion summary from the LLM envelope.
 */
function buildSeriesScriptMd(envelope: BatchEnvelope): string {
  const lines: string[] = [];
  lines.push(`# ${envelope.series.title}`);
  lines.push("");
  if (envelope.series.synopsis) {
    lines.push(`> ${envelope.series.synopsis}`);
    lines.push("");
  }
  if (envelope.series.style_notes) {
    lines.push(`**风格**: ${envelope.series.style_notes}`);
    lines.push("");
  }
  for (const ep of envelope.episodes) {
    lines.push(`## ${ep.title}`);
    if (ep.synopsis) {
      lines.push("");
      lines.push(ep.synopsis);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("*由 AI 批量生成 — 灵感 → 系列+分集+分镜 一站式*");
  return lines.join("\n");
}

// ─── Main persist logic ────────────────────────────────────────────

/**
 * 持久化"一个 series 的 envelope" — 复用 single + multi 落盘逻辑.
 *
 * 调用方传:
 *   - envelope: LLM 输出的单个 series 数据
 *   - projectParams: 该项目的参数 (single 模式是顶层 body, multi 模式是 merged 后的 project 参数)
 *   - promptText: 用了的 prompt (snapshot 用)
 *   - actualProviderId: 实际命中的 LLM provider
 *
 * 返回该剧的落盘汇总.
 */
export async function persistOneSeriesFromEnvelope(
  envelope: BatchEnvelope,
  projectParams: BatchProjectInput,
  promptText: string,
  actualProviderId: string,
): Promise<{
  series_slug: string;
  series_title: string;
  episodes_created: number;
  total_shots: number;
  characters_created: number;
  scenes_created: number;
  pending_image_briefs: number;
  script_version_id?: string;
  storyboard_version_ids: string[];
  prompt_snapshot: string;
}> {
  const finalTitle = projectParams.series_title?.trim() || envelope.series.title;
  // 2026-05-22: 优先级 envelope.series.aspect_ratio (LLM 输出) > projectParams (用户填) > "9:16" (短剧默认竖屏).
  // 之前写死 fallback "16:9", 但本工作台是 AI 短剧, 默认应该竖屏抖音/小红书.
  // 用户原话: "这部剧的比例是什么, 视频、图片缩略图的比例就是什么".
  const finalAspect =
    (envelope.series as { aspect_ratio?: string }).aspect_ratio
    ?? projectParams.aspect_ratio
    ?? "9:16";
  const finalPlatform =
    (envelope.series as { platform?: string }).platform
    ?? projectParams.platform
    ?? "bilibili";

  const series = await createSeries({
    title: finalTitle,
    synopsis: envelope.series.synopsis,
    defaults: {
      platform: finalPlatform,
      aspect_ratio: finalAspect,
      ...(projectParams.style ? { visual_style: projectParams.style } : {}),
    },
  });

  await ensureDir(seriesBase(series.slug));

  let charactersCreated = 0;
  let scenesCreated = 0;
  let pendingImageBriefs = 0;

  // name → id 映射
  const nameToCharacterId = new Map<string, string>();
  const nameToSceneId = new Map<string, string>();
  // health-ignore: character/scene 走下方 createCharacter/createScene 专门路径,
  // 此处只管 4 类通用素材, 不是 ElementKind 覆盖缺失
  const nameToElementId = new Map<string, string>();
  try {
    const existingElements = await listElements(series.slug);
    for (const el of existingElements) {
      if (isSupportingElement(el)) {
        nameToElementId.set(el.name, el.id);
        nameToElementId.set(el.name.toLowerCase().trim(), el.id);
      }
    }
  } catch (e) {
    loggerSync().warn(
      "[batch-series] listElements for element_refs resolve failed (continuing with empty map):",
      e instanceof Error ? e.message : e,
    );
  }

  for (const ch of envelope.series.characters ?? []) {
    try {
      const briefs = ensureBriefs(ch.image_briefs, ch.appearance ?? "");
      const created = await createCharacter(series.slug, {
        name: ch.name,
        role: ch.role ?? "",
        appearance_prompt: ch.appearance ?? "",
        personality: ch.personality ?? "",
        appearance: ch.appearance,
        outfit: ch.outfit,
      });
      await updateCharacter(series.slug, created.id, { image_briefs: briefs });
      nameToCharacterId.set(ch.name, created.id);
      nameToCharacterId.set(ch.name.toLowerCase().trim(), created.id);
      charactersCreated += 1;
      pendingImageBriefs += briefs.length;
    } catch (e) {
      loggerSync().warn(
        `[batch-series] createCharacter "${ch.name}" failed (continuing):`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  for (const sc of envelope.series.scenes ?? []) {
    try {
      const briefs = ensureBriefs(sc.image_briefs, sc.visual_style ?? sc.location ?? "");
      const created = await createScene(series.slug, {
        name: sc.name,
        location: sc.location,
        mood: sc.mood,
        visual_style: sc.visual_style,
      });
      await updateScene(series.slug, created.id, { image_briefs: briefs });
      nameToSceneId.set(sc.name, created.id);
      nameToSceneId.set(sc.name.toLowerCase().trim(), created.id);
      scenesCreated += 1;
      pendingImageBriefs += briefs.length;
    } catch (e) {
      loggerSync().warn(
        `[batch-series] createScene "${sc.name}" failed (continuing):`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // ─── ID 解析 helpers (闭包转为显式参数) ──────────────────────────────

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
          `[batch-series] shot.character_refs name="${name}" 在 series 中找不到对应 character, 跳过`,
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
      `[batch-series] shot.scene_ref name="${name}" 在 series 中找不到对应 scene, 跳过`,
    );
    return undefined;
  }

  function resolveElementRefIds(refs: string[] | undefined): string[] {
    if (!refs || refs.length === 0) return [];
    const ids: string[] = [];
    for (const ref of refs) {
      const name = ref.trim();
      if (!name) continue;
      const id = nameToElementId.get(name) ?? nameToElementId.get(name.toLowerCase());
      if (id) {
        if (!ids.includes(id)) ids.push(id);
      } else {
        loggerSync().warn(
          `[batch-series] shot.element_refs name="${name}" 在 series 中找不到对应 element, 跳过`,
        );
      }
    }
    return ids;
  }

  const snapshotName = await saveSeriesPromptSnapshot(
    series.slug,
    "batch-generate-series",
    promptText,
    { input: projectParams, provider: actualProviderId },
  );

  const seriesScriptMd = buildSeriesScriptMd(envelope);
  await fs.writeFile(path.join(seriesBase(series.slug), "script.md"), seriesScriptMd, "utf8");

  let scriptVersionId: string | undefined;
  try {
    const sv = await createScriptVersion({
      series_slug: series.slug,
      title: `批量生成 · ${finalTitle}`,
      content_md: seriesScriptMd,
      source_inspirations: projectParams.inspiration ? [projectParams.inspiration.slice(0, 5000)] : [],
      user_prompt: `[batch] inspiration=${(projectParams.inspiration ?? "").slice(0, 200)}; style=${projectParams.style ?? ""}`,
      activate: true,
    });
    scriptVersionId = sv.id;
  } catch (e: unknown) {
    loggerSync().warn(
      "[batch-series] createScriptVersion failed (continuing):",
      e instanceof Error ? e.message : e,
    );
  }

  const storyboardVersionIds: string[] = [];
  let totalShots = 0;

  for (let i = 0; i < envelope.episodes.length; i++) {
    const ep = envelope.episodes[i];
    const created = await createEpisode(series.slug, {
      title: ep.title,
      index: i + 1,
    });

    const epDir = episodeBase(series.slug, created.id);
    await ensureDir(epDir);
    const shotsDir = path.join(epDir, "shots");
    await ensureDir(shotsDir);

    const sortedShots = [...ep.shots].sort((a, b) => a.index - b.index);
    const shotEntries: Array<{ shot_id: string; index: number }> = [];
    for (let j = 0; j < sortedShots.length; j++) {
      const s = sortedShots[j];
      const shotId = newShotId(j + 1);

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

      const resolvedCharacterIds = resolveCharacterIds(s.character_refs);
      const resolvedSceneId = resolveSceneId(s.scene_ref);
      const resolvedElementIds = resolveElementRefIds(s.element_refs);
      const batchReferenceOverrides = resolveReferenceOverrides(
        s,
        { elementNameToId: nameToElementId, characterNameToId: nameToCharacterId, sceneNameToId: nameToSceneId },
      );

      const batchNodesCtx = {
        characters: (envelope.series.characters ?? [])
          .map((c) => ({ name: c.name, id: nameToCharacterId.get(c.name) ?? nameToCharacterId.get(c.name.toLowerCase().trim()) ?? "" }))
          .filter((c) => c.id),
        scenes: (envelope.series.scenes ?? [])
          .map((sc) => ({ name: sc.name, id: nameToSceneId.get(sc.name) ?? nameToSceneId.get(sc.name.toLowerCase().trim()) ?? "" }))
          .filter((sc) => sc.id),
        elements: Array.from(nameToElementId.entries())
          .filter(([, id]) => typeof id === "string" && id.trim().length > 0)
          .map(([name, id]) => ({ name, id })),
      };
      const actionNodes = plainTextToNodes(s.action || "", batchNodesCtx);
      const dialogueNodes = plainTextToNodes(s.dialogue || "", batchNodesCtx);
      const voiceoverNodes = plainTextToNodes(s.voiceover || "", batchNodesCtx);
      const promptImgNodes = plainTextToNodes(initialImgPrompt, batchNodesCtx);
      const promptVidNodes = plainTextToNodes(initialVidPrompt, batchNodesCtx);

      const shotData: ShotData = {
        id: shotId,
        series_slug: series.slug,
        episode_id: created.id,
        index: j + 1,
        duration_sec: s.duration_sec ?? 5,
        character_ids: resolvedCharacterIds,
        element_ids: resolvedElementIds,
        scene_id: resolvedSceneId,
        reference_overrides: batchReferenceOverrides.length > 0 ? batchReferenceOverrides : undefined,
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
        prompt_img_versions: initialImgPrompt
          ? [{ version: 1, content: nodesToPlainText(promptImgNodes) || initialImgPrompt, created_at: nowISO(), created_by: "user" }]
          : promptImgVersions,
        prompt_vid_versions: initialVidPrompt
          ? [{ version: 1, content: nodesToPlainText(promptVidNodes) || initialVidPrompt, created_at: nowISO(), created_by: "user" }]
          : promptVidVersions,
        status: "drafted",
        generations: [],
        active_generations: [],
        trashed_generations: [],
      };

      await writeJson(path.join(shotsDir, `${shotId}.json`), shotData);
      shotEntries.push({ shot_id: shotId, index: j + 1 });
      totalShots += 1;
    }

    await writeJson(path.join(epDir, "storyboard.json"), {
      episode_id: created.id,
      series_slug: series.slug,
      shots: shotEntries,
      updated_at: nowISO(),
    });

    const epScriptMd = ep.script_md?.trim() || "";
    await updateEpisode(series.slug, created.id, {
      ...(ep.synopsis ? { synopsis: ep.synopsis } : {}),
      ...(projectParams.duration_per_episode_sec
        ? { target_duration_sec: projectParams.duration_per_episode_sec }
        : {}),
      ...(epScriptMd ? { script_md: epScriptMd } : {}),
      status: "storyboarded",
      storyboard_path: `episodes/${created.id}/storyboard.json`,
    });

    if (epScriptMd) {
      try {
        await createEpisodeVersion(
          series.slug,
          created.id,
          epScriptMd,
          "ai_init",
          `批量生成 · ${finalTitle} · ${ep.title}`,
        );
      } catch (e: unknown) {
        loggerSync().warn(
          `[batch-series] createEpisodeVersion(${created.id}) failed (continuing):`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (scriptVersionId) {
      try {
        const sbv = await createStoryboardVersion({
          series_slug: series.slug,
          episode_id: created.id,
          name: `分镜 v1 (批量生成 · ${new Date().toLocaleString("zh-CN", { hour12: false })})`,
          script_version_id: scriptVersionId,
          shot_ids: shotEntries.map((e) => e.shot_id),
          activate: true,
        });
        storyboardVersionIds.push(sbv.id);
      } catch (e: unknown) {
        loggerSync().warn(
          `[batch-series] createStoryboardVersion failed for ${created.id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  return {
    series_slug: series.slug,
    series_title: series.title,
    episodes_created: envelope.episodes.length,
    total_shots: totalShots,
    characters_created: charactersCreated,
    scenes_created: scenesCreated,
    pending_image_briefs: pendingImageBriefs,
    script_version_id: scriptVersionId,
    storyboard_version_ids: storyboardVersionIds,
    prompt_snapshot: snapshotName,
  };
}
