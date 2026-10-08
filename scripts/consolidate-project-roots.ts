import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeWorkspaceRoot } from "../packages/core/src/workspaceMerge";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parentRoot = path.dirname(repoRoot);
const apply = process.argv.includes("--apply");
console.log(`[workspace-merge] mode=${apply ? "COPY + VERIFY (source retained)" : "PLAN"}`);
let found = false;
for (const [legacy, canonical] of [["video-generate-data", "data"], ["outputs", "outputs"]]) {
  const source = path.join(parentRoot, legacy);
  if (!fs.existsSync(source)) { console.log(`${legacy}: source missing, skip`); continue; }
  found = true;
  const destination = path.join(repoRoot, canonical);
  const stats = mergeWorkspaceRoot(source, destination, path.join(destination, "_merge_conflicts", `from-${legacy}`), apply);
  console.log(JSON.stringify({ source, destination, ...stats }));
}
if (!found) console.log("[workspace-merge] no external roots found; project is already consolidated.");
else if (apply) console.log("[workspace-merge] verified copies; sources retained for recoverability. No recursive deletion is performed.");
else console.log("[workspace-merge] PLAN only. Run npm run workspace:merge to copy and verify.");
