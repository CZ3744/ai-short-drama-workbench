import fs from "node:fs/promises";
import path from "node:path";
import {
  compactSummary,
  createBaseManifest,
  estimateDuration,
  fallbackScenes,
  jobDir,
  jobPath,
  JobLogger,
  normalizeScene,
  pathExists,
  readJson,
  resolveVideoFormat,
  writeJson,
  type AudioMode,
  type CreateJobInput,
  type GenerationMode,
  type JobRecord,
  type QaReport,
  type RenderAudioSource,
  type RevisionPlan,
  type SceneManifest,
  type SceneManifestScene,
  type ScriptUnderstanding,
  type SubtitleMode,
  type VideoMetadata,
  type VideoStyle,
  type ProjectBible,
  type ProjectBrief,
  type ExpandedScript,
  type ThreeLayerQa,
  type ToolRegistryEntry,
  type ProviderCapability
} from "../../../../packages/core/src/index";
import { buildAudio, buildSubtitles, generateSceneAssets, renderFinalVideo } from "../../../../packages/render/src/index";
import { fillTemplate, loadLlmConfig, loadPrompt, MockLlmProvider, OpenAiCompatibleProvider, compilePrompt, runCompiledAgent, type OldLlmProvider } from "../../../../packages/providers/src/index";
import { ProjectBriefSchema, ScriptExpansionSchema } from "../../../../packages/core/src/schema";
import { loadModelRouterConfig, ModelRouter, type TextLlmProvider } from "../../../../packages/providers/src/mimo";
import type { LlmConfig } from "../../../../packages/providers/src/config";
import { engineeringValidation, contentValidation, publishValidation, summarizeQaStatus } from "./qa";
import { initializeJob, readJob, saveJob } from "./store";
import { getConfigValue } from "../../../../packages/core/src/localSettings";
import { runScriptUnderstanding } from "./agents/scriptUnderstanding";
import { runScenePlanner } from "./agents/scenePlanner";
import { runVisualDirector } from "./agents/visualDirector";
import { runMetadataAgent } from "./agents/metadata";

/**
 * W7 (2026-05-16) — 红线 #1:legacy job 路径(`/api/runs/*`)写 ProjectBible 时,
 * 不允许 silent fallback 到 `local_card_image` / `local_mock_video`。
 * 必须从 settings 显式读 IMAGE_PROVIDER / VIDEO_PROVIDER,空就 throw 让 job 直接失败,
 * 而不是悄悄塞 mock 数据进 manifest。
 *
 * 主流量已迁到 v2 + shot-centric,这里只是兜底兜不到也别撒谎。
 */
function resolveLegacyImageProviderOrThrow(): string {
  const id = getConfigValue("IMAGE_PROVIDER", "").trim();
  if (!id) {
    throw new Error(
      "legacy job 缺少 IMAGE_PROVIDER 配置 — 请在设置里选择图像 provider," +
      "或改走 v2 shot-centric 路径(/api/v2/shots/:sid/firstframe/generate)",
    );
  }
  return id;
}
function resolveLegacyVideoProviderOrThrow(): string {
  const id = getConfigValue("VIDEO_PROVIDER", "").trim();
  if (!id) {
    throw new Error(
      "legacy job 缺少 VIDEO_PROVIDER 配置 — 请在设置里选择视频 provider," +
      "或改走 v2 shot-centric 路径(/api/v2/shots/:sid/video/generate)",
    );
  }
  return id;
}

/** Adapter: wraps TextLlmProvider (from ModelRouter) to satisfy OldLlmProvider.callJson interface */
class TextProviderAdapter implements OldLlmProvider {
  readonly config: LlmConfig;
  private delegate: TextLlmProvider;
  private logger?: JobLogger;

  constructor(delegate: TextLlmProvider, config: LlmConfig, logger?: JobLogger) {
    this.delegate = delegate;
    this.config = config;
    this.logger = logger;
  }

  async callJson<T>(input: { agentName: string; promptFile: string; inputSummary: string; system: string; user: string }): Promise<T> {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.delegate.chatJson<T>({
          system: `${input.system}\n\nReturn only valid JSON. Do not wrap it in Markdown.`,
          user: input.user
        });
        await this.logger?.llm({
          at: new Date().toISOString(),
          agent_name: input.agentName,
          prompt_file: input.promptFile,
          input_summary: input.inputSummary,
          model: this.config.model,
          provider: this.delegate.id,
          base_url: this.config.baseUrl,
          llm_mode: "real",
          status: "parsed",
          attempt,
          output_summary: compactSummary(result)
        });
        return result;
      } catch (error) {
        await this.logger?.llm({
          at: new Date().toISOString(),
          agent_name: input.agentName,
          prompt_file: input.promptFile,
          input_summary: input.inputSummary,
          model: this.config.model,
          provider: this.delegate.id,
          base_url: this.config.baseUrl,
          llm_mode: "real",
          status: "failed",
          attempt,
          retry_delay_ms: attempt < maxAttempts ? (attempt * 1000) : 0,
          error: error instanceof Error ? error.message : String(error)
        });
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        } else {
          throw error;
        }
      }
    }
    throw new Error(`TextProviderAdapter failed after retries for ${input.agentName}`);
  }
}

function createProviderFromRouter(logger: JobLogger): { provider: OldLlmProvider; providerId: string } {
  const routerConfig = loadModelRouterConfig();
  const router = new ModelRouter(routerConfig, logger);
  const baseConfig = loadLlmConfig();

  if (routerConfig.globalProvider === "mimo_v25_pro") {
    const textProvider = router.getMimoTextProvider();
    return { provider: new TextProviderAdapter(textProvider, baseConfig, logger), providerId: "mimo" };
  }
  // auto mode and ikuncode_gpt55 both start with ikuncode
  const textProvider = router.selectTextProvider();
  return { provider: new TextProviderAdapter(textProvider, baseConfig, logger), providerId: textProvider.id };
}

const GATE_STAGES: Record<GenerationMode, string[]> = {
  auto: [],
  review: ["awaiting_storyboard_review"],
  director: ["awaiting_script_review", "awaiting_storyboard_review", "awaiting_visual_review"]
};

export async function createAndRunJob(input: CreateJobInput) {
  const { record, sourcePath } = await initializeJob(input);
  void runJob(record.job_id, sourcePath).catch(async (error) => {
    const job = await readJob(record.job_id);
    if (job) {
      job.status = "failed";
      job.stage = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      await saveJob(job);
    }
  });
  return record;
}

export async function createTopicJob(input: {
  topic: string;
  platform: string;
  style: string;
  durationTarget: number;
  audience: string;
  videoStyle?: VideoStyle;
  generationMode?: GenerationMode;
  aspectRatio?: string;
  visualStrategy?: string;
  confirmedBrief?: ProjectBrief;
}) {
  const config = loadLlmConfig();

  // Step 1: Create job FIRST so we have a real job_id for logs
  const placeholderScript = `# ${input.topic}\n\n正在生成项目简报和脚本...`;
  const { record, sourcePath } = await initializeJob({
    scriptText: placeholderScript,
    filename: `topic_${Date.now()}.md`,
    style: input.style,
    visualStrategy: input.visualStrategy || "自动",
    videoStyle: input.videoStyle || "knowledge_card",
    generationMode: input.generationMode || "auto",
    aspectRatio: input.aspectRatio || "16:9"
  });

  const logger = new JobLogger(jobPath(record.job_id, "logs"));

  const toolRegistry = await loadToolRegistry();
  const providerCapabilities = await loadProviderCapabilities();

  // Step 2: Use confirmedBrief if provided and valid, otherwise generate new brief
  let brief: ProjectBrief;
  if (input.confirmedBrief) {
    // Validate confirmedBrief against schema
    const validation = ProjectBriefSchema.safeParse(input.confirmedBrief);
    if (validation.success) {
      brief = validation.data;
      await logger.line(`[Project Brief Builder] Using confirmed brief from user (not regenerating)`);
    } else {
      await logger.line(`[Project Brief Builder] confirmedBrief failed schema validation, regenerating. Issues: ${validation.error.issues.map(i => i.message).join("; ")}`);
      brief = await generateTopicBrief(input, logger, config, toolRegistry, providerCapabilities);
    }
  } else {
    brief = await generateTopicBrief(input, logger, config, toolRegistry, providerCapabilities);
  }

  // Step 3: Expand Script
  const expandedScript = await generateTopicScript(brief, input, logger);

  // Step 4: Write real script source
  const scriptText = expandedScript.full_script || expandedScript.title;
  await fs.writeFile(sourcePath, scriptText, "utf8");

  // Step 5: Generate and save Project Bible
  const projectBible: ProjectBible = {
    job_id: record.job_id,
    topic: brief.topic || input.topic,
    source_type: "topic",
    audience: brief.audience || input.audience,
    platform: brief.platform || input.platform,
    aspect_ratio: resolveVideoFormat({ aspectRatio: input.aspectRatio }).aspectRatio,
    resolution: resolveVideoFormat({ aspectRatio: input.aspectRatio }).resolution,
    duration_target_sec: brief.duration_target_sec || input.durationTarget,
    scene_duration_range_sec: [6, 10],
    style: brief.style || input.style,
    tone: "清晰、克制、有吸引力",
    visual_rules: ["每个分镜只突出一个核心观点", "避免屏幕文字过密", "字幕安全区预留"],
    narration_rules: ["口语化但不油腻", "避免论文摘要腔", "每段旁白 6-10 秒"],
    subtitle_rules: ["短句优先", "保留关键词"],
    forbidden: ["不要虚构用户文档没有的数据", "不要夸大事实", "明确标注来源假设"],
    quality_goals: ["内容清晰", "分镜可生成", "适合目标平台"],
    provider_preferences: {
      llm: config.provider,
      tts: config.ttsProvider,
      // W7 (2026-05-16): 红线 #1 — 不允许 silent fallback,空就 throw。
      image: resolveLegacyImageProviderOrThrow(),
      video: resolveLegacyVideoProviderOrThrow()
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  await writeJson(jobPath(record.job_id, "manifests", "project_bible.json"), projectBible);
  await writeJson(jobPath(record.job_id, "manifests", "project_brief.json"), brief);
  await writeJson(jobPath(record.job_id, "manifests", "expanded_script.json"), expandedScript);

  // Step 6: Run the job
  void runJob(record.job_id, sourcePath).catch(async (error) => {
    const job = await readJob(record.job_id);
    if (job) {
      job.status = "failed";
      job.stage = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      await saveJob(job);
    }
  });

  return record;
}

async function generateTopicBrief(
  input: { topic: string; platform: string; style: string; durationTarget: number; audience: string },
  logger: JobLogger,
  config: LlmConfig,
  toolRegistry: any,
  providerCapabilities: any
): Promise<ProjectBrief> {
  const { provider } = config.mock
    ? { provider: new MockLlmProvider(config, logger) as OldLlmProvider }
    : createProviderFromRouter(logger);

  const briefPrompt = await loadPrompt("project_brief_builder.md");
  const briefFilled = fillTemplate(briefPrompt, {
    TOPIC: input.topic,
    PLATFORM: input.platform,
    STYLE: input.style,
    DURATION_TARGET: String(input.durationTarget),
    AUDIENCE: input.audience,
    VISUAL_STRATEGY: "自动",
    GENERATION_MODE: "auto",
    ASPECT_RATIO: "16:9"
  });

  const briefResult = await runCompiledAgent<ProjectBrief>({
    provider,
    logger,
    agentName: "Project Brief Builder",
    promptFile: "project_brief_builder.md",
    userInstruction: briefFilled,
    inputSummary: input.topic.slice(0, 200),
    outputSchemaName: "ProjectBrief",
    outputSchema: ProjectBriefSchema,
    toolRegistry,
    providerCapabilities,
    fallback: {
      topic: input.topic,
      audience: input.audience,
      platform: input.platform,
      style: input.style,
      duration_target_sec: input.durationTarget,
      angle: "科普讲解",
      core_message: input.topic,
      content_boundaries: [],
      risk_notes: ["未经人工审核的事实可能不准确"],
      recommended_workflow: ["topic_to_script_to_storyboard"]
    }
  });
  await logger.line(`[Project Brief Builder] parse_status=${briefResult.parse_status}, sections=${briefResult.included_sections.join(",")}`);
  return briefResult.data;
}

async function generateTopicScript(
  brief: ProjectBrief,
  input: { topic: string; durationTarget: number },
  logger: JobLogger
): Promise<ExpandedScript> {
  const config = loadLlmConfig();
  const { provider } = config.mock
    ? { provider: new MockLlmProvider(config, logger) as OldLlmProvider }
    : createProviderFromRouter(logger);

  const toolRegistry = await loadToolRegistry();
  const providerCapabilities = await loadProviderCapabilities();

  const scriptPrompt = await loadPrompt("script_expander.md");
  const scriptFilled = fillTemplate(scriptPrompt, {
    PROJECT_BRIEF_JSON: JSON.stringify(brief, null, 2),
    DURATION_TARGET: String(brief.duration_target_sec || input.durationTarget)
  });

  const scriptResult = await runCompiledAgent<ExpandedScript>({
    provider,
    logger,
    agentName: "Script Expander",
    promptFile: "script_expander.md",
    userInstruction: scriptFilled,
    inputSummary: brief.topic?.slice(0, 200) || input.topic,
    outputSchemaName: "ScriptExpansion",
    outputSchema: ScriptExpansionSchema,
    toolRegistry,
    providerCapabilities,
    fallback: {
      title: input.topic,
      hook: `你有没有想过，${input.topic}？`,
      outline: [{ section_title: "核心内容", key_points: [input.topic] }],
      full_script: input.topic,
      estimated_duration_sec: input.durationTarget,
      style_notes: [],
      source_assumptions: ["基于模型知识创作，未经人工审核"]
    }
  });
  await logger.line(`[Script Expander] parse_status=${scriptResult.parse_status}, sections=${scriptResult.included_sections.join(",")}`);
  return scriptResult.data;
}

async function safeAgentDirect<T>(provider: OldLlmProvider, logger: JobLogger, input: Parameters<OldLlmProvider["callJson"]>[0], fallback: T): Promise<T> {
  try {
    return await provider.callJson<T>(input);
  } catch (error) {
    await logger.line(`[safeAgentDirect] ${input.agentName} failed, using fallback. ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

export async function continueJobFromStage(jobId: string, stage: string) {
  const job = await requireJob(jobId);
  const source = await findSource(jobId);
  const script = await fs.readFile(source, "utf8");
  const logger = new JobLogger(jobPath(jobId, "logs"));
  const config = loadLlmConfig();
  const { provider } = config.mock
    ? { provider: new MockLlmProvider(config, logger) as OldLlmProvider }
    : createProviderFromRouter(logger);

  await logger.line(`Job resumed from stage: ${stage}`);
  job.status = "running";
  await saveJob(job);

  try {
    // Load existing manifest if available
    const manifestPath = jobPath(jobId, "manifests", "scene_manifest.json");
    let manifest: SceneManifest | null = null;
    if (await pathExists(manifestPath)) {
      manifest = await readJson<SceneManifest>(manifestPath);
    }

    // Determine what to run based on stage
    if (stage === "scene_planning" || stage === "awaiting_storyboard_review") {
      // Need to run visual_direction onwards
      if (!manifest) {
        // Re-run from scene_planning
        const understanding = await readJson<ScriptUnderstanding>(jobPath(jobId, "manifests", "script_understanding.json"));
        if (!understanding) throw new Error("script_understanding.json 损坏或为空");
        const planner = await runScenePlanner(job, provider, logger, script, understanding);
        const routerCfg = loadModelRouterConfig();
        const effProvider = routerCfg.globalProvider === "mimo_v25_pro" ? "mimo" : config.provider;
        const effModel = routerCfg.globalProvider === "mimo_v25_pro" ? (routerCfg.mimoConfig.textModel || "mimo-v2.5-pro") : config.model;
        manifest = createBaseManifest({
          jobId,
          title: planner.project_title || deriveProjectTitle(script),
          style: job.style,
          visualStrategy: job.visual_strategy,
          provider: effProvider,
          baseUrl: config.baseUrl,
          model: effModel,
          mock: config.mock,
          subtitleMode: config.subtitleMode,
          aspectRatio: job.aspect_ratio,
          understanding: understanding ?? undefined,
          scenes: planner.scenes.map((scene, index) => normalizeScene(scene, index + 1))
        });
        await saveManifest(job, manifest);
      }
      manifest = await runVisualDirector(job, provider, logger, manifest);
      manifest.metadata = await runMetadataAgent(job, provider, logger, manifest.script_understanding, manifest.scenes);
      await saveManifest(job, manifest);
      await renderPipeline(job, manifest, logger);
      await runQaAgent(job, provider, logger);
    } else if (stage === "visual_direction" || stage === "awaiting_visual_review") {
      if (!manifest) throw new Error("Manifest not found for visual_direction resume");
      manifest = await runVisualDirector(job, provider, logger, manifest);
      manifest.metadata = await runMetadataAgent(job, provider, logger, manifest.script_understanding, manifest.scenes);
      await saveManifest(job, manifest);
      await renderPipeline(job, manifest, logger);
      await runQaAgent(job, provider, logger);
    } else if (stage === "metadata") {
      if (!manifest) throw new Error("Manifest not found for metadata resume");
      manifest.metadata = await runMetadataAgent(job, provider, logger, manifest.script_understanding, manifest.scenes);
      await saveManifest(job, manifest);
      await renderPipeline(job, manifest, logger);
      await runQaAgent(job, provider, logger);
    } else if (stage === "assets" || stage === "subtitles" || stage === "audio" || stage === "render") {
      if (!manifest) throw new Error("Manifest not found for render resume");
      await renderPipeline(job, manifest, logger);
      await runQaAgent(job, provider, logger);
    } else if (stage === "qa") {
      await runQaAgent(job, provider, logger);
    }

    job.stage = "completed";
    job.status = "completed";
    job.progress = 100;
    await saveJob(job);
    await logger.line("Job completed after resume.");
    return job;
  } catch (error) {
    job.stage = "failed";
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    await saveJob(job);
    await logger.line(`Job failed after resume: ${job.error}`);
    throw error;
  }
}

export async function runJob(jobId: string, sourcePath?: string) {
  const job = await requireJob(jobId);
  const source = sourcePath ?? (await findSource(jobId));
  const script = await fs.readFile(source, "utf8");
  const logger = new JobLogger(jobPath(jobId, "logs"));
  const config = loadLlmConfig();
  const routerConfig = loadModelRouterConfig();
  const { provider, providerId } = config.mock
    ? { provider: new MockLlmProvider(config, logger) as OldLlmProvider, providerId: "mock" }
    : createProviderFromRouter(logger);

  // Update manifest fields based on provider
  const effectiveProvider = providerId === "mimo" ? "mimo" : config.provider;
  const effectiveModel = providerId === "mimo" ? (routerConfig.mimoConfig.textModel || "mimo-v2.5-pro") : config.model;

  await writeJobEnvironment(jobId, config);
  await logger.line(`Job started. provider=${effectiveProvider}, model=${effectiveModel}, mock=${config.mock}, global_model_provider=${routerConfig.globalProvider}, generation_mode=${job.generation_mode}`);
  job.status = "running";
  job.progress = 3;
  await saveJob(job);

  const gates = GATE_STAGES[job.generation_mode] ?? [];

  try {
    // Generate Project Bible if not already present (e.g., topic flow creates it earlier)
    const biblePath = jobPath(jobId, "manifests", "project_bible.json");
    if (!(await pathExists(biblePath))) {
      const projectBible: ProjectBible = {
        job_id: jobId,
        topic: deriveProjectTitle(script),
        source_type: script.length < 200 ? "topic" : "document",
        audience: "B站普通观众",
        platform: "bilibili",
        aspect_ratio: resolveVideoFormat({ resolution: job.resolution, aspectRatio: job.aspect_ratio }).aspectRatio,
        resolution: resolveVideoFormat({ resolution: job.resolution, aspectRatio: job.aspect_ratio }).resolution,
        duration_target_sec: 180,
        scene_duration_range_sec: [6, 10],
        style: job.style,
        tone: "清晰、克制、有吸引力",
        visual_rules: ["每个分镜只突出一个核心观点", "避免屏幕文字过密", "字幕安全区预留"],
        narration_rules: ["口语化但不油腻", "避免论文摘要腔", "每段旁白 6-10 秒"],
        subtitle_rules: ["短句优先", "保留关键词"],
        forbidden: ["不要虚构用户文档没有的数据", "不要夸大事实"],
        quality_goals: ["内容清晰", "分镜可生成", "适合 B 站知识视频"],
        provider_preferences: {
          llm: effectiveProvider,
          tts: config.ttsProvider,
          // W7 (2026-05-16): 红线 #1 — 不允许 silent fallback,空就 throw。
          image: resolveLegacyImageProviderOrThrow(),
          video: resolveLegacyVideoProviderOrThrow()
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      await writeJson(biblePath, projectBible);
    }

    const understanding = await runScriptUnderstanding(job, provider, logger);
    await writeJson(jobPath(jobId, "manifests", "script_understanding.json"), understanding);

    // Gate: awaiting_script_review (director mode)
    if (gates.includes("awaiting_script_review")) {
      job.stage = "awaiting_script_review";
      job.status = "awaiting_approval";
      job.progress = 20;
      await saveJob(job);
      await logger.line("Gate: awaiting_script_review — paused for review");
      return job;
    }

    const planner = await runScenePlanner(job, provider, logger, script, understanding);
    let manifest = createBaseManifest({
      jobId,
      title: planner.project_title || deriveProjectTitle(script),
      style: job.style,
      visualStrategy: job.visual_strategy,
      provider: effectiveProvider,
      baseUrl: config.baseUrl,
      model: effectiveModel,
      mock: config.mock,
      subtitleMode: config.subtitleMode,
      aspectRatio: job.aspect_ratio,
      understanding,
      scenes: planner.scenes.map((scene, index) => normalizeScene(scene, index + 1))
    });
    await saveManifest(job, manifest);

    // Gate: awaiting_storyboard_review (review & director modes)
    if (gates.includes("awaiting_storyboard_review")) {
      job.stage = "awaiting_storyboard_review";
      job.status = "awaiting_approval";
      job.progress = 38;
      await saveJob(job);
      await logger.line("Gate: awaiting_storyboard_review — paused for review");
      return job;
    }

    manifest = await runVisualDirector(job, provider, logger, manifest);

    // Gate: awaiting_visual_review (director mode)
    if (gates.includes("awaiting_visual_review")) {
      job.stage = "awaiting_visual_review";
      job.status = "awaiting_approval";
      job.progress = 54;
      await saveJob(job);
      await logger.line("Gate: awaiting_visual_review — paused for review");
      return job;
    }

    manifest.metadata = await runMetadataAgent(job, provider, logger, understanding, manifest.scenes);
    await saveManifest(job, manifest);

    await renderPipeline(job, manifest, logger);
    await runQaAgent(job, provider, logger);

    job.stage = "completed";
    job.status = "completed";
    job.progress = 100;
    await saveJob(job);
    await logger.line("Job completed.");
    return job;
  } catch (error) {
    job.stage = "failed";
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    await saveJob(job);
    await logger.line(`Job failed: ${job.error}`);
    throw error;
  }
}

export async function rerenderJob(jobId: string) {
  const job = await requireJob(jobId);
  const logger = new JobLogger(jobPath(jobId, "logs"));
  const manifest = await readJson<SceneManifest>(jobPath(jobId, "manifests", "scene_manifest.json"));
  if (!manifest) throw new Error("scene_manifest.json 损坏或为空");
  job.status = "running";
  job.stage = "render";
  job.progress = 72;
  await saveJob(job);
  await renderPipeline(job, manifest, logger);
  await runQaAgent(job, createProvider(logger), logger);
  job.status = "completed";
  job.stage = "completed";
  job.progress = 100;
  await saveJob(job);
  return job;
}

export async function reviseJob(jobId: string, revisionText: string) {
  const job = await requireJob(jobId);
  const logger = new JobLogger(jobPath(jobId, "logs"));
  const provider = createProvider(logger);
  const manifest = await readJson<SceneManifest>(jobPath(jobId, "manifests", "scene_manifest.json"));
  if (!manifest) throw new Error("scene_manifest.json 损坏或为空");
  job.status = "running";
  job.stage = "revision";
  job.progress = 45;
  job.agents["Revision Agent"] = "running";
  await saveJob(job);
  await logger.line(`Revision requested: ${revisionText.slice(0, 240)}`);

  const prompt = await loadPrompt("revision_agent.md");
  const filled = fillTemplate(prompt, {
    REVISION_TEXT: revisionText,
    MANIFEST_JSON: manifest
  });
  const fallback = new MockLlmProvider(loadLlmConfig(), logger);
  let plan: RevisionPlan;
  try {
    plan = await provider.callJson<RevisionPlan>({
      agentName: "Revision Agent",
      promptFile: "revision_agent.md",
      inputSummary: revisionText.slice(0, 300),
      system: "You analyze revision instructions for a video generation manifest.",
      user: filled
    });
  } catch (error) {
    job.fallback_count += 1;
    job.agents["Revision Agent"] = "fallback";
    await logger.line(`Revision Agent fallback: ${error instanceof Error ? error.message : String(error)}`);
    plan = await fallback.callJson<RevisionPlan>({
      agentName: "Revision Agent",
      promptFile: "revision_agent.md",
      inputSummary: revisionText.slice(0, 300),
      system: "",
      user: revisionText
    });
  }

  plan.revision_id ||= `rev_${Date.now()}`;
  plan.created_at ||= new Date().toISOString();
  plan.user_instruction = revisionText;
  await writeJson(jobPath(jobId, "manifests", "revision_plan.json"), plan);
  await fs.mkdir(jobPath(jobId, "manifests", "revisions"), { recursive: true });
  await writeJson(jobPath(jobId, "manifests", "revisions", `${plan.revision_id}.json`), plan);

  const updated = await applyRevision(job, manifest, plan, revisionText);
  updated.revision_history = [...(updated.revision_history ?? []), plan];
  await saveManifest(job, updated);
  job.agents["Revision Agent"] = "completed";
  await saveJob(job);

    const partialAssetScenes =
      plan.modification_type === "visual_only" && plan.affected_scenes.length > 0 && !plan.full_replan_required ? plan.affected_scenes : undefined;
    await renderPipeline(job, updated, logger, { assetSceneIds: partialAssetScenes });
  await runQaAgent(job, provider, logger);
  job.status = "completed";
  job.stage = "completed";
  job.progress = 100;
  await saveJob(job);
  await logger.line(`Revision completed: ${plan.revision_id}`);
  return plan;
}


async function renderPipeline(job: JobRecord, manifest: SceneManifest, logger: JobLogger, options?: { assetSceneIds?: number[] }) {
  const fullConfig = loadLlmConfig();
  manifest.subtitle_mode = fullConfig.subtitleMode;
  await setStage(job, "assets", 66);
  if (options?.assetSceneIds?.length) {
    await logger.line(`局部重建素材 scenes: ${options.assetSceneIds.join(", ")}`);
  }
  await generateSceneAssets(manifest, jobDir(job.job_id), logger, options?.assetSceneIds);
  await saveManifest(job, manifest);
  await setStage(job, "audio", 73);
  try {
    await buildAudio(manifest, jobDir(job.job_id), logger, {
      provider: fullConfig.ttsProvider,
      voice: fullConfig.ttsVoice,
      rate: fullConfig.ttsRate,
      enabled: fullConfig.ttsEnabled
    }, {
      provider: fullConfig.ttsFallbackProvider,
      voice: "zh-CN-YunxiNeural",
      rate: "+0%",
      enabled: fullConfig.ttsEnabled && fullConfig.ttsFallbackProvider !== "silence"
    });
  } catch (error) {
    job.fallback_count += 1;
    await logger.line(`Audio builder failed; renderer will use direct anullsrc fallback. ${error instanceof Error ? error.message : String(error)}`);
  }
  await saveManifest(job, manifest);
  // Audio stage has now set actual_duration_sec — build subtitles after audio to use real durations
  await setStage(job, "subtitles", 78);
  await logger.line(`audio_subtitle_sync_policy = audio_first_subtitles_second`);
  const subtitles = await buildSubtitles(manifest, jobDir(job.job_id), logger);
  await saveManifest(job, manifest);
  await setStage(job, "render", 88);
  const renderResult = await renderFinalVideo(manifest, jobDir(job.job_id), logger, manifest.subtitle_mode);
  // Store clip stats in manifest for QA (SceneManifest 已声明这三个可选字段, 2026-05-28 audit P1)
  manifest.clip_scene_count = renderResult.clipSceneCount;
  manifest.card_fallback_scene_count = renderResult.cardFallbackSceneCount;
  manifest.video_provider_used = renderResult.clipSceneCount > 0 ? "local_mock_video" : undefined;
  await saveManifest(job, manifest);
}

async function runQaAgent(job: JobRecord, provider: OldLlmProvider, logger: JobLogger) {
  await setStage(job, "qa", 94, "QA Agent", "running");
  const validation = await engineeringValidation(job.job_id);
  const checks = validation.checks;
  const manifest = validation.manifest;
  const prompt = await loadPrompt("qa_agent.md");
  const filled = fillTemplate(prompt, {
    MANIFEST_JSON: manifest ?? {},
    ENGINEERING_CHECKS_JSON: checks
  });
  const fallback = {
    status: summarizeQaStatus(checks),
    strengths: ["工程输出目录完整", "manifest 可追踪", "素材、字幕、视频闭环已生成"],
    issues: checks.filter((check) => check.status !== "pass").map((check) => `${check.name}: ${check.detail}`),
    recommendations: ["接入真实 TTS provider", "继续提升视觉模板和局部重渲染效率"]
  };
  const llmReview = await safeAgent<typeof fallback>(job, provider, logger, {
    agentName: "QA Agent",
    promptFile: "qa_agent.md",
    inputSummary: `engineering checks=${checks.length}`,
    system: "You review video generation manifests and engineering validation output.",
    user: filled
  }, fallback);
  const status = worstStatus(summarizeQaStatus(checks), llmReview.status);

  // Determine output_ready_level
  // Rules:
  //  - publish_candidate: audio_mode=real_tts AND burned_subtitles=true
  //    AND engineering checks no fail/warning AND llm_review.status not warning/fail
  //  - narrated_draft: audio_mode=real_tts AND burned_subtitles=true
  //    BUT llm_review.status=warning OR engineering has warning
  //  - partial_narrated_draft: audio_mode=partial_tts
  //  - silent_draft: audio_mode=silence/fallback
  //  - mixed_video_draft: clip + card mixed, with real audio
  //  - card_video_draft: all card, with real audio
  let outputReadyLevel = "script_only";
  const hasNoFailure = !checks.some((c) => c.status === "fail");
  const hasNoWarning = !checks.some((c) => c.status === "warning");
  const llmReviewOk = llmReview.status !== "warning" && llmReview.status !== "fail";
  const audioMode = validation.audioMode;
  const burnedSubtitles = validation.burnedSubtitles;
  const realSceneCount = validation.realAudioSceneCount ?? 0;
  const fallbackSceneCount = validation.fallbackAudioSceneCount ?? 0;
  const clipSceneCount = manifest?.clip_scene_count ?? 0;
  const cardSceneCount = manifest?.card_fallback_scene_count ?? manifest?.scenes?.length ?? 0;
  const hasClipCardMix = clipSceneCount > 0 && cardSceneCount > 0;
  const allCard = clipSceneCount === 0 && cardSceneCount > 0;

  if (audioMode === "real_tts") {
    if (burnedSubtitles) {
      if (hasNoFailure && hasNoWarning && llmReviewOk) {
        outputReadyLevel = "publish_candidate";
      } else {
        outputReadyLevel = hasClipCardMix ? "mixed_video_draft" : allCard ? "card_video_draft" : "narrated_draft";
      }
    } else {
      outputReadyLevel = hasClipCardMix ? "mixed_video_draft" : allCard ? "card_video_draft" : "narrated_draft";
    }
  } else if (audioMode === "partial_tts") {
    outputReadyLevel = "partial_narrated_draft";
  } else if (audioMode === "silence" || audioMode === "fallback" || audioMode === "anullsrc_fallback") {
    outputReadyLevel = "silent_draft";
  } else {
    outputReadyLevel = "silent_draft";
  }

  // Override: if real_scene_count is 0 and fallback_scene_count > 0, must be silent_draft
  if (realSceneCount === 0 && fallbackSceneCount > 0) {
    outputReadyLevel = "silent_draft";
  }

  // Override: if video provider is local_mock_video, never call it publish_candidate
  // local_mock_video + card output → local_video_draft (technical draft, not real AI video)
  if (outputReadyLevel === "publish_candidate") {
    outputReadyLevel = hasClipCardMix ? "mixed_video_draft" : allCard ? "card_video_draft" : "narrated_draft";
  }
  // When video provider is mock or all-card, use local_video_draft to clearly indicate
  // this is a technical draft, not real AI video
  if (outputReadyLevel === "narrated_draft" || outputReadyLevel === "mixed_video_draft" || outputReadyLevel === "card_video_draft") {
    // 保守降级: manifest 没记录 video_provider 时(老 job)按未知处理 → local_video_draft,
    // 避免把 mock / 未知输出误标成发布候选。不是 provider 兜底,只影响 outputReadyLevel 评级。
    const videoProviderFromManifest = (manifest as unknown as Record<string, unknown>)?.video_provider as string | undefined;
    if (!videoProviderFromManifest || videoProviderFromManifest === "local_mock_video" || cardSceneCount > 0) {
      outputReadyLevel = "local_video_draft";
    }
  }

  const routerConfig = loadModelRouterConfig();

  const report: QaReport = {
    job_id: job.job_id,
    created_at: new Date().toISOString(),
    status,
    summary: status === "pass" ? "Output passed automated validation." : "Output completed with warnings or failures. See checks.",
    checks,
    ffprobe: validation.ffprobe,
    llm_mode: validation.llmMode,
    subtitle_mode: validation.subtitleMode,
    audio_mode: audioMode,
    render_audio_source: validation.renderAudioSource,
    burned_subtitles: burnedSubtitles,
    global_model_provider: routerConfig.globalProvider,
    text_llm_provider: routerConfig.globalProvider === "mimo_v25_pro" ? "mimo" : "ikuncode",
    multimodal_provider: routerConfig.globalProvider === "ikuncode_gpt55" ? "none" : "mimo_multimodal",
    tts_provider: validation.ttsProviderFromManifest,
    tts_fallback_provider: validation.ttsFallbackProviderFromManifest ?? undefined,
    tts_fallback_used: validation.ttsFallbackUsed,
    real_audio_scene_count: realSceneCount,
    fallback_audio_scene_count: fallbackSceneCount,
    audio_silence_suspected: validation.audioSilenceSuspected,
    audio_health_warning: validation.audioHealthWarning || undefined,
    audio_duration_sec: Number(validation.audioDurationSec.toFixed(3)),
    final_audio_size_bytes: validation.finalAudioSizeBytes,
    subtitle_duration_sec: 0,
    audio_subtitle_delta_sec: 0,
    output_ready_level: outputReadyLevel,
    clip_scene_count: manifest?.clip_scene_count ?? 0,
    card_fallback_scene_count: manifest?.card_fallback_scene_count ?? (manifest?.scenes?.length ?? 0),
    video_provider_used: manifest?.video_provider_used,
    llm_review: llmReview
  };

  // Read subtitle duration from SRT
  const srtPath = jobPath(job.job_id, "subtitles", "final.srt");
  if (await pathExists(srtPath)) {
    try {
      const srtContent = await fs.readFile(srtPath, "utf8");
      const timeMatches = srtContent.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/g);
      if (timeMatches && timeMatches.length > 0) {
        const lastMatch = timeMatches[timeMatches.length - 1];
        const endMatch = lastMatch.match(/-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
        if (endMatch) {
          report.subtitle_duration_sec = Number(endMatch[1]) * 3600 + Number(endMatch[2]) * 60 + Number(endMatch[3]) + Number(endMatch[4]) / 1000;
          report.audio_subtitle_delta_sec = Number(Math.abs((report.audio_duration_sec ?? 0) - report.subtitle_duration_sec).toFixed(3));
        }
      }
    } catch { /* ignore */ }
  }

  // Three-layer QA: Content QA
  let contentQa: ThreeLayerQa["content_qa"] = { status: "pass", issues: [], recommendations: [] };
  try {
    contentQa = await contentValidation(job.job_id, provider, logger);
  } catch {
    contentQa = { status: "warning", issues: ["Content QA 未完成"], recommendations: ["建议人工审核内容质量"] };
  }

  // Three-layer QA: Publish QA
  let publishQa: ThreeLayerQa["publish_qa"] = { status: "warning", platform: "bilibili", title_quality: "未评估", cover_quality: "未评估", publish_notes: ["发布 QA 未完成"] };
  try {
    publishQa = await publishValidation(job.job_id, provider, logger);
  } catch {
    publishQa = { status: "warning", platform: "bilibili", title_quality: "未评估", cover_quality: "未评估", publish_notes: ["发布 QA 未完成，建议人工复核"] };
  }

  // Embed three-layer QA into report
  const threeLayerQa: ThreeLayerQa = {
    engineering_qa: { status: report.status, checks: report.checks },
    content_qa: contentQa,
    publish_qa: publishQa
  };
  report.three_layer_qa = threeLayerQa;
  report.engineering_qa = threeLayerQa.engineering_qa;
  report.publish_qa = publishQa;
  report.content_qa = contentQa;

  await writeJson(jobPath(job.job_id, "qa", "qa_report.json"), report);
  await setStage(job, "qa", 98, "QA Agent", "completed");
  return report;
}

async function safeAgent<T>(job: JobRecord, provider: OldLlmProvider, logger: JobLogger, input: Parameters<OldLlmProvider["callJson"]>[0], fallback: T): Promise<T> {
  try {
    return await provider.callJson<T>(input);
  } catch (error) {
    job.fallback_count += 1;
    job.agents[input.agentName] = "fallback";
    await saveJob(job);
    await logger.line(`${input.agentName} failed; fallback used. ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

async function applyRevision(job: JobRecord, manifest: SceneManifest, plan: RevisionPlan, revisionText: string) {
  const source = await fs.readFile(await findSource(job.job_id), "utf8");
  if (plan.full_replan_required || plan.modification_type === "full_replan") {
    const provider = createProvider(new JobLogger(jobPath(job.job_id, "logs")));
    const understanding = {
      ...manifest.script_understanding,
      tone: plan.global_updates?.tone ?? manifest.script_understanding.tone,
      recommended_style: plan.global_updates?.style ?? manifest.script_understanding.recommended_style
    };
    const planner = await runScenePlanner(job, provider, new JobLogger(jobPath(job.job_id, "logs")), source, understanding);
    manifest.scenes = planner.scenes.map((scene, index) => normalizeScene(scene, index + 1));
    manifest.project_title = planner.project_title || manifest.project_title;
  } else {
    const affected = new Set(plan.affected_scenes);
    manifest.scenes = manifest.scenes.map((scene) => {
      if (!affected.has(scene.scene_id)) return scene;
      const update = plan.scene_updates.find((item) => item.scene_id === scene.scene_id);
      const replacement = update?.replacement ?? {};
      const patch: Partial<SceneManifestScene> = {
        ...replacement,
        notes: [scene.notes, `Revision: ${update?.instructions ?? revisionText}`].filter(Boolean).join("\n"),
        status: "planned",
        asset_path: null
      };
      if (!replacement.visual_prompt && /架构图|流程图|结构图/.test(revisionText)) {
        patch.visual_type = "diagram";
        patch.visual_prompt = `${scene.visual_prompt} 改为系统架构图风格，展示节点、数据流、agent 分工和本地工具执行链路。`;
        patch.layout_suggestion = "中心架构图，左侧 LLM agents，右侧本地渲染工具，底部输出目录。";
      }
      if (!replacement.screen_text && /字幕.*拆|拆短/.test(revisionText)) {
        patch.screen_text = scene.screen_text.flatMap((text) => text.split(/[，。；、]/)).filter(Boolean).slice(0, 4);
      }
      return normalizeScene({ ...scene, ...patch }, scene.scene_id);
    });
  }
  if (plan.global_updates?.style) manifest.style = plan.global_updates.style;
  if (plan.global_updates?.visual_strategy) manifest.visual_strategy = plan.global_updates.visual_strategy;
  manifest.updated_at = new Date().toISOString();
  return manifest;
}

export async function setStage(job: JobRecord, stage: JobRecord["stage"], progress: number, agentName?: string, agentStatus?: JobRecord["agents"][string]) {
  job.stage = stage;
  job.progress = Math.max(job.progress, progress);
  if (agentName && agentStatus) job.agents[agentName] = agentStatus;
  await saveJob(job);
}

async function saveManifest(job: JobRecord, manifest: SceneManifest) {
  manifest.updated_at = new Date().toISOString();
  await writeJson(jobPath(job.job_id, "manifests", "scene_manifest.json"), manifest);
}

function createProvider(logger: JobLogger): OldLlmProvider {
  const config = loadLlmConfig();
  if (config.mock) return new MockLlmProvider(config, logger);
  const { provider } = createProviderFromRouter(logger);
  return provider;
}

async function requireJob(jobId: string) {
  const job = await readJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return job;
}

export async function findSource(jobId: string) {
  const md = jobPath(jobId, "input", "source.md");
  if (await pathExists(md)) return md;
  const txt = jobPath(jobId, "input", "source.txt");
  if (await pathExists(txt)) return txt;
  throw new Error(`Source script not found for ${jobId}`);
}

async function writeJobEnvironment(jobId: string, config: ReturnType<typeof loadLlmConfig>) {
  const content = `# Job Environment

- Job: ${jobId}
- Created at: ${new Date().toISOString()}
- Workspace output: ${jobDir(jobId)}
- LLM provider: ${config.provider}
- LLM base URL: ${config.baseUrl}
- LLM model: ${config.model}
- LLM mock fallback: ${config.mock}
- API key present: ${config.apiKey ? "true" : "false"}
- Subtitle mode: ${config.subtitleMode}
- TTS provider: ${config.ttsProvider}
- TTS fallback provider: ${config.ttsFallbackProvider}
- TTS voice: ${config.ttsVoice}
- TTS rate: ${config.ttsRate}
- TTS enabled: ${config.ttsEnabled}

API keys are never written to logs.
`;
  await fs.writeFile(jobPath(jobId, "logs", "environment.md"), content, "utf8");
}

export function deriveProjectTitle(script: string) {
  const first = script.replace(/[#>*`\-\[\]]/g, "").split(/\n|。|！|\?/).find((item) => item.trim().length > 4)?.trim();
  return first?.slice(0, 28) || "脚本驱动的 AI 视频自动生成系统";
}

/** Load Project Bible from job manifests, or null */
export async function loadProjectBible(jobId: string): Promise<ProjectBible | null> {
  const biblePath = jobPath(jobId, "manifests", "project_bible.json");
  if (await pathExists(biblePath)) {
    try {
      return await readJson<ProjectBible>(biblePath);
    } catch { return null; }
  }
  return null;
}

/** Load Tool Registry from config, or empty */
export async function loadToolRegistry(): Promise<Record<string, ToolRegistryEntry>> {
  const registryPath = path.join(process.cwd(), "config", "tool_registry.json");
  if (await pathExists(registryPath)) {
    try {
      return await readJson<Record<string, ToolRegistryEntry>>(registryPath) ?? {};
    } catch { return {}; }
  }
  return {};
}

/** Load Provider Capabilities from config, or empty */
export async function loadProviderCapabilities(): Promise<ProviderCapability[]> {
  const capPath = path.join(process.cwd(), "config", "provider_capabilities.json");
  if (await pathExists(capPath)) {
    try {
      return await readJson<ProviderCapability[]>(capPath) ?? [];
    } catch { return []; }
  }
  return [];
}

export function compactUnderstandingForPlanning(understanding: ScriptUnderstanding): ScriptUnderstanding {
  return {
    ...understanding,
    summary: understanding.summary.slice(0, 900),
    audience: understanding.audience.slice(0, 280),
    tone: understanding.tone.slice(0, 240),
    content_type: understanding.content_type?.slice(0, 180),
    recommended_style: understanding.recommended_style?.slice(0, 260),
    structure: understanding.structure.slice(0, 10).map((section) => ({
      title: section.title.slice(0, 120),
      purpose: section.purpose.slice(0, 240),
      key_points: section.key_points.slice(0, 7).map((point) => point.slice(0, 180))
    })),
    visual_direction: understanding.visual_direction.slice(0, 700),
    potential_difficulties: understanding.potential_difficulties?.slice(0, 8).map((item) => item.slice(0, 180))
  };
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function worstStatus(a: QaReport["status"], b: QaReport["status"]): QaReport["status"] {
  if (a === "fail" || b === "fail") return "fail";
  if (a === "warning" || b === "warning") return "warning";
  return "pass";
}
