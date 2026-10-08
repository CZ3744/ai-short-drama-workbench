import { adapt, compilePromptLegacy as compilePrompt, type CompilePromptInput, type CompiledPrompt } from "./promptCompiler";
import { parseAndValidate, type ValidationResult } from "../../core/src/schema";
import type { ProjectBible, SceneManifestScene, ToolRegistryEntry, ProviderCapability } from "../../core/src/types";
import type { JobLogger } from "../../core/src/logger";
import type { LlmProvider } from "./llm";
import type { z } from "zod";

export interface RunCompiledAgentInput<T> {
  provider: LlmProvider;
  logger: JobLogger;
  agentName: string;
  handbookName?: string;
  promptFile: string;
  projectBible?: ProjectBible | null;
  jobContext?: Record<string, any>;
  sceneContext?: SceneManifestScene | null;
  toolRegistry?: Record<string, ToolRegistryEntry>;
  providerCapabilities?: ProviderCapability[];
  userInstruction: string;
  outputSchemaName?: string;
  outputSchema?: z.ZodSchema<T>;
  fallback: T;
  inputSummary: string;
  constraints?: string[];
}

export interface RunCompiledAgentResult<T> {
  data: T;
  prompt_version: string;
  included_sections: string[];
  parse_status: "validated" | "raw_json" | "fallback";
  repaired: boolean;
  schema_name?: string;
  error_count: number;
  warnings: string[];
  fallback_used: boolean;
}

export async function runCompiledAgent<T>(input: RunCompiledAgentInput<T>): Promise<RunCompiledAgentResult<T>> {
  const {
    provider, logger, agentName, handbookName, promptFile,
    projectBible, jobContext, sceneContext, toolRegistry,
    providerCapabilities, userInstruction, outputSchemaName,
    outputSchema, fallback, inputSummary, constraints
  } = input;

  // 1. Compile prompt
  const compileInput: CompilePromptInput = {
    agentName,
    handbookName,
    projectBible,
    jobContext,
    sceneContext,
    toolRegistry,
    providerCapabilities,
    userInstruction,
    outputSchema: outputSchema ? JSON.stringify({ description: `请返回符合 ${outputSchemaName || "schema"} 的 JSON` }) : undefined,
    constraints
  };

  let compiled: CompiledPrompt;
  try {
    compiled = await compilePrompt(compileInput);
  } catch (error) {
    await logger.line(`[agentRunner] compilePrompt failed for ${agentName}: ${error instanceof Error ? error.message : String(error)}`);
    compiled = {
      system: "你是一个专业的 AI 视频创作团队成员。返回严格 JSON。",
      user: userInstruction,
      prompt_version: "fallback_v1",
      included_sections: ["global_rules", "user_instruction"],
      warnings: []
    };
  }

  // Check for missing handbook
  if (handbookName && !compiled.included_sections.includes(`handbook:${handbookName}`)) {
    compiled.included_sections.push(`handbook_missing:${handbookName}`);
    compiled.warnings.push(`handbook_missing:${handbookName}`);
    await logger.line(`[agentRunner] WARNING: handbook '${handbookName}' not found for ${agentName}`);
  }

  // Log promptCompiler warnings (handbook missing, etc.)
  for (const w of compiled.warnings) {
    await logger.line(`[agentRunner] promptCompiler warning: ${w}`);
  }

  // 2. Call LLM — prefer callText for raw text, then callJson
  const callInput = { agentName, promptFile, inputSummary, system: compiled.system, user: compiled.user };
  const logBase = {
    agentName,
    prompt_version: compiled.prompt_version,
    handbookName,
    prompt_compiler_warnings: compiled.warnings.length > 0 ? compiled.warnings : undefined,
    project_bible_used: compiled.included_sections.includes("project_bible"),
    tool_registry_used: compiled.included_sections.includes("tool_registry"),
    provider_capabilities_used: compiled.included_sections.includes("provider_capabilities"),
    output_schema_name: outputSchemaName,
  };

  // Track callText failure info for llm_calls traceability
  let rawTextErrorType = "";
  let rawTextErrorMessageRedacted = "";
  let callTextFallbackToCallJson = false;

  // Attempt 1: raw text
  if (provider.callText && outputSchema) {
    try {
      const rawText = await provider.callText(callInput);
      const validation = parseAndValidate(rawText, outputSchema);
      if (validation.success) {
        await logLlmCall(logger, { ...logBase, parse_status: "validated", fallback_used: false, raw_text_used: true, repaired: validation.repaired, retry_used: false });
        return {
          data: validation.data,
          prompt_version: compiled.prompt_version,
          included_sections: compiled.included_sections,
          parse_status: "validated",
          repaired: validation.repaired,
          schema_name: outputSchemaName,
          error_count: 0,
          warnings: [...(validation.warnings || []), ...compiled.warnings],
          fallback_used: false
        };
      }
      // raw text failed schema validation — will retry below
      await logger.line(`[agentRunner] raw text schema validation failed for ${agentName}: ${validation.errors.join("; ")}`);
    } catch (callTextError) {
      callTextFallbackToCallJson = true;
      const errMsg = callTextError instanceof Error ? callTextError.message : String(callTextError);
      rawTextErrorType = classifyCallError(errMsg);
      rawTextErrorMessageRedacted = redactErrorMessage(errMsg);
      await logger.line(`[agentRunner] callText failed for ${agentName}, raw_text_error_type=${rawTextErrorType}, falling back to callJson`);
    }
  }

  // Attempt 1 fallback: callJson
  let rawResult: T;
  let rawTextUsed = false;
  try {
    rawResult = await provider.callJson<T>(callInput);
  } catch (error) {
    await logger.line(`[agentRunner] LLM call failed for ${agentName}: ${error instanceof Error ? error.message : String(error)}`);
    await logLlmCall(logger, { ...logBase, parse_status: "fallback", fallback_used: true, raw_text_used: false, retry_used: false, ...(callTextFallbackToCallJson ? { raw_text_error_type: rawTextErrorType, raw_text_error_message_redacted: rawTextErrorMessageRedacted, fallback_to_callJson: true } : {}) });
    // A-2 (2026-05-12): 在 data 内部注入 _fallback_reason, 让下游消费者 (写 manifest /
    // beat_sheet.json 等) 不需要单独看顶层 fallback_used 就能判断这是假数据.
    return {
      data: stampFallback(fallback, `llm_call_failed:${classifyCallError(error instanceof Error ? error.message : String(error))}`),
      prompt_version: compiled.prompt_version,
      included_sections: compiled.included_sections,
      parse_status: "fallback",
      repaired: false,
      schema_name: outputSchemaName,
      error_count: 1,
      warnings: [`LLM call failed: ${error instanceof Error ? error.message : String(error)}`],
      fallback_used: true
    };
  }

  // 3. Validate with schema if provided
  if (outputSchema) {
    const validation = parseAndValidate(JSON.stringify(rawResult), outputSchema);
    if (validation.success) {
      await logLlmCall(logger, { ...logBase, parse_status: "validated", fallback_used: false, raw_text_used: false, retry_used: false, repaired: validation.repaired, ...(callTextFallbackToCallJson ? { raw_text_error_type: rawTextErrorType, raw_text_error_message_redacted: rawTextErrorMessageRedacted, fallback_to_callJson: true } : {}) });
      return {
        data: validation.data,
        prompt_version: compiled.prompt_version,
        included_sections: compiled.included_sections,
        parse_status: "validated",
        repaired: validation.repaired,
        schema_name: outputSchemaName,
        error_count: 0,
        warnings: validation.warnings || [],
        fallback_used: false
      };
    }

    // 4. Retry — prefer callText, then callJson
    // E-N4 (2026-05-12): 之前 retryUser 把全部 validation errors append, 极端情况下
    // (e.g. schema 几十个字段每个都报错) 会把 user prompt 撑爆 token 上限. 现在:
    //   - errors 仅取前 5 条
    //   - 每条 message slice 至 300 char
    //   - retry user 最大 16K, 超出截断
    const errorsSummary = validation.errors.slice(0, 5).map((e) => String(e).slice(0, 300)).join("; ");
    const retryUserRaw = `${compiled.user}\n\n## 上一次返回的 JSON 校验失败\n错误: ${errorsSummary}\n\n请修正后重新返回严格符合 schema 的 JSON。`;
    const RETRY_USER_MAX_CHARS = 16_000;
    const retryUser = retryUserRaw.length > RETRY_USER_MAX_CHARS
      ? retryUserRaw.slice(0, RETRY_USER_MAX_CHARS) + "\n[...truncated]"
      : retryUserRaw;
    const retryInput = { ...callInput, agentName: `${agentName}_retry`, inputSummary: `retry: ${inputSummary}`, user: retryUser };
    await logger.line(`[agentRunner] Schema validation failed for ${agentName}, retrying. Errors: ${validation.errors.join("; ")}`);

    // Try raw text retry first
    if (provider.callText) {
      try {
        const retryRawText = await provider.callText(retryInput);
        const retryValidation = parseAndValidate(retryRawText, outputSchema);
        if (retryValidation.success) {
          await logLlmCall(logger, { ...logBase, parse_status: "validated", fallback_used: false, raw_text_used: true, retry_used: true, repaired: retryValidation.repaired });
          return {
            data: retryValidation.data,
            prompt_version: compiled.prompt_version,
            included_sections: compiled.included_sections,
            parse_status: "validated",
            repaired: retryValidation.repaired,
            schema_name: outputSchemaName,
            error_count: 0,
            warnings: [`Initial validation failed, retry(raw) succeeded. Errors: ${validation.errors.join("; ")}`],
            fallback_used: false
          };
        }
      } catch { /* fall through to callJson retry */ }
    }

    // callJson retry
    try {
      const retryResult = await provider.callJson<T>(retryInput);
      const retryValidation = parseAndValidate(JSON.stringify(retryResult), outputSchema);
      if (retryValidation.success) {
        await logLlmCall(logger, { ...logBase, parse_status: "validated", fallback_used: false, raw_text_used: false, retry_used: true, repaired: retryValidation.repaired });
        return {
          data: retryValidation.data,
          prompt_version: compiled.prompt_version,
          included_sections: compiled.included_sections,
          parse_status: "validated",
          repaired: retryValidation.repaired,
          schema_name: outputSchemaName,
          error_count: 0,
          warnings: [`Initial validation failed, retry succeeded. Errors: ${validation.errors.join("; ")}`],
          fallback_used: false
        };
      }
    } catch (retryError) {
      await logger.line(`[agentRunner] Retry LLM call also failed for ${agentName}`);
    }

    // Both attempts failed — use fallback
    await logger.line(`[agentRunner] Using fallback for ${agentName} after validation failures`);
    await logLlmCall(logger, { ...logBase, parse_status: "fallback", fallback_used: true, raw_text_used: false, retry_used: true });
    // A-2: 校验失败 + 重试失败也要打 _fallback_reason 印记.
    return {
      data: stampFallback(fallback, `schema_validation_failed:${validation.errors.slice(0, 3).join("|").slice(0, 200)}`),
      prompt_version: compiled.prompt_version,
      included_sections: compiled.included_sections,
      parse_status: "fallback",
      repaired: false,
      schema_name: outputSchemaName,
      error_count: validation.errors.length,
      warnings: validation.errors,
      fallback_used: true
    };
  }

  // No schema — return raw result
  await logLlmCall(logger, { ...logBase, parse_status: "raw_json", fallback_used: false, raw_text_used: false, retry_used: false });
  return {
    data: rawResult,
    prompt_version: compiled.prompt_version,
    included_sections: compiled.included_sections,
    parse_status: "raw_json",
    repaired: false,
    schema_name: outputSchemaName,
    error_count: 0,
    warnings: [],
    fallback_used: false
  };
}

interface LlmCallLogEntry {
  agentName: string;
  prompt_version: string;
  handbookName?: string;
  prompt_compiler_warnings?: string[];
  project_bible_used: boolean;
  tool_registry_used: boolean;
  provider_capabilities_used: boolean;
  output_schema_name?: string;
  parse_status: string;
  fallback_used: boolean;
  raw_text_used?: boolean;
  raw_text_error_type?: string;
  raw_text_error_message_redacted?: string;
  fallback_to_callJson?: boolean;
  retry_used?: boolean;
  repaired?: boolean;
}

async function logLlmCall(logger: JobLogger, entry: LlmCallLogEntry) {
  await logger.llm({
    at: new Date().toISOString(),
    ...entry
  } as any);
}

function classifyCallError(message: string): string {
  if (/network|econnrefused|enotfound|timeout|fetch.?failed/i.test(message)) return "network_error";
  if (/key|unauthorized|401|403|auth/i.test(message)) return "auth_error";
  if (/quota|rate.?limit|too.?many|429|503/i.test(message)) return "quota_or_rate_limit";
  if (/parse|json|unexpected|token/i.test(message)) return "response_parse_failed";
  return "unknown";
}

/**
 * A-2 (2026-05-12): 给 fallback data 盖一个 _fallback_reason 印记, 这样下游写
 * manifest / beat_sheet.json / scene.* 时即使忽略顶层 fallback_used 也能从 data
 * payload 自身识别出这是假数据. 只对对象类型生效; 标量直接返回原值 (但标量 fallback
 * 极少见, 几乎都是 object / array).
 *
 * 不变性保证: 不修改原 fallback 引用 (避免污染调用方传入的常量), 返回浅拷贝.
 */
function stampFallback<T>(fallback: T, reason: string): T {
  if (fallback == null || typeof fallback !== "object") return fallback;
  // P1-NEW: 清理 dead code — array / object 分支独立, 不再走双计算路径
  if (Array.isArray(fallback)) {
    // 数组: 保留原型 + 非枚举属性, 下游 caller 仍能 .map / .length
    const arr = [...fallback] as T & any[];
    Object.defineProperty(arr, "_fallback_reason", { value: reason, enumerable: false });
    Object.defineProperty(arr, "_fallback_at", { value: new Date().toISOString(), enumerable: false });
    return arr as T;
  }
  // 对象: 浅拷贝 + 注入字段
  const stamped: Record<string, unknown> = {
    ...(fallback as Record<string, unknown>),
    _fallback_reason: reason,
    _fallback_at: new Date().toISOString(),
  };
  return stamped as unknown as T;
}

function redactErrorMessage(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "sk-***")
    .replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, "Bearer ***")
    // JWT 3-part token (MiniMax)
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt_***]")
    // api-key / x-api-key / dashscope-api-key header value echo
    .replace(/(["']?(?:api[_-]?key|x[_-]?api[_-]?key|dashscope[_-]?api[_-]?key)["']?\s*[:=]\s*["']?)([A-Za-z0-9._-]{12,})/gi, "$1***")
    .replace(/[a-zA-Z0-9+/=]{40,}/g, (m) => m.length > 40 ? `${m.slice(0, 6)}...` : m);
}

// --- Provider Prompt Adapter via runCompiledAgent ---

import { ProviderPromptAdapterSchema, validateProviderPromptAdapter } from "../../core/src/schema";
import type { ProviderPromptAdapterOutput } from "../../core/src/types";

export interface RunProviderPromptAdapterInput {
  jobId: string;
  scene: SceneManifestScene;
  providerId: string;
  modality: "image" | "video";
  duration: number;
  logger: JobLogger;
  projectBible?: ProjectBible | null;
  providerCapabilities?: ProviderCapability[];
}

export interface RunProviderPromptAdapterResult {
  provider_prompt: string;
  provider_prompt_adapter_output: ProviderPromptAdapterOutput | null;
  provider_prompt_adapter_fallback: boolean;
  adapter_version: string;
  adapter_warnings: string[];
}

export async function runProviderPromptAdapterForScene(
  input: RunProviderPromptAdapterInput
): Promise<RunProviderPromptAdapterResult> {
  const { jobId, scene, providerId, modality, duration, logger, projectBible, providerCapabilities } = input;

  const fallbackPrompt = scene.future_video_prompt || scene.visual_prompt;
  const fallbackAdapted = adapt(fallbackPrompt, "scene_manifest", providerId, {
    modality,
    negativePrompt: scene.negative_prompt || ""
  });
  const fallbackResult: RunProviderPromptAdapterResult = {
    provider_prompt: fallbackAdapted.prompt,
    provider_prompt_adapter_output: null,
    provider_prompt_adapter_fallback: true,
    adapter_version: fallbackAdapted.adapter_version,
    adapter_warnings: fallbackAdapted.warnings
  };

  try {
    // Build a TextLlmProvider via ModelRouter
    const { loadModelRouterConfig, ModelRouter } = await import("./mimo");
    const routerConfig = loadModelRouterConfig();
    const router = new ModelRouter(routerConfig, logger);
    const textProvider = router.selectTextProvider("visual_prompt_adapter");

    // Wrap TextLlmProvider as LlmProvider for runCompiledAgent
    // E-N2 (2026-05-12): 透传 agentName, 让 task-aware temperature 生效到底层 provider
    const llmProvider: LlmProvider = {
      config: { provider: textProvider.id, baseUrl: "", apiKey: "", model: "", temperature: 0.7, mock: false, subtitleMode: "both", ttsProvider: "silence", ttsFallbackProvider: "silence", ttsVoice: "", ttsRate: "1.0", ttsEnabled: false },
      async callJson<T>(callInput: { agentName: string; promptFile: string; inputSummary: string; system: string; user: string }): Promise<T> {
        return textProvider.chatJson<T>({ system: callInput.system, user: callInput.user, agentName: callInput.agentName });
      },
      async callText(callInput: { agentName: string; promptFile: string; inputSummary: string; system: string; user: string }): Promise<string> {
        return textProvider.chatText({ system: callInput.system, user: callInput.user, agentName: callInput.agentName });
      }
    };

    // Load tool registry
    const { pathExists, readJson } = await import("../../core/src/index");
    const path = await import("node:path");
    const toolRegPath = path.join(process.cwd(), "config", "tool_registry.json");
    const toolRegistry = (await pathExists(toolRegPath) ? await readJson<Record<string, any>>(toolRegPath) : undefined) ?? undefined;

    const result = await runCompiledAgent<ProviderPromptAdapterOutput>({
      provider: llmProvider,
      logger,
      agentName: "provider_prompt_adapter",
      handbookName: "provider_prompt_adapter",
      promptFile: "provider_prompt_adapter.md",
      projectBible,
      sceneContext: scene,
      toolRegistry,
      providerCapabilities,
      userInstruction: `请将以下分镜的视觉描述适配为 ${providerId} 的 ${modality} 生成提示词。场景时长 ${duration} 秒。`,
      outputSchemaName: "ProviderPromptAdapterSchema",
      outputSchema: ProviderPromptAdapterSchema,
      fallback: {
        scene_stable_id: scene.stable_scene_id,
        provider: providerId,
        modality,
        provider_prompt: fallbackAdapted.prompt,
        negative_prompt: fallbackAdapted.negative_prompt,
        duration_sec: duration,
        aspect_ratio: "16:9",
        resolution: "1920x1080",
        camera_motion: "",
        style_tags: [],
        safety_notes: []
      },
      inputSummary: `scene=${scene.stable_scene_id} provider=${providerId} modality=${modality}`,
      constraints: [
        "provider_prompt 不得为空",
        "不得修改旁白内容",
        "不得虚构场景中不存在的元素"
      ]
    });

    if (result.fallback_used || !result.data.provider_prompt?.trim()) {
      await logger.line(`[Provider Prompt Adapter] runCompiledAgent returned fallback for scene ${scene.stable_scene_id}`);
      return fallbackResult;
    }

    // Validate adapter output
    const adapterWarnings = validateProviderPromptAdapter(result.data, duration);
    if (adapterWarnings.length > 0) {
      await logger.line(`[Provider Prompt Adapter] warnings: ${adapterWarnings.join("; ")}`);
    }

    await logger.line(`[Provider Prompt Adapter] success for scene ${scene.stable_scene_id}, provider=${providerId}, parse_status=${result.parse_status}`);

    return {
      provider_prompt: result.data.provider_prompt,
      provider_prompt_adapter_output: result.data,
      provider_prompt_adapter_fallback: false,
      adapter_version: result.prompt_version,
      adapter_warnings: adapterWarnings
    };
  } catch (adapterError) {
    await logger.line(`[Provider Prompt Adapter] failed, using scene prompt as fallback. ${adapterError instanceof Error ? adapterError.message : String(adapterError)}`);
    return fallbackResult;
  }
}
