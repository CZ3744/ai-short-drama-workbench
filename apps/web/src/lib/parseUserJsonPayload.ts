/**
 * parseUserJsonPayload — 解析用户从外部 AI 粘贴的 JSON 文本.
 *
 * 容错 markdown ```json``` 代码块 + 友好中文错误.
 *
 * 用户场景: 把外部 ChatGPT / Claude / Gemini 输出粘到 textarea, 经常带
 *   ```json ... ``` 包裹. 这个 helper 统一所有 caller 的解析逻辑, 不再
 *   各处重写正则.
 *
 * 之前散落 4 处 (PasteStoryboardDialog / ExtractFromScriptDialog /
 *   BatchImportMultiDialog / ElementWorkbench), 各自正则细节有差异,
 *   修一个 bug 要改 4 个地方. 用户原话 (2026-05-19):
 *   "避免屎山, 避免同样的逻辑需要去不同处改多次"
 */

export interface ParseSuccess<T = unknown> {
  ok: true;
  data: T;
  /** stripped 后的纯 JSON 字符串, 便于后续 stringify / 比对 */
  cleaned: string;
}

export interface ParseError {
  ok: false;
  message: string;
  rawError?: unknown;
}

export type ParseResult<T = unknown> = ParseSuccess<T> | ParseError;

/**
 * 剥 markdown ```json``` 或 ``` ``` 代码块. 容错: 无包裹也 OK.
 *
 * 同时容错:
 *   - 起始 ```json\n 或 ```\n
 *   - 结尾 \n``` 或 ```
 *   - 中间无 \n 的 single-line fence
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  // 完整多行 fence: ```json\n...content...\n```
  const fullMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fullMatch) return fullMatch[1].trim();
  // 不完整 fence (例如缺尾): 至少把头部 ```json 剥掉
  return trimmed.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

/**
 * 兜底: 找文本中的首个 `{ ... }` 块 (LLM 可能在 JSON 前后多说话).
 *
 * 注: 用 lastIndexOf('}') 兜内层嵌套, 不保证一定正确, 但比"完整失败"友好.
 */
export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return text;
  return text.slice(start, end + 1);
}

/**
 * 完整解析路径:
 *   1. trim 空字符串 → 友好错误
 *   2. 剥 fence
 *   3. JSON.parse — 成功直接返回
 *   4. 失败兜底: extractJsonObject → 再 parse
 *   5. 还失败 → 友好中文错误 + 原 error
 *
 * @example
 *   const r = parseUserJsonPayload<MyType>(text);
 *   if (!r.ok) { setError(r.message); return; }
 *   const data = r.data;
 */
export function parseUserJsonPayload<T = unknown>(text: string): ParseResult<T> {
  if (!text || !text.trim()) {
    return { ok: false, message: "请粘贴 JSON 内容" };
  }

  let cleaned = stripCodeFence(text);
  try {
    return { ok: true, data: JSON.parse(cleaned) as T, cleaned };
  } catch (e1) {
    // 兜底: 提取首个 { ... }
    const extracted = extractJsonObject(cleaned);
    if (extracted !== cleaned) {
      try {
        return { ok: true, data: JSON.parse(extracted) as T, cleaned: extracted };
      } catch (e2) {
        return {
          ok: false,
          message: `JSON 解析失败: ${e2 instanceof Error ? e2.message : "格式错误"}. 请检查是否被 markdown 包裹或缺少必填字段.`,
          rawError: e2,
        };
      }
    }
    return {
      ok: false,
      message: `JSON 解析失败: ${e1 instanceof Error ? e1.message : "格式错误"}. 请检查是否被 markdown 包裹或缺少必填字段.`,
      rawError: e1,
    };
  }
}
