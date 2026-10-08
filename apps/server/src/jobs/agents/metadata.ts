import type { ScriptUnderstanding, SceneManifestScene, VideoMetadata, JobRecord } from "../../../../../packages/core/src/index";
import { JobLogger, writeJson, jobPath } from "../../../../../packages/core/src/index";
import { loadPrompt, fillTemplate, runCompiledAgent } from "../../../../../packages/providers/src/index";
import type { OldLlmProvider } from "../../../../../packages/providers/src/index";
import { setStage, loadProjectBible } from "../runner";

export async function runMetadataAgent(job: JobRecord, provider: OldLlmProvider, logger: JobLogger, understanding: ScriptUnderstanding, scenes: SceneManifestScene[]) {
  await setStage(job, "metadata", 56, "Metadata Agent", "running");
  const prompt = await loadPrompt("metadata_agent.md");
  const filled = fillTemplate(prompt, {
    UNDERSTANDING_JSON: understanding,
    SCENES_JSON: scenes
  });

  const projectBible = await loadProjectBible(job.job_id);

  const fallback: VideoMetadata = {
    bilibili_title: "从脚本到成片：本地 AI 视频自动生成系统",
    bilibili_description: "一个本地端到端视频自动生成原型：LLM 负责理解、分镜、视觉规划和 QA，本地工具负责素材、字幕、静音音轨与 FFmpeg 合成。",
    bilibili_tags: ["AI视频", "自动化", "LLM", "B站创作", "本地工具"],
    cover_text: "脚本进来，视频出去",
    comment_prompt: "你希望下一步先接入真实 TTS、图像模型，还是视频模型？",
    episode_suggestions: ["真实 TTS 接入", "局部重渲染", "视频 provider 替换"]
  };
  const result = await runCompiledAgent<VideoMetadata>({
    provider,
    logger,
    agentName: "Metadata Agent",
    promptFile: "metadata_agent.md",
    projectBible,
    userInstruction: filled,
    inputSummary: `metadata for ${scenes.length} scenes`,
    fallback
  });
  if (result.fallback_used) job.fallback_count += 1;
  await writeJson(jobPath(job.job_id, "manifests", "bilibili_metadata.json"), result.data);
  await logger.line(`[Metadata Agent] parse_status=${result.parse_status}, sections=${result.included_sections.join(",")}`);
  await setStage(job, "metadata", 60, "Metadata Agent", "completed");
  return result.data;
}
