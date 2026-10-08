/**
 * CameraMovementSelect — 运镜参数选择器 (B-4).
 *   - 预设 chip + tooltip description + 自定义文本框
 *   - 预设命中 → chip 高亮, description 显示在气泡
 *   - 自定义 → 直接输入, chip 取消高亮
 *   - 铁律 #1: 用户控制权 > 系统智能, 允许任意自定义
 *
 * 视觉零变更. 从 ShotStagePage 拆出 (P2 #16).
 */
import { useState } from "react";
import {
  CAMERA_MOVEMENT_PRESETS,
  CAMERA_MOVEMENT_PRESET_MAP,
  cameraMovementDisplayLabel,
} from "../../../lib/cameraMovementPresets";
import { inputStyle } from "./styles";

export function CameraMovementSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isCustom = value && !CAMERA_MOVEMENT_PRESET_MAP[value];
  const [hoverVal, setHoverVal] = useState<string | null>(null);
  const hoveredPreset = hoverVal ? CAMERA_MOVEMENT_PRESET_MAP[hoverVal] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* 预设 chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, position: "relative" }}>
        {CAMERA_MOVEMENT_PRESETS.map((p) => (
          // 保留原因: mk-chip 已建立的非-mk-btn 语义 class (规则 1) — 预设运镜 chip 形态
          <button
            key={p.value}
            type="button"
            title={p.description}
            onClick={() => onChange(value === p.value ? "" : p.value)}
            onMouseEnter={() => setHoverVal(p.value)}
            onMouseLeave={() => setHoverVal(null)}
            className={value === p.value ? "mk-chip mk-chip--brand" : "mk-chip"}
            style={{ cursor: "pointer", height: 24, fontSize: 11, padding: "0 8px", position: "relative" }}
          >
            {p.label}
          </button>
        ))}
      </div>
      {/* hover description 气泡 */}
      {hoveredPreset && (
        <div style={{
          fontSize: 10.5, color: "var(--ink-500)",
          background: "var(--ink-50)", border: "1px solid var(--ink-150)",
          borderRadius: 5, padding: "3px 8px", lineHeight: 1.5,
        }}>
          {hoveredPreset.label}：{hoveredPreset.description}
        </div>
      )}
      {/* 自定义文本框 */}
      <input
        value={isCustom ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="自定义运镜描述（直接输入）"
        style={{ ...inputStyle, height: 28, fontSize: 11.5 }}
      />
      {/* 当前值展示（非空且是预设时提示） */}
      {value && CAMERA_MOVEMENT_PRESET_MAP[value] && (
        <div style={{ fontSize: 10, color: "var(--ink-400)" }}>
          已选：{cameraMovementDisplayLabel(value)} — {CAMERA_MOVEMENT_PRESET_MAP[value].description}
        </div>
      )}
    </div>
  );
}
