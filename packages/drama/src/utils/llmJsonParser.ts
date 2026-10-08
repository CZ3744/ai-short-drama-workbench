/**
 * BUG-60: 从 clarifier.ts / directorAgent.ts 提取的共享 LLM JSON 解析工具
 *
 * 处理 LLM 常见输出格式:
 * - 纯 JSON
 * - Markdown 代码块包裹的 JSON (```json ... ```)
 */
export function parseJsonFromLlm(text: string): unknown {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const end = cleaned.lastIndexOf("```");
    if (end > 3) cleaned = cleaned.slice(3, end).trim();
    const nl = cleaned.indexOf("\n");
    if (nl > 0 && nl < 15) cleaned = cleaned.slice(nl + 1).trim();
  }
  return JSON.parse(cleaned);
}
