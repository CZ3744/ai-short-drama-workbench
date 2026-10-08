import path from "node:path";
import { resolveVideoFormat } from "./videoFormat";
import type { SceneManifest, SceneManifestScene, ScriptUnderstanding, VideoMetadata } from "./types";

export const emptyUnderstanding: ScriptUnderstanding = {
  summary: "脚本尚未完成理解，已使用安全 fallback。",
  audience: "对主题感兴趣的普通观众",
  tone: "清晰、克制、适合知识讲解",
  content_type: "知识讲解",
  recommended_style: "Claude/iOS 质感卡片风",
  structure: [
    {
      title: "核心内容",
      purpose: "保证视频闭环生成",
      key_points: ["脚本导入", "分镜规划", "本地渲染"]
    }
  ],
  visual_direction: "使用浅色卡片、关键词、结构图和字幕承载信息。",
  potential_difficulties: ["LLM 不可用时需要 fallback 保证工程闭环"]
};

export function createBaseManifest(input: {
  jobId: string;
  title: string;
  style: string;
  visualStrategy: string;
  provider: string;
  baseUrl: string;
  model: string;
  mock?: boolean;
  subtitleMode?: SceneManifest["subtitle_mode"];
  understanding?: ScriptUnderstanding;
  scenes?: SceneManifestScene[];
  metadata?: VideoMetadata;
  aspectRatio?: string;
  resolution?: string;
}): SceneManifest {
  const now = new Date().toISOString();
  const fmt = resolveVideoFormat({ resolution: input.resolution, aspectRatio: input.aspectRatio });
  return {
    job_id: input.jobId,
    project_title: input.title,
    source_language: "zh-CN",
    target_platform: "bilibili",
    aspect_ratio: fmt.aspectRatio,
    resolution: fmt.resolution,
    style: input.style,
    visual_strategy: input.visualStrategy,
    llm_provider: input.provider,
    llm_base_url: input.baseUrl,
    llm_model: input.model,
    llm_mock: Boolean(input.mock ?? false),
    subtitle_mode: input.subtitleMode ?? "both",
    audio_mode: undefined,
    render_audio_source: undefined,
    burned_subtitles: false,
    created_at: now,
    updated_at: now,
    script_understanding: input.understanding ?? emptyUnderstanding,
    scenes: input.scenes ?? [],
    metadata:
      input.metadata ?? {
        bilibili_title: input.title,
        bilibili_description: "由本地脚本驱动 AI 视频系统自动生成的视频草案。",
        bilibili_tags: ["AI视频", "自动化", "知识讲解"],
        cover_text: input.title,
        comment_prompt: "你最希望这个系统下一步补上哪类能力？"
      }
  };
}

export function normalizeScene(scene: Partial<SceneManifestScene>, index: number): SceneManifestScene {
  // v0.2.4 fix: `??` only catches null/undefined; when the LLM returns
  // narration_text:"" we were writing an empty string into the manifest,
  // which downstream estimateDuration and splitSubtitle both degrade on.
  // `||` is correct here because three non-empty strings are what we want.
  const narration = String(scene.narration_text || scene.scene_title || `第 ${index} 段内容`);
  const sceneId = Number(scene.scene_id ?? index);
  const now = new Date().toISOString();
  return {
    scene_id: sceneId,
    stable_scene_id: String(scene.stable_scene_id ?? `scn_${sceneId}`),
    order: Number(scene.order ?? sceneId),
    chapter: String(scene.chapter ?? "正文"),
    scene_title: String(scene.scene_title ?? `Scene ${index}`),
    narration_text: narration,
    narration_mode: scene.narration_mode ?? "verbatim_or_adapted",
    visual_goal: String(scene.visual_goal ?? "用清晰的信息卡片承载本段核心观点。"),
    visual_type: scene.visual_type ?? "keyword_card",
    visual_prompt: String(scene.visual_prompt ?? "Claude/iOS 风格浅色信息卡片，清晰标题、关键词、结构化层级。"),
    local_card_prompt: String(scene.local_card_prompt ?? scene.visual_prompt ?? "Claude/iOS 风格浅色信息卡片，清晰标题、关键词、结构化层级。"),
    future_image_prompt: String(scene.future_image_prompt ?? scene.visual_prompt ?? "高质量知识视频配图，清晰信息层级，适合 B 站报告解读。"),
    future_video_prompt: String(scene.future_video_prompt ?? "轻微推拉镜头，信息卡片淡入，保持字幕安全区。"),
    negative_prompt: String(scene.negative_prompt ?? "低清晰度、拥挤排版、强烈霓虹、廉价渐变、遮挡字幕"),
    screen_text: Array.isArray(scene.screen_text) && scene.screen_text.length > 0 ? scene.screen_text.map(String).slice(0, 4) : [narration.slice(0, 32)],
    keywords: Array.isArray(scene.keywords) && scene.keywords.length > 0 ? scene.keywords.map(String).slice(0, 8) : ["脚本", "分镜", "自动化"],
    motion_suggestion: String(scene.motion_suggestion ?? "轻微淡入和 1.02x 缓慢推近。"),
    layout_suggestion: String(scene.layout_suggestion ?? "左侧标题与关键词，右侧使用结构卡片或流程图，底部保留字幕安全区。"),
    visual_consistency_tags:
      Array.isArray(scene.visual_consistency_tags) && scene.visual_consistency_tags.length > 0
        ? scene.visual_consistency_tags.map(String).slice(0, 8)
        : ["warm-light", "glass-card", "bilibili-report"],
    fallback_strategy: String(scene.fallback_strategy ?? "使用程序化 SVG/PNG 信息卡片承载标题、关键词和结构关系。"),
    duration_estimate_sec: clampDuration(Number(scene.duration_estimate_sec ?? estimateDuration(narration))),
    actual_duration_sec: scene.actual_duration_sec ?? null,
    asset_path: scene.asset_path ?? null,
    audio_path: scene.audio_path ?? null,
    subtitle_path: scene.subtitle_path ?? null,
    status: scene.status ?? "draft",
    fallback_used: Boolean(scene.fallback_used ?? false),
    notes: String(scene.notes ?? ""),
    locked: Boolean(scene.locked ?? false),
    needs_regen: Boolean(scene.needs_regen ?? false),
    needs_audio_regen: Boolean(scene.needs_audio_regen ?? false),
    version: Number(scene.version ?? 1),
    major_version: Number((scene as any).major_version ?? 1),
    minor_version: Number((scene as any).minor_version ?? 0),
    updated_at: String(scene.updated_at ?? now),
    asset_versions: Array.isArray(scene.asset_versions) ? scene.asset_versions : [],
    clip_versions: Array.isArray(scene.clip_versions) ? scene.clip_versions : [],
    active_clip_version_id: scene.active_clip_version_id ?? null,
    clip_generation_status: scene.clip_generation_status ?? "idle",
    image_versions: Array.isArray(scene.image_versions) ? scene.image_versions : [],
    active_image_version_id: scene.active_image_version_id ?? null
  };
}

export function estimateDuration(text: string) {
  const zhChars = [...text].filter((char) => /[\u4e00-\u9fff]/.test(char)).length;
  const latinWords = text.replace(/[\u4e00-\u9fff]/g, " ").trim().split(/\s+/).filter(Boolean).length;
  return clampDuration(Math.ceil(zhChars / 4.2 + latinWords / 2.2) + 2);
}

// Clamp scene-level duration estimate during planning.
// Scene duration (6-60s) is separate from clip duration (max 120s in schema).
// Scene clamp is lower because a single scene rarely exceeds 60s in B站 content.
// Clip-level 120s limit is enforced at clip generation / provider adapter stage.
export function clampDuration(value: number) {
  if (!Number.isFinite(value)) return 10;
  return Math.max(6, Math.min(60, Math.round(value)));
}

export function fallbackScenes(script: string): SceneManifestScene[] {
  const chunks = chunkScript(script);
  const scenes: SceneManifestScene[] = [];
  scenes.push(
    normalizeScene(
      {
        scene_id: 1,
        chapter: "开场",
        scene_title: "脚本驱动的视频生产从哪里开始",
        narration_text: chunks[0] ?? script.slice(0, 120),
        visual_type: "title_card",
        visual_goal: "建立主题与观看期待。",
        screen_text: ["脚本驱动", "AI 视频自动生产"],
        keywords: ["脚本", "工作流", "自动生成"],
        layout_suggestion: "大标题居中，底部显示进度线与章节标签。"
      },
      1
    )
  );
  chunks.slice(1).forEach((chunk, index) => {
    scenes.push(
      normalizeScene(
        {
          scene_id: index + 2,
          chapter: index < 2 ? "系统能力" : "落地路径",
          scene_title: deriveTitle(chunk, index + 2),
          narration_text: chunk,
          visual_type: index % 3 === 1 ? "diagram" : "keyword_card",
          visual_goal: "把段落中的抽象信息转化为可浏览的视觉层级。",
          screen_text: deriveBullets(chunk),
          keywords: deriveKeywords(chunk),
          layout_suggestion: index % 3 === 1 ? "中心流程图，三到四个节点串联任务。" : "左标题右关键词卡，背景使用柔和玻璃质感。"
        },
        index + 2
      )
    );
  });
  // v0.2.4: align with ScenePlannerSchema which allows up to 50 scenes.
  // Previous hard cap of 12 silently dropped scenes past index 12 on
  // fallback paths, making idempotent re-runs non-deterministic.
  return scenes.slice(0, 50).map((scene, index) =>
    normalizeScene({
      ...scene,
      scene_id: index + 1,
      order: index + 1,
      stable_scene_id: scene.stable_scene_id ?? `scn_${index + 1}`
    }, index + 1)
  );
}

function chunkScript(script: string) {
  const normalized = script.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const paragraph of paragraphs.length ? paragraphs : [normalized]) {
    if ([...paragraph].length <= 170) {
      chunks.push(paragraph);
      continue;
    }
    const sentences = paragraph.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
    let current = "";
    for (const sentence of sentences) {
      if ([...`${current}${sentence}`].length > 170 && current) {
        chunks.push(current);
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks.length ? chunks : ["请提供脚本文本。"];
}

export function migrateManifest(manifest: SceneManifest): SceneManifest {
  const now = new Date().toISOString();
  let changed = false;

  const migratedScenes = manifest.scenes.map((scene, idx) => {
    let sceneChanged = false;
    const migrated = { ...scene };

    if (!migrated.stable_scene_id) {
      migrated.stable_scene_id = `scn_${migrated.scene_id ?? idx + 1}`;
      sceneChanged = true;
    }
    if (migrated.order === undefined || migrated.order === null) {
      migrated.order = migrated.scene_id ?? idx + 1;
      sceneChanged = true;
    }
    if (migrated.locked === undefined || migrated.locked === null) {
      migrated.locked = false;
      sceneChanged = true;
    }
    if ((migrated as any).status === undefined) {
      migrated.status = (migrated as any).status || "draft";
      sceneChanged = true;
    }
    if (migrated.needs_regen === undefined || migrated.needs_regen === null) {
      migrated.needs_regen = false;
      sceneChanged = true;
    }
    if (migrated.needs_audio_regen === undefined || migrated.needs_audio_regen === null) {
      migrated.needs_audio_regen = false;
      sceneChanged = true;
    }
    if (migrated.version === undefined || migrated.version === null) {
      migrated.version = 1;
      sceneChanged = true;
    }
    if ((migrated as any).major_version === undefined || (migrated as any).major_version === null) {
      (migrated as any).major_version = 1;
      sceneChanged = true;
    }
    if ((migrated as any).minor_version === undefined || (migrated as any).minor_version === null) {
      (migrated as any).minor_version = 0;
      sceneChanged = true;
    }
    if (!migrated.updated_at) {
      migrated.updated_at = now;
      sceneChanged = true;
    }
    if (!Array.isArray(migrated.asset_versions)) {
      migrated.asset_versions = [];
      sceneChanged = true;
    }
    if (!Array.isArray(migrated.clip_versions)) {
      migrated.clip_versions = [];
      sceneChanged = true;
    }
    if (migrated.active_clip_version_id === undefined) {
      migrated.active_clip_version_id = null;
      sceneChanged = true;
    }
    if (!migrated.clip_generation_status) {
      migrated.clip_generation_status = "idle";
      sceneChanged = true;
    }
    if (!Array.isArray(migrated.image_versions)) {
      (migrated as any).image_versions = [];
      sceneChanged = true;
    }
    if ((migrated as any).active_image_version_id === undefined) {
      (migrated as any).active_image_version_id = null;
      sceneChanged = true;
    }

    if (sceneChanged) changed = true;
    return migrated;
  });

  if (!changed && manifest.updated_at) return manifest;

  return { ...manifest, scenes: migratedScenes, updated_at: now };
}

function deriveTitle(text: string, index: number) {
  const clean = text.replace(/[，。！？；：、,.!?;:]/g, " ").trim();
  return clean.slice(0, 18) || `关键观点 ${index}`;
}

function deriveBullets(text: string) {
  const parts = text.split(/[，。；：、,.!?！？;:]/).map((x) => x.trim()).filter(Boolean);
  return parts.slice(0, 3).map((x) => x.slice(0, 22));
}

function deriveKeywords(text: string) {
  const candidates = text.match(/[\u4e00-\u9fffA-Za-z0-9]{2,8}/g) ?? [];
  return [...new Set(candidates)].slice(0, 6);
}

// --- validateAndRepairManifest ---

const VALID_SCENE_STATUSES = new Set([
  "planned", "asset_ready", "audio_ready", "subtitle_ready", "rendered",
  "failed", "fallback", "draft", "approved", "edited", "needs_regen", "generated"
]);

const VALID_CLIP_GEN_STATUSES = new Set(["idle", "generating", "ready", "failed"]);

export interface ValidateRepairResult {
  manifest: SceneManifest;
  warnings: string[];
  changed: boolean;
}

export function validateAndRepairManifest(manifest: SceneManifest, opts?: { jobRoot?: string }): ValidateRepairResult {
  const warnings: string[] = [];
  let changed = false;
  const now = new Date().toISOString();

  // P1-1: Check for contradictory aspect_ratio / resolution
  // Derive the expected resolution from aspect_ratio alone, then compare.
  const fmtFromAspect = resolveVideoFormat({ aspectRatio: manifest.aspect_ratio });
  if (manifest.resolution !== fmtFromAspect.resolution) {
    warnings.push(
      `manifest: aspect_ratio=${manifest.aspect_ratio} + resolution=${manifest.resolution} 矛盾，已修复为 resolution=${fmtFromAspect.resolution}`
    );
    manifest = { ...manifest, resolution: fmtFromAspect.resolution };
    changed = true;
  }

  const repairedScenes = manifest.scenes.map((scene, idx) => {
    const sceneChanged = { changed: false };
    const s = { ...scene };

    // stable_scene_id \u7f3a\u5931
    if (!s.stable_scene_id) {
      s.stable_scene_id = `scn_${s.scene_id ?? idx + 1}`;
      warnings.push(`scene[${idx}]: stable_scene_id \u7f3a\u5931\uff0c\u5df2\u751f\u6210 ${s.stable_scene_id}`);
      sceneChanged.changed = true;
    }

    // order \u7f3a\u5931\u6216\u91cd\u590d
    if (s.order === undefined || s.order === null || !Number.isFinite(s.order)) {
      s.order = s.scene_id ?? idx + 1;
      warnings.push(`scene[${idx}]: order \u7f3a\u5931\uff0c\u5df2\u8bbe\u4e3a ${s.order}`);
      sceneChanged.changed = true;
    }

    // screen_text \u4e0d\u662f string[]
    if (!Array.isArray(s.screen_text)) {
      s.screen_text = [String(s.narration_text || "").slice(0, 32)];
      warnings.push(`scene[${idx}]: screen_text \u4e0d\u662f\u6570\u7ec4\uff0c\u5df2\u91cd\u7f6e`);
      sceneChanged.changed = true;
    } else {
      s.screen_text = s.screen_text.map(String).slice(0, 4);
    }

    // duration_estimate_sec \u975e\u6570\u5b57
    if (!Number.isFinite(s.duration_estimate_sec)) {
      s.duration_estimate_sec = clampDuration(estimateDuration(s.narration_text || ""));
      warnings.push(`scene[${idx}]: duration_estimate_sec \u975e\u6570\u5b57\uff0c\u5df2\u91cd\u7f6e\u4e3a ${s.duration_estimate_sec}`);
      sceneChanged.changed = true;
    }

    // actual_duration_sec \u975e\u6570\u5b57\u6216\u975e\u6cd5
    if (s.actual_duration_sec !== null && s.actual_duration_sec !== undefined) {
      if (!Number.isFinite(s.actual_duration_sec) || (s.actual_duration_sec as number) < 0) {
        s.actual_duration_sec = null;
        warnings.push(`scene[${idx}]: actual_duration_sec \u975e\u6cd5\uff0c\u5df2\u7f6e null`);
        sceneChanged.changed = true;
      }
    }

    // asset_versions \u4e0d\u662f\u6570\u7ec4
    if (!Array.isArray(s.asset_versions)) {
      s.asset_versions = [];
      warnings.push(`scene[${idx}]: asset_versions \u4e0d\u662f\u6570\u7ec4\uff0c\u5df2\u91cd\u7f6e`);
      sceneChanged.changed = true;
    }

    // clip_versions \u4e0d\u662f\u6570\u7ec4
    if (!Array.isArray(s.clip_versions)) {
      s.clip_versions = [];
      warnings.push(`scene[${idx}]: clip_versions \u4e0d\u662f\u6570\u7ec4\uff0c\u5df2\u91cd\u7f6e`);
      sceneChanged.changed = true;
    }

    // image_versions \u4e0d\u662f\u6570\u7ec4
    if (!Array.isArray(s.image_versions)) {
      s.image_versions = [];
      warnings.push(`scene[${idx}]: image_versions \u4e0d\u662f\u6570\u7ec4\uff0c\u5df2\u91cd\u7f6e`);
      sceneChanged.changed = true;
    }

    // active_clip_version_id \u6307\u5411\u4e0d\u5b58\u5728\u7248\u672c
    if (s.active_clip_version_id) {
      const exists = s.clip_versions.some(cv => cv.version_id === s.active_clip_version_id);
      if (!exists) {
        warnings.push(`scene[${idx}]: active_clip_version_id "${s.active_clip_version_id}" \u6307\u5411\u4e0d\u5b58\u5728\u7248\u672c\uff0c\u5df2\u7f6e null`);
        s.active_clip_version_id = null;
        sceneChanged.changed = true;
      }
    }

    // active_image_version_id \u6307\u5411\u4e0d\u5b58\u5728\u7248\u672c
    if (s.active_image_version_id) {
      const exists = s.image_versions.some(iv => iv.version_id === s.active_image_version_id);
      if (!exists) {
        warnings.push(`scene[${idx}]: active_image_version_id "${s.active_image_version_id}" \u6307\u5411\u4e0d\u5b58\u5728\u7248\u672c\uff0c\u5df2\u7f6e null`);
        s.active_image_version_id = null;
        sceneChanged.changed = true;
      }
    }

    // clip_generation_status \u975e\u6cd5
    if (s.clip_generation_status && !VALID_CLIP_GEN_STATUSES.has(s.clip_generation_status)) {
      s.clip_generation_status = "idle";
      warnings.push(`scene[${idx}]: clip_generation_status \u975e\u6cd5\uff0c\u5df2\u91cd\u7f6e\u4e3a idle`);
      sceneChanged.changed = true;
    }

    // status \u975e\u6cd5
    if (s.status && !VALID_SCENE_STATUSES.has(s.status)) {
      s.status = "draft";
      warnings.push(`scene[${idx}]: status \u975e\u6cd5\uff0c\u5df2\u91cd\u7f6e\u4e3a draft`);
      sceneChanged.changed = true;
    }

    // path \u5b89\u5168\u68c0\u67e5 \u2014 \u4fee\u590d\u5371\u9669\u8def\u5f84
    for (const pathField of ["asset_path", "audio_path", "subtitle_path"] as const) {
      const p = s[pathField];
      if (p && typeof p === "string") {
        if (p.includes("..")) {
          warnings.push(`scene[${idx}]: ${pathField} \u5305\u542b ".."\uff0c\u5df2\u7f6e null`);
          (s as any)[pathField] = null;
          sceneChanged.changed = true;
        } else if (path.isAbsolute(p)) {
          if (opts?.jobRoot) {
            try {
              const rel = path.relative(opts.jobRoot, p).replace(/\\/g, "/");
              if (!rel.startsWith("..")) {
                (s as any)[pathField] = rel;
                warnings.push(`scene[${idx}]: ${pathField} \u7edd\u5bf9\u8def\u5f84\u5df2\u8f6c\u4e3a\u76f8\u5bf9\u8def\u5f84`);
                sceneChanged.changed = true;
              } else {
                warnings.push(`scene[${idx}]: ${pathField} \u662f jobRoot \u5916\u7edd\u5bf9\u8def\u5f84\uff0c\u5df2\u7f6e null`);
                (s as any)[pathField] = null;
                sceneChanged.changed = true;
              }
            } catch {
              warnings.push(`scene[${idx}]: ${pathField} \u8def\u5f84\u8f6c\u6362\u5931\u8d25\uff0c\u5df2\u7f6e null`);
              (s as any)[pathField] = null;
              sceneChanged.changed = true;
            }
          } else {
            warnings.push(`scene[${idx}]: ${pathField} \u7edd\u5bf9\u8def\u5f84\u65e0 jobRoot \u53c2\u7167\uff0c\u5df2\u7f6e null`);
            (s as any)[pathField] = null;
            sceneChanged.changed = true;
          }
        }
      }
    }

    // \u4fee\u590d version \u6570\u7ec4\u4e2d\u7684\u5371\u9669\u8def\u5f84
    for (const versionField of ["asset_versions", "clip_versions", "image_versions"] as const) {
      const versions = s[versionField] as Array<Record<string, any>> | undefined;
      if (Array.isArray(versions)) {
        for (let vi = 0; vi < versions.length; vi++) {
          const vp = versions[vi]?.path;
          if (vp && typeof vp === "string") {
            if (vp.includes("..")) {
              warnings.push(`scene[${idx}]: ${versionField}[${vi}].path \u5305\u542b ".."\uff0c\u5df2\u7f6e null`);
              versions[vi].path = null;
              sceneChanged.changed = true;
            } else if (path.isAbsolute(vp)) {
              if (opts?.jobRoot) {
                try {
                  const rel = path.relative(opts.jobRoot, vp).replace(/\\/g, "/");
                  versions[vi].path = rel.startsWith("..") ? null : rel;
                } catch {
                  versions[vi].path = null;
                }
              } else {
                versions[vi].path = null;
              }
              warnings.push(`scene[${idx}]: ${versionField}[${vi}].path \u7edd\u5bf9\u8def\u5f84\u5df2\u5904\u7406`);
              sceneChanged.changed = true;
            }
          }
        }
      }
    }

    // \u8865\u9f50\u5176\u4ed6\u7f3a\u5931\u5b57\u6bb5
    if (s.locked === undefined || s.locked === null) { s.locked = false; sceneChanged.changed = true; }
    if (s.needs_regen === undefined || s.needs_regen === null) { s.needs_regen = false; sceneChanged.changed = true; }
    if (s.needs_audio_regen === undefined || s.needs_audio_regen === null) { s.needs_audio_regen = false; sceneChanged.changed = true; }
    if (s.version === undefined || s.version === null) { s.version = 1; sceneChanged.changed = true; }
    if ((s as any).major_version === undefined || (s as any).major_version === null) { (s as any).major_version = 1; sceneChanged.changed = true; }
    if ((s as any).minor_version === undefined || (s as any).minor_version === null) { (s as any).minor_version = 0; sceneChanged.changed = true; }
    if (!s.updated_at) { s.updated_at = now; sceneChanged.changed = true; }
    if (!s.clip_generation_status) { s.clip_generation_status = "idle"; sceneChanged.changed = true; }
    if (s.active_image_version_id === undefined) { s.active_image_version_id = null; sceneChanged.changed = true; }

    if (sceneChanged.changed) changed = true;
    return s;
  });

  // scene_id/order \u4e0e\u663e\u793a\u987a\u5e8f\u660e\u663e\u4e0d\u4e00\u81f4
  for (let i = 0; i < repairedScenes.length; i++) {
    const s = repairedScenes[i];
    if (s.scene_id !== i + 1) {
      warnings.push(`scene[${i}]: scene_id=${s.scene_id} \u4e0e\u663e\u793a\u987a\u5e8f ${i + 1} \u4e0d\u4e00\u81f4`);
    }
  }

  if (!changed && manifest.updated_at) {
    return { manifest, warnings, changed: false };
  }

  const repaired = { ...manifest, scenes: repairedScenes, updated_at: now };
  return { manifest: repaired, warnings, changed: true };
}
