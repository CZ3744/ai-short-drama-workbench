/**
 * fileBase64 — 浏览器端 File → base64 工具 (唯一实现, 全前端共用).
 *
 * 两个导出函数:
 *   fileToBase64      — 返回完整 data URL (含 "data:mime;base64," 前缀) + filename
 *                       供 elementApi / element 页面使用 (需要 data_url 格式)
 *   fileToRawBase64   — 返回去掉前缀的纯 base64 + mime
 *                       供 shotApi 使用 (image_base64 / video_base64 字段需纯 base64)
 *
 * 历史: 原有两份 inline 实现分散在 elementApi.ts:650 / shotApi.ts:795, 已废弃.
 */

/** 返回完整 data URL (带 "data:mime;base64," 前缀) 以及 filename */
export function fileToBase64(
  file: File,
): Promise<{ base64: string; mime: string; filename: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve({ base64: result, mime: file.type || "image/png", filename: file.name });
    };
    reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** 返回去掉 "data:mime;base64," 前缀的纯 base64 字符串 + mime */
export function fileToRawBase64(
  file: File,
): Promise<{ base64: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve({
        base64: comma >= 0 ? result.slice(comma + 1) : result,
        mime: file.type || "image/png",
      });
    };
    reader.readAsDataURL(file);
  });
}
