/**
 * Select — 统一下拉组件 (2026-05-19 重构)
 *
 * 设计目标 (用户反馈 2026-05-19 #15):
 *   - 全项目下拉视觉风格统一,不允许各处 native <select> 各自写 mk-select / ad-hoc 样式
 *   - chip 风格收起态: 圆角 8 / 高 34 (sm 26) / 边框 ink-200 / hover brand
 *   - 支持 group 分组 (二级菜单),取代 native <optgroup>
 *   - 收起态可显前缀 chip (例 "图像" / "视频"),取代 ModelPicker 外面套 chip + 内嵌 <select> 的左右失衡
 *
 * 底层: 仍用 @radix-ui/react-select — Radix 已经处理 ESC 关闭 / 点外面关闭 / Enter 选中 / 键盘导航 /
 *       Portal 渲染 / aria 属性,自己重写一遍是浪费。Radix 不能定制视觉的部分,我们通过覆盖
 *       trigger/content/item 的样式来满足"chip 风格 + 自定义视觉"。
 *
 * 历史: 旧的 select.tsx 只支持 { value, label } 一维 options + 没有 prefix/size/group。
 *       本次扩展兼容旧调用方 (NewProviderDialog / PresetSelect / CoverEditor),所有新字段都是 optional。
 *
 * 红线 (CLAUDE.md UX 铁律):
 *   - #11 每个按钮都有名字: trigger 默认展示完整 label,不允许 icon-only
 *   - #4 视觉一致性: 同一 Select 组件,只是 props 不同
 *   - #5 真实保存: onValueChange 触发即生效,不缓存
 */

import type { ReactNode } from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { cn } from "../../lib/cn";
import { ChevronDown, Check } from "../shared/LucideIcon";

// ─── Types ───────────────────────────────────────────────────────────

export interface SelectOption {
  /** 选项 value (空字符串不允许,Radix 会警告) */
  value: string;
  /** 用户可见标签 */
  label: string;
  /** 二级提示文字 (显示在 label 下方,小灰字) */
  description?: string;
  /** 禁用单项 */
  disabled?: boolean;
  /** 分组 (二级菜单) — 同一 group 的 option 会归到一组,显示组标题 */
  group?: string;
}

export interface SelectProps {
  /** 当前选中 value, null/undefined = placeholder */
  value?: string | null;
  /** 旧 API: onValueChange (Radix 风格) */
  onValueChange?: (value: string) => void;
  /** 新 API: onChange (常规风格) — 与 onValueChange 等价,两者择一传 */
  onChange?: (value: string) => void;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  /** 选项列表,新建议带 group 字段 */
  options: SelectOption[];
  className?: string;
  /** chip 风格收起态尺寸 — sm = 26px 高 (紧凑场景如分镜卡), md = 34px 高 (一般表单, 默认) */
  size?: "sm" | "md";
  /** 收起态前缀 chip (例: "图像" / "视频" / "长度") — 灰色小字,大写 letter-spacing */
  prefix?: string;
  /** 前置图标 — 例 Icon name="bolt" */
  icon?: ReactNode;
  /** aria-label,无 prefix 时强烈建议传 */
  ariaLabel?: string;
  /** 不显示边框 (无边界场景,例如塞在另一容器内) */
  borderless?: boolean;
  /** trigger 最大宽度,超出 ellipsis */
  maxWidth?: number;
}

// ─── Group helper ────────────────────────────────────────────────────

/**
 * 把扁平 options 按 group 字段聚合。
 * 没 group 的归入 null (后面渲染时跳过分组标题,直接平铺)。
 * 顺序按首次出现稳定 (不重排序)。
 */
function groupOptions(options: SelectOption[]): Array<{ label: string | null; items: SelectOption[] }> {
  const buckets = new Map<string, SelectOption[]>();
  const nullBucket: SelectOption[] = [];
  const order: string[] = [];
  for (const opt of options) {
    const key = opt.group?.trim();
    if (!key) {
      nullBucket.push(opt);
      continue;
    }
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(opt);
  }
  const result: Array<{ label: string | null; items: SelectOption[] }> = [];
  // 无 group 的先平铺 (放最前)
  if (nullBucket.length > 0) result.push({ label: null, items: nullBucket });
  for (const k of order) result.push({ label: k, items: buckets.get(k)! });
  return result;
}

// ─── Component ───────────────────────────────────────────────────────

export function Select({
  value,
  onValueChange,
  onChange,
  defaultValue,
  placeholder = "请选择...",
  disabled,
  error,
  options,
  className,
  size = "md",
  prefix,
  icon,
  ariaLabel,
  borderless = false,
  maxWidth,
}: SelectProps) {
  // 兼容 onValueChange / onChange 两套 API
  const handleChange = (v: string) => {
    onValueChange?.(v);
    onChange?.(v);
  };

  // 当前 value 的 label (用于 trigger 显示)
  const currentOption = value != null ? options.find((o) => o.value === value) : undefined;

  // 尺寸 token
  const h = size === "sm" ? 26 : 34;
  const fz = size === "sm" ? 11 : 13;
  const padX = size === "sm" ? 8 : 12;

  const grouped = groupOptions(
    options.filter((opt) => {
      if (opt.value === "") {
        if (import.meta.env.DEV) console.warn("[Select] option value 不能为空字符串,已过滤", opt);
        return false;
      }
      return true;
    })
  );

  return (
    <RadixSelect.Root
      // 2026-05-27 — value 永远给 string, null/undefined 给 "" 而不是 undefined.
      // 之前 `value ?? undefined` 在初始 SWR 没数据时给 undefined, Radix 当作未受控;
      // 数据到了 value 变 string, 又当作受控 → console 警告"Select is changing from
      // uncontrolled to controlled". 空字符串保持永远受控 (没匹配选项时显示 placeholder).
      value={value ?? ""}
      onValueChange={handleChange}
      defaultValue={defaultValue}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        aria-label={ariaLabel || prefix || placeholder}
        className={cn(
          "inline-flex items-center gap-[6px] transition-colors",
          "focus:outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30",
          "disabled:cursor-not-allowed disabled:opacity-55",
          "hover:border-[var(--brand-500)]",
          "data-[placeholder]:text-[var(--ink-500)]",
          className
        )}
        style={{
          height: h,
          padding: `0 ${padX - 2}px 0 ${padX}px`,
          borderRadius: 8,
          border: borderless ? "none" : `1px solid ${error ? "var(--err, #c83c3c)" : "var(--ink-200, #c7c1b9)"}`,
          backgroundColor: borderless ? "transparent" : "var(--surface-card, #ffffff)",
          fontSize: fz,
          color: "var(--ink-700)",
          maxWidth: maxWidth,
          minWidth: 0,
        }}
      >
        {icon ? <span style={{ display: "inline-flex", flexShrink: 0, color: "var(--brand-600)" }}>{icon}</span> : null}
        {prefix ? (
          <span
            style={{
              fontSize: Math.max(10, fz - 2),
              color: "var(--ink-500)",
              letterSpacing: "0.04em",
              flexShrink: 0,
            }}
          >
            {prefix}
          </span>
        ) : null}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: currentOption ? 600 : 400,
            color: currentOption ? "var(--ink-900)" : "var(--ink-500)",
            textAlign: "left",
          }}
        >
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon style={{ flexShrink: 0, marginLeft: 2 }}>
          <ChevronDown size={size === "sm" ? 12 : 14} className="text-[var(--ink-400)]" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          className="z-[var(--z-popover)] overflow-hidden rounded-[10px] bg-white shadow-[var(--shadow-lg)] border border-[var(--ink-100)]"
          position="popper"
          sideOffset={4}
        >
          <RadixSelect.Viewport className="p-1 max-h-[320px] overflow-y-auto">
            {grouped.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[var(--ink-400)]">无选项</div>
            ) : (
              grouped.map((grp, gi) => (
                <RadixSelect.Group key={grp.label ?? `__null__${gi}`}>
                  {grp.label ? (
                    <RadixSelect.Label
                      className="px-3 pt-2 pb-1 text-[10px] font-semibold text-[var(--ink-400)] tracking-wider uppercase select-none"
                    >
                      {grp.label}
                    </RadixSelect.Label>
                  ) : null}
                  {grp.items.map((opt) => (
                    <RadixSelect.Item
                      key={opt.value}
                      value={opt.value}
                      disabled={opt.disabled}
                      className={cn(
                        "relative flex flex-col items-start gap-0.5 pl-8 pr-3 rounded-[var(--r-sm)] outline-none cursor-pointer select-none",
                        "py-[6px] text-[var(--fs-sm)] text-[var(--ink-700)]",
                        "data-[highlighted]:bg-[var(--brand-50)] data-[highlighted]:text-[var(--ink-950)]",
                        "data-[state=checked]:text-[var(--brand-600)] data-[state=checked]:font-medium",
                        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                      )}
                    >
                      <RadixSelect.ItemIndicator className="absolute left-2 top-[8px] inline-flex items-center justify-center">
                        <Check size={14} />
                      </RadixSelect.ItemIndicator>
                      <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                      {opt.description ? (
                        <span className="text-[11px] text-[var(--ink-400)] font-normal leading-tight">
                          {opt.description}
                        </span>
                      ) : null}
                    </RadixSelect.Item>
                  ))}
                </RadixSelect.Group>
              ))
            )}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
