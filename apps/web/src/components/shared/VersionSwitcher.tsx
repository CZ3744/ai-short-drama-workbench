/**
 * VersionSwitcher — W6-B 通用版本切换器
 *
 * 一个无业务耦合的 UI 组件，用来在剧本/分镜/任何带"多版本"概念的页面顶部展示并切换版本。
 *
 * 设计参考用户痛点 #11 + UX 铁律：
 *   - 不 icon-only（始终带"版本"字样 + 当前激活版本名）
 *   - 删除是软删，二次确认 by parent（onDelete 由调用方接 prompt-dialog）
 *   - 不强制跳转，激活操作不改变路由
 *
 * 任何带 versions[] 的页面都可以直接放：
 *   <VersionSwitcher
 *     versions={scriptVersions.versions}
 *     onActivate={scriptVersions.activate}
 *     onCreate={() => scriptVersions.create({})}
 *     onDelete={scriptVersions.remove}
 *   />
 */

import { useMemo, useState } from "react";
import {
  Badge,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "../ui";
import { ChevronDown } from "./LucideIcon";
import { useConfirm } from "../ui/ConfirmModal";

// ─── Props ───────────────────────────────────────────────────────────

export interface VersionSummary {
  id: string;
  /** 用户可见名称，默认显示为按钮主标签 */
  name: string;
  created_at: string;
  is_active: boolean;
}

export interface VersionSwitcherProps {
  /** 版本列表（建议按 created_at 升序，本组件不再重排序） */
  versions: VersionSummary[];
  /** 点击激活一个版本（保证幂等：激活当前版本应仍可调） */
  onActivate: (id: string) => void | Promise<void>;
  /** 新建一个版本（可选，传则展示"+ 新建版本"按钮） */
  onCreate?: () => void | Promise<void>;
  /** 软删一个版本（可选；调用方负责二次确认） */
  onDelete?: (id: string) => void | Promise<void>;
  /** 标签前缀，默认"剧本版本"。其他业务可改成"分镜版本"等 */
  label?: string;
  /** 加载/disabled */
  disabled?: boolean;
  /** 容器额外 className */
  className?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatCreatedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

// ─── Component ──────────────────────────────────────────────────────

export function VersionSwitcher(props: VersionSwitcherProps) {
  const { versions, onActivate, onCreate, onDelete, label = "剧本版本", disabled = false, className } = props;
  const [open, setOpen] = useState(false);
  const confirm = useConfirm();

  const active = useMemo(() => versions.find((v) => v.is_active), [versions]);
  const inactiveSorted = useMemo(
    () => versions.filter((v) => !v.is_active).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [versions],
  );

  const hasVersions = versions.length > 0;

  // trigger 视觉与 ui/Select chip 风格统一 (2026-05-19 #15) — 圆角 8 / 高 34 / 边框 ink-200 / hover brand /
  // prefix chip 灰色小字 + label 主字 + 激活 Badge + ▾ 图标. 全项目下拉一个 look-and-feel.
  return (
    <div className={["inline-flex items-center gap-2", className].filter(Boolean).join(" ")}>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          type="button"
          disabled={disabled || !hasVersions}
          aria-label={`${label}切换器`}
          className="inline-flex items-center gap-[6px] transition-colors hover:border-[var(--brand-500)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:cursor-not-allowed disabled:opacity-55"
          style={{
            height: 34,
            padding: "0 10px 0 12px",
            borderRadius: 8,
            border: "1px solid var(--ink-200, #c7c1b9)",
            background: "var(--surface-card, #ffffff)",
            fontSize: 13,
            color: "var(--ink-700)",
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: "var(--ink-500)",
              letterSpacing: "0.04em",
              flexShrink: 0,
            }}
          >
            {label}
          </span>
          {active ? (
            <>
              <span
                style={{ fontWeight: 600, color: "var(--ink-900)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {active.name}
              </span>
              <Badge variant="brand" className="text-[10px]">激活</Badge>
            </>
          ) : (
            <span style={{ color: "var(--ink-500)" }}>{hasVersions ? "未激活" : "暂无版本"}</span>
          )}
          <ChevronDown size={14} className="text-[var(--ink-400)] flex-shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[260px]">
          <DropdownMenuLabel>{label}（共 {versions.length} 个）</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {versions.length === 0 ? (
            <div className="px-3 py-2 text-xs opacity-60">还没有版本</div>
          ) : (
            <>
              {/* Active first */}
              {active && (
                <DropdownMenuItem
                  key={active.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    void onActivate(active.id);
                  }}
                  className="flex flex-col items-start gap-0.5"
                >
                  <div className="flex w-full items-center gap-2">
                    <span className="font-medium truncate flex-1">{active.name}</span>
                    <Badge variant="brand" className="text-[10px]">激活</Badge>
                  </div>
                  <div className="text-[11px] opacity-60">{formatCreatedAt(active.created_at)}</div>
                </DropdownMenuItem>
              )}
              {inactiveSorted.length > 0 && active && <DropdownMenuSeparator />}
              {inactiveSorted.map((v) => (
                <DropdownMenuItem
                  key={v.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    setOpen(false);
                    void onActivate(v.id);
                  }}
                  className="flex flex-col items-start gap-0.5"
                >
                  <div className="flex w-full items-center gap-2">
                    <span className="truncate flex-1">{v.name}</span>
                    {/* 保留原因: dropdown item 内嵌的 plain-text 次要 action — opacity hover, 不能套 Button (Button border 会破坏 DropdownMenuItem 行视觉) */}
                    {onDelete && (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          setOpen(false);
                          const ok = await confirm({
                            title: "删除版本",
                            description: `删除版本「${v.name}」后无法恢复，确定吗？`,
                            confirmLabel: "删除",
                            variant: "destructive",
                          });
                          if (ok) void onDelete(v.id);
                        }}
                        className="text-[11px] opacity-70 hover:opacity-100 hover:text-destructive"
                        aria-label={`删除版本 ${v.name}`}
                      >
                        删除
                      </button>
                    )}
                  </div>
                  <div className="text-[11px] opacity-60">{formatCreatedAt(v.created_at)}</div>
                </DropdownMenuItem>
              ))}
            </>
          )}
          {onCreate && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  void onCreate();
                }}
              >
                <span className="text-primary">+ 新建版本（快照当前）</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
