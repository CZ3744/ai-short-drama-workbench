import type { SceneManifest, SceneManifestScene, JobRecord } from "../../../../../packages/core/src/index";
import { JobLogger, normalizeScene } from "../../../../../packages/core/src/index";
import { loadPrompt, fillTemplate, runCompiledAgent } from "../../../../../packages/providers/src/index";
import type { OldLlmProvider } from "../../../../../packages/providers/src/index";
import { setStage, loadProjectBible, loadToolRegistry, loadProviderCapabilities, chunkArray } from "../runner";

export async function runVisualDirector(job: JobRecord, provider: OldLlmProvider, logger: JobLogger, manifest: SceneManifest) {
  await setStage(job, "visual_direction", 42, "Visual Director Agent", "running");
  const prompt = await loadPrompt("visual_director.md");
  const projectBible = await loadProjectBible(job.job_id);
  const toolRegistry = await loadToolRegistry();
  const providerCapabilities = await loadProviderCapabilities();
  const visualUpdates: Array<Partial<SceneManifestScene> & { scene_id: number }> = [];
  for (const batch of chunkArray(manifest.scenes, 6)) {
    const batchManifest = { ...manifest, scenes: batch };
    const filled = fillTemplate(prompt, { MANIFEST_JSON: batchManifest });
    const fallback = {
      scenes: batch.map((scene) => ({
        scene_id: scene.scene_id,
        visual_type: scene.visual_type,
        visual_goal: scene.visual_goal,
        visual_prompt: `${scene.visual_prompt}。画面使用温暖浅米白背景、玻璃卡片、柔和珊瑚色与紫色强调、清晰标题和留白。`,
        local_card_prompt: `${scene.scene_title}：程序化信息卡片，标题区清晰，主体区展示 2-4 个短句，底部留出字幕安全区。`,
        future_image_prompt: `${scene.visual_prompt}，适合知识型 B 站报告解读，干净信息层级，真实可读中文排版。`,
        future_video_prompt: `${scene.scene_title} 的轻量动态镜头：卡片淡入、关键词逐条出现、镜头缓慢推近。`,
        negative_prompt: scene.negative_prompt,
        screen_text: scene.screen_text,
        keywords: scene.keywords,
        motion_suggestion: "淡入 300ms，1.02x 缓慢推近，关键词轻微上浮。",
        layout_suggestion: scene.layout_suggestion,
        visual_consistency_tags: ["warm-light", "glass-card", "bilibili-report", scene.visual_type],
        fallback_strategy: "使用程序化 SVG 信息卡片与结构图近似呈现。"
      }))
    };
    const result = await runCompiledAgent<typeof fallback>({
      provider,
      logger,
      agentName: "Visual Director Agent",
      handbookName: "visual_director",
      promptFile: "visual_director.md",
      projectBible,
      toolRegistry,
      providerCapabilities,
      userInstruction: filled,
      inputSummary: `manifest scenes=${batch[0]?.scene_id}-${batch.at(-1)?.scene_id}`,
      fallback
    });
    if (result.fallback_used) job.fallback_count += 1;
    visualUpdates.push(...result.data.scenes);
  }
  const updates = new Map(visualUpdates.map((scene) => [Number(scene.scene_id), scene]));
  manifest.scenes = manifest.scenes.map((scene) => {
    const update = updates.get(scene.scene_id);
    if (!update) return scene;
    return normalizeScene({ ...scene, ...update, notes: [scene.notes, update.fallback_strategy].filter(Boolean).join("\n") }, scene.scene_id);
  });
  manifest.updated_at = new Date().toISOString();
  await setStage(job, "visual_direction", 52, "Visual Director Agent", "completed");
  return manifest;
}
