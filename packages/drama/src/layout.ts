/**
 * P11 - Drama 磁盘路径解析工具
 * 给定 series slug + episode/shot id 生成绝对路径
 */
import path from "node:path";
import { DATA_ROOT } from "../../core/src/paths.js";

// BUG-47: 路径遍历防护
function validateSegment(seg: string, label: string): void {
  if (!seg || seg.includes("..") || seg.includes("/") || seg.includes("\\") || seg.includes("\0")) {
    throw new Error(`Invalid ${label}: ${seg}`);
  }
}

/** 系列根目录 */
export function seriesDir(slug: string): string {
  validateSegment(slug, "series slug");
  return path.join(DATA_ROOT, "series", slug);
}

/** series.json 路径 */
export function seriesJsonPath(slug: string): string {
  // seriesDir 内部已 validateSegment(slug)
  return path.join(seriesDir(slug), "series.json");
}

/** 角色 JSON 路径 */
export function characterPath(slug: string, charId: string): string {
  validateSegment(charId, "character ID");
  return path.join(seriesDir(slug), "characters", `${charId}.json`);
}

/** 场景 JSON 路径 */
export function scenePath(slug: string, sceneId: string): string {
  validateSegment(sceneId, "scene ID");
  return path.join(seriesDir(slug), "scenes", `${sceneId}.json`);
}

/** 集目录 */
export function episodeDir(slug: string, epId: string): string {
  validateSegment(epId, "episode ID");
  return path.join(seriesDir(slug), "episodes", epId);
}

/** episode.json 路径 */
export function episodeJsonPath(slug: string, epId: string): string {
  return path.join(episodeDir(slug, epId), "episode.json");
}

/** storyboard.json 路径 */
export function storyboardPath(slug: string, epId: string): string {
  return path.join(episodeDir(slug, epId), "storyboard.json");
}

/** shot JSON 路径 */
export function shotPath(slug: string, epId: string, shotId: string): string {
  validateSegment(shotId, "shot ID");
  return path.join(episodeDir(slug, epId), "shots", `${shotId}.json`);
}

/** 素材根目录 */
export function assetsDir(slug: string): string {
  return path.join(seriesDir(slug), "assets");
}

/** 索引文件路径 */
export function assetsIndexPath(slug: string): string {
  return path.join(assetsDir(slug), "index.jsonl");
}
