/**
 * Real Video Lock — 真实视频生成并发锁
 * v0.2.4 hardening: token verification on release.
 * 2026-05-13 hardening: no-token release now warns + no-ops (was lenient).
 * 2026-05-17 hardening:
 *   - REAL_VIDEO_PROVIDERS 补全到 9 个真实视频 provider id (含新增智谱/百度/腾讯).
 *   - LockHolder 状态持久化到 data/real_video_lock.json (原子 rename), 进程重启不丢锁.
 *   - 启动恢复: 通过 initRealVideoLock() 校对 inflight 队列, 残留死锁自动清理.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./paths";
import { popNext } from "./db/taskQueue";

/**
 * 真实视频 provider 注册表 (扣费 / 需要并发锁).
 * id 必须与 config/presets/video_provider.json 中的注册 id 完全一致.
 *
 * 当前真实 provider (2026-05-17 与 config/presets/video_provider.json 同步):
 *   - minimax_hailuo        (MiniMax 海螺)
 *   - aliyun_wan_t2v        (阿里通义万相 文生视频)
 *   - jimeng_video_3pro     (字节即梦 3.0 Pro)
 *   - jimeng_video_3_720p   (字节即梦 3.0 720P — 低清子档, env_key_name=JIMENG_API_KEY,
 *                             enabled_without_key=false → 与其他真实 provider 相同策略)
 *   - kling_3               (可灵 i2v)
 *   - vidu_q3_ref           (Vidu 参考图生视频)
 *   - zhipu_cogvideox       (智谱 CogVideoX 文生视频)
 *   - baidu_qianfan_video   (百度千帆视频)
 *   - tencent_hunyuan_video (腾讯混元生视频)
 */
const REAL_VIDEO_PROVIDERS = new Set([
  "minimax_hailuo",
  "aliyun_wan_t2v",
  "jimeng_video_3pro",
  "jimeng_video_3_720p",
  "kling_3",
  "vidu_q3_ref",
  "zhipu_cogvideox",
  "baidu_qianfan_video",
  "tencent_hunyuan_video",
]);
const MOCK_TOKEN = "mock_no_lock_needed";

interface LockHolder {
  provider: string;
  jobId: string;
  sceneId: string;
  startedAt: string;
  token: string;
}

let _lockHolder: LockHolder | null = null;

// ── Persistence ─────────────────────────────────────────────────────
const LOCK_FILE = path.join(DATA_ROOT, "real_video_lock.json");

function persistLockState(): void {
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    if (_lockHolder === null) {
      // 锁释放 → 删除文件
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          console.warn("[realVideoLock] unlink lock file failed:", err?.message ?? err);
        }
      }
      return;
    }
    const tmp = LOCK_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(_lockHolder, null, 2), "utf8");
    fs.renameSync(tmp, LOCK_FILE);
  } catch (err) {
    console.warn(
      "[realVideoLock] persist lock state failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function readPersistedLock(): LockHolder | null {
  try {
    if (!fs.existsSync(LOCK_FILE)) return null;
    const raw = fs.readFileSync(LOCK_FILE, "utf8");
    const parsed = JSON.parse(raw) as LockHolder;
    // 基本字段校验
    if (
      parsed &&
      typeof parsed.provider === "string" &&
      typeof parsed.jobId === "string" &&
      typeof parsed.sceneId === "string" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.token === "string"
    ) {
      return parsed;
    }
    return null;
  } catch (err) {
    console.warn(
      "[realVideoLock] read persisted lock failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * 启动时调用. 读 data/real_video_lock.json, 用 inflight 队列校对:
 *   - 文件不存在 → 不做事
 *   - jobId 还在 inflight (loadAllInflight 任一记录 context.job_id 命中) → 恢复 _lockHolder
 *   - 不在 inflight (说明对应任务已完成或被清理) → 删除 lock 文件, 不恢复
 *
 * 注意: 这里用动态 import 避开 core ← providers 的反向依赖.
 *       loadAllInflight 来自 packages/providers/src/core/inflightStore.ts.
 */
export async function initRealVideoLock(): Promise<{
  restored: boolean;
  removedStale: boolean;
  holder: LockHolder | null;
}> {
  const persisted = readPersistedLock();
  if (!persisted) {
    return { restored: false, removedStale: false, holder: null };
  }

  // V-31: 锁超过 4 小时自动释放 — 防止异常退出后锁永久卡死
  const lockAgeMs = Date.now() - Date.parse(persisted.startedAt);
  if (Number.isFinite(lockAgeMs) && lockAgeMs > 4 * 60 * 60 * 1000) {
    console.warn(
      `[realVideoLock] lock aged ${Math.round(lockAgeMs / 3600000)}h, auto-releasing — job=${persisted.jobId} provider=${persisted.provider}`,
    );
    _lockHolder = null;
    persistLockState();
    return { restored: false, removedStale: true, holder: null };
  }

  let stillInflight = false;
  try {
    // 动态 import 避免 core 反向依赖 providers
    const mod = await import("../../providers/src/core/inflightStore");
    const records = await mod.loadAllInflight();
    stillInflight = records.some((r) => r.context?.job_id === persisted.jobId);
  } catch (err) {
    // inflight 读不出来时, 保守做法: 保留锁让用户手动 forceRelease, 不静默释放
    console.warn(
      "[realVideoLock] inflight check failed, keeping lock conservatively:",
      err instanceof Error ? err.message : String(err),
    );
    _lockHolder = persisted;
    return { restored: true, removedStale: false, holder: _lockHolder };
  }

  if (stillInflight) {
    _lockHolder = persisted;
    return { restored: true, removedStale: false, holder: _lockHolder };
  }

  // 不在 inflight → 对应 job 已完成或被清理, 锁是悬挂的, 删掉
  _lockHolder = null;
  persistLockState();
  return { restored: false, removedStale: true, holder: null };
}

export function isRealVideoProvider(provider: string): boolean {
  return REAL_VIDEO_PROVIDERS.has(provider);
}

export function isRealVideoLocked(): boolean {
  return _lockHolder !== null;
}

export function getRealVideoLockHolder(): LockHolder | null {
  return _lockHolder;
}

// BUG-50: Promise-chain mutex 防止 check-then-act 竞态条件
let _lockMutex: Promise<void> = Promise.resolve();

export function acquireRealVideoLock(params: {
  provider: string;
  jobId: string;
  sceneId: string;
}): Promise<{ token: string } | null> {
  if (!isRealVideoProvider(params.provider)) {
    return Promise.resolve({ token: MOCK_TOKEN });
  }
  const prev = _lockMutex;
  let release!: () => void;
  _lockMutex = new Promise<void>(r => { release = r; });
  return prev.then(() => {
    try {
      if (_lockHolder) return null;
      const token = `real_lock_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      _lockHolder = {
        provider: params.provider,
        jobId: params.jobId,
        sceneId: params.sceneId,
        startedAt: new Date().toISOString(),
        token
      };
      persistLockState();
      return { token };
    } finally {
      release();
    }
  });
}

/**
 * FIX 2026-05-13: no-token release now warns + no-ops (previously released any
 * current lock — defeated token verification).
 */
export function releaseRealVideoLock(token?: string): boolean {
  if (token === MOCK_TOKEN) return true;
  if (!_lockHolder) return false;
  if (!token) {
    console.warn(`[realVideoLock] release called without token; refusing to release lock held by ${_lockHolder.provider} (job=${_lockHolder.jobId}, scene=${_lockHolder.sceneId}). Use forceReleaseRealVideoLock() for emergency recovery.`);
    return false;
  }
  // 2026-05-28 audit P1-21: 之前错 token silent return — caller 以为锁释放成功了, 实际还被
  // 别的 job 占着, 后续 acquire 会 conflict 但 caller 不知道为啥. 现在 warn + 返 false 让
  // caller (orchestrator.ts:2084/2089) 能日志记录"我以为我释放了, 其实没有".
  if (token !== _lockHolder.token) {
    console.warn(`[realVideoLock] release token mismatch; expected token for ${_lockHolder.provider} (job=${_lockHolder.jobId}, scene=${_lockHolder.sceneId}) but got different token. Lock not released.`);
    return false;
  }
  _lockHolder = null;
  persistLockState();
  try {
    popNext();
  } catch (error) {
    console.warn("[realVideoLock] popNext after release failed:", error instanceof Error ? error.message : String(error));
  }
  return true;
}

export function forceReleaseRealVideoLock(): void {
  _lockHolder = null;
  persistLockState();
}

export function getRealVideoLockStatus(): {
  locked: boolean;
  holder: LockHolder | null;
  age_ms?: number;
} {
  if (_lockHolder) {
    const age = Date.now() - Date.parse(_lockHolder.startedAt);
    return { locked: true, holder: _lockHolder, age_ms: Number.isFinite(age) ? age : undefined };
  }
  return { locked: false, holder: null };
}
