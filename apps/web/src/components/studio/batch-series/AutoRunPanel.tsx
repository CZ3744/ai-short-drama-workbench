/**
 * AutoRunPanel — 创建完自动跑设置.
 *
 * 从 BatchSeriesDialog 抽离.
 * 铁律 #1 用户控制权: 默认关闭
 * 铁律 #4 就近决策: 模式 + ModelPicker 贴开关旁边
 */

import { Icon } from "../../shared/Icon";
import { ModelPicker } from "../ModelPicker";

export interface AutoRunPanelProps {
  autoRunAfterCreate: boolean;
  onAutoRunAfterCreateChange: (v: boolean) => void;
  autoRunMode: "only_firstframes" | "only_element_images" | "full";
  onAutoRunModeChange: (v: "only_firstframes" | "only_element_images" | "full") => void;
  autoRunImageRef: string | null;
  onAutoRunImageRefChange: (v: string | null) => void;
  autoRunVideoRef: string | null;
  onAutoRunVideoRefChange: (v: string | null) => void;
}

export function AutoRunPanel({
  autoRunAfterCreate,
  onAutoRunAfterCreateChange,
  autoRunMode,
  onAutoRunModeChange,
  autoRunImageRef,
  onAutoRunImageRefChange,
  autoRunVideoRef,
  onAutoRunVideoRefChange,
}: AutoRunPanelProps) {
  return (
    <div
      style={{
        marginBottom: 18,
        padding: 14,
        borderRadius: 12,
        border: autoRunAfterCreate
          ? "1.5px solid var(--brand-300)"
          : "1px solid var(--ink-200)",
        background: autoRunAfterCreate
          ? "linear-gradient(135deg, var(--brand-50) 0%, #fff 80%)"
          : "var(--ink-50)",
        transition: "border-color 120ms, background 120ms",
      }}
    >
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--ink-900)",
        }}
      >
        <input
          type="checkbox"
          checked={autoRunAfterCreate}
          onChange={(e) => onAutoRunAfterCreateChange(e.target.checked)}
          style={{ width: 16, height: 16, cursor: "pointer" }}
        />
        <Icon name="sparkles" size={14} style={{ color: "var(--brand-600)" }} />
        创建完后,自动为每部剧的第 1 集生成素材
        <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-500)" }}>
          (可选 · 生成完去对应剧的合成页看成品)
        </span>
      </label>

      {autoRunAfterCreate && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <SmallLabel>运行模式</SmallLabel>
            {(
              [
                { value: "only_firstframes", label: "只抽首帧 (推荐, 不扣视频费)" },
                { value: "only_element_images", label: "只补素材图" },
                { value: "full", label: "全流程 (首帧+视频+合成)" },
              ] as const
            ).map((opt) => (
              <label
                key={opt.value}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 12,
                  cursor: "pointer",
                  color: autoRunMode === opt.value ? "var(--brand-700)" : "var(--ink-700)",
                  fontWeight: autoRunMode === opt.value ? 700 : 500,
                }}
              >
                <input
                  type="radio"
                  name="auto-run-mode"
                  value={opt.value}
                  checked={autoRunMode === opt.value}
                  onChange={() => onAutoRunModeChange(opt.value)}
                  style={{ cursor: "pointer" }}
                />
                {opt.label}
              </label>
            ))}
          </div>

          <div>
            <SmallLabel>图像模型 (生首帧 / 素材图)</SmallLabel>
            <ModelPicker
              kind="image"
              value={autoRunImageRef}
              onChange={onAutoRunImageRefChange}
              placeholder="选图像模型(可选, 默认走系列设置)"
              size="sm"
            />
          </div>

          {autoRunMode === "full" && (
            <div>
              <SmallLabel>视频模型 (i2v)</SmallLabel>
              <ModelPicker
                kind="video"
                value={autoRunVideoRef}
                onChange={onAutoRunVideoRefChange}
                placeholder="选视频模型(可选, 默认走系列设置)"
                size="sm"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SmallLabel({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.06em",
        color: "var(--ink-500)",
        textTransform: "uppercase",
        display: "block",
        marginBottom: 4,
      }}
    >
      {children}
    </label>
  );
}
