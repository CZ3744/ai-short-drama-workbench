/**
 * Prompt Pre-check — B2 Wave B
 *
 * Rule-based prompt validation before image/video generation.
 * Detects: conflict words, missing key descriptors, forbidden words.
 * Returns auto-fix suggestions and a pass/fail verdict.
 *
 * Design:
 * - Pure rule engine — no LLM calls, fast and deterministic
 * - extensible: conflict pairs and required keywords are configurable
 * - Mock mode: all checks return "pass" (for unit tests)
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface PrecheckIssue {
  type: "conflict" | "missing" | "forbidden";
  /** Human-readable description of the issue */
  message: string;
  /** The conflicting/missing/forbidden token */
  token?: string;
  /** Auto-fix suggestion (if applicable) */
  suggestion?: string;
}

export interface PrecheckResult {
  pass: boolean;
  score: number; // 0-1, 1 = perfect prompt
  issues: PrecheckIssue[];
  fixedPrompt?: string; // auto-fixed prompt if suggestions were applied
}

// ─── Conflict pairs ─────────────────────────────────────────────────

/** Each pair: if both words (case-insensitive) appear in prompt, it's a conflict */
const CONFLICT_PAIRS: Array<[string, string, string]> = [
  // Style conflicts
  ["realistic", "anime", "风格冲突：'realistic' 与 'anime' 不能共存，建议选择一种风格"],
  ["photorealistic", "cartoon", "风格冲突：'photorealistic' 与 'cartoon' 矛盾"],
  ["3d render", "watercolor", "风格冲突：'3d render' 与 'watercolor' 矛盾"],
  ["oil painting", "flat design", "风格冲突：'oil painting' 与 'flat design' 矛盾"],
  // Lighting conflicts
  ["dark", "bright", "光照冲突：'dark' 与 'bright' 不能共存，建议明确一种光照"],
  ["night", "daylight", "时间冲突：'night' 与 'daylight' 矛盾"],
  ["sunset", "sunrise", "时间冲突：'sunset' 与 'sunrise' 同时出现可能混淆"],
  // Mood conflicts
  ["happy", "sad", "情绪冲突：'happy' 与 'sad' 不能共存"],
  ["peaceful", "violent", "情绪冲突：'peaceful' 与 'violent' 矛盾"],
  // Technical conflicts
  ["blur", "sharp", "清晰度冲突：'blur' 与 'sharp' 矛盾"],
  ["close-up", "wide shot", "构图冲突：'close-up' 与 'wide shot' 矛盾"],
  ["extreme close-up", "panoramic", "构图冲突：'extreme close-up' 与 'panoramic' 矛盾"],
];

// ─── Required keywords ──────────────────────────────────────────────

/** Minimum recommended descriptor categories for a good prompt */
const REQUIRED_CATEGORIES: Array<{ keywords: string[]; label: string; suggestion: string }> = [
  {
    keywords: ["scene", "background", "setting", "location", "环境", "场景", "背景", "室内", "室外", "forest", "city", "room", "street", "beach", "mountain"],
    label: "场景描述",
    suggestion: "建议添加场景描述（如 'in a forest', '室内'）",
  },
  {
    keywords: ["person", "man", "woman", "girl", "boy", "character", "figure", "人", "人物", "女孩", "男孩", "角色", "老人", "child", "adult", "king", "queen"],
    label: "主体描述",
    suggestion: "建议明确主体（如 'a young woman', '一个老人'）",
  },
];

// ─── Forbidden words ────────────────────────────────────────────────

const FORBIDDEN_WORDS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\bn(sfw|ude|aked|ipples)\b/i, message: "包含违禁词：NSFW 内容不允许" },
  { pattern: /\b(gore|blood|violence|kill|murder)\b/i, message: "包含违禁词：暴力内容不允许" },
  { pattern: /\b(hate\s*speech|racist|nazi)\b/i, message: "包含违禁词：仇恨言论不允许" },
];

// ─── Detection helpers ──────────────────────────────────────────────

function detectConflicts(prompt: string): PrecheckIssue[] {
  const lower = prompt.toLowerCase();
  const issues: PrecheckIssue[] = [];

  for (const [wordA, wordB, message] of CONFLICT_PAIRS) {
    // Use word boundary matching for short words, substring for multi-word
    const aFound = wordA.includes(" ")
      ? lower.includes(wordA)
      : new RegExp(`\\b${escapeRegex(wordA)}\\b`, "i").test(prompt);
    const bFound = wordB.includes(" ")
      ? lower.includes(wordB)
      : new RegExp(`\\b${escapeRegex(wordB)}\\b`, "i").test(prompt);

    if (aFound && bFound) {
      issues.push({
        type: "conflict",
        message,
        token: `${wordA} / ${wordB}`,
        suggestion: `移除其中一个冲突词（保留更具体的需求）`,
      });
    }
  }

  return issues;
}

function detectMissingDescriptors(prompt: string): PrecheckIssue[] {
  const lower = prompt.toLowerCase();
  const issues: PrecheckIssue[] = [];

  // If prompt is very short (under 10 chars), skip detailed checks
  if (prompt.trim().length < 10) {
    issues.push({
      type: "missing",
      message: "提示词过短（< 10 字符），建议补充更多描述",
      suggestion: "添加场景、主体、风格、光照等描述",
    });
    // Empty or near-empty prompts should fail
    if (prompt.trim().length === 0) {
      issues.push({
        type: "forbidden",
        message: "提示词为空",
        suggestion: "请输入有效的提示词",
      });
    }
    return issues;
  }

  for (const category of REQUIRED_CATEGORIES) {
    const found = category.keywords.some((kw) => lower.includes(kw));
    if (!found) {
      issues.push({
        type: "missing",
        message: `缺少${category.label}`,
        suggestion: category.suggestion,
      });
    }
  }

  return issues;
}

function detectForbiddenWords(prompt: string): PrecheckIssue[] {
  const issues: PrecheckIssue[] = [];

  for (const { pattern, message } of FORBIDDEN_WORDS) {
    const match = prompt.match(pattern);
    if (match) {
      issues.push({
        type: "forbidden",
        message,
        token: match[0],
        suggestion: `移除违禁词 '${match[0]}'`,
      });
    }
  }

  return issues;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Auto-fix ───────────────────────────────────────────────────────

/**
 * Apply auto-fixes to a prompt based on detected issues.
 * Only fixes "safe" issues: removes one side of conflicts, removes forbidden words.
 * Does NOT add missing descriptors (that's user choice).
 */
function applyAutoFix(prompt: string, issues: PrecheckIssue[]): string {
  let fixed = prompt;

  // Remove forbidden words
  for (const issue of issues) {
    if (issue.type === "forbidden" && issue.token) {
      fixed = fixed.replace(new RegExp(escapeRegex(issue.token), "gi"), "").trim();
    }
  }

  // For conflicts: remove the second (typically less important) word
  for (const issue of issues) {
    if (issue.type === "conflict" && issue.token) {
      const parts = issue.token.split(" / ");
      if (parts.length === 2) {
        // Remove the second conflicting word
        const toRemove = parts[1].trim();
        const regex = new RegExp(`\\b${escapeRegex(toRemove)}\\b`, "gi");
        fixed = fixed.replace(regex, "").trim();
      }
    }
  }

  // Clean up double spaces and trailing punctuation
  fixed = fixed.replace(/\s{2,}/g, " ").replace(/,\s*,/g, ",").trim();

  return fixed;
}

// ─── Main function ──────────────────────────────────────────────────

/**
 * Pre-check a prompt before generation.
 *
 * @param prompt - The text prompt to validate
 * @param opts.mock - If true, bypass all checks and return pass (for unit tests)
 * @returns PrecheckResult with pass/fail, score, issues, and optional fixed prompt
 */
export function precheckPrompt(
  prompt: string,
  opts?: { mock?: boolean },
): PrecheckResult {
  // Mock mode: always pass (for unit tests)
  if (opts?.mock) {
    return { pass: true, score: 1.0, issues: [] };
  }

  const issues: PrecheckIssue[] = [];

  // 1. Forbidden words (always fail)
  const forbidden = detectForbiddenWords(prompt);
  issues.push(...forbidden);

  // 2. Conflicts (warning, not fatal)
  const conflicts = detectConflicts(prompt);
  issues.push(...conflicts);

  // 3. Missing descriptors (warning, not fatal)
  const missing = detectMissingDescriptors(prompt);
  issues.push(...missing);

  // Calculate score: start at 1.0, deduct for each issue type
  let score = 1.0;
  for (const issue of issues) {
    switch (issue.type) {
      case "forbidden":
        score -= 0.5; // severe
        break;
      case "conflict":
        score -= 0.2; // moderate
        break;
      case "missing":
        score -= 0.1; // minor
        break;
    }
  }
  score = Math.max(0, Math.min(1, score));

  // Fail if forbidden words present or score too low
  const pass = forbidden.length === 0 && score >= 0.5;

  // Generate fixed prompt if there are fixable issues
  const fixableIssues = issues.filter((i) => i.type !== "missing");
  const fixedPrompt = fixableIssues.length > 0 ? applyAutoFix(prompt, issues) : undefined;

  return { pass, score, issues, fixedPrompt };
}
