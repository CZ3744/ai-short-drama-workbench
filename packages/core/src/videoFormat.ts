/**
 * Unified video format resolution helpers.
 * Centralizes aspect ratio → width/height mapping so all layers
 * (provider, renderer, QA) use the same logic.
 */

export interface VideoDimensions {
  width: number;
  height: number;
}

export interface VideoFormat extends VideoDimensions {
  aspectRatio: string;
  resolution: string;
}

const ASPECT_RATIO_MAP: Record<string, VideoDimensions> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1":  { width: 1080, height: 1080 },
};

/**
 * Parse "1920x1080" → { width, height }. Returns null if format doesn't match.
 */
export function parseResolution(resolution: string): VideoDimensions | null {
  const match = resolution.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!match) return null;
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}

/**
 * Map aspect ratio string to dimensions. Defaults to 16:9 for unknown values.
 */
export function aspectRatioToResolution(aspectRatio: string): VideoDimensions {
  return ASPECT_RATIO_MAP[aspectRatio] ?? ASPECT_RATIO_MAP["16:9"];
}

/**
 * Resolve video format from any combination of inputs.
 * Priority: resolution string > aspectRatio string > default 16:9.
 */
export function resolveVideoFormat(input: {
  resolution?: string;
  aspectRatio?: string;
}): VideoFormat {
  // Try explicit resolution first
  if (input.resolution) {
    const parsed = parseResolution(input.resolution);
    if (parsed) {
      return {
        ...parsed,
        aspectRatio: input.aspectRatio ?? `${parsed.width}:${parsed.height}`,
        resolution: input.resolution,
      };
    }
  }

  // Fall back to aspect ratio
  const dims = aspectRatioToResolution(input.aspectRatio ?? "16:9");
  return {
    ...dims,
    aspectRatio: input.aspectRatio ?? "16:9",
    resolution: `${dims.width}x${dims.height}`,
  };
}
