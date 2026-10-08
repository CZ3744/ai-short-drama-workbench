/**
 * useClipboardPaste — 全局剪贴板粘贴图片导入
 *
 * 使用方式:
 * 1. globalListen=true: 监听整个 document paste 事件（推荐用于 ImageDropZone）
 * 2. ref: 监听指定容器内的 paste 事件
 * 3. trigger(): 主动调用 navigator.clipboard.read() 弹权限提示后读取
 */

import { useEffect, useCallback, useRef } from "react";

export interface UseClipboardPasteOpts {
  onPaste: (files: File[]) => void;
  /** "image" 仅提取图片, "any" 提取所有文件. 默认 "image" */
  accept?: "image" | "any";
  /** 监听整个 document (true) 还是仅 ref 元素内 (false). 默认 false */
  globalListen?: boolean;
  /** 监听特定容器的 ref */
  ref?: React.RefObject<HTMLElement | null>;
}

export interface UseClipboardPasteReturn {
  /** 主动触发: 弹出浏览器剪贴板权限, 然后读取第一张图片 */
  trigger: () => Promise<void>;
}

function extractImageFiles(items: DataTransferItemList, accept: "image" | "any"): File[] {
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "file") continue;
    if (accept === "image" && !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

export function useClipboardPaste({
  onPaste,
  accept = "image",
  globalListen = false,
  ref,
}: UseClipboardPasteOpts): UseClipboardPasteReturn {
  // 稳定引用, 避免 effect 因 onPaste 闭包变化反复重建
  const onPasteRef = useRef(onPaste);
  onPasteRef.current = onPaste;

  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const files = extractImageFiles(e.clipboardData.items, accept);
      if (files.length === 0) return;
      e.preventDefault();
      onPasteRef.current(files);
    };

    const target: EventTarget | null = globalListen
      ? document
      : ref?.current ?? null;

    if (!target) return;
    target.addEventListener("paste", handler as EventListener);
    return () => {
      target.removeEventListener("paste", handler as EventListener);
    };
  }, [globalListen, ref, accept]);

  const trigger = useCallback(async () => {
    if (!navigator.clipboard?.read) {
      // 降级: 让用户手动 Ctrl+V
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const ext = imageType.split("/")[1] ?? "png";
        files.push(new File([blob], `clipboard-${Date.now()}.${ext}`, { type: imageType }));
      }
      if (files.length > 0) {
        onPasteRef.current(files);
      }
    } catch {
      // 权限被拒或不支持, 静默忽略
    }
  }, []);

  return { trigger };
}
