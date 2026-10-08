/**
 * v2 Failure Controller — Failure center scanning & classification
 *
 * GET  /api/v2/failures?since=24h       扫描并分类失败
 * PATCH /api/v2/failures/:id/ignore      标记忽略（持久化到 data/failure_ignored.jsonl）
 */

import { Request, Response, NextFunction } from "express";
import fsp from "node:fs/promises";
import path from "node:path";
import { type ScannedFailure } from "../../repositories/failureRepo";
import { listFailures } from "../../repositories/failureRepo";
import { repoRoot } from "../../../../../packages/core/src/paths";

/** Categories matching C5 spec + ProviderError codes */
const CATEGORY_RULES: Array<{ category: string; label: string; match: (f: ScannedFailure) => boolean }> = [
  {
    category: "missing_key",
    label: "缺 key",
    match: (f) =>
      f.error_code === "missing_key" ||
      /missing.key|no.api.key|unauthorized|401|403|key.*missing|api.key.*not|未配置/.test(f.error_message || ""),
  },
  {
    category: "insufficient_balance",
    label: "余额不足",
    match: (f) =>
      f.error_code === "insufficient_balance" ||
      /insufficient.balance|余额不足|quota.exceeded|billing|402/.test(f.error_message || ""),
  },
  {
    category: "provider_timeout",
    label: "provider timeout",
    match: (f) =>
      f.error_code === "timeout" ||
      /timeout|超时|timed.out|ETIMEDOUT|ESOCKETTIMEDOUT/.test(f.error_message || ""),
  },
  {
    category: "content_filter",
    label: "审核拦截",
    match: (f) =>
      f.error_code === "content_filter" ||
      /content.filter|审核|reject|blocked|safety|moderation|inappropriate/.test(f.error_message || ""),
  },
  {
    category: "download_failed",
    label: "下载失败",
    match: (f) =>
      /download.*fail|下载失败|fetch.fail|ECONNREFUSED|ENOTFOUND/.test(f.error_message || ""),
  },
  {
    category: "invalid_mp4",
    label: "invalid mp4",
    match: (f) =>
      f.error_code === "invalid_output" &&
      /mp4|video.*invalid|invalid.*video|corrupt/i.test(f.error_message || ""),
  },
  {
    category: "ratio_mismatch",
    label: "ratio mismatch",
    match: (f) =>
      /ratio.*mismatch|aspect.*ratio|宽高比|aspect ratio.*differ|width.*height.*mismatch/i.test(f.error_message || ""),
  },
  {
    category: "ffprobe_failed",
    label: "ffprobe failed",
    match: (f) =>
      /ffprobe.*fail|ffprobe.*error|probe.*fail|cannot.probe/i.test(f.error_message || ""),
  },
  {
    category: "quality_too_low",
    label: "quality too low",
    match: (f) =>
      /quality.*(too.low|below|threshold)|low.quality|score.*below|overall.*<|quality_check/i.test(f.error_message || ""),
  },
  {
    category: "ref_not_supported",
    label: "ref not supported",
    match: (f) =>
      /ref.*not.*support|reference.*not.*support|不支持.*参考|reference image/i.test(f.error_message || ""),
  },
  {
    category: "budget_exceeded",
    label: "budget exceeded",
    match: (f) =>
      f.error_code === "budget_exceeded" ||
      /budget.*exceed|预算.*超|cost.*exceed|budget.cap/i.test(f.error_message || ""),
  },
];

const UNCATEGORIZED = { category: "other", label: "其他错误" };

function classifyFailure(f: ScannedFailure): string {
  for (const rule of CATEGORY_RULES) {
    if (rule.match(f)) return rule.category;
  }
  return UNCATEGORIZED.category;
}

function categoryLabel(cat: string): string {
  const found = CATEGORY_RULES.find((r) => r.category === cat);
  return found ? found.label : UNCATEGORIZED.label;
}

/** Sanitize error message: remove API keys, tokens, URLs with credentials */
function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, "Bearer ***")
    .replace(/api[_-]?key[=:]\s*[A-Za-z0-9\-._~+/=]+/gi, "api_key=***")
    .replace(/sk-[A-Za-z0-9\-]+/g, "sk-***")
    .replace(/token[=:]\s*[A-Za-z0-9\-._~+/=]+/gi, "token=***")
    .replace(/https?:\/\/[^@\s]+@/g, "https://***@");
}

/** Build a short request summary from generation/task data */
function buildRequestSummary(f: ScannedFailure): string {
  const parts: string[] = [];
  if (f.provider) parts.push(`provider: ${f.provider}`);
  if (f.kind) parts.push(`type: ${f.kind}`);
  if (f.prompt_final) {
    const truncated = f.prompt_final.length > 120 ? f.prompt_final.slice(0, 120) + "..." : f.prompt_final;
    parts.push(`prompt: "${truncated}"`);
  } else if (f.prompt_snippet) {
    parts.push(`prompt: "${f.prompt_snippet}"`);
  }
  if (f.series_slug) parts.push(`series: ${f.series_slug}`);
  if (f.shot_id) parts.push(`shot: ${f.shot_id}`);
  if (f.cost_cny != null) parts.push(`cost: ¥${f.cost_cny.toFixed(2)}`);
  if (f.created_at) parts.push(`time: ${f.created_at}`);
  return parts.join(" | ") || "(无摘要)";
}

const IGNORED_PATH = path.join(repoRoot, "data", "failure_ignored.jsonl");

/** 读取持久化的忽略记录，返回 Set<failure_id> */
async function loadIgnoredIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const content = await fsp.readFile(IGNORED_PATH, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { id?: string };
        if (record.id) ids.add(record.id);
      } catch { /* skip malformed */ }
    }
  } catch {
    // 文件不存在视为空
  }
  return ids;
}

export async function getFailures(req: Request, res: Response, next: NextFunction) {
  try {
    const sinceParam = (req.query.since as string) || "24h";
    const sinceMs = parseSinceToMs(sinceParam);
    const cutoff = new Date(Date.now() - sinceMs).toISOString();

    // T6: use listFailures (reads from jsonl index, falls back to dir scan)
    const allFailuresRaw = await listFailures();

    // Load persistent ignored IDs
    const ignoredIds = await loadIgnoredIds();

    // Merge & filter by cutoff
    const allFailures = allFailuresRaw.filter(
      (f) => f.created_at && f.created_at >= cutoff,
    );

    // Classify
    const classified = allFailures.map((f) => {
      const cat = classifyFailure(f);
      const sanitizedError = f.error_message ? sanitizeErrorMessage(f.error_message) : "";
      const sanitizedRawError = f.raw_error ? sanitizeErrorMessage(f.raw_error) : sanitizedError;
      const isIgnored = ignoredIds.has(f.id) || f.ignored === true;
      return {
        id: f.id,
        category: cat,
        category_label: categoryLabel(cat),
        source: f.source, // "generation" | "task"
        kind: f.kind,
        provider: f.provider,
        series_slug: f.series_slug,
        series_title: f.series_title,
        episode_id: f.episode_id,
        shot_id: f.shot_id,
        task_id: f.task_id,
        generation_id: f.generation_id,
        job_id: f.job_id,
        error_code: f.error_code,
        error_message: sanitizedError,
        raw_error_sanitized: sanitizedRawError,
        request_summary: buildRequestSummary(f),
        prompt_final: f.prompt_final || f.prompt_snippet || null,
        prompt_snippet: f.prompt_snippet || null,
        cost_cny: f.cost_cny ?? null,
        created_at: f.created_at,
        ignored: isIgnored,
        retry_count: f.retry_count ?? 0,
      };
    });

    // Sort by created_at descending
    classified.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

    // Group by category for display
    const grouped: Record<string, typeof classified> = {};
    for (const item of classified) {
      const cat = item.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(item);
    }

    const summary = CATEGORY_RULES.map((rule) => ({
      category: rule.category,
      label: rule.label,
      count: (grouped[rule.category] || []).length,
    })).filter((s) => s.count > 0);
    // Add "other" if present
    if (grouped.other && grouped.other.length > 0) {
      summary.push({ category: "other", label: UNCATEGORIZED.label, count: grouped.other.length });
    }

    res.json({
      ok: true,
      total: classified.length,
      since: sinceParam,
      cutoff,
      summary,
      grouped,
      failures: classified,
    });
  } catch (err: unknown) {
    next(err);
  }
}

function parseSinceToMs(since: string): number {
  const match = since.match(/^(\d+)(h|d|m)$/);
  if (!match) return 24 * 60 * 60 * 1000; // default 24h
  const val = parseInt(match[1]);
  switch (match[2]) {
    case "m": return val * 60 * 1000;
    case "h": return val * 3600 * 1000;
    case "d": return val * 86400 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

/** PATCH /api/v2/failures/:id/ignore — 标记失败为已忽略（持久化） */
export async function ignoreFailure(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id;
    if (!id || typeof id !== "string" || id.length > 256) {
      res.status(400).json({ error: { code: "InvalidFailureId", message: "invalid failure id" } });
      return;
    }

    // 防御: 确保 data 目录存在
    const dataDir = path.dirname(IGNORED_PATH);
    await fsp.mkdir(dataDir, { recursive: true });

    const record = JSON.stringify({ id, ignored_at: new Date().toISOString() }) + "\n";
    await fsp.appendFile(IGNORED_PATH, record, "utf8");

    res.json({ ok: true, id, ignored_at: new Date().toISOString() });
  } catch (err: unknown) {
    next(err);
  }
}
