/**
 * FailedTaskTile — 失败卡 (把失败 task 直接显示在候选位).
 *   铁律 #3 信息直接可见 + 铁律 #11 按钮有名字
 *
 * 2026-05-27 重构: 卡内只显示精简 friendly (一句话原因), 不再塞 raw HTML body
 * (200px 宽的卡放 502 整个 HTML 就是看不清). "看完整错误"按钮打开 ErrorDetailModal,
 * 全屏宽的弹窗显示 friendly + 排查建议 + raw 完整体 + 复制.
 *
 * 统一 image / video — 通过 kind 区分文案 + 默认 aspectRatio. 真正的失败提示生成
 * 在 hooks 层 resolveTaskFailureMessage 共享函数, 改一份等于两边都改.
 */
import { useState } from "react";
import { Icon } from "../../../components/shared/Icon";
import { Button } from "../../../components/ui/button";
import { ModelPicker } from "../../../components/studio/ModelPicker";
import { ErrorDetailModal } from "../../../components/shared/ErrorDetailModal";
import { friendlyTaskError } from "../../../lib/sourceLabels";
import type { TaskRecord } from "../../../stores/tasksStore";

export function FailedTaskTile({
  task, modelRef, onModelRefChange, onPreviewPrompt, onRetry, onDismiss, kind = "image", aspectRatio,
}: {
  task: TaskRecord;
  modelRef: string | null;
  onModelRefChange: (v: string | null) => void;
  /** 复制提示词按钮 */
  onPreviewPrompt: () => void;
  /** 用当前 modelRef 重新生成 */
  onRetry: () => void;
  /** 关掉这张失败卡(把 task 从 store 删除) */
  onDismiss: () => void;
  kind?: "image" | "video";
  /** 2026-05-22: 跟剧本身 aspect 一致, fallback 按 kind */
  aspectRatio?: string;
}) {
  // 卡片内只显示翻译后的精简文案 — raw 全文走 ErrorDetailModal 看
  const rawError = task.error_message ?? "";
  const friendly = rawError ? friendlyTaskError(rawError) : "生成未完成, 可重试";
  const finalAspect = aspectRatio ?? (kind === "video" ? "16/9" : "1/1");
  const kindLabel = kind === "video" ? "视频生成" : "首帧生成";

  // ErrorDetailModal 开关
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <div
      style={{
        borderRadius: 7,
        border: "1.5px solid rgba(220,38,38,0.55)",
        padding: 6,
        background: "rgba(254,242,242,0.6)",
        position: "relative",
      }}
      title="生成失败 — 你可以换模型或加修改后重抽"
    >
      <div style={{
        position: "relative",
        minHeight: 140,
        aspectRatio: finalAspect,
        borderRadius: 5, overflow: "hidden",
        background: "var(--ink-50)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: 12, gap: 8, textAlign: "center",
        color: "rgba(220,38,38,0.95)",
      }}>
        <Icon name="warning" size={22} />
        <span style={{ fontSize: 11.5, fontWeight: 700 }}>
          {kindLabel}失败
        </span>
        {/* 卡内只放 friendly 一句话, 限高 3 行, 想看完整走 modal */}
        <span style={{
          fontSize: 10.5, color: "var(--ink-700)",
          lineHeight: 1.5,
          wordBreak: "break-word",
          maxHeight: 48,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
        }}>
          {friendly}
        </span>
        {/* 看完整错误 — 打开 modal 显示 raw + 排查建议 + 复制 */}
        {rawError && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDetailOpen(true); }}
            style={{
              fontSize: 11, color: "var(--brand-700)", fontWeight: 600,
              background: "var(--surface-card)",
              border: "1px solid var(--ink-200)",
              borderRadius: 4,
              padding: "3px 8px",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
            title="打开完整错误详情 — 含原始错误体 + 排查建议 + 一键复制"
          >
            <Icon name="info" size={11} />
            看完整错误 →
          </button>
        )}
        {/* 右上 dismiss */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          style={{
            position: "absolute", top: 4, right: 4,
            width: 20, height: 20, borderRadius: 999,
            border: "1px solid var(--ink-200)", background: "var(--surface-card)",
            color: "var(--ink-600)", cursor: "pointer",
            display: "grid", placeItems: "center",
          }}
          title="关闭此失败卡(任务已记录, 不影响后续重试)"
        >
          <Icon name="close" size={10} />
        </button>
      </div>
      {/* 底部操作行 — 嵌入 ModelPicker + 提示词 + 重新生成 (铁律 #2 #4 #11) */}
      <div style={{
        marginTop: 6, display: "flex", flexDirection: "column", gap: 5,
      }}>
        <ModelPicker
          kind={kind}
          value={modelRef}
          onChange={onModelRefChange}
          size="sm"
          placeholder={kind === "video" ? "选择生视频模型" : "选择生图模型"}
        />
        <div style={{ display: "flex", gap: 4 }}>
          <Button
            variant="secondary"
            size="xs"
            iconLeft="doc"
            onClick={(e) => { e.stopPropagation(); onPreviewPrompt(); }}
            style={{ flex: 1 }}
            title="查看完整提示词 — 可复制走外部生成"
          >
            提示词
          </Button>
          <Button
            variant="primary"
            size="xs"
            iconLeft="refresh"
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            style={{ flex: 1 }}
            disabled={!modelRef}
            title={modelRef ? "用上方选定的模型重新生成一张" : "请先选择模型"}
          >
            重新生成
          </Button>
        </div>
      </div>

      {/* 完整错误详情弹窗 — 用户点"看完整错误"才挂载 */}
      <ErrorDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        friendly={friendly}
        raw={rawError}
        kindLabel={kindLabel}
        onRetry={onRetry}
      />
    </div>
  );
}
