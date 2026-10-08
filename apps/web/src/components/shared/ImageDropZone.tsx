/**
 * ImageDropZone — 统一图片导入区
 *
 * 支持三种导入方式:
 * 1. 点击选文件 (input[type=file])
 * 2. 拖拽到区域内
 * 3. 粘贴剪贴板图片
 *
 * 铁律 #11: 按钮有完整名字
 * 铁律 #3: 信息直接可见 (提示三种方式)
 */

import { useRef, useState, useCallback, type DragEvent } from "react";
import { cn } from "../../lib/cn";
import { useClipboardPaste } from "../../hooks/useClipboardPaste";
import { Upload, ClipboardPaste } from "../shared/LucideIcon";

export interface ImageDropZoneProps {
  onImport: (files: File[]) => void;
  label?: string;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * 统一图片导入区: 点击、拖拽、粘贴均可导入图片。
 */
export function ImageDropZone({
  onImport,
  label = "导入图片",
  accept = "image/*",
  multiple = true,
  disabled = false,
  className,
}: ImageDropZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  // 全局粘贴监听 + 主动触发
  const { trigger } = useClipboardPaste({
    onPaste: (files) => {
      if (disabled) return;
      onImport(files);
    },
    accept: "image",
    globalListen: true,
  });

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (!disabled) setDragging(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith("image/")
      );
      if (files.length > 0) onImport(files);
    },
    [disabled, onImport]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) onImport(files);
      // 清空 value 以允许重复选同一文件
      e.target.value = "";
    },
    [onImport]
  );

  const handleClick = useCallback(() => {
    if (!disabled) fileInputRef.current?.click();
  }, [disabled]);

  const handlePasteBtn = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      await trigger();
    },
    [trigger]
  );

  return (
    <div className={cn("relative w-full", className)}>
      {/* 隐藏 file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        style={{ display: "none" }}
        onChange={handleFileChange}
        aria-label={`选择图片文件 — ${label}`}
      />

      {/* 主区域: 点击 + 拖拽 */}
      <div
        ref={zoneRef}
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label}: 点击选择文件、拖拽图片到此处或粘贴剪贴板图片`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleClick();
        }}
        className={cn(
          "flex flex-col items-center justify-center rounded-[var(--r-xl)] border-2 border-dashed p-[var(--sp-8)] transition-colors cursor-pointer select-none",
          dragging
            ? "border-[var(--brand-500)] bg-[var(--brand-50)] scale-[1.01]"
            : "border-[var(--ink-200)] bg-[var(--surface-muted)] hover:border-[var(--brand-400)] hover:bg-[var(--brand-50)]/40",
          disabled && "opacity-50 cursor-not-allowed pointer-events-none"
        )}
      >
        <Upload
          className={cn(
            "h-8 w-8 mb-[var(--sp-2)]",
            dragging ? "text-[var(--brand-500)]" : "text-[var(--ink-300)]"
          )}
        />
        <p className="text-[var(--fs-md)] font-medium text-[var(--ink-700)]">{label}</p>
        <p className="text-[var(--fs-sm)] text-[var(--ink-400)] mt-1 text-center">
          点击选择文件&emsp;/&emsp;拖拽图片到此处&emsp;/&emsp;粘贴剪贴板图片
        </p>
      </div>

      {/* 主动粘贴按钮 (兜底: 当全局 paste 不触发时) */}
      {/* 保留原因: plain-text 链接形态 (无 border 无 background, 只 hover 颜色变化), 跟上方大块虚线拖拽区视觉一致, Button 加 border 会破坏链接观感 */}
      <button
        type="button"
        onClick={handlePasteBtn}
        disabled={disabled}
        className={cn(
          "mt-[var(--sp-2)] flex items-center gap-1.5 text-[var(--fs-xs)] text-[var(--ink-500)] hover:text-[var(--brand-600)] transition-colors",
          disabled && "opacity-40 cursor-not-allowed pointer-events-none"
        )}
        aria-label="从剪贴板读取图片并导入"
        title="如果直接粘贴没响应，可点这里主动从剪贴板读取图片"
      >
        <ClipboardPaste className="h-3.5 w-3.5" />
        从剪贴板导入图片
      </button>
    </div>
  );
}
