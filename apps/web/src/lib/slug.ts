/**
 * slug.ts — 前端共享 slugify 工具函数
 *
 * 与 packages/core/src/slug.ts 保持逻辑一致（前端无法直接 import Node.js packages）。
 * 保留中文/英文/数字, 其余转 `-`, 去掉首尾 `-`, lowercase 英文。
 *
 * @param text    要转换的文本
 * @param opts.maxLen          最大字符数（默认 80）
 * @param opts.fallbackPrefix  为空时的回退前缀（默认 "s"，生成 s-<timestamp36>）
 */
export function slugify(
  text: string,
  opts?: { maxLen?: number; fallbackPrefix?: string }
): string {
  const maxLen = opts?.maxLen ?? 80;
  const fallbackPrefix = opts?.fallbackPrefix ?? "s";
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLen) || `${fallbackPrefix}-${Date.now().toString(36)}`
  );
}
