import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Existing files only. Check both lexical boundaries and the actual junction/symlink target. */
export function resolveSafeFile(root: string, candidate: string): string {
  const resolved = path.resolve(candidate.startsWith("file:") ? fileURLToPath(candidate) : candidate);
  if (!isPathWithin(root, resolved)) throw new Error("文件不在允许的数据目录内");
  const actual = fs.realpathSync(resolved);
  if (!isPathWithin(fs.realpathSync(root), actual) || !fs.statSync(actual).isFile()) {
    throw new Error("文件链接指向数据目录外，或不是普通文件");
  }
  return actual;
}
