/**
 * 格式化工具 — 时长/字节/金额/时间。
 *
 * 时间统一北京时区 (2026-05-26 用户红线): "全用北京时间, 以后也是".
 * 所有 toLocale*  / formatDate 必须走本文件的 helper, 不许散落手写
 * `new Date(...).toLocaleString(...)`. 即使开发机时区是 UTC / 用户浏览器
 * 系统时区是别的, UI 上一律显示北京时间.
 */

/** 北京时区常量, 内部使用. */
const BJ_TZ = "Asia/Shanghai";

/**
 * 北京时间格式化主入口.
 *
 *   formatBeijingTime("2026-05-26T13:45:00Z") → "05-26 21:45"
 *   formatBeijingTime(date, { mode: "datetime" }) → "2026-05-26 21:45"
 *   formatBeijingTime(date, { mode: "full" })     → "2026-05-26 21:45:33"
 *   formatBeijingTime(date, { mode: "date" })     → "2026-05-26"
 *   formatBeijingTime(date, { mode: "time" })     → "21:45"
 *
 * 入参兼容 string ISO / Date / number ms. 无效输入返回 "—".
 */
export type BeijingTimeMode = "short" | "datetime" | "full" | "date" | "time";

export function formatBeijingTime(
  value: string | Date | number | undefined | null,
  opts?: { mode?: BeijingTimeMode },
): string {
  if (value === undefined || value === null || value === "") return "—";
  const d = typeof value === "string"
    ? new Date(value)
    : typeof value === "number"
      ? new Date(value)
      : value;
  if (Number.isNaN(d.getTime())) return "—";
  const mode = opts?.mode ?? "short";
  try {
    switch (mode) {
      case "full":
        return d.toLocaleString("zh-CN", {
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
          hour12: false, timeZone: BJ_TZ,
        }).replace(/\//g, "-");
      case "datetime":
        return d.toLocaleString("zh-CN", {
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit",
          hour12: false, timeZone: BJ_TZ,
        }).replace(/\//g, "-");
      case "date":
        return d.toLocaleDateString("zh-CN", {
          year: "numeric", month: "2-digit", day: "2-digit",
          timeZone: BJ_TZ,
        }).replace(/\//g, "-");
      case "time":
        return d.toLocaleTimeString("zh-CN", {
          hour: "2-digit", minute: "2-digit",
          hour12: false, timeZone: BJ_TZ,
        });
      case "short":
      default:
        return d.toLocaleString("zh-CN", {
          month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit",
          hour12: false, timeZone: BJ_TZ,
        }).replace(/\//g, "-");
    }
  } catch {
    return "—";
  }
}

/**
 * 取某时刻的北京时区"小时"(0-23), 用于按小时分桶统计(如失败热力图)。
 * 与 formatBeijingTime 同源锁 Asia/Shanghai, 不走浏览器本地时区。
 * 无效输入返回 -1(调用方自行过滤)。
 */
export function beijingHourOf(value: string | Date | number | undefined | null): number {
  if (value === undefined || value === null || value === "") return -1;
  const d = typeof value === "string" || typeof value === "number" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return -1;
  try {
    const hh = new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: BJ_TZ }).format(d);
    const n = Number(hh) % 24; // 某些环境午夜返回 "24", 归一到 0
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

/** 格式化秒数为 mm:ss 或 hh:mm:ss */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 格式化字节数 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(decimals)} ${units[i]}`;
}

/** 格式化金额（分 → ¥X.XX） */
export function formatCurrency(cents: number): string {
  if (cents === 0) return "免费";
  return `¥${(cents / 100).toFixed(2)}`;
}

/** 格式化百分比 */
export function formatPercent(value: number, decimals = 0): string {
  return `${value.toFixed(decimals)}%`;
}

/**
 * 格式化相对时间.
 *
 * 2026-05-26 audit #4: 入参兼容 string ISO / Date / number (ms 时间戳) / undefined.
 * NaN / undefined 返回 "—". 单一真理源, 全前端用这一个.
 *
 * 输出阶梯:
 *   < 60s          → "X 秒前"  (秒级精度, 用户能看见"32 秒前"比"刚刚"更准)
 *   < 1h           → "X 分钟前"
 *   < 24h          → "X 小时前"
 *   < 7d           → "X 天前"
 *   < 30d          → "X 周前"
 *   >= 30d         → toLocaleDateString
 */
export function formatRelativeTime(date: string | Date | number | undefined | null): string {
  if (date === undefined || date === null || date === "") return "—";
  const d = typeof date === "string"
    ? new Date(date)
    : typeof date === "number"
      ? new Date(date)
      : date;
  const t = d.getTime();
  if (Number.isNaN(t)) return "—";

  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)} 周前`;
  return formatBeijingTime(d, { mode: "date" });
}
