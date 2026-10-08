/**
 * 把 series.defaults.aspect_ratio (例 "16:9" / "9:16" / "1:1" / "4:3" / "21:9")
 * 转 CSS aspectRatio 字符串 ("16/9" 形式).
 *
 * 用户原话 (2026-05-22): "这部剧的比例是什么, 视频、图片缩略图的比例就是什么,
 * 而不是默认 16 比 9". 所有候选 tile / import tile / placeholder 都该用这个,
 * 不再写死 "16/9" 或 "1/1".
 *
 * fallback: 16/9 (短剧最常见横屏); 输入非法 / 空时也 fallback.
 */
export function seriesAspectToCss(aspect?: string | null, fallback = "16/9"): string {
  if (!aspect || typeof aspect !== "string") return fallback;
  const cleaned = aspect.trim();
  // "16:9" → "16/9"; "16/9" 原样; "0.5625" 不支持
  if (cleaned.includes(":")) {
    const parts = cleaned.split(":");
    if (parts.length === 2 && parts[0] && parts[1]) {
      const w = Number(parts[0]);
      const h = Number(parts[1]);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return `${w}/${h}`;
      }
    }
    return fallback;
  }
  if (cleaned.includes("/")) {
    const parts = cleaned.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      const w = Number(parts[0]);
      const h = Number(parts[1]);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return `${w}/${h}`;
      }
    }
    return fallback;
  }
  return fallback;
}
