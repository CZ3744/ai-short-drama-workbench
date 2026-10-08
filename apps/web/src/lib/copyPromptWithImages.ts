/**
 * copyPromptWithImages — 共享 helper (铁律 #13)
 *
 * 把提示词 + 所有参考图打包成 markdown (图 base64 内联) 写到剪贴板.
 * 用户可直接粘到 ChatGPT / Claude / Gemini 等支持 markdown 图片的 AI 即看见图.
 *
 * 调用方:
 *   - PromptReviewModal (element / shot stage 场景, 含 implicitReferences)
 *   - InlineEditablePromptBlock (PromptReviewButton 内部, PromptPreview 场景)
 *
 * 2026-05-20 P2: 返回结构化结果 (含 skipped 计数), 调用方自行 toast partial 提示.
 */

export interface CopyImage {
  url: string;
  label: string;
}

export interface CopyPromptOptions {
  /** 完整提示词正文 */
  fullPrompt: string;
  /** 负向提示词 (可选) */
  negativePrompt?: string;
  /** 所有要内联的参考图 (调用方负责过滤已取消的隐式图) */
  images: CopyImage[];
}

export interface CopyPromptResult {
  /** 操作是否整体成功 (false = 剪贴板写入失败) */
  ok: boolean;
  /** 成功内联的图片数 */
  copied: number;
  /** 因超 500KB / fetch 失败被跳过的图片数 */
  skipped: number;
  /** 用于展示给用户的状态描述字符串 */
  message: string;
}

/**
 * 拼 markdown 并写到剪贴板.
 * @returns CopyPromptResult — 调用方据此显示合适的 toast.
 */
export async function copyPromptWithImages(opts: CopyPromptOptions): Promise<CopyPromptResult> {
  const { fullPrompt, negativePrompt, images } = opts;

  let md = `# 视频生成提示词\n\n${fullPrompt}\n`;
  if (negativePrompt) md += `\n## 排除 (negative prompt)\n${negativePrompt}\n`;

  let copiedCount = 0;
  let skippedCount = 0;

  if (images.length > 0) {
    md += `\n## 参考图 (${images.length} 张)\n`;
    const fetched: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        const resp = await fetch(img.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        // 限单图 500 KB 避免剪贴板溢出
        if (blob.size > 500 * 1024) {
          skippedCount += 1;
          failed.push(
            `${img.label} (${(blob.size / 1024).toFixed(0)}KB 超 500KB, 手动下载: ${img.url})`
          );
          continue;
        }
        const b64 = await blobToBase64(blob);
        fetched.push(`### ${i + 1}. ${img.label}\n![${img.label}](${b64})\n`);
        copiedCount += 1;
      } catch (e) {
        skippedCount += 1;
        failed.push(
          `${img.label}: ${e instanceof Error ? e.message : "fetch 失败"} (${img.url})`
        );
      }
    }

    md += fetched.join("\n");
    if (failed.length > 0) {
      md += `\n### 图片获取失败 (${failed.length} 张, 请手动下载)\n`;
      for (const f of failed) md += `- ${f}\n`;
    }
  }

  try {
    await navigator.clipboard.writeText(md);
  } catch (e) {
    const msg = `剪贴板写入失败: ${e instanceof Error ? e.message : "未知错误"}`;
    return { ok: false, copied: copiedCount, skipped: skippedCount, message: msg };
  }

  const imgCount = images.length;
  let message: string;
  if (imgCount === 0) {
    message = "已复制文字 (markdown 格式)";
  } else if (skippedCount === 0) {
    message = `已复制文字 + ${copiedCount} 张图 (markdown 格式)`;
  } else {
    message = `已复制文字 + ${copiedCount} 张图 (${skippedCount} 张因超 500KB 或加载失败被跳过)`;
  }
  return { ok: true, copied: copiedCount, skipped: skippedCount, message };
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
