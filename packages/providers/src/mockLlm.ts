import {
  createBaseManifest,
  emptyUnderstanding,
  fallbackScenes,
  type JobLogger,
  type QaReport,
  type RevisionPlan,
  type SceneManifest,
  type ScriptUnderstanding,
  type VideoMetadata
} from "../../core/src/index";
import type { LlmConfig } from "./config";
import type { JsonCallInput, LlmProvider } from "./llm";

export class MockLlmProvider implements LlmProvider {
  readonly config: LlmConfig;

  constructor(config: LlmConfig, private readonly logger?: JobLogger) {
    this.config = { ...config, mock: true };
  }

  async callJson<T>(input: JsonCallInput): Promise<T> {
    const topic = extractTopicSummary(input.user);
    await this.logger?.llm({
      at: new Date().toISOString(),
      agent_name: input.agentName,
      prompt_file: input.promptFile,
      input_summary: input.inputSummary,
      status: "mock_fallback",
      llm_mode: "mock",
      provider: this.config.provider,
      base_url: this.config.baseUrl,
      model: this.config.model,
      output_summary: "No .env API key found or MOCK_LLM=true; mock output varies by input topic.",
      mock_generated: true,
      warning: "mock output, not real LLM reasoning"
    });

    const script = input.user;
    if (input.agentName === "Script Understanding Agent") {
      return mockUnderstanding(script, topic) as T;
    }
    if (input.agentName === "Scene Planner Agent") {
      return { scenes: fallbackScenes(extractSection(script, "SOURCE_SCRIPT:", "\n\nSTYLE:") ?? extractScript(script)) } as T;
    }
    if (input.agentName === "Visual Director Agent") {
      const manifest = extractManifest(script);
      return {
        scenes:
          manifest?.scenes?.map((scene: any) =>
            enrichScene({
              ...scene,
              scene_id: Number(scene.scene_id),
              visual_type: scene.visual_type ?? "keyword_card",
              visual_goal: scene.visual_goal ?? "把本段核心观点转化为清晰画面。",
              screen_text: Array.isArray(scene.screen_text) ? scene.screen_text : [],
              keywords: Array.isArray(scene.keywords) ? scene.keywords : [],
              layout_suggestion: scene.layout_suggestion ?? "信息卡片布局。"
            }, topic)
          ) ?? []
      } as T;
    }
    if (input.agentName === "Metadata Agent") {
      return mockMetadata(topic) as T;
    }
    if (input.agentName === "Revision Agent") {
      return mockRevision(extractSection(input.user, "USER_REVISION:", "\n\nCURRENT_MANIFEST:") ?? input.user) as T;
    }
    if (input.agentName === "QA Agent") {
      return mockQa(input.user) as T;
    }
    if (input.agentName === "LLM Check Agent") {
      return { ok: true, message: "ready" } as T;
    }
    if (input.agentName === "Project Brief Builder") {
      return mockProjectBrief(topic, input.user) as T;
    }
    if (input.agentName === "Script Expander") {
      return mockScriptExpansion(topic, input.user) as T;
    }
    return mockEmptyWithWarning() as T;
  }
}

export function createMockManifest(jobId: string, script: string, style: string, visualStrategy: string, config: LlmConfig): SceneManifest {
  const topic = extractTopicSummary(script);
  const scenes = fallbackScenes(script).map((s) => enrichScene(s, topic));
  return createBaseManifest({
    jobId,
    title: topic ? `「${topic}」— 脚本驱动的 AI 视频` : "脚本驱动的 AI 视频自动生产系统",
    style,
    visualStrategy,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    mock: config.mock,
    subtitleMode: config.subtitleMode,
    understanding: mockUnderstanding(script, topic),
    scenes,
    metadata: mockMetadata(topic)
  });
}

function extractTopicSummary(text: string): string {
  // Extract meaningful topic keywords from structured prompts before falling
  // back to a generic source-script prefix.
  const topicMatch =
    matchPromptParam(text, "TOPIC", "主题") ??
    text.match(/"topic"\s*:\s*"([^"]+)"/i)?.[1] ??
    text.match(/SOURCE_SCRIPT:\s*(.+?)(?:\n|$)/)?.[1];
  const candidate = (topicMatch ?? text).slice(0, 200).replace(/\s+/g, " ").trim();
  // Grab up to ~20 meaningful chars from the start
  const short = candidate.slice(0, 40).replace(/[,，。！？!?\n]/g, " ").trim();
  return short || "";
}

function mockUnderstanding(script: string, topic?: string): ScriptUnderstanding {
  const t = topic || "脚本驱动 AI 视频";
  return {
    ...emptyUnderstanding,
    summary: `这是一篇关于「${t}」的内容，核心是把文本理解、分镜规划、本地素材生成、字幕、渲染和修改闭环连接成可追踪工作流。`,
    audience: "想用 AI 提升内容生产效率的创作者、开发者和知识型团队",
    tone: "清晰、可信、面向 B 站知识讲解，避免夸张营销",
    content_type: "技术方案解读 / 产品原型说明",
    recommended_style: "Claude/iOS 质感卡片风",
    structure: [
      {
        title: `「${t}」的核心挑战`,
        purpose: "建立痛点：视频生产链路长，手工衔接成本高。",
        key_points: ["脚本是生产源头", "分镜和素材需要结构化", "输出必须可追踪"]
      },
      {
        title: "系统如何协作",
        purpose: "说明 LLM agent 与本地工具的边界。",
        key_points: ["LLM 负责规划判断", "工程负责状态和渲染", "provider 可替换"]
      },
      {
        title: "当前 MVP 能力",
        purpose: "给出今晚可运行闭环和后续扩展路径。",
        key_points: ["本地卡片素材", "SRT 字幕", "FFmpeg 合成", "revision flow"]
      }
    ],
    visual_direction: "使用浅色玻璃卡片、章节标题页、关键词卡片和流程图式布局；避免信息拥挤，保留字幕安全区。",
    potential_difficulties: ["真实 TTS 和视频模型未接入", "长文节奏需要自动拆分", "LLM JSON 输出需要修复和 fallback"]
  };
}

function mockMetadata(topic?: string): VideoMetadata {
  const t = topic || "AI视频自动生成";
  return {
    bilibili_title: `从脚本到成片：「${t}」全流程解析`,
    bilibili_description:
      `本视频围绕「${t}」展开：LLM 负责理解、切片、分镜和质检，本地工具负责素材、字幕、音频 fallback 与 FFmpeg 合成。当前版本使用程序化卡片替代真实生图/生视频，重点打通可追踪的端到端闭环。`,
    bilibili_tags: ["AI视频", "自动化工作流", "本地工具", "LLM应用", "B站创作"],
    cover_text: t.length > 15 ? t.slice(0, 14) + "…" : t,
    comment_prompt: "你更想先接入真实 TTS、图像模型，还是视频模型？",
    episode_suggestions: ["系统架构篇", "Provider 接入篇", "局部重渲染篇"]
  };
}

function mockRevision(user: string): RevisionPlan {
  const instruction = user.trim().slice(0, 500);
  const full = /全片|整体|重新切片|前半部分|节奏/.test(instruction);
  const visual = /画面|风格|卡片|架构图|流程图|普通/.test(user);
  const subtitle = /字幕|文案|拆短/.test(user);
  const match = instruction.match(/第\s*(\d+)\s*[段幕场]?/);
  const affected = match ? [Number(match[1])] : full ? [] : [1];
  return {
    revision_id: `rev_${Date.now()}`,
    created_at: new Date().toISOString(),
    user_instruction: instruction,
    summary: full ? "修改意见影响全片节奏或风格，建议全片重规划。" : "修改意见可局部应用到相关 scene。",
    affected_scenes: affected,
    modification_type: full ? "full_replan" : visual ? "visual_only" : subtitle ? "subtitle_only" : "rerender_required",
    rerender_required: true,
    full_replan_required: full,
    scene_updates: affected.map((scene_id) => ({
      scene_id,
      fields_to_update: visual ? ["visual_type", "visual_prompt", "layout_suggestion"] : subtitle ? ["narration_text", "screen_text"] : ["visual_prompt"],
      instructions: instruction,
      replacement: visual
        ? {
            visual_type: /架构图|流程图|结构图/.test(instruction) ? "diagram" : undefined,
            visual_prompt: `${instruction} 使用清晰的信息架构、节点关系、柔和 Claude/iOS 卡片排版。`,
            layout_suggestion: /架构图|流程图|结构图/.test(instruction)
              ? "中心系统架构图，左右分区展示 LLM agents、本地工具、输出文件。"
              : undefined
          }
        : undefined
    })),
    global_updates: full ? { tone: "更像 B 站科普，节奏更紧凑", notes: instruction } : { notes: instruction },
    risks: ["mock revision 只能做启发式判断；填入真实 LLM_API_KEY 后会使用 gpt-5.5 解析。"]
  };
}

function mockQa(user: string): QaReport["llm_review"] {
  return {
    status: user.includes("failed") ? "warning" : "pass",
    strengths: ["scene 字段完整", "视觉 fallback 明确", "适合后续替换真实图像/视频 provider"],
    issues: ["当前画面仍为程序化卡片", "静音音轨无法体现旁白情绪"],
    recommendations: ["接入本地 TTS 或商业 TTS", "为 diagram scene 增加更细的节点布局"]
  };
}

function enrichScene(scene: ReturnType<typeof fallbackScenes>[number], topic?: string) {
  const t = topic || scene.scene_title || "本段";
  return {
    ...scene,
    visual_prompt: `${scene.visual_prompt} 采用温暖浅米白背景、柔和橙色/珊瑚色/紫色强调、半透明玻璃面板、细腻阴影、清晰中文排版。`,
    local_card_prompt: `程序化卡片呈现「${scene.scene_title}」：左侧标题和关键词，右侧主体信息区，底部字幕安全区。`,
    future_image_prompt: `${scene.visual_prompt} 高质量知识视频配图，温暖浅色背景，清晰中文信息层级。`,
    future_video_prompt: `围绕「${t}」中的「${scene.scene_title}」生成 8-15 秒轻量信息动画，关键词逐条出现，镜头缓慢推近。`,
    negative_prompt: "霓虹赛博朋克、纯黑白临时图、拥挤字幕、低清晰度、过度装饰、廉价渐变",
    motion_suggestion: "淡入 300ms，主体卡片 1.02x 缓慢推近，关键词轻微上浮。",
    visual_consistency_tags: ["warm-light", "glass-card", "bilibili-report", scene.visual_type],
    fallback_strategy: "使用程序化 SVG/PNG 卡片承载标题、关键词、结构关系和字幕安全区。",
    fallback_used: true,
    mock_generated: true,
    notes: "Mock LLM fallback planned this scene; replace with IKunCode gpt-5.5 by configuring .env."
  };
}

function extractScript(text: string) {
  const marker = "SOURCE_SCRIPT:";
  const index = text.indexOf(marker);
  return index >= 0 ? text.slice(index + marker.length).trim() : text;
}

function extractSection(text: string, startMarker: string, endMarker: string) {
  const start = text.indexOf(startMarker);
  if (start < 0) return null;
  const afterStart = start + startMarker.length;
  const end = text.indexOf(endMarker, afterStart);
  return text.slice(afterStart, end >= 0 ? end : undefined).trim();
}

function mockProjectBrief(topic: string, user: string) {
  const extractParam = (key: string, label: string, fallback: string) => {
    return matchPromptParam(user, key, label)?.trim() || fallback;
  };
  const promptTopic = matchPromptParam(user, "TOPIC", "主题")?.trim();
  const visualStr = extractParam("VISUAL_STRATEGY", "画面策略", "自动");
  const rawGenMode = extractParam("GENERATION_MODE", "生成模式", "auto");
  const genMode = rawGenMode === "review" || rawGenMode === "director" || rawGenMode === "auto" ? rawGenMode : "auto";
  const rawAspectRatio = extractParam("ASPECT_RATIO", "视频比例", "16:9");
  const ar = rawAspectRatio === "9:16" || rawAspectRatio === "1:1" || rawAspectRatio === "16:9" ? rawAspectRatio : "16:9";
  const durTarget = parseInt(extractParam("DURATION_TARGET", "目标时长", "180"), 10) || 180;
  const platform = extractParam("PLATFORM", "目标平台", "bilibili");
  const style = extractParam("STYLE", "风格偏好", "Claude/iOS 质感卡片风");
  const audience = extractParam("AUDIENCE", "目标受众", "对 AI 工具感兴趣的内容创作者、开发者和知识型团队");
  const t = promptTopic || topic || "AI 如何改变内容创作";

  return {
    topic: t,
    audience,
    platform,
    style,
    duration_target_sec: durTarget,
    angle: `从「${t}」切入，分析当前工具链的痛点与解决方案`,
    core_message: `${t} 正在改变内容生产的方式，但更重要的是理解它能做什么、不能做什么。`,
    content_boundaries: [
      `必须包含：${t}的核心概念与实际案例`,
      "必须避免：未经证实的性能数据、过度承诺"
    ],
    risk_notes: [
      "基于模型知识创作，未经人工审核的事实可能不准确",
      "请勿直接用于商业发布，建议人工复核内容"
    ],
    recommended_workflow: ["阶段1: 脚本撰写与审核", "阶段2: 分镜设计与规划", "阶段3: 素材生成与调整", "阶段4: 合成渲染与质检"],
    visual_strategy: visualStr,
    generation_mode: genMode,
    aspect_ratio: ar
  };
}

function matchPromptParam(text: string, key: string, chineseLabel?: string): string | null {
  const escapedKey = escapeRegExp(key);
  const keyMatch = text.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${escapedKey}\\s*[:：]\\s*(.+?)(?:\\n|$)`, "i"));
  if (keyMatch?.[1]) return keyMatch[1].trim();

  if (chineseLabel) {
    const escapedLabel = escapeRegExp(chineseLabel);
    const labelMatch = text.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escapedLabel}(?:\\*\\*)?\\s*[:：]\\s*(.+?)(?:\\n|$)`));
    if (labelMatch?.[1]) return labelMatch[1].trim();
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mockScriptExpansion(topic: string, user: string) {
  const t = topic || "AI 视频创作";
  let durationTarget = 180;
  try {
    const brief = JSON.parse(user.match(/\{[\s\S]*\}/)?.[0] || "{}");
    durationTarget = brief.duration_target_sec || 180;
  } catch { /* use default */ }

  return {
    title: `「${t}」深度解析`,
    hook: `你有没有想过，${t} 其实正在悄悄地改变我们每个人的工作和学习方式？`,
    outline: [
      { section_title: `什么是${t}`, key_points: ["核心概念解释", "为什么现在值得关注"] },
      { section_title: "当前工具与挑战", key_points: ["主流方案对比", "实际落地中的困难"] },
      { section_title: "未来方向", key_points: ["技术演进趋势", "给创作者的建议"] }
    ],
    full_script: `【开场】\n你有没有想过，${t} 其实正在改变我们的创作方式？今天我们来深入聊聊这个话题。\n\n【正文】\n首先，我们需要理解${t}的核心概念...\n\n【结尾】\n总结一下，${t} 的关键在于...`,
    estimated_duration_sec: durationTarget,
    style_notes: ["使用温和克制的语气", "避免营销话术", "关键数据需要标注来源"],
    source_assumptions: ["基于模型知识创作，未经人工审核"]
  };
}

function mockEmptyWithWarning() {
  return {};
}

function extractManifest(text: string) {
  const raw = extractSection(text, "CURRENT_MANIFEST:", "\n\n") ?? text.slice(text.indexOf("CURRENT_MANIFEST:") + "CURRENT_MANIFEST:".length);
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    return null;
  }
}
