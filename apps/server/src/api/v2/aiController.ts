/**
 * v24-batch-all · AI 辅助接口
 *
 * POST /api/v2/ai/ask                  · 不改内容, 仅回答
 * POST /api/v2/ai/suggest              · 返回 suggestion_id + patches
 * POST /api/v2/ai/suggest/:sid/accept  · 应用 patch 到 shot prompt / episode script
 * POST /api/v2/ai/suggest/:sid/reject  · 丢弃
 *
 * TODO(pm): 当前 suggest patches 用内存 Map 存 1 小时; 复杂局部 diff 合并仍待 op-based editor 接入.
 */

import { Router, type Request, type Response } from "express";
import { clientDisconnectSignal } from "../../middleware/clientDisconnectSignal";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getRegistry } from "./orchestrationController";
import { getConfigValue, getKeyFor } from "../../../../../packages/core/src/localSettings";
import { scrubForClient, loggerSync } from "../../../../../packages/core/src/logger";
import { resolveChain, tryWithFallback } from "../../../../../packages/providers/src/core/queue";
import type { CostInfo, ProviderContext } from "../../../../../packages/providers/src/core/types";
import {
  appendPromptVersion,
  readEpisode,
  readShotById,
  saveVersionFile,
  updateEpisode,
  updateShotById,
  type EpisodeVersion,
} from "./seriesStore";
import { providerIdFromModelRef } from "../../application/generation/modelRef";
import { DATA_ROOT } from "../../../../../packages/core/src/paths";
import { buildAiSuggestPromptParts } from "../../application/preview/previewPrompts";

export const aiRouter = Router();

interface SuggestRecord {
  suggestion_id: string;
  at: number;
  input: unknown;
  patches: Array<{
    id: string; kind: "modify" | "insert" | "rewrite" | "delete";
    path: string; title: string;
    before?: string; after?: string;
    is_field?: boolean; is_new?: boolean; affect?: string;
  }>;
}

interface SuggestScope {
  kind?: "script" | "shot" | "prompt";
  id?: string;
}

// ── AI Suggest 持久化存储 ────────────────────────────────────────────────────
// 替代原内存 Map，写盘 data/ai_patches/<sid>.json。
// 出错不阻塞主流程（catch → warn log），回退到当前请求的内存副本。
const AI_PATCHES_DIR = path.join(DATA_ROOT, "ai_patches");
const SUGGEST_TTL_MS = 60 * 60 * 1000; // 1 小时

/** 内存缓存，作为写盘的二级索引（避免每次 get 都读文件） */
const SUGGEST_STORE = new Map<string, SuggestRecord>();

function patchFilePath(sid: string): string {
  return path.join(AI_PATCHES_DIR, `${sid}.json`);
}

/** 启动时从磁盘加载未过期的 patch 记录 */
function loadPatchesFromDisk(): void {
  if (!fs.existsSync(AI_PATCHES_DIR)) return;
  const now = Date.now();
  let loaded = 0;
  let expired = 0;
  for (const fname of fs.readdirSync(AI_PATCHES_DIR)) {
    if (!fname.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(AI_PATCHES_DIR, fname), "utf8");
      const rec: SuggestRecord = JSON.parse(raw);
      if (typeof rec.suggestion_id === "string" && typeof rec.at === "number") {
        if (now - rec.at <= SUGGEST_TTL_MS) {
          SUGGEST_STORE.set(rec.suggestion_id, rec);
          loaded++;
        } else {
          // 过期文件异步删除，不阻塞启动
          fsp.unlink(path.join(AI_PATCHES_DIR, fname)).catch(() => {});
          expired++;
        }
      }
    } catch { /* 解析失败跳过 */ }
  }
  if (loaded > 0 || expired > 0) {
    loggerSync().info(`[aiController] ai_patches 加载: ${loaded} 条有效, ${expired} 条过期已删`);
  }
}

/** 写盘（原子：先写 .tmp 再 rename） */
async function persistPatch(record: SuggestRecord): Promise<void> {
  try {
    if (!fs.existsSync(AI_PATCHES_DIR)) {
      await fsp.mkdir(AI_PATCHES_DIR, { recursive: true });
    }
    const target = patchFilePath(record.suggestion_id);
    const tmp = target + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await fsp.rename(tmp, target);
  } catch (e) {
    console.warn(`[aiController] persistPatch 写盘失败 (${record.suggestion_id}):`, e);
  }
}

/** 删除磁盘文件（accept / reject 时调用） */
async function deletePatch(sid: string): Promise<void> {
  const fp = patchFilePath(sid);
  if (fs.existsSync(fp)) {
    await fsp.unlink(fp).catch(() => {});
  }
}

// 启动时 reload
loadPatchesFromDisk();

function costToCny(cost?: CostInfo): number {
  if (!cost) return 0;
  return cost.currency === "CNY" ? cost.amount : 0;
}

function buildProviderContext(purpose: string, req: Request): ProviderContext {
  // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 不传 AbortSignal.timeout(120_000)。
  // 2026-06-01(查 bug 一致性收尾): 透传 req.signal 不是"主动超时", 是铁律 #1 鼓励的
  // (客户端断开/用户取消才 abort)。与 polish-prompt / seriesRoutes / planStoryboard 等 7 处
  // callsite 对齐, 避免用户关弹窗后 ad-hoc LLM 调用空跑完浪费额度。原 void req 注释本就写明"待接入"。
  return {
    series_slug: "ad-hoc-ai",
    job_id: `ai_${Date.now().toString(36)}`,
    task_id: `task_${purpose}_${Date.now().toString(36)}`,
    log: () => {},
    signal: clientDisconnectSignal(req, req.res!),
  };
}

function resolveAiChain(requestedProviderId?: string): string[] {
  const registry = getRegistry();
  const all = registry.listAvailable("llm").map((p) => p.id);
  const lead = requestedProviderId || getConfigValue("GLOBAL_MODEL_PROVIDER", "ikuncode_gpt55");
  return resolveChain(
    lead,
    all,
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );
}

async function callLlmText(req: Request, input: {
  purpose: string;
  system: string;
  prompt: string;
  providerId?: string;
  maxTokens?: number;
  responseFormat?: "text" | "json";
}) {
  const chain = resolveAiChain(input.providerId);
  const ctx = buildProviderContext(input.purpose, req);
  return tryWithFallback(
    chain,
    (id) => getRegistry().getLlm(id),
    {
      prompt: input.prompt,
      system: input.system,
      response_format: input.responseFormat ?? "text",
      max_tokens: input.maxTokens ?? 1200,
    },
    ctx,
  );
}

function parseJsonFromLlm(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

function normalizePatches(raw: unknown, fallbackText: string, scope: { kind?: string; id?: string } | undefined, instruction: string): SuggestRecord["patches"] {
  // 2026-05-28 audit P1 type-safety — LLM 出 dynamic JSON, 走 unknown narrowing 替代 (raw as any).patches / (p: any)
  let candidate: unknown[];
  if (Array.isArray(raw)) {
    candidate = raw;
  } else if (raw && typeof raw === "object" && "patches" in raw && Array.isArray((raw as { patches: unknown }).patches)) {
    candidate = (raw as { patches: unknown[] }).patches;
  } else {
    candidate = [];
  }
  const patches = candidate
    .map((p): SuggestRecord["patches"][number] => {
      const rec = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      const kindRaw = typeof rec.kind === "string" ? rec.kind : "";
      const kind: "modify" | "insert" | "rewrite" | "delete" =
        kindRaw === "modify" || kindRaw === "insert" || kindRaw === "rewrite" || kindRaw === "delete"
          ? kindRaw
          : "modify";
      return {
        id: typeof rec.id === "string" ? rec.id : `p_${randomUUID().slice(0, 6)}`,
        kind,
        path: typeof rec.path === "string" ? rec.path : `${scope?.kind ?? "script"}[${scope?.id ?? "current"}]`,
        title: typeof rec.title === "string" ? rec.title : "AI 改写建议",
        before: typeof rec.before === "string" ? rec.before : instruction.slice(0, 80),
        after: typeof rec.after === "string" ? rec.after : fallbackText.trim(),
        is_field: typeof rec.is_field === "boolean" ? rec.is_field : undefined,
        is_new: typeof rec.is_new === "boolean" ? rec.is_new : undefined,
        affect: typeof rec.affect === "string" ? rec.affect : "仅影响当前范围",
      };
    })
    .filter((p) => p.after && p.after.trim().length > 0);

  if (patches.length > 0) return patches;
  return [{
    id: `p_${randomUUID().slice(0, 6)}`,
    kind: "modify",
    path: `${scope?.kind ?? "script"}[${scope?.id ?? "current"}]`,
    title: "AI 改写建议",
    before: instruction.slice(0, 80),
    after: fallbackText.trim(),
    affect: "仅影响当前范围",
  }];
}

function pruneSuggestions() {
  const now = Date.now();
  for (const [k, v] of SUGGEST_STORE) {
    if (now - v.at > SUGGEST_TTL_MS) {
      SUGGEST_STORE.delete(k);
      deletePatch(k).catch(() => {});
    }
  }
}

function getScope(record: SuggestRecord): SuggestScope {
  // 2026-05-28 audit P1 type-safety — record.input 是 caller body, dynamic; 用 unknown narrowing
  const input = record.input as unknown as { scope?: unknown } | null | undefined;
  const scope = input?.scope;
  return scope && typeof scope === "object" ? scope as SuggestScope : {};
}

function getSelectedPatches(record: SuggestRecord, patchIds: unknown): SuggestRecord["patches"] {
  if (!Array.isArray(patchIds) || patchIds.length === 0) return record.patches;
  const ids = new Set(patchIds.filter((id): id is string => typeof id === "string"));
  return record.patches.filter((patch) => ids.has(patch.id));
}

function resolveAcceptedText(patches: SuggestRecord["patches"]): string | null {
  for (let i = patches.length - 1; i >= 0; i--) {
    const text = patches[i]?.after?.trim();
    if (text) return text;
  }
  return null;
}

function resolveShotPromptField(patches: SuggestRecord["patches"]): "prompt_img" | "prompt_vid" {
  const haystack = patches.map((patch) => `${patch.path} ${patch.title} ${patch.affect ?? ""}`).join(" ").toLowerCase();
  return /(prompt_vid|motion|video|动态|运镜|视频)/i.test(haystack) ? "prompt_vid" : "prompt_img";
}

async function applySuggestion(record: SuggestRecord, req: Request) {
  const patches = getSelectedPatches(record, req.body?.patch_ids);
  if (patches.length === 0) {
    throw Object.assign(new Error("没有匹配的 patch_ids"), { status: 400, code: "ValidationError" });
  }
  const after = resolveAcceptedText(patches);
  if (!after) {
    throw Object.assign(new Error("被接受的 patch 缺少 after 文本"), { status: 400, code: "ValidationError" });
  }

  const scope = getScope(record);
  if ((scope.kind === "prompt" || scope.kind === "shot") && scope.id) {
    const shot = await readShotById(scope.id);
    if (!shot) {
      throw Object.assign(new Error(`shot ${scope.id} 未找到`), { status: 404, code: "NotFound" });
    }
    const field = resolveShotPromptField(patches);
    const patch = field === "prompt_vid"
      ? { prompt_vid: after, prompt_vid_versions: appendPromptVersion(shot.prompt_vid_versions, after, "ai") }
      : { prompt_img: after, prompt_img_versions: appendPromptVersion(shot.prompt_img_versions, after, "ai") };
    const updated = await updateShotById(scope.id, patch);
    return {
      kind: "shot_prompt",
      id: scope.id,
      field,
      patch_count: patches.length,
      prompt: field === "prompt_vid" ? updated?.prompt_vid : updated?.prompt_img,
    };
  }

  if (scope.kind === "script" && scope.id) {
    const slug = typeof req.body?.slug === "string"
      ? req.body.slug
      : typeof req.body?.series_slug === "string"
        ? req.body.series_slug
        : "";
    const epId = typeof req.body?.episode_id === "string"
      ? req.body.episode_id
      : typeof req.body?.epId === "string"
        ? req.body.epId
        : scope.id;
    if (!slug) {
      throw Object.assign(new Error("接受 script 建议需要提供 slug/series_slug"), { status: 400, code: "ValidationError" });
    }
    const episode = await readEpisode(slug, epId);
    if (!episode) {
      throw Object.assign(new Error(`episode ${epId} 未找到`), { status: 404, code: "NotFound" });
    }
    const nextVersion = (episode.version || 1) + 1;
    const versionRecord: EpisodeVersion = {
      version: nextVersion,
      created_at: new Date().toISOString(),
      source: "ai_revise",
      summary: patches.map((patch) => patch.title).filter(Boolean).join("; ").slice(0, 100) || "AI 改写建议",
      script_md: after,
    };
    const versions = [...(episode.versions ?? []), versionRecord];
    await updateEpisode(slug, epId, { script_md: after, version: nextVersion, versions });
    await saveVersionFile(slug, epId, versionRecord).catch(() => undefined);
    return { kind: "script", slug, episode_id: epId, version: nextVersion, patch_count: patches.length };
  }

  throw Object.assign(new Error("当前 suggestion scope 暂不支持自动落库"), { status: 400, code: "UnsupportedScope" });
}

aiRouter.post("/ai/ask", async (req: Request, res: Response) => {
  const { context = "", question = "", llm_provider_id } = req.body ?? {};
  if (typeof question !== "string" || question.length === 0) {
    return res.status(400).json({ error: { code: "ValidationError", message: "question 必填" } });
  }
  try {
    const result = await callLlmText(req, {
      purpose: "ask",
      providerId: providerIdFromModelRef(llm_provider_id),
      system: "你是视频短剧创作助手。回答要具体、简洁、可执行；不要改写原文，除非用户明确要求。",
      prompt: `上下文:\n${String(context).slice(0, 12000)}\n\n问题:\n${question}`,
      maxTokens: 1200,
    });
    res.json({ ok: true, answer: result.text.trim(), cost_cny: costToCny(result.cost) });
  } catch (error) {
    res.status(503).json({
      error: {
        code: "LlmUnavailable",
        message: scrubForClient(error instanceof Error ? error.message : String(error)),
      },
    });
  }
});

aiRouter.post("/ai/suggest", async (req: Request, res: Response) => {
  const { context = "", instruction = "", scope: rawScope, llm_provider_id } = req.body ?? {};
  if (typeof instruction !== "string" || instruction.length === 0) {
    return res.status(400).json({ error: { code: "ValidationError", message: "instruction 必填" } });
  }
  // 2026-05-28 audit P1 type-safety — scope 来自 req.body, dynamic, narrow 成 SuggestScope-like
  const scope: { kind?: string; id?: string } | undefined =
    rawScope && typeof rawScope === "object" ? rawScope as { kind?: string; id?: string } : undefined;
  try {
    pruneSuggestions();
    const promptParts = buildAiSuggestPromptParts({ context, instruction, scope });
    const result = await callLlmText(req, {
      purpose: "suggest",
      providerId: providerIdFromModelRef(llm_provider_id),
      responseFormat: "json",
      maxTokens: 1600,
      system: promptParts.system,
      prompt: promptParts.prompt,
    });
    const sid = `sug_${randomUUID().slice(0, 8)}`;
    const patches = normalizePatches(parseJsonFromLlm(result.text), result.text, scope, instruction);
    const record: SuggestRecord = { suggestion_id: sid, at: Date.now(), input: { context, instruction, scope }, patches };
    SUGGEST_STORE.set(sid, record);
    persistPatch(record).catch(() => {}); // 异步写盘，不阻塞响应
    res.json({ ok: true, suggestion_id: sid, patches, cost_cny: costToCny(result.cost) });
  } catch (error) {
    res.status(503).json({
      error: {
        code: "LlmUnavailable",
        message: scrubForClient(error instanceof Error ? error.message : String(error)),
      },
    });
  }
});

aiRouter.post("/ai/suggest/:sid/accept", async (req: Request, res: Response) => {
  const sid = String(req.params.sid);
  const record = SUGGEST_STORE.get(sid);
  if (!record) return res.status(404).json({ error: { code: "NotFound", message: `suggestion ${sid} 未找到或已过期` } });
  try {
    const applied = await applySuggestion(record, req);
    SUGGEST_STORE.delete(sid);
    deletePatch(sid).catch(() => {}); // 异步删盘
    res.json({ ok: true, applied });
  } catch (error) {
    const err = error as Error & { status?: number; code?: string };
    res.status(err.status ?? 500).json({
      error: {
        code: err.code ?? "ApplySuggestionFailed",
        message: scrubForClient(err.message),
      },
    });
  }
});

aiRouter.post("/ai/suggest/:sid/reject", (req: Request, res: Response) => {
  // 2026-05-18 (铁律 #5 真实保存): reject 必须校验 suggestion 存在,
  // 历史: 不校验直接 delete + ok:true, 已被另一标签页清掉时前端显示"成功" 但实际没事做.
  const sid = String(req.params.sid);
  if (!SUGGEST_STORE.has(sid)) {
    res.status(404).json({
      error: {
        code: "SuggestionNotFound",
        message: "该 AI 建议已不存在(可能已被采纳/超时清理), 无需重复操作",
      },
    });
    return;
  }
  SUGGEST_STORE.delete(sid);
  deletePatch(sid).catch(() => {}); // 异步删盘
  res.json({ ok: true });
});

// /api/ai/script/:eid/ops endpoint 已删除:
// 前端未调用此路径, 返回 501 的孤儿注册无意义。
// 剧本保存走 PATCH /api/v2/series/:slug/episodes/:epId。
