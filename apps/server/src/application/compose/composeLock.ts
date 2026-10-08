/**
 * P1-2 (2026-07-10 Fable 审查) — 每集一把内存互斥锁, 手动合成与一键管线共用.
 *
 * 背景: 合成是全链路里唯一"大规模写共享固定文件名"的一步 —
 *   compose/source.mp4 · source_tts.mp4 · source_mixed.mp4 · subtitles/final.srt ·
 *   final.mp4 · compose_manifest.json 全是每集固定路径。之前没有每集互斥:
 *     - 手动合成走 composeTaskQueue.enqueueComposeTask (setImmediate 起跑, 不查是否已有 running);
 *     - 一键管线的 compose 阶段 (stages/compose.ts) 绕过队列直接调 composeEpisode;
 *   两条路径互不知情, 同一集并发即两个 ffmpeg 交错写同一批文件 → 概率性坏 final.mp4 /
 *   字幕串轨, 且每镜 TTS 全部重合成一遍 (付费 TTS 双花)。
 *
 * 修复: 手动合成(含 rough / full / 单镜重合成 — 都走 enqueue)与管线合成共用这一把锁
 * (key = slug::episodeId)。第二个请求立即被拦:
 *     - enqueue 返 409 + 持有者信息(job_id / task_id / 已运行时长), 前端 toast + "取消当前合成";
 *     - 管线 compose 阶段拿不到锁 → 失败本阶段 + 写失败中心(不静默两个 ffmpeg 并发)。
 *
 * 生命周期: 内存级即可, 与 recoverComposeTasksOnStartup 同寿 — 进程重启锁自然清空, 僵尸
 * compose task 已由启动恢复翻 failed, 不必持久化。
 */

export interface ComposeLockHolder {
  /** 持有者 job_id (手动: compose_xxx; 管线: pipeline_compose_<pipeline_id>) */
  job_id: string;
  /** 手动合成的 compose task_id — 前端拿它调 POST /tasks/:id/abort 取消当前合成 */
  task_id?: string;
  /** 一键管线持有时的 pipeline_id (管线经此 id 取消, 不走 compose task) */
  pipeline_id?: string;
  /** 触发来源 */
  source: "manual" | "pipeline";
  /** 合成模式 (full / rough) */
  mode?: string;
  /** 获得锁的时刻 ISO — 用于给用户算"已运行 N 秒" */
  started_at: string;
}

const _episodeComposeLocks = new Map<string, ComposeLockHolder>();

export function episodeComposeLockKey(slug: string, episodeId: string): string {
  return `${slug}::${episodeId}`;
}

/**
 * 尝试获取锁。已被占用返 false(不覆盖持有者)。check 与 set 之间无 await, 对 Node 事件循环
 * 原子 — 两个并发 enqueue 只会有一个拿到, 另一个必得 false。
 */
export function tryAcquireEpisodeComposeLock(key: string, holder: ComposeLockHolder): boolean {
  if (_episodeComposeLocks.has(key)) return false;
  _episodeComposeLocks.set(key, holder);
  return true;
}

/**
 * 释放锁。传 expectedJobId 时只在持有者匹配才释放 — 防御性地避免 A 的 finally 误删 B 刚拿到的
 * 锁(正常不会发生: 拿不到锁的一方根本跑不到 release, 但抽成通用工具后保留此护栏)。
 */
export function releaseEpisodeComposeLock(key: string, expectedJobId?: string): void {
  const cur = _episodeComposeLocks.get(key);
  if (!cur) return;
  if (expectedJobId && cur.job_id !== expectedJobId) return;
  _episodeComposeLocks.delete(key);
}

export function getEpisodeComposeLockHolder(key: string): ComposeLockHolder | undefined {
  return _episodeComposeLocks.get(key);
}

/**
 * 给用户看的"本集正在合成中(已运行 N 秒)"人话 — 只描述状态, 不泄漏技术 id
 * (job_id / task_id / pipeline_id 只放 409 的 details 结构里供前端接线, 不进句子)。
 */
export function composeLockBusyMessage(holder: ComposeLockHolder): string {
  const elapsedSec = Math.max(0, Math.round((Date.now() - Date.parse(holder.started_at)) / 1000));
  const elapsed = elapsedSec >= 60
    ? `${Math.floor(elapsedSec / 60)} 分 ${elapsedSec % 60} 秒`
    : `${elapsedSec} 秒`;
  if (holder.source === "pipeline") {
    return `本集的一键管线正在合成（已运行 ${elapsed}），请等它完成，或到一键管线面板取消后再试。`;
  }
  return `本集正在合成中（已运行 ${elapsed}），请等它完成，或先取消当前合成后再试。`;
}
