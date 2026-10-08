import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./paths";
import { isPathWithin, resolveSafeFile } from "./safePath";

/** Read-time compatibility for the two formerly adjacent roots; never rewrites metadata. */
export function remapLegacyWorkspacePath(candidate: string, workspace = repoRoot): string {
  const file = candidate.startsWith("file:") ? fileURLToPath(candidate) : candidate;
  if (!path.isAbsolute(file)) return file;
  const absolute = path.resolve(file);
  for (const [oldName, newName] of [["video-generate-data", "data"], ["outputs", "outputs"]]) {
    const oldRoot = path.join(path.dirname(workspace), oldName);
    if (isPathWithin(oldRoot, absolute)) return path.join(workspace, newName, path.relative(oldRoot, absolute));
  }
  return absolute;
}

export function resolveWorkspaceMediaFile(candidate: string, workspace = repoRoot): string {
  const file = remapLegacyWorkspacePath(candidate, workspace);
  const root = ["data", "outputs"].map(dir => path.join(workspace, dir)).find(dir => isPathWithin(dir, file));
  if (!root) throw new Error("素材不在当前项目的数据或输出目录内");
  return resolveSafeFile(root, file);
}
