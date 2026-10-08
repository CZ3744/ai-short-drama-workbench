/**
 * shotPromptInput — 共用 helper: 把 ShotData + slug 转成 ShotPromptInput.
 *
 * 2026-05-19 Wave O Entity-first 重构:
 *   把原来藏在 shotStageController.ts 私有 helper 里的 buildShotPromptInput
 *   提到这里, 让 orchestrator (AutoPipeline 跑首帧) 和 shotStageController
 *   (单镜手动) 都能调用.
 *
 *   解耦信仰 (memory feedback_decoupling.md):
 *     "看到两份相似实现必须合并" — 原 shotStageController 内私有, orchestrator
 *     另写一份简陋字符串拼接 = 解耦失败. 抽到这里两条路径都走同一份逻辑.
 *
 *   Entity-first (memory feedback_entity_first.md):
 *     orchestrator AutoPipeline 路径之前用 `shot.prompt_img` 简陋字符串当 prompt,
 *     ChatGPT 拿到 reference_images 但 prompt 没有场景/角色/素材描述 → 生成的
 *     背景跟参考的"茶水间代表图"对不上. 现在两条路径都走 compileShotImagePrompt,
 *     prompt 含完整 entity 描述 + reference_images 双重锚定.
 *
 *   降级路径 (memory feedback_non_linear_workflow.md):
 *     无 character / scene / element 数据时不阻塞, 只是 segments 少一段.
 *     compileShotImagePrompt 内部对空数组/undefined 都有兜底.
 */

import {
  listCharacters,
  readCharacter,
  readScene,
  readEpisode,
  listShots,
  type ShotData,
} from "../../api/v2/seriesStore";
import { readSeries } from "../../repositories/seriesRepo";
import { readElement } from "../../repositories/elementRepo";
// 2026-05-28 — AI 出图打磨: 用现有 visual_style preset 作 fallback 给 series_visual_style.
// 用户没填 visual_style_guide 自由文本时, 走 defaults.visual_style enum (animecel / realistic /
// ink_wash / cyberpunk 等) 查 preset 拿 prompt_phrase 喂 compiler.
import { getPreset } from "../../../../../packages/core/src/presets";
import { readEffectiveElement } from "../cast/effectiveElements";
import type { ShotPromptInput } from "./shotPromptCompiler";
// 2026-05-27 — inferred reference_images_layout 走 collector, 跟 orchestrator 实发的
// reference_images 单一数据源, 防止"图发了 4 张但 prompt 文字说未附参考图"两套独立推导。
import { collectImplicitReferencesFromShot } from "./implicitReferenceCollector";
// Wave B-3 (2026-05-16): character appearance/outfit/personality 拆分后的拼接 helper
import { resolveVisualDescription } from "../../../../../packages/drama/src/characterPrompt";
// 2026-05-26 Fix 4 — *_nodes 富文本是真理源, 转 short text (@角色:林深 / @林深.img:asset_xxx) 喂 compiler.
// 让 humanizeMentionTokens 在 compiler 内拿到结构化 entity 引用, 避免裸文字丢失语义.
import { nodesToShortText } from "../../../../../packages/drama/src/shotText";
import type { ShotTextNode } from "../../../../../packages/drama/src/types";
// 2026-05-26 Codex P0-2 — 修复"页面预览有角色外观, 但审核弹窗没角色段"问题.
// 根因: shot.character_ids 没同步用户在 action/dialogue 等文本里写的 "@角色:林岚" mention.
// 这里在 compiler 入口主动 mention → entity 解析, 补 character_ids 让 compiler 永远拿到完整人物清单.
import { parseMentionTokensFromTexts } from "../../../../../packages/drama/src/mentionParser.js";

/**
 * 2026-05-26 W1 组合性 — 把 element id resolve 成 { name, description } 子对象.
 * 失败/找不到时返回 null (caller 跳过这一项, 不阻塞)。
 *
 * 用 readEffectiveElement (W4) 兼容 character/scene/prop/wardrobe/reference 全 kind:
 *   - 先 series local (含 character/scene legacy)
 *   - 失败再 cast member (W4 新, 当 series 挂了 cast 时)
 *
 * 主要给 wardrobe / prop 用 (角色绑定 / 本镜独立道具), 其他 kind 不会通过这条路径进来.
 */
async function resolveElementNameDesc(
  slug: string,
  elementId: string,
): Promise<{ name: string; description?: string } | null> {
  try {
    const el = await readEffectiveElement(slug, elementId);
    if (!el) return null;
    return {
      name: el.name ?? elementId,
      description: el.description?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 2026-05-28 — AI 出图打磨: visual_style preset id → prompt_phrase 解析.
 *
 * 用户在 CreateSeriesDialog 选 "动漫赛璐璐" → series.defaults.visual_style = "anime_cel",
 * 这里查 config/presets/visual_style.json 拿 prompt_phrase = "日式动漫风格,赛璐璐着色,清晰线条".
 *
 * 用作 series_visual_style fallback (优先 visual_style_guide 自由文本, fallback preset).
 * 找不到 / preset 缺 prompt_phrase 时返 undefined, caller 跳过该字段.
 */
async function resolveVisualStylePresetPhrase(presetId: string): Promise<string | undefined> {
  if (!presetId.trim()) return undefined;
  try {
    const option = getPreset("visual_style", presetId);
    const phrase = (option?.prompt_phrase ?? "").trim();
    return phrase || undefined;
  } catch {
    return undefined;
  }
}

export interface BuildShotPromptOptions {
  user_extra?: string;
  has_first_frame_ref?: boolean;
  has_end_frame_ref?: boolean;
  /**
   * 2026-05-22 — caller (orchestrator / shotStage 等) 自己已经知道 reference_images 的
   * 顺序和角色 (e.g. ["picked first frame", "picked end frame", "key #1 t=1.5s",
   *  "character primary", "scene primary", "user @ ref"]), 直接传进来, prompt 里会
   * 一一列出. 不传则 buildShotPromptInput 内部尝试从 shot.frame_anchors 推导.
   */
  reference_images_layout?: ShotPromptInput["reference_images_layout"];
  /**
   * 2026-05-27 — 跨分镜风格一致性: caller 注入全剧 / 本集 / 邻镜上下文.
   * 不传走 fallback: 内部自动从 series.synopsis / episode meta / 邻镜 action 派生.
   */
  series_synopsis?: string;
  series_visual_style?: string;
  episode_brief?: string;
  shot_position?: { current: number; total: number };
  prev_shot_brief?: string;
  next_shot_brief?: string;
}

/**
 * 2026-05-27 — 跨分镜一致性: 派生 series + episode + adjacent shot 上下文.
 *
 * 用户原话: "整部剧的风格就不怎么统一... 通常这种问题成熟短剧生成流是怎么解决的?
 * 需不需要把全集的剧本作为背景信息喂给模型? 或者针对剧本提炼一下关键词或者简述,
 * 帮助模型理解他生成的这段分镜在整集中的位置".
 *
 * 成熟方案 (Runway/Sora/Higgsfield): Style Bible (全剧美学) + Episode Brief
 * (本集情绪) + Adjacent Shot Context (前后镜) 三层全局上下文喂模型. 本项目从
 * series.synopsis + episode.title + 同 ep 的相邻 shot.action 现有字段派生,
 * 0 改 schema 就能用. 未来扩展可加 series.visual_style_guide 字段.
 *
 * 任何字段读不到时 silently 跳过, 不阻塞主流程.
 */
async function deriveSeriesContextForShot(
  slug: string,
  shot: ShotData,
): Promise<{
  series_synopsis?: string;
  series_visual_style?: string;
  episode_brief?: string;
  shot_position?: { current: number; total: number };
  prev_shot_brief?: string;
  next_shot_brief?: string;
}> {
  const ctx: ReturnType<typeof deriveSeriesContextForShot> extends Promise<infer T> ? T : never = {};
  // 2026-05-28 — AI 出图打磨: series 题材 + 全剧视觉风格.
  //
  // visual_style 解析优先级 (高 → 低):
  //   1. series.visual_style_guide (用户自由文本, 0-600 字, "Style Bible")
  //   2. series.defaults.visual_style (enum preset, 查 config/presets/visual_style.json
  //      拿 prompt_phrase, e.g. "日式动漫风格,赛璐璐着色,清晰线条")
  //   3. 都没填 → ctx.series_visual_style undefined, compiler 跳过该段
  //
  // 老 series 没填 visual_style_guide 也能继续工作 — defaults.visual_style
  // 在创建 series 时就强制要求 (CreateSeriesDialog), 几乎所有 series 都有.
  try {
    const series = await readSeries(slug);
    if (series) {
      const synopsis = (series.synopsis ?? "").trim();
      if (synopsis) ctx.series_synopsis = synopsis.slice(0, 400);

      // 优先用 visual_style_guide (用户自由文本) — Style Bible
      const userStyleGuide = (series.visual_style_guide ?? "").trim();
      if (userStyleGuide) {
        ctx.series_visual_style = userStyleGuide.slice(0, 600);
      } else {
        // Fallback to defaults.visual_style preset prompt_phrase
        const presetId = (series.defaults?.visual_style ?? "").trim();
        if (presetId) {
          const phrase = await resolveVisualStylePresetPhrase(presetId);
          if (phrase) ctx.series_visual_style = phrase;
        }
      }
    }
  } catch { /* noop — series 读不到不阻塞 */ }

  // episode brief + shot 在 ep 内位置 + 前后镜
  try {
    const epId = shot.episode_id;
    if (epId) {
      const ep = await readEpisode(slug, epId).catch(() => null);
      const epBrief = ((ep as { brief?: string; description?: string } | null)?.brief
        ?? (ep as { brief?: string; description?: string } | null)?.description
        ?? "").trim();
      if (epBrief) ctx.episode_brief = epBrief.slice(0, 300);

      // 同集所有 shot 列表 — 推位置 + 邻镜
      const shots = await listShots(slug, epId).catch(() => [] as ShotData[]);
      if (Array.isArray(shots) && shots.length > 0) {
        const idx = shots.findIndex((s) => s.id === shot.id);
        if (idx >= 0) {
          ctx.shot_position = { current: idx + 1, total: shots.length };
          const briefOf = (s: ShotData | undefined): string => {
            if (!s) return "";
            // 取 action / title 前 120 字作 brief
            const raw = (s.action ?? "").trim() || (s.title ?? "").trim() || (s.dialogue ?? "").trim();
            return raw.slice(0, 120);
          };
          const prevB = briefOf(shots[idx - 1]);
          const nextB = briefOf(shots[idx + 1]);
          if (prevB) ctx.prev_shot_brief = prevB;
          if (nextB) ctx.next_shot_brief = nextB;
        }
      }
    }
  } catch { /* noop — episode / shots 读不到不阻塞 */ }

  return ctx;
}

/**
 * 从 ShotData + slug resolve 出 entity 描述 (character / scene / element),
 * 拼成 shotPromptCompiler 接受的 ShotPromptInput.
 *
 * - character_ids → readCharacter → 拿 description + primary_image_note
 * - scene_id → readScene → 拿 description + primary_image_note
 * - element_ids → readElement → 拿 kind + name + description
 * - reference_asset_ids → 加进 elements 作 "参考图" 标签
 *
 * 任何 entity 读不到时 fallback 到 id 作 name (不阻塞), 跟 shotStageController
 * 原 buildShotPromptInput 行为完全一致.
 */
export async function buildShotPromptInput(
  slug: string,
  shot: ShotData,
  opts: BuildShotPromptOptions = {},
): Promise<ShotPromptInput> {
  // 2026-05-26 Codex P0-2 — 主动从 shot 文本字段解析 @角色:XXX mention, 补齐 character_ids.
  // 防止 ensureSaved 不同步 / 用户没 picker 绑定 → compiler 拿不到角色 → composed_prompt 漏外观段.
  // 解析失败/无 mention 时无副作用, 行为退化为原 character_ids.
  const explicitCharIds = new Set(shot.character_ids ?? []);
  const mentionedCharIds: string[] = [];
  try {
    const mentionTexts: Array<string | undefined> = [
      shot.action,
      shot.dialogue,
      shot.voiceover,
      shot.notes,
      shot.prompt_img,
      shot.prompt_vid,
    ];
    // *_nodes 是真理源, 转 short text 一并喂进去
    if (Array.isArray(shot.action_nodes)) mentionTexts.push(nodesToShortText(shot.action_nodes));
    if (Array.isArray(shot.dialogue_nodes)) mentionTexts.push(nodesToShortText(shot.dialogue_nodes));
    if (Array.isArray(shot.voiceover_nodes)) mentionTexts.push(nodesToShortText(shot.voiceover_nodes));
    const tokens = parseMentionTokensFromTexts(...mentionTexts);
    const characterTokens = tokens.filter((t) => t.kind === "character");
    if (characterTokens.length > 0) {
      const allChars = await listCharacters(slug).catch(() => []);
      for (const tok of characterTokens) {
        const match = allChars.find((c) => c.name === tok.name);
        if (match && !explicitCharIds.has(match.id) && !mentionedCharIds.includes(match.id)) {
          mentionedCharIds.push(match.id);
        }
      }
    }
  } catch {
    // mention 解析失败不阻塞, fallback 到 explicit character_ids
  }
  const effectiveCharIds = [...(shot.character_ids ?? []), ...mentionedCharIds];

  const characters: ShotPromptInput["characters"] = [];
  for (const cid of effectiveCharIds) {
    try {
      const c = await readCharacter(slug, cid);
      if (c) {
        // P1-fix(task4): populate primary_image_note with real prompt_snapshot
        // so the LLM gets concrete visual features for consistency.
        let primaryImageNote = "";
        if (c.primary_ref_image_id) {
          const meta = c.ref_image_meta?.[c.primary_ref_image_id];
          if (meta?.prompt_snapshot) {
            primaryImageNote = `主图特征(参考此风格): ${meta.prompt_snapshot.slice(0, 200)}`;
          } else {
            primaryImageNote = "已锁定主图(参考其外观一致性，主图无提示词记录)";
          }
        }

        // 2026-05-26 W1 组合性 — resolve 角色本镜服装造型 + 常带道具
        //   wardrobe 优先级: shot.wardrobe_id 显式 > character.wardrobe_element_ids[0] 默认 > undefined
        //   props: character.prop_element_ids 全部 resolve (与 shot.prop_ids 互补, 后者走 shot_props)
        let wardrobe: { name: string; description?: string } | undefined;
        const wardrobeId =
          (shot.wardrobe_id && shot.wardrobe_id.trim()) ||
          (c.wardrobe_element_ids && c.wardrobe_element_ids[0]) ||
          undefined;
        if (wardrobeId) {
          const wr = await resolveElementNameDesc(slug, wardrobeId);
          if (wr) wardrobe = wr;
        }

        const props: Array<{ name: string; description?: string }> = [];
        for (const propId of c.prop_element_ids ?? []) {
          const pr = await resolveElementNameDesc(slug, propId);
          if (pr) props.push(pr);
        }

        // Wave B-3 (2026-05-16): description = appearance + outfit
        characters.push({
          name: c.name ?? cid,
          description: resolveVisualDescription(c),
          primary_image_note: primaryImageNote,
          ...(wardrobe ? { wardrobe } : {}),
          ...(props.length > 0 ? { props } : {}),
        });
      } else {
        // 2026-07-09 audit C23 — 缺失角色(被删/读不到)不把裸 cid(ULID)当角色名 push:
        // 否则 char_01H8... 既在铁律#2 审核弹窗展示给用户看到 ULID, 又发给图像/视频模型
        // 当角色名污染生成(铁律 #9 toC 兜底). 与 scene 分支(readScene 返 null → 省略场景段)
        // 对齐: 跳过该角色, "出场人物" 段自然省略这个已不存在的 entity.
        // 缺失参考图信号已由下方 collectImplicitReferencesFromShot 走 SSE missing 上报, 不重复.
        continue;
      }
    } catch {
      // 同上: 读角色异常也跳过, 绝不把裸 cid 当角色名喂 LLM/展示.
      continue;
    }
  }

  let scene: ShotPromptInput["scene"];
  if (shot.scene_id) {
    try {
      const s = await readScene(slug, shot.scene_id);
      if (s) {
        let scenePrimaryNote = "";
        if (s.primary_ref_image_id) {
          const sMeta = s.ref_image_meta?.[s.primary_ref_image_id];
          if (sMeta?.prompt_snapshot) {
            scenePrimaryNote = `场景主图特征(参考此风格): ${sMeta.prompt_snapshot.slice(0, 200)}`;
          } else {
            scenePrimaryNote = "已锁定场景图(参考其视觉风格，场景主图无提示词记录)";
          }
        }
        scene = {
          name: s.name ?? "未命名场景",
          description: s.description ?? s.visual_style ?? "",
          primary_image_note: scenePrimaryNote,
        };
      } else {
        // P1-fix(task5): do NOT use raw scene_id as scene name — it leaks internal IDs to LLM.
        scene = undefined;
      }
    } catch {
      scene = undefined;
    }
  }

  const elements: ShotPromptInput["elements"] = [];
  for (const eid of shot.element_ids ?? []) {
    try {
      // W4: 先走 series local (readElement = elementRepo 4 kind), 没的话 fallback effective
      // (含 cast member). 老路径 readElement 在前可避免对 series 挂 cast 时的多余查询.
      let el: { kind?: string; name?: string; description?: string } | null = await readElement(slug, eid);
      if (!el) {
        const eff = await readEffectiveElement(slug, eid);
        if (eff) el = { kind: eff.kind, name: eff.name, description: eff.description };
      }
      if (el) {
        elements.push({
          kind: el.kind ?? "素材",
          // 2026-07-09 audit 补漏(终验 C23) — el.name 空时不用 eid(ULID)兜底(会泄漏进 prompt 喂模型), 用 kind.
          name: el.name ?? el.kind ?? "素材",
          description: el.description ?? "",
        });
      } else {
        // 素材找不到 → 跳过, 不把 raw ULID 当素材名塞进 prompt (降级: 缺该素材, 符合缺数据降级铁律).
        continue;
      }
    } catch {
      continue;
    }
  }

  // reference_asset_ids — 当作 reference 类 element 拼进去 (走 notes 当描述)
  const refNotes = shot.reference_notes ?? {};
  for (const aid of shot.reference_asset_ids ?? []) {
    elements.push({
      kind: "参考图",
      // 2026-07-09 audit 补漏(终验 C23) — 无 note 时不用 aid(ULID)当名(会泄漏进 prompt 喂模型), 用中性占位.
      name: refNotes[aid]?.trim() || "参考图",
      description: refNotes[aid]?.trim() || "",
    });
  }

  // 2026-05-26 W1 组合性 — shot.prop_ids: 本镜独立出现的道具 (与 character.prop_element_ids 互补).
  //   渲染时单独走 shot_props section, 让模型清楚"这是本镜剧情特有的, 不是角色平时常带".
  const shotProps: ShotPromptInput["shot_props"] = [];
  for (const propId of shot.prop_ids ?? []) {
    const pr = await resolveElementNameDesc(slug, propId);
    if (pr) shotProps.push(pr);
  }

  // 2026-05-22 — 收集参考图清单 (用户原话: "首帧/尾帧/关键帧等如果有 0~n 张,
  // 如何确保一一正确加入了文字提示词要求参考?")
  //
  // 优先用 caller 传的 (orchestrator 已知 reference_images 数组顺序),
  // 否则按 shot 数据兜底推导:
  //   1. frame_anchors role=first → first_frame
  //   2. frame_anchors role=end → end_frame
  //   3. frame_anchors role=key (按 position 排序) → key_frame
  //   4. collector (collectImplicitReferencesFromShot) → character_primary /
  //      character_wardrobe / character_prop / scene_primary / element_primary /
  //      shot_prop (含 typical pool 多张)
  //   5. shot.reference_asset_ids → user_reference (按 reference_notes 命名)
  //
  // 2026-05-27 — 4 路改走 collector, 跟 orchestrator 实发的 reference_images 单一数据源.
  //   之前用 characters[].primary_image_note / scene.primary_image_note 字段非空判断,
  //   W4 后角色/场景图存到 element typical pool, primary_ref_image_id 字段为空 →
  //   inferred 推不出 character_primary → 实际发了 4 张图但文字写"未附参考图".
  //   collector 走 el.images[].is_typical, 跟 orchestrator 真实发图逻辑完全一致.
  let referenceLayout = opts.reference_images_layout;
  if (!referenceLayout) {
    const inferred: NonNullable<ShotPromptInput["reference_images_layout"]> = [];
    const anchors = shot.frame_anchors ?? [];
    const first = anchors.find((a) => a.role === "first");
    if (first) inferred.push({ role: "first_frame", label: "首帧锚点候选图" });
    const end = anchors.find((a) => a.role === "end");
    if (end) inferred.push({ role: "end_frame", label: "尾帧锚点候选图" });
    const keys = anchors.filter((a) => a.role === "key").sort((a, b) => a.position - b.position);
    keys.forEach((k, i) => {
      inferred.push({ role: "key_frame", label: `关键帧 #${i + 1}`, position_sec: k.position });
    });

    // 2026-05-27 — character/scene/element/shot_prop 走 collector 拿 typical pool 多图,
    // 跟 orchestrator 实发的 reference_images 数组对齐 (SuggestedReference.source 与
    // reference_images_layout.role 字符串枚举完全一致, 直接 1:1 映射).
    try {
      const suggested = await collectImplicitReferencesFromShot(slug, shot);
      for (const ref of suggested) {
        inferred.push({ role: ref.source, label: ref.label });
      }
    } catch {
      // collector 异常时降级到旧推导逻辑 (基于字段非空), 保底不阻塞 compile.
      for (const c of characters) {
        if (c.primary_image_note) {
          inferred.push({ role: "character_primary", label: `角色「${c.name}」主图` });
        }
        if (c.wardrobe) {
          inferred.push({
            role: "character_wardrobe",
            label: `角色「${c.name}」服装造型「${c.wardrobe.name}」`,
          });
        }
        if (c.props && c.props.length > 0) {
          for (const p of c.props) {
            inferred.push({
              role: "character_prop",
              label: `角色「${c.name}」常带道具「${p.name}」`,
            });
          }
        }
      }
      if (scene?.primary_image_note) {
        inferred.push({ role: "scene_primary", label: `场景「${scene.name}」主图` });
      }
      for (const sp of shotProps) {
        inferred.push({ role: "shot_prop", label: `本镜独立道具「${sp.name}」` });
      }
    }

    const refNotes = shot.reference_notes ?? {};
    for (const aid of shot.reference_asset_ids ?? []) {
      const note = refNotes[aid]?.trim();
      inferred.push({ role: "user_reference", label: note || "用户附加参考图" });
    }
    referenceLayout = inferred;
  }

  // 2026-05-26 Fix 4 — 5 个文本字段优先读 *_nodes 走 nodesToShortText, 让 compiler
  // 拿到含 "@角色:林深" / "@林深.img:asset_xxx" 的字符串. plain text 字段是 derived,
  // 会丢失 @ 标注 (用户写 "@林深被抓走" → action="林深被抓走", entity 引用语义丢失).
  const readShotText = (
    nodes: ShotTextNode[] | undefined,
    plain: string | undefined,
  ): string => {
    if (Array.isArray(nodes) && nodes.length > 0) {
      const short = nodesToShortText(nodes);
      if (short && short.trim()) return short;
    }
    return plain ?? "";
  };
  return {
    shot_index: shot.index,
    title: shot.title ?? shot.scene_label ?? undefined,
    action: readShotText(shot.action_nodes, shot.action),
    dialogue: readShotText(shot.dialogue_nodes, shot.dialogue),
    voiceover: readShotText(shot.voiceover_nodes, shot.voiceover),
    notes: shot.notes ?? "",
    shot_type: shot.shot_type ?? "",
    camera_movement: shot.camera_movement ?? "",
    style: shot.style ?? "",
    time_of_day: shot.time_of_day ?? "",
    lighting: shot.lighting ?? "",
    mood: shot.mood ?? "",
    duration_sec: shot.duration_sec,
    pace: (shot as { pace?: string }).pace ?? "",
    // W7 (2026-05-16): 画幅必须进 prompt — 防止模型生成与 resolveRenderSpec
    // clamp 出的尺寸不匹配的画面。
    aspect_ratio: shot.aspect_ratio ?? "",
    characters,
    scene,
    elements,
    ...(shotProps.length > 0 ? { shot_props: shotProps } : {}),
    user_extra: opts.user_extra,
    has_first_frame_ref: opts.has_first_frame_ref,
    has_end_frame_ref: opts.has_end_frame_ref,
    reference_images_layout: referenceLayout,
    extra_negative: shot.negative_prompt ?? "",
    // 2026-05-27 — 跨分镜一致性上下文. caller 显式传入优先, 否则自动派生 fallback.
    // 派生失败 (series / episode / shots 读不到) 时各字段 undefined, compiler 自动跳过对应 segment.
    ...(await (async () => {
      const derived = await deriveSeriesContextForShot(slug, shot);
      return {
        series_synopsis: opts.series_synopsis ?? derived.series_synopsis,
        series_visual_style: opts.series_visual_style ?? derived.series_visual_style,
        episode_brief: opts.episode_brief ?? derived.episode_brief,
        shot_position: opts.shot_position ?? derived.shot_position,
        prev_shot_brief: opts.prev_shot_brief ?? derived.prev_shot_brief,
        next_shot_brief: opts.next_shot_brief ?? derived.next_shot_brief,
      };
    })()),
  };
}
