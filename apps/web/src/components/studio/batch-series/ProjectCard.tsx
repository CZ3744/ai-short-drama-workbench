/**
 * ProjectCard — 单项目卡 (标题 / 集数 / 灵感 / advanced).
 *
 * 从 BatchSeriesDialog 抽离.
 */

import { Icon } from "../../shared/Icon";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { TitleConflictHint } from "../TitleConflictHint";
import { type ProjectSlot, ASPECT_OPTIONS, PLATFORM_OPTIONS } from "./batchStats";

export interface ProjectCardProps {
  slot: ProjectSlot;
  index: number;
  canRemove: boolean;
  onChange: (patch: Partial<ProjectSlot>) => void;
  onRemove: () => void;
  /** 已有系列 title 列表 (重名检测用) */
  existingTitles?: string[];
}

export function ProjectCard({ slot, index, canRemove, onChange, onRemove, existingTitles = [] }: ProjectCardProps) {
  return (
    <div
      className="mk-card"
      style={{
        padding: 14,
        borderRadius: 12,
        border: "1px solid var(--ink-200)",
        background: "#fff",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* 顶部 chip 一行: 项目编号 + 集数 + 删除 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            padding: "3px 10px",
            borderRadius: 999,
            background: "linear-gradient(135deg, var(--brand-50), var(--brand-100))",
            border: "1px solid var(--brand-200)",
            fontSize: 12,
            fontWeight: 700,
            color: "var(--brand-700)",
            whiteSpace: "nowrap",
          }}
        >
          项目 {index + 1}
        </div>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--ink-700)",
          }}
        >
          集数:
          <input
            type="number"
            min={1}
            max={20}
            value={slot.episode_count}
            onChange={(e) => onChange({ episode_count: e.target.value })}
            placeholder="自定"
            style={{
              width: 60,
              height: 28,
              padding: "0 8px",
              borderRadius: 6,
              border: "1px solid var(--ink-200)",
              fontSize: 12,
              outline: "none",
              background: "#fff",
              textAlign: "center",
            }}
          />
        </label>
        <span style={{ flex: 1 }} />
        {canRemove && (
          <Button
            variant="danger"
            size="sm"
            iconLeft="trash"
            onClick={onRemove}
            title="删除该项目"
          >
            删除
          </Button>
        )}
      </div>

      {/* 标题 */}
      <div>
        <SmallLabel>系列标题 (可选)</SmallLabel>
        <input
          value={slot.series_title}
          onChange={(e) => onChange({ series_title: e.target.value })}
          placeholder="留空让 AI 起名"
          style={inputStyle}
        />
        <TitleConflictHint title={slot.series_title} existingTitles={existingTitles} />
      </div>

      {/* 灵感 */}
      <div>
        <SmallLabel>灵感 / 指示 (可选)</SmallLabel>
        <Textarea
          value={slot.inspiration}
          onChange={(e) => onChange({ inspiration: e.target.value })}
          placeholder="例: 失忆的女程序员发现自己的过去线索..."
          rows={3}
          className="font-serif text-[13px] leading-[1.5]"
        />
      </div>

      {/* 高级折叠 */}
      <div>
        <Button
          variant="ghost"
          size="xs"
          iconLeft={slot.advancedOpen ? "arrowUp" : "chevDown"}
          onClick={() => onChange({ advancedOpen: !slot.advancedOpen })}
          title={slot.advancedOpen ? "收起高级参数" : "展开高级参数 (留空继承全局)"}
        >
          {slot.advancedOpen ? "收起高级参数" : "展开高级参数 (可选, 留空继承全局)"}
        </Button>

        {slot.advancedOpen && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 8,
              background: "var(--ink-50)",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
            }}
          >
            <div>
              <SmallLabel>每集时长 (秒)</SmallLabel>
              <input
                type="number"
                min={5}
                max={600}
                value={slot.duration_per_episode_sec}
                onChange={(e) => onChange({ duration_per_episode_sec: e.target.value })}
                placeholder="继承全局"
                style={inputStyle}
              />
            </div>
            <div>
              <SmallLabel>画面比例</SmallLabel>
              <select
                value={slot.aspect_ratio}
                onChange={(e) => onChange({ aspect_ratio: e.target.value })}
                style={inputStyle}
              >
                <option value="">继承全局</option>
                {ASPECT_OPTIONS.filter((o) => o.value !== "").map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <SmallLabel>投放平台</SmallLabel>
              <select
                value={slot.platform}
                onChange={(e) => onChange({ platform: e.target.value })}
                style={inputStyle}
              >
                <option value="">继承全局</option>
                {PLATFORM_OPTIONS.filter((o) => o.value !== "").map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <SmallLabel>风格 / 题材</SmallLabel>
              <input
                value={slot.style}
                onChange={(e) => onChange({ style: e.target.value })}
                placeholder="继承全局"
                style={inputStyle}
              />
            </div>
          </div>
        )}
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
