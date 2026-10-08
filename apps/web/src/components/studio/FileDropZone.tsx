import { useState, useCallback, type DragEvent, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { Upload, FileText, Image as ImageIcon, Film, X } from "../shared/LucideIcon";
import { AnimatePresence, motion } from "framer-motion";

export interface FileDropZoneProps extends Omit<HTMLAttributes<HTMLDivElement>, "onDrop"> {
  onDrop?: (files: File[]) => void;
  accept?: string[];
  maxFiles?: number;
  disabled?: boolean;
  label?: string;
  description?: string;
}

/**
 * 拖拽上传，支持 txt/md/docx/pdf/image。
 */
export function FileDropZone({
  onDrop,
  accept = [".txt", ".md", ".docx", ".pdf", ".png", ".jpg", ".jpeg", ".webp"],
  maxFiles = 5,
  disabled,
  label = "拖拽文件到这里",
  description,
  className,
  ...props
}: FileDropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (!disabled) setDragging(true);
  }, [disabled]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (disabled) return;
      const dropped = Array.from(e.dataTransfer.files).slice(0, maxFiles);
      setFiles((prev) => [...prev, ...dropped].slice(0, maxFiles));
      onDrop?.(dropped);
    },
    [disabled, maxFiles, onDrop]
  );

  const handleRemove = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const getIcon = (name: string) => {
    if (/\.(png|jpe?g|webp|gif)$/i.test(name)) return <ImageIcon className="h-4 w-4" />;
    if (/\.(mp4|mov|webm)$/i.test(name)) return <Film className="h-4 w-4" />;
    return <FileText className="h-4 w-4" />;
  };

  return (
    <div className={cn("w-full", className)} {...props}>
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "flex flex-col items-center justify-center rounded-[var(--r-xl)] border-2 border-dashed p-[var(--sp-10)] transition-colors cursor-pointer",
          dragging
            ? "border-[var(--brand-500)] bg-[var(--brand-50)]"
            : "border-[var(--ink-200)] bg-[var(--surface-muted)] hover:border-[var(--ink-300)]",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <Upload className={cn("h-10 w-10 mb-[var(--sp-3)]", dragging ? "text-[var(--brand-500)]" : "text-[var(--ink-300)]")} />
        <p className="text-[var(--fs-md)] font-medium text-[var(--ink-700)]">{label}</p>
        <p className="text-[var(--fs-sm)] text-[var(--ink-400)] mt-1">
          {description ?? `支持 ${accept.join(" ")} 等格式`}
        </p>
      </div>

      {/* 已上传文件列表 */}
      <AnimatePresence>
        {files.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-[var(--sp-3)] space-y-2"
          >
            {files.map((f, i) => (
              <motion.div
                key={`${f.name}-${i}`}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--surface-card)] px-3 py-2 border border-[var(--ink-100)]"
              >
                {getIcon(f.name)}
                <span className="flex-1 text-[var(--fs-sm)] text-[var(--ink-700)] truncate">{f.name}</span>
                <span className="text-[var(--fs-xs)] text-[var(--ink-400)]">
                  {(f.size / 1024).toFixed(0)}KB
                </span>
                {/* 保留原因: list-row 内嵌的 plain-text X 删除按钮 — 无 border 无 background, 只 hover 颜色变化, Button 加 border 会破坏 row 内视觉 */}
                <button
                  onClick={() => handleRemove(i)}
                  className="text-[var(--ink-400)] hover:text-[var(--err)] transition-colors"
                  aria-label={`移除文件 ${f.name}`}
                  title="移除"
                >
                  <X className="h-4 w-4" />
                </button>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
