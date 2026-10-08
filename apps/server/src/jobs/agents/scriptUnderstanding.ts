import fs from "node:fs/promises";
import type { ScriptUnderstanding, JobRecord } from "../../../../../packages/core/src/index";
import { JobLogger } from "../../../../../packages/core/src/index";
import { loadPrompt, fillTemplate, runCompiledAgent } from "../../../../../packages/providers/src/index";
import type { OldLlmProvider } from "../../../../../packages/providers/src/index";
import { setStage, findSource, loadProjectBible, loadToolRegistry, loadProviderCapabilities } from "../runner";

export async function runScriptUnderstanding(job: JobRecord, provider: OldLlmProvider, logger: JobLogger) {
  await setStage(job, "script_understanding", 8, "Script Understanding Agent", "running");
  const script = await fs.readFile(await findSource(job.job_id), "utf8");
  const prompt = await loadPrompt("script_understanding.md");
  const filled = fillTemplate(prompt, {
    SCRIPT: script,
    STYLE: job.style,
    VISUAL_STRATEGY: job.visual_strategy
  });

  const projectBible = await loadProjectBible(job.job_id);
  const toolRegistry = await loadToolRegistry();
  const providerCapabilities = await loadProviderCapabilities();

  const result = await runCompiledAgent<ScriptUnderstanding>({
    provider,
    logger,
    agentName: "Script Understanding Agent",
    handbookName: "content_planner",
    promptFile: "script_understanding.md",
    projectBible,
    toolRegistry,
    providerCapabilities,
    userInstruction: filled,
    inputSummary: `${script.slice(0, 220)}...`,
    fallback: {
      summary: "脚本围绕本地 AI 视频自动生产系统展开，强调可追踪、可复现、可替换 provider 的工程闭环。",
      audience: "内容创作者、开发者、知识型团队",
      tone: "清晰、克制、面向 B 站知识讲解",
      content_type: "技术方案解读",
      recommended_style: job.style,
      structure: [
        { title: "系统目标", purpose: "解释为什么需要脚本驱动闭环", key_points: ["脚本理解", "分镜规划", "本地合成"] },
        { title: "工程执行", purpose: "说明本地工具如何保障输出", key_points: ["素材 fallback", "字幕", "FFmpeg"] }
      ],
      visual_direction: "浅色信息卡片、关键词页和结构图结合。",
      potential_difficulties: ["真实 TTS/视频 provider 未接入"]
    }
  });

  if (result.fallback_used) job.fallback_count += 1;
  await logger.line(`[Script Understanding] parse_status=${result.parse_status}, sections=${result.included_sections.join(",")}`);
  await setStage(job, "script_understanding", 18, "Script Understanding Agent", "completed");
  return result.data;
}
