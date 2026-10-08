/**
 * v2 Settings Controller — GET/PATCH /settings with key masking
 */

import { Router } from "express";
import { handleValidationError } from "./validateHelpers";
import fsp from "node:fs/promises";
import path from "node:path";
import { getSecretStatus, readLocalSettings, writeLocalSettings } from "../../../../../packages/core/src/localSettings";
import { repoRoot } from "../../../../../packages/core/src/paths";
import { migrateToLatest } from "../../../../../packages/core/src/migrations";
import { validate, PatchSettingsSchema } from "./validators";
import { clearHealthCache } from "./providersHealthCache";
import { reloadRegistry } from "./orchestration/_shared/registry";

export const settingsRouter = Router();

// GET /settings
settingsRouter.get("/settings", async (_req, res, next) => {
  try {
    const raw = readLocalSettings();
    // Mask all key values — never return plaintext
    const masked: Record<string, any> = {};
    for (const [key, value] of Object.entries(raw)) {
      const lower = key.toLowerCase();
      if (lower.includes("key") || lower.includes("secret") || lower.includes("token")) {
        masked[key] = value ? { has_key: true } : { has_key: false };
      } else {
        masked[key] = value;
      }
    }
    // Add structured status
    const status = getSecretStatus();
    res.json({ settings: masked, provider_status: status });
  } catch (err) { next(err); }
});

// PATCH /settings
settingsRouter.patch("/settings", async (req, res, next) => {
  try {
    const v = validate(PatchSettingsSchema, req.body);
    if (handleValidationError(res, v)) return;

    const patch: Record<string, string | null> = {};

    if (v.data.max_parallel_tasks !== undefined) patch.MAX_PARALLEL_TASKS = String(v.data.max_parallel_tasks);
    if (v.data.max_retake_per_shot !== undefined) patch.MAX_RETAKE_PER_SHOT = String(v.data.max_retake_per_shot);
    if (v.data.max_video_seconds_per_job !== undefined) patch.MAX_VIDEO_SECONDS_PER_JOB = String(v.data.max_video_seconds_per_job);
    if (v.data.max_clip_seconds_per_shot !== undefined) patch.MAX_CLIP_SECONDS_PER_SHOT = String(v.data.max_clip_seconds_per_shot);
    if (v.data.default_template_id !== undefined) patch.DEFAULT_TEMPLATE_ID = v.data.default_template_id;

    // Budget limits
    if (v.data.budget_daily_cap_cny !== undefined) patch.BUDGET_DAILY_CAP_CNY = String(v.data.budget_daily_cap_cny);
    if (v.data.budget_single_job_cap_cny !== undefined) patch.BUDGET_SINGLE_JOB_CAP_CNY = String(v.data.budget_single_job_cap_cny);
    if (v.data.budget_per_provider_cap_cny !== undefined) patch.BUDGET_PER_PROVIDER_CAP_CNY = String(v.data.budget_per_provider_cap_cny);

    // Quick settings — user-facing defaults
    if (v.data.DEFAULT_TTS_VOICE !== undefined) patch.DEFAULT_TTS_VOICE = String(v.data.DEFAULT_TTS_VOICE);
    if (v.data.DEFAULT_ASPECT_RATIO !== undefined) patch.DEFAULT_ASPECT_RATIO = String(v.data.DEFAULT_ASPECT_RATIO);
    if (v.data.DEFAULT_LLM_PROVIDER_ID !== undefined) patch.DEFAULT_LLM_PROVIDER_ID = String(v.data.DEFAULT_LLM_PROVIDER_ID);
    if (v.data.BURN_SUBTITLES_DEFAULT !== undefined) patch.BURN_SUBTITLES_DEFAULT = String(v.data.BURN_SUBTITLES_DEFAULT);
    if (v.data.EXPORT_SRT_DEFAULT !== undefined) patch.EXPORT_SRT_DEFAULT = String(v.data.EXPORT_SRT_DEFAULT);
    if (v.data.REAL_VIDEO_ENABLED !== undefined) patch.REAL_VIDEO_ENABLED = String(v.data.REAL_VIDEO_ENABLED);
    // 2026-05-20 Wave T 留尾 — 一致性体检评分器(三级 cascade 起点)
    if (v.data.CONSISTENCY_SCORER_PROVIDER !== undefined) patch.CONSISTENCY_SCORER_PROVIDER = String(v.data.CONSISTENCY_SCORER_PROVIDER);

    // Provider keys
    let touchedProviderKeys = false;
    if (v.data.provider_keys) {
      for (const [provider, key] of Object.entries(v.data.provider_keys)) {
        const envKeyMap: Record<string, string> = {
          ikuncode: "IKUNCODE_API_KEY",
          mimo: "MIMO_API_KEY",
          mimo_singapore: "MIMO_SINGAPORE_API_KEY",
          minimax: "MINIMAX_API_KEY",
          video: "VIDEO_API_KEY",
          image: "IMAGE_API_KEY",
          aliyun_wan: "ALIYUN_DASHSCOPE_API_KEY",
          openai: "OPENAI_API_KEY",
        };
        const envKey = envKeyMap[provider];
        if (envKey) {
          patch[envKey] = typeof key === "string" && key.length > 0 ? key : null;
          touchedProviderKeys = true;
        }
      }
    }

    await writeLocalSettings(patch);
    if (touchedProviderKeys) {
      clearHealthCache();
      reloadRegistry();
    }

    // Return masked status (never return keys)
    const status = getSecretStatus();
    res.json({ ok: true, provider_status: status });
  } catch (err) { next(err); }
});

// GET /settings/budget — daily budget status
settingsRouter.get("/settings/budget", async (_req, res, next) => {
  try {
    const s = readLocalSettings();
    // 2026-07-09 audit 补漏(终验) — 显示端与执行端(budgetGuard.getLimits)统一, 否则用户把预算
    // 设成 0(想彻底停扣费)时执行端已冻结、显示端却仍 Number(x)||50 显示 50 → 状态不符(铁律#5).
    const { budgetGuard } = await import("../../../../../packages/providers/src/core/budgetGuard");
    const _limits = budgetGuard.getLimits();
    const dailyCap = _limits.dailyCapCNY;
    const singleJobCap = _limits.singleJobCapCNY;
    const perProviderCap = _limits.perProviderCapCNY;

    // Compute daily used from cost_ledger
    // TODO: BUG-17 全量读取 ledger 性能问题 — budgetGuard 应维护内存 dailyUsed 计数器,
    // 避免每次 budget 状态查询都读整个 JSONL 文件.
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const ledgerPath = path.join(repoRoot, "data", "cost_ledger", `${monthKey}.jsonl`);
    let dailyUsed = 0;
    try {
      // C5: 改用 async readFile（避免阻塞事件循环）
      let ledgerRaw: string | null = null;
      try { ledgerRaw = await fsp.readFile(ledgerPath, "utf8"); } catch { /* file may not exist */ }
      if (ledgerRaw !== null) {
        const lines = ledgerRaw.trim().split("\n");
        const today = now.toISOString().slice(0, 10);
        for (const line of lines) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            // E3: apply global schema version migration
            const migrated = migrateToLatest(entry);
            if (migrated.timestamp && String(migrated.timestamp).slice(0, 10) === today) {
              dailyUsed += Number(migrated.amount_cny) || 0;
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* ledger read error */ }

    // Inflight count
    let inflightCount = 0;
    try {
      const { inflightCount: getInflightCount } = await import("../../../../../packages/providers/src/core/inflightStore");
      inflightCount = await getInflightCount();
    } catch { /* inflight store not available */ }

    res.json({
      daily_cap_cny: dailyCap,
      single_job_cap_cny: singleJobCap,
      per_provider_cap_cny: perProviderCap,
      daily_used_cny: dailyUsed,
      inflight_count: inflightCount,
    });
  } catch (err) { next(err); }
});

// GET /settings/usage — P1-7 (2026-05-31): 用量仪表盘数据 (按天聚合 cost_ledger)
settingsRouter.get("/settings/usage", async (req, res, next) => {
  try {
    const period = (req.query.period as string) || "month"; // day | week | month
    const now = new Date();
    const entries: { date: string; amount_cny: number; provider: string; kind: string }[] = [];

    // 读最近 3 个月的 ledger 文件 (覆盖 day/week/month 查询范围)
    for (let m = 0; m < 3; m++) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const ledgerPath = path.join(repoRoot, "data", "cost_ledger", `${monthKey}.jsonl`);
      let ledgerRaw: string | null = null;
      try { ledgerRaw = await fsp.readFile(ledgerPath, "utf8"); } catch { /* file may not exist */ }
      if (ledgerRaw === null) continue;
      for (const line of ledgerRaw.trim().split("\n")) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const migrated = migrateToLatest(entry);
          const ts = String(migrated.timestamp || "");
          const date = ts.slice(0, 10);
          if (!date) continue;
          entries.push({
            date,
            amount_cny: Number(migrated.amount_cny) || 0,
            provider: String(migrated.provider || "unknown"),
            kind: String(migrated.kind || "unknown"),
          });
        } catch { /* skip malformed */ }
      }
    }

    // 按 period 过滤
    let cutoff: string;
    if (period === "day") {
      cutoff = now.toISOString().slice(0, 10);
    } else if (period === "week") {
      const weekAgo = new Date(now.getTime() - 7 * 86400000);
      cutoff = weekAgo.toISOString().slice(0, 10);
    } else {
      // month: 从本月 1 号开始
      cutoff = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    }
    const filtered = entries.filter((e) => e.date >= cutoff);

    // 按天聚合
    const byDay: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    let total = 0;
    for (const e of filtered) {
      byDay[e.date] = (byDay[e.date] || 0) + e.amount_cny;
      byProvider[e.provider] = (byProvider[e.provider] || 0) + e.amount_cny;
      total += e.amount_cny;
    }

    // 转成排序后的数组
    const dailyBreakdown = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, amount_cny]) => ({ date, amount_cny: Math.round(amount_cny * 100) / 100 }));

    const providerBreakdown = Object.entries(byProvider)
      .sort(([, a], [, b]) => b - a)
      .map(([provider, amount_cny]) => ({ provider, amount_cny: Math.round(amount_cny * 100) / 100 }));

    res.json({
      period,
      total_cny: Math.round(total * 100) / 100,
      daily: dailyBreakdown,
      by_provider: providerBreakdown,
    });
  } catch (err) { next(err); }
});

// ─── v24-batch-all · 模型默认选择 ───
// GET /settings/model-defaults — 返回 { defaults: { t2i, i2v, t2v } }
// PUT /settings/model-defaults — body: { defaults: {...} }
// 存储: local-settings.json 里 DEFAULT_MODELS 键 = JSON 字符串
// TODO(pm): 如需 per-series 默认需要扩展 schema

// 2026-05-18: JSON 损坏 silent reset 是数据丢失红线 — 改为 500 错误让前端知晓.
// 历史: catch { defaults = {}; } / catch { /* reset */ } 在 DEFAULT_MODELS 字段 JSON 损坏时
// 把已保存的模型选择全部"忘记", PUT 进一步把现有 setting 清空成仅本次写入的 key.
// 改: 显式 throw + 用 ConfigurationCorrupt code, 前端 toast 引导用户手动重置.
settingsRouter.get("/settings/model-defaults", async (_req, res, next) => {
  try {
    const raw = readLocalSettings();
    const serialized = raw.DEFAULT_MODELS ?? "";
    let defaults: Record<string, string> = {};
    if (serialized) {
      try {
        defaults = JSON.parse(serialized) as Record<string, string>;
      } catch (parseErr) {
        return res.status(500).json({
          error: {
            code: "ConfigurationCorrupt",
            message: "模型默认设置 JSON 已损坏 — 请在设置页清空后重新选择默认模型。原有的选择无法读取以避免误覆盖。",
            field: "DEFAULT_MODELS",
            cause: parseErr instanceof Error ? parseErr.message : String(parseErr),
          },
        });
      }
    }
    res.json({ defaults });
  } catch (err) { next(err); }
});

settingsRouter.put("/settings/model-defaults", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const incoming = body.defaults && typeof body.defaults === "object" ? body.defaults : null;
    if (!incoming) {
      return res.status(400).json({ error: { code: "ValidationError", message: "body.defaults 必须是对象" } });
    }
    const raw = readLocalSettings();
    let current: Record<string, string> = {};
    if (raw.DEFAULT_MODELS) {
      try {
        current = JSON.parse(raw.DEFAULT_MODELS);
      } catch (parseErr) {
        // 2026-05-18: 写入时同样不允许 silent 把现有 settings 清成 base={} (会丢历史 key).
        // 让用户先去 GET 端点拿到 ConfigurationCorrupt 错误并显式清理后再 PUT.
        return res.status(409).json({
          error: {
            code: "ConfigurationCorrupt",
            message: "当前模型默认设置 JSON 已损坏, 拒绝合并 — 请先在设置页清空 DEFAULT_MODELS 字段后再保存, 避免历史已保存模型被覆盖丢失。",
            field: "DEFAULT_MODELS",
            cause: parseErr instanceof Error ? parseErr.message : String(parseErr),
          },
        });
      }
    }
    const merged = { ...current, ...(incoming as Record<string, string>) };
    await writeLocalSettings({ DEFAULT_MODELS: JSON.stringify(merged) });
    res.json({ ok: true, defaults: merged });
  } catch (err) { next(err); }
});
