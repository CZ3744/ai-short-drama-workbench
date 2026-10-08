/**
 * Shared script-text utilities (Step 3a batch 0-B).
 *
 * Extracted verbatim from orchestrationController.ts — zero behavior change.
 * Only the function bodies moved; signatures, JSDoc and inline comments are
 * preserved exactly. All symbols are exported (some were module-private in
 * the original file).
 */

import type { z } from "zod";
import type { SeriesEpisodePlanSchema } from "./schemas";

export function compactText(input: string, fallback = "未命名"): string {
  const text = input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_\-\[\]()`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

export function labelSnippet(input: string, fallback: string, max = 18): string {
  const text = compactText(input, fallback);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function stripScriptPreamble(scriptText: string): string {
  const lines = scriptText.split(/\r?\n/);
  let start = 0;
  while (start < lines.length) {
    const trimmed = lines[start].trim();
    if (!trimmed) {
      start++;
      continue;
    }
    if (/^#\s+/.test(trimmed)) {
      start++;
      continue;
    }
    if (/^##\s*灵感原文/.test(trimmed)) {
      start++;
      continue;
    }
    if (/^>\s*(?:时长预估|注[:：])/.test(trimmed)) {
      start++;
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      start++;
      continue;
    }
    break;
  }
  return lines.slice(start).join("\n").trim();
}

export function splitScriptSegments(scriptText: string, preferredCount = 6): string[] {
  const narrativeText = stripScriptPreamble(scriptText);
  const cleaned = compactText(narrativeText, "");
  if (!cleaned) return ["开场交代核心信息", "展开主要冲突或知识点", "收束并给出行动指向"];

  const paragraphs = narrativeText
    .split(/\n{2,}/)
    .map((p) => compactText(p, ""))
    .filter((p) => p.length >= 8);

  let segments = paragraphs.length >= 2
    ? paragraphs
    : cleaned.split(/(?<=[。！？.!?])\s*/).map((p) => compactText(p, "")).filter((p) => p.length >= 8);

  if (segments.length === 0) segments = [cleaned];

  const target = Math.max(3, Math.min(preferredCount, 10));
  if (segments.length > target) {
    const bucketSize = Math.ceil(segments.length / target);
    const grouped: string[] = [];
    for (let i = 0; i < segments.length; i += bucketSize) {
      grouped.push(segments.slice(i, i + bucketSize).join(" "));
    }
    segments = grouped;
  }

  while (segments.length < Math.min(target, 4)) {
    const last = segments[segments.length - 1] ?? cleaned;
    segments.push(last);
  }

  return segments.slice(0, target);
}

export function extractSpeakerNames(scriptText: string): string[] {
  const names = new Set<string>();
  const speakerPattern = /^\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{1,16})\s*[：:]/gm;
  for (const match of scriptText.matchAll(speakerPattern)) {
    const name = match[1].trim();
    if (/^(旁白|镜头|场景|Scene|Shot)$/i.test(name)) continue;
    names.add(name);
  }
  return [...names].slice(0, 8);
}

type SeriesEpisodePlan = z.infer<typeof SeriesEpisodePlanSchema>["episodes"][number];

export function extractEpisodeSections(scriptText: string): SeriesEpisodePlan[] {
  const matches = [...scriptText.matchAll(/^#{1,3}\s*((?:第\s*\d+\s*集|EP\s*\d+|Episode\s*\d+)[^\n]*)\n/gim)];
  if (matches.length === 0) return [];

  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? scriptText.length : scriptText.length;
    const title = labelSnippet(match[1], `第 ${index + 1} 集`, 40);
    const body = scriptText.slice(start, end).trim();
    const scriptMd = body ? `# ${title}\n\n${body}` : `# ${title}\n\n${scriptText.trim()}`;
    return {
      title,
      synopsis: labelSnippet(body || title, title, 80),
      script_md: scriptMd,
      target_duration_sec: 60,
      target_shot_count: 8,
    };
  });
}

export function cleanShotPrompt(prompt: string | undefined | null): string {
  if (!prompt) return "";
  return prompt
    .replace(/[#>*_|`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}
