import fs from "node:fs/promises";
import path from "node:path";
import { promptsRoot } from "../../core/src/paths";

export async function loadPrompt(promptFile: string) {
  return fs.readFile(path.join(promptsRoot, promptFile), "utf8");
}

export function fillTemplate(template: string, values: Record<string, unknown>) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
    const value = values[key];
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });
}
