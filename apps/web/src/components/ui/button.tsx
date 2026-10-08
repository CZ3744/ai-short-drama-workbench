// 2026-05-21 — 统一按钮组件 (解耦信仰: 单一真理源, 所有按钮走这一份).
//
// 用户原话: "我说没说组件要抽象, 直接调用同一套逻辑? 你又在不同地方分别写按钮实现干什么?
//   立即全面扫描所有按钮, 创建几个基本样式可调用, 然后各处直接复用需要的形态".
//
// 实现走 mk-btn CSS class (apps/web/src/styles/v24-utilities.css) —
// 视觉规格集中在 CSS, 这里只做 React API + 图标 + loading 封装,
// 避免内联 style 散落各处.
//
// 旧 Tailwind cva 实现 (variant: outline/link, size: lg/icon) 已废弃,
// 全部映射到 mk-btn class 体系. 旧 caller 不破: variant=outline → ghost, link → ghost,
// size=lg → md, size=icon → mk-btn--icon 方形.

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Slot } from "@radix-ui/react-slot";
import { Icon, type IconName } from "../shared/Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline" | "link";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon" | "icon-sm";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: ButtonVariant | null;
  size?: ButtonSize | null;
  /** 左侧图标 (IconName, 尺寸跟 size 联动) */
  iconLeft?: IconName;
  /** 右侧图标 (IconName, 尺寸跟 size 联动) */
  iconRight?: IconName;
  /** loading 时替换 iconLeft 为旋转 refresh + disabled */
  loading?: boolean;
  /** 占满父容器宽度 */
  block?: boolean;
  /** Radix Slot 模式: 把样式注入到子元素 (PopoverTrigger / NavLink 等场景) */
  asChild?: boolean;
  children?: React.ReactNode;
}

// 旧 variant 兼容映射: outline 没有专属 mk-btn--outline, 视觉上跟 ghost 一致 (描边 + 浅底).
// link 旧用法是裸文字链接, 也映射到 ghost 降级 (避免 ghost 描边过淡时跟旧 link 差异大).
const VARIANT_TO_MK: Record<ButtonVariant, string> = {
  primary: "mk-btn--primary",
  secondary: "mk-btn--secondary",
  ghost: "mk-btn--ghost",
  danger: "mk-btn--danger",
  outline: "mk-btn--ghost",
  link: "mk-btn--ghost",
};

// 旧 size 兼容: lg 退到 md (mk-btn 默认就是 32px), icon/icon-sm 退到 sm + mk-btn--icon.
const SIZE_TO_MK: Record<ButtonSize, string> = {
  xs: "mk-btn--xs",
  sm: "mk-btn--sm",
  md: "",
  lg: "",
  icon: "mk-btn--icon",
  "icon-sm": "mk-btn--sm mk-btn--icon",
};

const ICON_SIZE_BY_SIZE: Record<ButtonSize, number> = {
  xs: 11,
  sm: 13,
  md: 14,
  lg: 14,
  icon: 14,
  "icon-sm": 13,
};

/**
 * 统一按钮 — 全局入口.
 *
 * @example 标准用法
 *   <Button variant="primary" onClick={save}>保存</Button>
 *   <Button variant="ghost" size="sm" iconLeft="copy">复制</Button>
 *   <Button variant="danger" loading={busy} onClick={del}>删除</Button>
 *
 * @example asChild (Popover trigger 等)
 *   <PopoverTrigger asChild>
 *     <Button variant="ghost" asChild>
 *       <span>触发器自定义内容</span>
 *     </Button>
 *   </PopoverTrigger>
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    iconLeft,
    iconRight,
    loading = false,
    block = false,
    asChild = false,
    className,
    disabled,
    children,
    type = "button",
    style,
    ...rest
  },
  ref,
) {
  const v = variant ?? "secondary";
  const s = size ?? "md";
  const Comp: React.ElementType = asChild ? Slot : "button";
  const iconSize = ICON_SIZE_BY_SIZE[s];
  const finalClass = [
    "mk-btn",
    VARIANT_TO_MK[v],
    SIZE_TO_MK[s],
    className,
  ].filter(Boolean).join(" ");

  const finalStyle = block ? { width: "100%", ...style } : style;
  const isDisabled = disabled || loading;
  const effectiveIconLeft = loading ? "refresh" : iconLeft;

  return (
    <Comp
      ref={ref}
      className={finalClass}
      disabled={isDisabled}
      type={asChild ? undefined : type}
      style={finalStyle}
      {...rest}
    >
      {effectiveIconLeft ? (
        <Icon name={effectiveIconLeft} size={iconSize} className={loading ? "mk-spin" : undefined} />
      ) : null}
      {children}
      {iconRight && !loading ? <Icon name={iconRight} size={iconSize} /> : null}
    </Comp>
  );
});

// 保留 buttonVariants 导出以避免外部 import 破坏 (有 ui/index.ts re-export)
export const buttonVariants = (opts?: { variant?: ButtonVariant; size?: ButtonSize; className?: string }) => {
  const v = opts?.variant ?? "secondary";
  const s = opts?.size ?? "md";
  return [
    "mk-btn",
    VARIANT_TO_MK[v],
    SIZE_TO_MK[s],
    opts?.className,
  ].filter(Boolean).join(" ");
};
