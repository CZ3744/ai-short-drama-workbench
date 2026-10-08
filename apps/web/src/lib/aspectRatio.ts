/** Convert preset IDs, stored ratios and CSS ratios to the API's positive integer width:height format. */
export function normalizeAspectRatio(aspect?: string | null): string | undefined {
  if (typeof aspect !== "string") return undefined;
  const match = aspect.trim().match(/^(\d{1,9}(?:\.\d{1,6})?)\s*[:x/]\s*(\d{1,9}(?:\.\d{1,6})?)$/);
  if (!match) return undefined;
  const decimals = Math.max(...match.slice(1).map((part) => part.split(".")[1]?.length ?? 0));
  const scale = 10 ** decimals;
  const width = Math.round(Number(match[1]) * scale);
  const height = Math.round(Number(match[2]) * scale);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return undefined;
  let a = width;
  let b = height;
  while (b) [a, b] = [b, a % b];
  const w = width / a;
  const h = height / a;
  // ComposeSchema accepts at most five digits per side.
  return w <= 99999 && h <= 99999 ? `${w}:${h}` : undefined;
}

/** Preset dictionaries use IDs such as 16x9; component/API state uses 16:9. */
export function aspectRatioToPresetId(aspect?: string | null): string | undefined {
  return normalizeAspectRatio(aspect)?.replace(":", "x");
}

/** Keep image, video and subtitle previews consistent with the selected output ratio. */
export function seriesAspectToCss(aspect?: string | null, fallback = "16/9"): string {
  return normalizeAspectRatio(aspect)?.replace(":", "/") ?? fallback;
}
