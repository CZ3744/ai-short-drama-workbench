/**
 * backupStatus.ts — 最近一次备份结果的共享持有者, 由 GET /healthz 的 last_backup 暴露。
 *
 * 2026-07-22 U-fix1: 之前这份状态是 index.ts 里的私有 let, 只有"启动/每日 cron"两条路径写它;
 * 手动 POST /api/backup/create 成功后不更新 → healthz 与磁盘实际脱节 (EVIDENCE-api 项 6 尾注)。
 * 抽到这个零依赖模块, 让 index.ts (启动/cron/healthz) 与 routes.ts (手动备份) 同写一处, 状态不再打架。
 */

export interface BackupStatus {
  /** true=成功 / false=失败 / null=本进程还没跑过任何备份 */
  ok: boolean | null;
  /** 最近一次记录时间 (ISO) */
  at: string | null;
  /** 最近一次成功产出的备份文件名; null=本次未新建 (今日已有非空备份) 或失败 */
  filename: string | null;
  /** 失败时的人话错误 (已过 scrubForClient) */
  error: string | null;
}

let lastBackupStatus: BackupStatus = {
  ok: null,
  at: null,
  filename: null,
  error: null,
};

export function getLastBackupStatus(): BackupStatus {
  return lastBackupStatus;
}

export function setLastBackupStatus(next: BackupStatus): void {
  lastBackupStatus = next;
}
