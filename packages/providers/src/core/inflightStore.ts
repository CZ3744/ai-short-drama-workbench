import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";
import { repoRoot } from "../../../core/src/paths";

const INFLIGHT_DIR = path.join(repoRoot, "data", "inflight");
// X7-5: 归档目录 —— abandoned 记录搬到这里 (子目录). loadAllInflight/inflightCount 只扫顶层 .json,
// 天然跳过本子目录 → 启动 resume 循环不再重复尝试这些死账、不再刷 WARN, 但记录不删除, 保留审计。
const ABANDONED_DIR = path.join(INFLIGHT_DIR, "abandoned");
// X7-5 阈值: resume 连续失败 ≥3 次, 或 inflight 年龄 >7 天 → 归档 abandoned。
const MAX_RESUME_ATTEMPTS = 3;
const MAX_INFLIGHT_AGE_DAYS = 7;

export interface InflightRecord {
  inflight_id: string;
  provider_id: string;
  provider_job_id: string;
  submitted_at: string;
  poll_url?: string;
  context: {
    series_slug?: string;
    shot_id?: string;
    kind?: string;
    cost_estimate?: number;
    job_id?: string;
    /** S5: original request params for resumePoll */
    aspect_ratio?: string;
    duration_sec?: number;
    /**
     * 2026-07-22 X1-1: 提交时用的实际 model_id (req.model_id override 优先, 否则 preset 默认).
     * baidu qianfan 的任务状态查询端点 `?task_id=X&model=Y` 需要 model, resumePoll 要用提交时的原值,
     * 否则重启后 resume 用 preset 默认 model 查询可能对不上已提交任务 → 已扣费视频恢复失败.
     */
    model?: string;
    /**
     * 2026-05-28 audit P1-22: 持久化 instance_override 让 resumePoll 能用对的 api_key.
     * 之前 resumePoll 永远 fallback 用 cfg 的 env Key, 用户在 ChannelInstance 切了 Key 后
     * 服务重启 → resumePoll 仍用旧 Key → 401 → 用户花的钱白花.
     * 仅 Vidu 一个核心案例先接, 其他 video provider 后续逐个补.
     */
    instance_override?: {
      api_key?: string;
      secret_key?: string;
      api_base_url?: string;
      region?: string;
    };
  };
  /**
   * X7-5 (A7-3, 2026-07-22): 启动 resume 连续失败计数. 每次 resume 失败 +1,
   * 达到 MAX_RESUME_ATTEMPTS 即归档为 abandoned (见 handleInflightResumeFailure).
   */
  resume_attempts?: number;
  /** X7-5: 最近一次 resume 失败原因 (审计留痕, 不含密钥 —— 上游已 scrub). */
  last_resume_error?: string;
  /** X7-5: 归档为 abandoned 的时间 (仅出现在 abandoned/ 子目录的记录里). */
  abandoned_at?: string;
  /** X7-5: 归档原因 (连续失败 ≥N 次 / 年龄 >7 天). */
  abandoned_reason?: string;
}

async function ensureDir(): Promise<void> {
  if (!fs.existsSync(INFLIGHT_DIR)) {
    await fsp.mkdir(INFLIGHT_DIR, { recursive: true });
  }
}

function filePath(inflightId: string): string {
  return path.join(INFLIGHT_DIR, `${inflightId}.json`);
}

/**
 * S6: Persist an inflight task to disk atomically.
 * Writes to .tmp first, then renames to avoid corrupt files on crash.
 */
export async function saveInflight(record: Omit<InflightRecord, "inflight_id">): Promise<InflightRecord> {
  await ensureDir();
  const id = ulid();
  const full: InflightRecord = { inflight_id: id, ...record };
  const targetPath = filePath(id);
  const tmpPath = targetPath + ".tmp";
  await fsp.writeFile(tmpPath, JSON.stringify(full, null, 2), "utf8");
  await fsp.rename(tmpPath, targetPath);
  return full;
}

/**
 * Remove an inflight record. Called when polling reaches terminal state.
 */
export async function removeInflight(inflightId: string): Promise<void> {
  const p = filePath(inflightId);
  try {
    await fsp.unlink(p);
  } catch {
    // already removed
  }
}

/**
 * On startup: scan data/inflight/*.json and return all records.
 * D-N5 (2026-05-12): cap 加上 500 — 如果 inflight 累积几千个 (e.g. 程序连续崩溃没清),
 * 启动时全读会拖慢; 超过 cap 按 mtime 取最新的 500. 旧 inflight 由 startup 后台异步
 * cleanup, 不阻塞 boot.
 */
const MAX_INFLIGHT_LOAD = 500;
export async function loadAllInflight(): Promise<InflightRecord[]> {
  await ensureDir();
  const files = await fsp.readdir(INFLIGHT_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
  // 若超过 cap, 按文件 mtime 取最新的; 用 stat 而不是全读, 仅做时间排序
  let pick: string[];
  if (jsonFiles.length <= MAX_INFLIGHT_LOAD) {
    pick = jsonFiles;
  } else {
    const stats = await Promise.all(
      jsonFiles.map(async (f) => ({ f, mtime: await fsp.stat(path.join(INFLIGHT_DIR, f)).then((s) => s.mtimeMs).catch(() => 0) })),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    pick = stats.slice(0, MAX_INFLIGHT_LOAD).map((s) => s.f);
  }
  const records: InflightRecord[] = [];
  for (const f of pick) {
    try {
      const raw = await fsp.readFile(path.join(INFLIGHT_DIR, f), "utf8");
      records.push(JSON.parse(raw));
    } catch {
      // malformed file, skip
    }
  }
  return records;
}

/**
 * X7-5: 原子 patch 一条 inflight 记录 (read-modify-write, .tmp + rename).
 * 记录不存在/损坏则静默跳过 (可能已被并发移除).
 */
async function patchInflight(inflightId: string, patch: Partial<InflightRecord>): Promise<void> {
  const p = filePath(inflightId);
  try {
    const raw = await fsp.readFile(p, "utf8");
    const record = JSON.parse(raw) as InflightRecord;
    Object.assign(record, patch);
    const tmp = p + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await fsp.rename(tmp, p);
  } catch {
    // record gone or malformed — skip
  }
}

/**
 * X7-5: 归档一条 inflight 为 abandoned —— 搬到 abandoned/ 子目录 (不删除, 留审计),
 * 盖上 abandoned_at / abandoned_reason 时间戳. 之后 loadAllInflight 不再看到它。
 */
export async function archiveAbandonedInflight(inflightId: string, reason: string, lastError?: string): Promise<void> {
  const src = filePath(inflightId);
  await fsp.mkdir(ABANDONED_DIR, { recursive: true });
  const dest = path.join(ABANDONED_DIR, `${inflightId}.json`);
  try {
    const raw = await fsp.readFile(src, "utf8");
    const record = JSON.parse(raw) as InflightRecord;
    record.abandoned_at = new Date().toISOString();
    record.abandoned_reason = reason;
    if (lastError) record.last_resume_error = lastError.slice(0, 500);
    const tmp = dest + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await fsp.rename(tmp, dest);
    await fsp.unlink(src).catch(() => {});
  } catch {
    // 读/解析失败时退回裸 move, 尽量保留原始文件到 abandoned/ (仍不删除)
    try {
      await fsp.rename(src, dest);
    } catch {
      // src 已不存在 → 无需处理
    }
  }
}

function inflightAgeDays(record: InflightRecord): number {
  const t = Date.parse(record.submitted_at);
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

/**
 * X7-5: 记录一次 resume 失败并按策略决定去留。
 * - 失败计数 +1 达到 MAX_RESUME_ATTEMPTS(≥3) 或 年龄 >MAX_INFLIGHT_AGE_DAYS(7d) → 归档 abandoned
 * - 否则原子写回 resume_attempts + last_resume_error, 保留待下次启动重试 (resumePoll 只重下载不重提交, 不重复扣费)
 * 返回 outcome 供调用方决定日志级别 (retained=WARN 噪音, abandoned=INFO 归档), 不再无限刷 WARN。
 */
export async function handleInflightResumeFailure(
  record: InflightRecord,
  errorMsg: string,
): Promise<{ outcome: "retained" | "abandoned"; attempts: number; reason?: string }> {
  const attempts = (record.resume_attempts ?? 0) + 1;
  const age = inflightAgeDays(record);
  let abandonReason: string | undefined;
  if (attempts >= MAX_RESUME_ATTEMPTS) {
    abandonReason = `resume 连续失败 ${attempts} 次 (≥${MAX_RESUME_ATTEMPTS})`;
  } else if (age > MAX_INFLIGHT_AGE_DAYS) {
    abandonReason = `inflight 年龄 ${age.toFixed(1)}d > ${MAX_INFLIGHT_AGE_DAYS}d`;
  }
  if (abandonReason) {
    await archiveAbandonedInflight(record.inflight_id, abandonReason, errorMsg);
    return { outcome: "abandoned", attempts, reason: abandonReason };
  }
  await patchInflight(record.inflight_id, { resume_attempts: attempts, last_resume_error: errorMsg.slice(0, 500) });
  return { outcome: "retained", attempts };
}

/**
 * X7-5: 列出已归档 abandoned 记录 (诊断/审计用, 让"死账"可见而非静默).
 */
export async function listAbandonedInflight(): Promise<InflightRecord[]> {
  try {
    const files = await fsp.readdir(ABANDONED_DIR);
    const out: InflightRecord[] = [];
    for (const f of files) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      try {
        out.push(JSON.parse(await fsp.readFile(path.join(ABANDONED_DIR, f), "utf8")) as InflightRecord);
      } catch {
        // malformed — skip
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Convenience alias matching the spec naming convention */
export const add = saveInflight;

/** Convenience alias matching the spec naming convention */
export const remove = removeInflight;

/**
 * Get count of inflight tasks (for frontend display).
 */
export async function inflightCount(): Promise<number> {
  try {
    const files = await fsp.readdir(INFLIGHT_DIR);
    return files.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp")).length; // S6: skip .tmp
  } catch {
    return 0;
  }
}
