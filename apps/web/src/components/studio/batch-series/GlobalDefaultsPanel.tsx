/**
 * GlobalDefaultsPanel — 全局参数表单.
 *
 * 从 BatchSeriesDialog 抽离.
 */

import { Icon } from "../../shared/Icon";
import { type GlobalDefaults, ASPECT_OPTIONS, PLATFORM_OPTIONS } from "./batchStats";

export interface GlobalDefaultsPanelProps {
  defaults: GlobalDefaults;
  onChange: (g: GlobalDefaults) => void;
  disabled?: boolean;
}

export function GlobalDefaultsPanel({ defaults, onChange, disabled }: GlobalDefaultsPanelProps) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 12,
        border: "1px solid var(--ink-100)",
        background: "var(--ink-50)",
        marginBottom: 18,
      }}
    >
      <SectionLabel icon="layers">全局默认参数 (项目层没填的继承)</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <SmallLabel>默认画面比例</SmallLabel>
          <select
            value={defaults.aspect_ratio}
            onChange={(e) => onChange({ ...defaults, aspect_ratio: e.target.value })}
            disabled={disabled}
            style={inputStyle}
          >
            {ASPECT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <SmallLabel>默认平台</SmallLabel>
          <select
            value={defaults.platform}
            onChange={(e) => onChange({ ...defaults, platform: e.target.value })}
            disabled={disabled}
            style={inputStyle}
          >
            {PLATFORM_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <SmallLabel>默认每集时长 (秒)</SmallLabel>
          <input
            type="number"
            min={5}
            max={600}
            value={defaults.duration_per_episode_sec}
            onChange={(e) => onChange({ ...defaults, duration_per_episode_sec: e.target.value })}
            disabled={disabled}
            placeholder="例: 60"
            style={inputStyle}
          />
        </div>
        <div>
          <SmallLabel>默认风格</SmallLabel>
          <input
            value={defaults.style}
            onChange={(e) => onChange({ ...defaults, style: e.target.value })}
            disabled={disabled}
            placeholder="例: 悬疑 / 治愈 / 古风..."
            style={inputStyle}
          />
        </div>
      </div>
    </div>
  );
}

// ─── 局部 helper (同 BatchSeriesDialog 原版) ────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 36,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid var(--ink-200)",
  fontSize: 13,
  color: "var(--ink-900)",
  outline: "none",
  background: "#fff",
};

function SectionLabel({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: "sparkles" | "layers" | "film";
}) {
  return (
    <label
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.08em",
        color: "var(--ink-500)",
        textTransform: "uppercase",
        marginBottom: 8,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {icon && <Icon name={icon} size={11} style={{ color: "var(--brand-600)" }} />}
      {children}
    </label>
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
