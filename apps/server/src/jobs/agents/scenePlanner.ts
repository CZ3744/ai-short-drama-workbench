import type { ScriptUnderstanding, SceneManifestScene, JobRecord } from "../../../../../packages/core/src/index";
import { fallbackScenes, JobLogger } from "../../../../../packages/core/src/index";
import { loadPrompt, fillTemplate, runCompiledAgent } from "../../../../../packages/providers/src/index";
import type { OldLlmProvider } from "../../../../../packages/providers/src/index";
import { setStage, loadProjectBible, loadToolRegistry, loadProviderCapabilities, compactUnderstandingForPlanning, deriveProjectTitle } from "../runner";

export async function runScenePlanner(job: JobRecord, provider: OldLlmProvider, logger: JobLogger, script: string, understanding: ScriptUnderstanding) {
  await setStage(job, "scene_planning", 24, "Scene Planner Agent", "running");
  const prompt = await loadPrompt("scene_planner.md");
  const filled = fillTemplate(prompt, {
    UNDERSTANDING_JSON: compactUnderstandingForPlanning(understanding),
    SCRIPT: script,
    STYLE: job.style,
    VISUAL_STRATEGY: job.visual_strategy
  });

  const projectBible = await loadProjectBible(job.job_id);
  const toolRegistry = await loadToolRegistry();
  const providerCapabilities = await loadProviderCapabilities();

  const fallback = {
    project_title: deriveProjectTitle(script),
    scenes: fallbackScenes(script)
  };

  const result = await runCompiledAgent<{ project_title: string; scenes: Partial<SceneManifestScene>[] }>({
    provider,
    logger,
    agentName: "Scene Planner Agent",
    handbookName: "storyboard_director",
    promptFile: "scene_planner.md",
    projectBible,
    toolRegistry,
    providerCapabilities,
    userInstruction: filled,
    inputSummary: `${script.slice(0, 220)}...`,
    fallback
  });

  if (result.fallback_used) job.fallback_count += 1;
  if (!Array.isArray(result.data.scenes) || result.data.scenes.length === 0) {
    job.fallback_count += 1;
    await logger.line("Scene Planner returned no scenes; using local fallback scenes.");
    return fallback;
  }
  await logger.line(`[Scene Planner] parse_status=${result.parse_status}, sections=${result.included_sections.join(",")}`);
  await setStage(job, "scene_planning", 36, "Scene Planner Agent", "completed");
  return result.data;
}
