import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readLocalSettings, writeLocalSettings, getConfigValue } from "../../../core/src/localSettings";
import { BudgetExceededError } from "./errors";
import { DATA_ROOT } from "../../../core/src/paths";

export interface BudgetLimits {
  dailyCapCNY: number;
  singleJobCapCNY: number;
  perProviderCapCNY: number;
}

interface ChargeRecord {
  amount: number;         // always CNY (converted at record time)
  currency?: "CNY" | "USD"; // original currency before conversion, default CNY
  providerId?: string;
  jobId?: string;
  timestamp: number;
}

const DEFAULT_LIMITS: BudgetLimits = {
  dailyCapCNY: 50,
  singleJobCapCNY: 20,
  perProviderCapCNY: 30,
};

const APPROACHING_RATIO = 0.8;

/** T3: read USD_CNY_RATE from config, default 7.2 */
function getUSDCNYRate(): number {
  const raw = getConfigValue("USD_CNY_RATE", "7.2");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 7.2;
}

/** T3: convert an amount to CNY. If already CNY, return as-is. */
function toCNY(amount: number, currency: "CNY" | "USD"): number {
  if (currency === "USD") return amount * getUSDCNYRate();
  return amount;
}

/** S2: budget charges persisted to data/budget_charges.jsonl (append-only) */
const BUDGET_FILE = path.join(DATA_ROOT, "budget_charges.jsonl");

export class BudgetGuard {
  private charges: ChargeRecord[] = [];
  private listeners: Array<(event: BudgetEvent) => void> = [];
  private _lastPruneHour = 0;
  private _loaded = false;
  private _pendingWrite: Promise<void> | null = null;

  getLimits(): BudgetLimits {
    const s = readLocalSettings();
    // 2026-07-09 audit 修复 — `Number(x) || DEFAULT` 会把用户显式设的 0 (想彻底停扣费) 静默改回默认.
    // 区分"未设置(空)→默认" 与 "显式 0 → 就是 0". 负/NaN 视为非法, 回落默认.
    const parseCap = (v: unknown, dflt: number): number => {
      if (v === undefined || v === null || String(v).trim() === "") return dflt;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : dflt;
    };
    return {
      dailyCapCNY: parseCap(s.BUDGET_DAILY_CAP_CNY, DEFAULT_LIMITS.dailyCapCNY),
      singleJobCapCNY: parseCap(s.BUDGET_SINGLE_JOB_CAP_CNY, DEFAULT_LIMITS.singleJobCapCNY),
      perProviderCapCNY: parseCap(s.BUDGET_PER_PROVIDER_CAP_CNY, DEFAULT_LIMITS.perProviderCapCNY),
    };
  }

  async saveLimits(limits: Partial<BudgetLimits>): Promise<void> {
    const patch: Record<string, string | null> = {};
    if (limits.dailyCapCNY !== undefined) patch.BUDGET_DAILY_CAP_CNY = String(limits.dailyCapCNY);
    if (limits.singleJobCapCNY !== undefined) patch.BUDGET_SINGLE_JOB_CAP_CNY = String(limits.singleJobCapCNY);
    if (limits.perProviderCapCNY !== undefined) patch.BUDGET_PER_PROVIDER_CAP_CNY = String(limits.perProviderCapCNY);
    await writeLocalSettings(patch);
  }

  onEvent(listener: (event: BudgetEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: BudgetEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* swallow */ }
    }
  }

  // ─── S2: Persistence ─────────────────────────────────────────────────

  /**
   * S2: 启动时从 data/budget_charges.jsonl 加载 24h 内的 charges。
   * 调用后方可正确计算 getDailyUsed()。
   */
  /** S2: 等待所有待写入操作完成 */
  async flush(): Promise<void> {
    if (this._pendingWrite) await this._pendingWrite;
  }

  /** S2: 清空内存记录（用于测试重启模拟） */
  reset(): void {
    this.charges = [];
    this._loaded = false;
    this._pendingWrite = null;
  }

  async loadCharges(force = false): Promise<void> {
    if (this._loaded && !force) return;
    // 2026-05-27 audit P0-04: 之前整段 try/catch silent return, 用户已花 ¥40 / 上限 ¥50,
    // 启动失败用 0 当起点, 放行下一个 ¥30 任务 → 实际超 ¥30 预算. 现在 throw, 让 server
    // eager init 阶段 fail-fast (用户启动看到错误总比 silent 超预算好).
    try {
      const dir = path.dirname(BUDGET_FILE);
      if (!fs.existsSync(dir)) await fsp.mkdir(dir, { recursive: true });
      if (!fs.existsSync(BUDGET_FILE)) {
        this._loaded = true;
        return;
      }
      const raw = await fsp.readFile(BUDGET_FILE, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      let malformedCount = 0;
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as ChargeRecord;
          if (now - record.timestamp < oneDayMs) {
            this.charges.push(record);
          }
        } catch {
          malformedCount++;
        }
      }
      if (malformedCount > 0) {
        console.warn(`[budgetGuard] 跳过 ${malformedCount} 条损坏的 charge 记录 (jsonl 文件 ${BUDGET_FILE})`);
      }
      this._loaded = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[budgetGuard] 预算账本加载失败, 拒绝启动 (silent 0 起点会导致超预算): ${msg}`);
    }
  }

  /**
   * S2: 异步追加一条 charge 到 jsonl 文件，失败只 warn 不 throw。
   */
  private _appendChargeFile(record: ChargeRecord): void {
    const line = JSON.stringify(record) + "\n";
    // M4: chain writes to prevent lost concurrent updates
    this._pendingWrite = (this._pendingWrite || Promise.resolve()).then(() =>
      fsp.appendFile(BUDGET_FILE, line, "utf8").catch(err => {
        console.warn("[BudgetGuard] failed to persist charge:", err.message);
      })
    ).then(() => { this._pendingWrite = null; });
  }

  /**
   * S2: 重写整个 jsonl 文件（prune 时调用）。
   * B9: 改用 .tmp + rename 原子操作，crash 不截断整份审计文件。
   * 先 drain 正在进行的 append chain，再 rewrite，完成后重置 chain。
   */
  private async _rewriteChargeFile(): Promise<void> {
    try {
      // Drain any in-flight append chain before overwriting
      await (this._pendingWrite ?? Promise.resolve());
    } catch { /* best-effort */ }
    try {
      const lines = this.charges.map(c => JSON.stringify(c)).join("\n") + (this.charges.length > 0 ? "\n" : "");
      const tmp = BUDGET_FILE + ".tmp";
      await fsp.writeFile(tmp, lines, "utf8");
      await fsp.rename(tmp, BUDGET_FILE);
      // Reset the chain so future appends chain off a clean resolved promise
      this._pendingWrite = Promise.resolve();
    } catch { /* best-effort */ }
  }

  // ─── Core ─────────────────────────────────────────────────────────────

  preflight(costEstimate: number, jobId: string, providerId?: string, opts?: { realPaidProvider?: boolean }): void {
    const limits = this.getLimits();
    this.pruneOldCharges();

    // 2026-07-10 audit — 日预算上限被显式设为 ¥0 = 用户想彻底冻结付费生成. 某些真实付费 provider
    // 的 preset 单价为 0 (如即梦 jimeng): costEstimate=0 → 下面 `dailyTotal + 0 > 0` 恒 false 会放行,
    // 冻结形同虚设. 对真实付费 provider 直接拦截, 与 estimate 无关 (调用方须显式标 realPaidProvider).
    if (opts?.realPaidProvider && limits.dailyCapCNY <= 0) {
      throw new BudgetExceededError(
        "已把日预算上限设为 ¥0，暂停了所有付费视频生成。如需继续，请到设置里调高日预算上限。",
      );
    }

    // Check daily cap
    const dailyTotal = this.charges.reduce((sum, c) => sum + c.amount, 0);
    if (dailyTotal + costEstimate > limits.dailyCapCNY) {
      throw new BudgetExceededError(
        `日预算已达上限 ¥${limits.dailyCapCNY.toFixed(2)}（已用 ¥${dailyTotal.toFixed(2)}，本次预估 ¥${costEstimate.toFixed(2)}）`,
      );
    }
    if (dailyTotal + costEstimate > limits.dailyCapCNY * APPROACHING_RATIO) {
      this.emit({ type: "budget.approaching", scope: "daily", used: dailyTotal, limit: limits.dailyCapCNY });
    }

    // Check single job cap
    const jobTotal = this.charges
      .filter((c) => c.jobId === jobId)
      .reduce((sum, c) => sum + c.amount, 0);
    if (jobTotal + costEstimate > limits.singleJobCapCNY) {
      throw new BudgetExceededError(
        `单任务预算已达上限 ¥${limits.singleJobCapCNY.toFixed(2)}（任务已用 ¥${jobTotal.toFixed(2)}，本次预估 ¥${costEstimate.toFixed(2)}）`,
      );
    }

    // Check per-provider cap
    if (providerId) {
      const providerTotal = this.charges
        .filter((c) => c.providerId === providerId)
        .reduce((sum, c) => sum + c.amount, 0);
      if (providerTotal + costEstimate > limits.perProviderCapCNY) {
        throw new BudgetExceededError(
          `Provider ${providerId} 预算已达上限 ¥${limits.perProviderCapCNY.toFixed(2)}（已用 ¥${providerTotal.toFixed(2)}，本次预估 ¥${costEstimate.toFixed(2)}）`,
        );
      }
      if (providerTotal + costEstimate > limits.perProviderCapCNY * APPROACHING_RATIO) {
        this.emit({ type: "budget.approaching", scope: "provider", providerId, used: providerTotal, limit: limits.perProviderCapCNY });
      }
    }
  }

  /**
   * S2: 记录实际花费 + 持久化到 jsonl (异步，失败只 warn)。
   * T3: amount 按 currency 传入，内部转 CNY 存储。
   */
  recordCharge(amount: number, jobId?: string, providerId?: string, currency: "CNY" | "USD" = "CNY"): void {
    const cnyAmount = toCNY(amount, currency);
    const record: ChargeRecord = {
      amount: cnyAmount,
      currency,
      jobId,
      providerId,
      timestamp: Date.now(),
    };
    this.charges.push(record);

    // S2: 异步追加到 jsonl
    this._appendChargeFile(record);

    const limits = this.getLimits();
    const dailyTotal = this.charges.reduce((sum, c) => sum + c.amount, 0);
    if (dailyTotal >= limits.dailyCapCNY) {
      this.emit({ type: "budget.exceeded", scope: "daily", used: dailyTotal, limit: limits.dailyCapCNY });
    }
  }

  /** Legacy alias for onCharge → recordCharge */
  onCharge(amount: number, jobId?: string, providerId?: string): void {
    this.recordCharge(amount, jobId, providerId);
  }

  getDailyUsed(): number {
    this.pruneOldCharges();
    return this.charges.reduce((sum, c) => sum + c.amount, 0);
  }

  /**
   * S2: pruneOldCharges — 清内存 24h+ 的 charges。
   * 每小时重写一次 jsonl 文件来压缩（避免无限增长）。
   */
  pruneOldCharges(): void {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const before = this.charges.length;
    this.charges = this.charges.filter((c) => now - c.timestamp < oneDayMs);

    // S2: 每小时重写一次 jsonl 压缩（仅当有记录被 prune 或到了新小时）
    const currentHour = Math.floor(now / 3600000);
    if (this.charges.length < before || currentHour > this._lastPruneHour) {
      this._lastPruneHour = currentHour;
      this._rewriteChargeFile().catch(() => {});
    }
  }
}

export type BudgetEvent =
  | { type: "budget.approaching"; scope: "daily" | "provider"; providerId?: string; used: number; limit: number }
  | { type: "budget.exceeded"; scope: "daily"; used: number; limit: number };

export const budgetGuard = new BudgetGuard();
