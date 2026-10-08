/**
 * v2 Diagnostics Controller — System health & environment info
 *
 * GET /api/v2/diagnostics
 * Returns environment info, provider key status, toolchain detection,
 * queue stats, inflight details, budget, disk usage, and recent errors.
 */

import { Request, Response, NextFunction } from "express";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
// execSync intentionally NOT imported — use timedSpawn / probeTool to avoid blocking the event loop
import { readRecentErrors } from "../../../../../packages/core/src/logger";
import { inflightCount, loadAllInflight } from "../../../../../packages/providers/src/core/inflightStore";
import { repoRoot, DATA_ROOT } from "../../../../../packages/core/src/paths";
import { resolveProvider } from "./providerController";
import { getConfigValue } from "../../../../../packages/core/src/localSettings";
import { killProcessTree } from "../../../../../packages/render/src/process";

// B16: key 优先读 local-settings.json (getConfigValue)，fallback env — 不回显 key 值本身
function keyStatus(envKey: string): "present" | "missing" {
  const fromConfig = getConfigValue(envKey);
  const fromEnv = process.env[envKey];
  return (fromConfig || fromEnv) ? "present" : "missing";
}

// A-9 (2026-05-12): 之前 4-5 个 execSync 串行最多 25s 阻塞 GET /diagnostics, 前端首屏卡死.
// 改用 spawn + Promise.all 并行, 单项 5s timeout, 整体最多 ~5s.
async function probeTool(command: string, args: string[]): Promise<{ found: boolean; version: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, shell: false });
    } catch {
      resolve({ found: false, version: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let resolved = false;
    const finish = (found: boolean, version: string) => {
      if (resolved) return;
      resolved = true;
      if (child!.pid !== undefined) void killProcessTree(child!.pid); // XT-T2: tree-kill
      resolve({ found, version });
    };
    const timer = setTimeout(() => finish(false, ""), 5000);
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", () => { clearTimeout(timer); finish(false, ""); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        // python --version 旧版输出到 stderr, 兼容.
        const out = (stdout || stderr).split("\n")[0].trim();
        finish(true, out);
      } else {
        finish(false, "");
      }
    });
  });
}

export async function getDiagnostics(_req: Request, res: Response, next: NextFunction) {
  try {
    // A-9: 并行 4 路工具探测.
    const [ffmpegResult, ffprobeResult, pythonResult, edgeTtsResult] = await Promise.all([
      probeTool("ffmpeg", ["-version"]),
      probeTool("ffprobe", ["-version"]),
      (async () => {
        const r1 = await probeTool("python", ["--version"]);
        if (r1.found) return r1;
        return probeTool("python3", ["--version"]);
      })(),
      probeTool("edge-tts", ["--version"]),
    ]);
    const ffmpegFound = ffmpegResult.found;
    const ffmpegVersion = ffmpegResult.version;
    const ffprobeFound = ffprobeResult.found;
    const ffprobeVersion = ffprobeResult.version;
    const pythonFound = pythonResult.found;
    const pythonVersion = pythonResult.version;
    const edgeTtsFound = edgeTtsResult.found;

    // P150-C4: Read recent errors from structured log (last 100 lines of jsonl)
    let recentErrors: Array<{ timestamp: string; level: string; message: string; requestId?: string }> = [];
    try {
      recentErrors = await readRecentErrors(100);
    } catch {
      // Non-fatal: log file may not exist yet
    }

    // Aggregate failure top 5 from recent errors (last 24h)
    let failureTop5: Array<{ reason: string; count: number; last_seen: string }> = [];
    try {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const reasonCount = new Map<string, { count: number; last: string }>();
      for (const e of recentErrors) {
        const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
        if (now - ts > dayMs) continue;
        const reason = e.message?.slice(0, 80) || "未知错误";
        const prev = reasonCount.get(reason);
        if (prev) {
          prev.count++;
          if (e.timestamp > prev.last) prev.last = e.timestamp;
        } else {
          reasonCount.set(reason, { count: 1, last: e.timestamp });
        }
      }
      failureTop5 = Array.from(reasonCount.entries())
        .map(([reason, v]) => ({ reason, count: v.count, last_seen: v.last }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
    } catch { /* non-fatal */ }

    // Inflight tasks
    let inflightTasks: Array<{
      provider_id: string;
      provider_job_id: string;
      submitted_at: string;
      shot_id?: string;
    }> = [];
    let remoteTasks = 0;
    try {
      const all = await loadAllInflight();
      remoteTasks = all.length;
      inflightTasks = all.map((r) => ({
        provider_id: r.provider_id,
        provider_job_id: r.provider_job_id,
        submitted_at: r.submitted_at,
        shot_id: r.context?.shot_id,
      }));
    } catch { /* non-fatal */ }

    // Queue stats (read from orchestrator if available)
    let queue = { queued: 0, running: 0, done: 0, failed: 0 };
    try {
      const { orchestrator } = await import("../../jobs/orchestrator");
      queue = orchestrator.queueStats();
    } catch { /* orchestrator not available */ }
    let attemptQueue = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, total: 0 };
    try {
      const { getPendingJobStats } = await import("../../jobs/pendingJobs");
      attemptQueue = getPendingJobStats();
    } catch { /* pending job queue not available */ }

    // Budget (same logic as settingsController)
    let budget = { daily_cap_cny: 50, daily_used_cny: 0 };
    try {
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const ledgerPath = path.join(repoRoot, "data", "cost_ledger", `${monthKey}.jsonl`);
      // C5: 改用 async readFile（避免阻塞事件循环）
      let ledgerRaw: string | null = null;
      try { ledgerRaw = await fsp.readFile(ledgerPath, "utf8"); } catch { /* file may not exist */ }
      if (ledgerRaw !== null) {
        const lines = ledgerRaw.trim().split("\n");
        const today = now.toISOString().slice(0, 10);
        let used = 0;
        for (const line of lines) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.timestamp && String(entry.timestamp).slice(0, 10) === today) {
              used += Number(entry.amount_cny) || 0;
            }
          } catch { /* skip malformed */ }
        }
        budget.daily_used_cny = Math.round(used * 100) / 100;
      }
      // Read cap from local settings
      try {
        // 2026-07-09 audit 补漏(终验) — 与执行端 budgetGuard.getLimits 统一(honor 显式 0, 不再 ||50).
        const { budgetGuard } = await import("../../../../../packages/providers/src/core/budgetGuard");
        budget.daily_cap_cny = budgetGuard.getLimits().dailyCapCNY;
      } catch {}
    } catch { /* non-fatal */ }

    // Disk usage of data/
    let dataDiskGb: number | null = null;
    try {
      dataDiskGb = await getDirSizeGb(DATA_ROOT);
    } catch {}

    const result = {
      environment: {
        node: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        uptime_seconds: Math.floor(process.uptime()),
        disk_free_gb: await getDiskFree(),
      },
      providers: {
        llm: [
          { id: "openai", key_present: keyStatus("OPENAI_API_KEY"), health: "unknown" as const },
          { id: "mimo", key_present: keyStatus("MIMO_API_KEY"), health: "unknown" as const },
        ],
        image: [
          { id: "jimeng", key_present: keyStatus("JIMENG_API_KEY"), health: "unknown" as const },
          { id: "gpt_image", key_present: keyStatus("OPENAI_API_KEY"), health: "unknown" as const },
          { id: "local_card", key_present: "present" as const, health: "ok" as const },
        ],
        video: [
          { id: "kling", key_present: keyStatus("KLING_API_KEY"), health: "unknown" as const },
          { id: "aliyun_wan", key_present: keyStatus("DASHSCOPE_API_KEY"), health: "unknown" as const },
          { id: "minimax", key_present: keyStatus("MINIMAX_API_KEY"), health: "unknown" as const },
          { id: "vidu", key_present: keyStatus("VIDU_API_KEY"), health: "unknown" as const },
          { id: "local_mock_video", key_present: "present" as const, health: "ok" as const },
        ],
        tts: [
          { id: "mimo_tts", key_present: keyStatus("MIMO_API_KEY"), health: "unknown" as const },
          { id: "edge_tts", key_present: "present" as const, health: "ok" as const },
        ],
      },
      tools: {
        ffmpeg: { found: ffmpegFound, version: ffmpegVersion || null },
        ffprobe: { found: ffprobeFound, version: ffprobeVersion || null },
        python: { found: pythonFound, version: pythonVersion || null },
        edge_tts: { found: edgeTtsFound },
      },
      queue: { ...queue, attempts: attemptQueue },
      budget,
      disk_usage: { data_gb: dataDiskGb },
      inflight: { remote_tasks: remoteTasks, tasks: inflightTasks },
      recent_errors: recentErrors,
      failure_top5: failureTop5,
    };

    res.json(result);
  } catch (err: unknown) {
    next(err);
  }
}

/**
 * getDiskFree — 异步获取 C 盘剩余空间 (GB).
 *
 * A-9 followup (2026-05-16): 原来用 execSync("wmic ...") 阻塞主线程最多 5s。
 * 现改为:
 *   1. 优先用 PowerShell Get-PSDrive C (wmic 在 Win11 已 deprecated 且可能慢)
 *   2. PowerShell 失败时 fallback 到 wmic (异步 spawn 3s timeout)
 *   3. 两者均失败 → 返回 null, 整段不阻塞事件循环
 */
async function getDiskFree(): Promise<number | null> {
  if (process.platform !== "win32") return null;
  try {
    // 优先：PowerShell Get-PSDrive C
    const psResult = await probeTool("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-PSDrive C).Free",
    ]);
    if (psResult.found) {
      const bytes = parseInt(psResult.version.trim(), 10);
      if (Number.isFinite(bytes) && bytes > 0) {
        return Math.round(bytes / 1e9 * 10) / 10;
      }
    }
    // Fallback：wmic (也用 probeTool 异步 spawn, 不用 execSync)
    const wmicResult = await probeTool("wmic", [
      "logicaldisk",
      "where",
      "DeviceID='C:'",
      "get",
      "FreeSpace",
    ]);
    if (wmicResult.found) {
      const match = wmicResult.version.match(/(\d+)/);
      if (match) return Math.round(parseInt(match[1], 10) / 1e9 * 10) / 10;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Provider Ping (T12) ──────────────────────────────────────────

const NO_KEY_PROVIDER_IDS = ["local_mock_video", "local_card_image", "edge_tts", "windows_sapi", "local_sdxl_openclaw", "local_animatediff_openclaw", "local_wan_openclaw", "chatgpt_codex_image"];

export async function pingProvider(req: Request, res: Response, next: NextFunction) {
  const id = String(req.params.id);
  const provider = resolveProvider(id);
  if (!provider) {
    res.status(404).json({ error: { code: "NotFound", message: `provider "${id}" 不存在` } });
    return;
  }

  const startMs = Date.now();
  let latencyMs = -1;
  let modelCount = 0;
  let ok = false;
  let error: string | null = null;

  try {
    const isKeyless = NO_KEY_PROVIDER_IDS.includes(id);
    const apiKey = provider.api_key ?? getConfigValue(`CUSTOM_PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_API_KEY`, "");
    if (!isKeyless && (!apiKey || apiKey.trim() === "")) {
      error = "API Key 未配置";
    } else {
      const baseUrl = provider.base_url?.replace(/\/$/, "") || "";
      // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
      // 删 AbortSignal.timeout(timeoutMs). provider.timeout_ms 不再读, 远端响应多久就等多久.

      if (provider.api_type === "anthropic") {
        const resp = await fetch(`${baseUrl}/v1/models`, {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": provider.anthropic_version || "2023-06-01",
          },
        });
        if (resp.ok) {
          const data = await resp.json() as Record<string, unknown>;
          modelCount = ((data.data as unknown[]) || []).length;
          latencyMs = Date.now() - startMs;
          ok = true;
        } else {
          error = `HTTP ${resp.status}`;
          latencyMs = Date.now() - startMs;
        }
      } else if (provider.api_type === "openai_compat") {
        const resp = await fetch(`${baseUrl}/models`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        });
        if (resp.ok) {
          const data2 = await resp.json() as Record<string, unknown>;
          modelCount = ((data2.data as unknown[]) || []).length;
          latencyMs = Date.now() - startMs;
          ok = true;
        } else {
          error = `HTTP ${resp.status}`;
          latencyMs = Date.now() - startMs;
        }
      } else if (baseUrl) {
        // custom — just HEAD / check reachable
        // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 setTimeout + abort 模式.
        try {
          await fetch(baseUrl, { method: "HEAD" });
          latencyMs = Date.now() - startMs;
          ok = true;
        } catch {
          // ignore
        }
      } else {
        // keyless local — always ok
        latencyMs = 0;
        ok = true;
      }
    }
  } catch (e: unknown) {
    error = (e instanceof Error ? e.message : null) || "连接超时";
    latencyMs = Date.now() - startMs;
  }

  res.json({
    provider_id: id,
    ok,
    latency_ms: latencyMs > 0 ? Math.round(latencyMs) : latencyMs,
    model_count: modelCount,
    error,
  });
}

/** Recursively compute total size of a directory in GB (capped at 15s) */
async function getDirSizeGb(dirPath: string): Promise<number | null> {
  try {
    await fsp.access(dirPath);
  } catch {
    return null;
  }
  try {
    let totalBytes = 0;
    const start = Date.now();
    async function walk(d: string): Promise<void> {
      if (Date.now() - start > 15000) return; // timeout 15s
      const entries = await fsp.readdir(d, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) {
          await walk(full);
        } else if (ent.isFile()) {
          try {
            const stat = await fsp.stat(full);
            totalBytes += stat.size;
          } catch {}
        }
      }
    }
    await walk(dirPath);
    return Math.round((totalBytes / 1e9) * 100) / 100;
  } catch {
    return null;
  }
}
