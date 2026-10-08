/**
 * P150-B1 · DirectorAgent — function-calling loop
 *
 * 将短剧制作流程封装为 LLM 驱动的决策闭环:
 * 每 stage 完成后读 ProjectManifest + QualitySignals，LLM 决定 next action
 *
 * 工具集:
 *   generate_script / plan_scenes / generate_first_frame / generate_video
 *   run_critic / replan / ask_user / finalize
 */
import { z } from "zod";
import { parseJsonFromLlm } from "../utils/llmJsonParser.js";

// ─── Types ────────────────────────────────────────────────────────

/** 工具名称 */
export type DirectorTool =
  | "generate_script"
  | "plan_scenes"
  | "generate_first_frame"
  | "generate_video"
  | "run_critic"
  | "replan"
  | "ask_user"
  | "finalize";

/** 工具调用参数（每种工具的 params 类型不同，用 Record 兜底） */
export interface ToolCall {
  tool: DirectorTool;
  params: Record<string, unknown>;
  reason: string;
}

/** 质量信号 — 每 stage 完成后由系统注入 */
export interface QualitySignals {
  clip_score?: number;       // CLIP 与 prompt 的匹配分 (0-1)
  continuity_ok?: boolean;   // 相邻镜头连续性检查通过
  critic_score?: number;     // 叙事 critic 打分 (0-1)
  failure_count: number;     // 本 stage 连续失败次数
  error_messages: string[];  // 最近错误信息
}

/** 项目清单 — 每次决策前由系统注入 */
export interface ProjectManifest {
  series_slug: string;
  episode_id: string;
  stage: DirectorStage;
  script_done: boolean;
  storyboard_done: boolean;
  first_frames_done: boolean;
  videos_done: boolean;
  compose_done: boolean;
  shot_count: number;
  shots_with_video: number;
  shots_with_first_frame: number;
  total_duration_sec: number;
  quality_signals: QualitySignals;
}

export type DirectorStage =
  | "init"
  | "scripting"
  | "storyboarding"
  | "first_frame"
  | "video_gen"
  | "critic"
  | "replanning"
  | "composing"
  | "done";

// ─── DirectorDecision ─────────────────────────────────────────────

export interface DirectorDecision {
  action: "call_tool" | "ask_user" | "finalize" | "abort";
  tool?: DirectorTool;
  params?: Record<string, unknown>;
  reason: string;
  thinking?: string;  // 内部推理链(可选，用于前端展示)
}

// ─── Tool schemas for LLM ─────────────────────────────────────────

const TOOL_DEFINITIONS: Record<DirectorTool, { description: string; params_schema: string }> = {
  generate_script: {
    description: "调用 LLM 生成或扩展剧本",
    params_schema: "{ user_note?: string }",
  },
  plan_scenes: {
    description: "调用 LLM 生成分镜计划",
    params_schema: "{ user_note?: string }",
  },
  generate_first_frame: {
    description: "为所有镜头生成首帧图",
    params_schema: "{ count_per_shot?: number }",
  },
  generate_video: {
    description: "为所有镜头生成视频片段",
    params_schema: "{ count_per_shot?: number }",
  },
  run_critic: {
    description: "运行叙事 critic 对当前产物打分",
    params_schema: "{}",
  },
  replan: {
    description: "根据 critic 反馈重新规划分镜",
    params_schema: "{ reason: string }",
  },
  ask_user: {
    description: "向用户提问以获取更多信息或确认",
    params_schema: "{ question: string, options?: string[] }",
  },
  finalize: {
    description: "所有阶段完成，结束流程",
    params_schema: "{}",
  },
};

// ─── Zod schemas for LLM response ─────────────────────────────────

const DirectorLlmResponseSchema = z.object({
  action: z.enum(["call_tool", "ask_user", "finalize", "abort"]),
  tool: z.enum([
    "generate_script", "plan_scenes", "generate_first_frame", "generate_video",
    "run_critic", "replan", "ask_user", "finalize",
  ]).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  reason: z.string(),
  thinking: z.string().optional(),
});

// ─── Prompt ───────────────────────────────────────────────────────

function buildDirectorPrompt(manifest: ProjectManifest): string {
  const toolList = Object.entries(TOOL_DEFINITIONS)
    .map(([name, def]) => `- ${name}: ${def.description}  params: ${def.params_schema}`)
    .join("\n");

  const stageProgress = [
    manifest.script_done ? "  [x] 剧本" : "  [ ] 剧本",
    manifest.storyboard_done ? "  [x] 分镜" : "  [ ] 分镜",
    manifest.first_frames_done ? "  [x] 首帧图" : "  [ ] 首帧图",
    manifest.videos_done ? "  [x] 视频" : "  [ ] 视频",
    manifest.compose_done ? "  [x] 合成" : "  [ ] 合成",
  ].join("\n");

  const qs = manifest.quality_signals;
  const qualityInfo = [
    qs.clip_score != null ? `CLIP 分: ${qs.clip_score}` : null,
    qs.continuity_ok != null ? `连续性: ${qs.continuity_ok ? "通过" : "不通过"}` : null,
    qs.critic_score != null ? `Critic 分: ${qs.critic_score}` : null,
    qs.failure_count > 0 ? `连续失败: ${qs.failure_count} 次` : null,
    qs.error_messages.length > 0 ? `最近错误: ${qs.error_messages.slice(-2).join("; ")}` : null,
  ].filter(Boolean).join("\n") || "暂无质量信号";

  return `你是一位短剧制作导演 Agent。当前项目进度如下:

系列: ${manifest.series_slug} / 集: ${manifest.episode_id}
当前阶段: ${manifest.stage}
镜头数: ${manifest.shot_count} | 已有首帧: ${manifest.shots_with_first_frame} | 已有视频: ${manifest.shots_with_video}
总时长: ${manifest.total_duration_sec}s

进度:
${stageProgress}

质量信号:
${qualityInfo}

可用工具:
${toolList}

规则:
1. 每次只调用一个工具
2. 如果连续失败 ≥3 次，应 ask_user 或 abort，不要死循环
3. critic_score < 0.7 时应 replan，≥0.7 时可进入下一阶段
4. 所有阶段完成后必须 finalize
5. 遇到不可恢复错误时 abort 并说明原因

请根据当前状态决定下一步行动。严格按以下 JSON 格式返回，不要包含 Markdown 代码块:
{
  "action": "call_tool" | "ask_user" | "finalize" | "abort",
  "tool": "工具名",           // action=call_tool 时必填
  "params": { ... },          // 工具参数
  "reason": "决策理由",
  "thinking": "内部推理(可选)"
}`;
}

// ─── DirectorAgent ────────────────────────────────────────────────

export interface DirectorAgentOptions {
  /** LLM provider 注入 */
  registry: import("../../../providers/src/core/index").ProviderRegistry;
  chain: string[];
  getKeyFor: (id: string) => string | null;
  /** 最大循环次数，防止死循环 */
  maxIterations?: number;
  /** 每步回调（LLM 决策后、工具执行前） */
  onStep?: (decision: DirectorDecision, iteration: number) => void;
  /** Wave 3: LLM 调用前回调（用于 SSE 推送 director_call_start） */
  beforeStep?: (iteration: number) => void;
  /** Wave 3: LLM 调用后回调（用于 SSE 推送 director_call_end） */
  afterStep?: (iteration: number, decision: DirectorDecision | null, durationMs: number, success: boolean, error?: string) => void;
  signal?: AbortSignal;
}

export interface DirectorRunResult {
  status: "completed" | "aborted" | "max_iterations";
  iterations: number;
  decisions: DirectorDecision[];
  final_manifest: ProjectManifest;
}

/**
 * 运行 DirectorAgent 的 function-calling loop
 *
 * 调用方需提供:
 * - getManifest: 获取当前项目清单
 * - executeTool: 执行具体工具并返回更新后的清单
 */
export async function runDirectorLoop(
  getManifest: () => Promise<ProjectManifest>,
  executeTool: (tool: DirectorTool, params: Record<string, unknown>) => Promise<ProjectManifest>,
  options: DirectorAgentOptions,
): Promise<DirectorRunResult> {
  const { registry, chain, getKeyFor, maxIterations = 30, onStep, beforeStep, afterStep, signal } = options;

  const { tryWithFallback, resolveChain } = await import("../../../providers/src/core/queue");
  const { getConfigValue } = await import("../../../core/src/localSettings");

  const resolvedChain = resolveChain(
    chain[0] || getConfigValue("GLOBAL_MODEL_PROVIDER", "ikuncode_gpt55"),
    chain,
    (id: string) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );

  const decisions: DirectorDecision[] = [];
  let iterations = 0;

  while (iterations < maxIterations) {
    // 1. 获取当前清单
    const manifest = await getManifest();

    // 2. 已完成 → 直接 finalize
    if (manifest.stage === "done") {
      const decision: DirectorDecision = {
        action: "finalize",
        reason: "所有阶段已完成",
      };
      decisions.push(decision);
      onStep?.(decision, iterations);
      return { status: "completed", iterations: iterations + 1, decisions, final_manifest: manifest };
    }

    // 3. 构建 prompt
    const prompt = buildDirectorPrompt(manifest);

    // Wave 3: push director_call_start before LLM call
    beforeStep?.(iterations);
    const llmCallStartMs = Date.now();

    // 4. 调用 LLM 决策
    // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
    // 删 AbortSignal.timeout(60_000) fallback, 只透传 caller signal (用户中止按钮).
    const providerCtx = {
      series_slug: manifest.series_slug,
      job_id: `director_${Date.now().toString(36)}`,
      task_id: `task_${Date.now().toString(36)}`,
      log: () => {},
      signal,
    };

    let llmResult;
    try {
      llmResult = await tryWithFallback(
        resolvedChain,
        (id: string) => registry.getLlm(id),
        {
          prompt,
          system: "你是一位短剧制作导演。只返回合法 JSON，不要包含 Markdown 代码块。",
          response_format: "json",
          max_tokens: 512,
        },
        providerCtx,
      );
      // Wave 3: LLM success — push director_call_end
      afterStep?.(iterations, null, Date.now() - llmCallStartMs, true);
    } catch (err) {
      // Wave 3: LLM error — push director_call_end
      afterStep?.(iterations, null, Date.now() - llmCallStartMs, false, (err as Error).message);
      const decision: DirectorDecision = {
        action: "abort",
        reason: `LLM 调用失败: ${(err as Error).message}`,
      };
      decisions.push(decision);
      onStep?.(decision, iterations);
      return { status: "aborted", iterations: iterations + 1, decisions, final_manifest: manifest };
    }

    // 5. 解析决策
    let decision: DirectorDecision;
    try {
      const raw = parseJsonFromLlm(llmResult.text);
      const parsed = DirectorLlmResponseSchema.parse(raw);
      decision = {
        action: parsed.action,
        tool: parsed.tool as DirectorTool | undefined,
        params: parsed.params ?? {},
        reason: parsed.reason,
        thinking: parsed.thinking,
      };
    } catch {
      // Wave 3: parse error — push director_call_end
      afterStep?.(iterations, null, Date.now() - llmCallStartMs, false, "LLM 返回格式校验失败");
      const decision: DirectorDecision = {
        action: "abort",
        reason: "LLM 返回格式校验失败",
      };
      decisions.push(decision);
      onStep?.(decision, iterations);
      return { status: "aborted", iterations: iterations + 1, decisions, final_manifest: manifest };
    }

    // Wave 3: after successful parse, push director_call_end with the decision
    afterStep?.(iterations, decision, Date.now() - llmCallStartMs, true);

    decisions.push(decision);
    onStep?.(decision, iterations);
    iterations++;

    // 6. 执行决策
    switch (decision.action) {
      case "finalize":
        return { status: "completed", iterations, decisions, final_manifest: manifest };

      case "abort":
        return { status: "aborted", iterations, decisions, final_manifest: manifest };

      case "ask_user":
        // ask_user 需要外部交互，返回当前状态让调用方处理
        return { status: "aborted", iterations, decisions, final_manifest: manifest };

      case "call_tool":
        if (!decision.tool) {
          return { status: "aborted", iterations, decisions, final_manifest: manifest };
        }
        try {
          await executeTool(decision.tool, decision.params ?? {});
        } catch (err) {
          // 工具执行失败 → 记录但继续循环(让 LLM 决定是否重试)
          const failDecision: DirectorDecision = {
            action: "abort",
            reason: `工具 ${decision.tool} 执行失败: ${(err as Error).message}`,
          };
          decisions.push(failDecision);
          // 不立即返回，让下一轮 LLM 决策处理
        }
        break;
    }
  }

  // 超过最大迭代次数
  const manifest = await getManifest();
  return { status: "max_iterations", iterations, decisions, final_manifest: manifest };
}
