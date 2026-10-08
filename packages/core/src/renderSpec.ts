export interface RenderSpec {
  aspect_ratio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  width: number;
  height: number;
  fps: 24 | 25 | 30;
}

const ASPECT_TO_DIM: Record<string, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1":  { w: 1080, h: 1080 },
  "4:3":  { w: 1440, h: 1080 },
  "3:4":  { w: 1080, h: 1440 },
};

export function resolveRenderSpec(aspectRatio?: string | null): RenderSpec {
  const aspect = (aspectRatio || "16:9") as RenderSpec["aspect_ratio"];
  const dim = ASPECT_TO_DIM[aspect] ?? ASPECT_TO_DIM["16:9"];
  return { aspect_ratio: aspect, width: dim.w, height: dim.h, fps: 24 };
}
