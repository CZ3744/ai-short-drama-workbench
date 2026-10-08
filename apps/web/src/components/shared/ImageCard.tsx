/**
 * ImageCard — 全项目通用图片卡片组件 (2026-05-20 抽出)
 *
 * 用户原话(2026-05-20 当面批"解耦信仰违反"):
 *   "这个事,我之前说没说过要解耦?只要你调用一次底层逻辑,以后就不用重复写,改的时候也好改,
 *    你刚才为什么就不能直接调用一个图片展示器呢?是没有还是怎么着?调用的话,图片底下的名称、
 *    可改名功能应该直接调过来不就行了吗,为什么你又在重写?"
 *
 * 此组件:
 *   - 单一图片卡片渲染(缩略 + display_name + 选中 / 主图 / 典型 角标 / 边框)
 *   - inline 改名(InlineLabel,需传 elementId,失败回退 + caller 接 onRenamed 回调)
 *   - 操作按钮 slot(variant="full" 时渲染,caller 自定义)
 *
 * 全项目所有"显示一张 element 图"的位置都应该调用这个组件,不再单独写卡片渲染.
 *
 * 三种 variant:
 *   - "compact"(默认):缩略图 + display_name (InlineLabel) — ChipDropdown / picker 用
 *   - "full":同 compact + 一排操作按钮(actionsSlot) — ElementImageGrid 单卡用
 *   - "readonly":同 compact 但不可编辑名字(纯展示) — PromptReviewModal / Lightbox 用
 *
 * 视觉一致性铁律(铁律 #8):
 *   - 三种 variant 缩略图区视觉完全一致, 只 actions / 编辑能力差别
 *   - selected / isPrimary / isTypical 边框 + 角标在所有 variant 都一致
 *   - 视觉与 ElementImageGrid 老实现保持像素级对齐 (用户验收过)
 */
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { patchElementImage, displayNameOfImage, type ElementImage } from "../../lib/elementApi";
import { imageThumbUrl } from "../../lib/imageThumb";
import { invalidateElements } from "../../lib/swrInvalidate";
import { showErrorToast } from "../../lib/errorTranslate";

export type ImageCardVariant = "compact" | "full" | "readonly";

export interface ImageCardProps {
  /** 单图数据 */
  image: ElementImage;
  /** 系列 slug — 拼缩略图 URL */
  slug: string;
  /**
   * 所属 element ID — 改名时用 patchElementImage(slug, elementId, imageId, ...).
   * 不传则禁用 inline 改名(显示 display_name 但不可编辑); compact / full 也降级为 readonly 名标签.
   */
  elementId?: string;
  /** 卡片是否选中态 — 控制 check 角标 + 蓝色边框高亮 */
  selected?: boolean;
  /** 是否主图(显示「主图」pill + 品牌色边框) */
  isPrimary?: boolean;
  /** 是否典型代表图(显示「⭐ 代表图」pill + 金色边框) */
  isTypical?: boolean;
  /** 是否在选用集(available_for_shot !== false)— 影响底部 pill 文案 / 颜色 */
  inRealPool?: boolean;
  /** 跨素材引用图来源 — 例如人物生图引用"旧怀表"的图时显示来源 chip */
  sourceElementName?: string;
  /**
   * 显示模式:
   *   - "compact"(默认):缩略图 + display_name(inline 编辑,如传 elementId) — ChipDropdown 用
   *   - "full":缩略图 + display_name + 一排操作按钮(actionsSlot) — ElementImageGrid 用
   *   - "readonly":缩略图 + display_name(不可编辑)— PromptReviewModal / CompareView 用
   */
  variant?: ImageCardVariant;
  /** 卡片点击 — 选中 / 进入 lightbox 等 */
  onClick?: (image: ElementImage) => void;
  /**
   * 改名成功回调(caller refresh SWR 等)— 不传则改完只在 local 显示.
   * 接收 (imageId, newName), caller 拿来 invalidate SWR / 更新 store.
   */
  onRenamed?: (imageId: string, newName: string) => void;
  /**
   * 自定义改名实现 (override 内置 patchElementImage 路径).
   * caller 传则用 caller 的 onSaveName(可做去重/长度/字符校验, throw 让 InlineLabel 回退).
   * 不传则走内置 patchElementImage(slug, elementId, imageId, ...) + onRenamed 回调.
   * 例: ElementWorkbench.handleRenameImage 含重名校验, 业务规则不能丢, 通过这个 prop 接进来.
   */
  onSaveName?: (newName: string) => Promise<void>;
  /**
   * variant="full" 时,操作按钮 slot — 设主图 / 设 typical / 废弃 / 改 angle 等.
   * 由 caller 定义,不在此组件硬编码业务按钮.
   */
  actionsSlot?: React.ReactNode;
  /**
   * 缩略图右下/左下 等额外角标 slot — caller 定义.
   * 例如 ElementImageGrid 在缩略图底部叠加"已选用 / 草稿池" pill,可放这里.
   */
  badgesSlot?: React.ReactNode;
  /**
   * 缩略图左上角额外角标 slot — caller 定义.
   * 例如 ElementImageGrid 显示 origin chip + angle chip,可放这里;
   * 若不传,默认渲染一个 origin chip (labelOfSource).
   */
  topLeftSlot?: React.ReactNode;
  /** display_name 没设时显示的灰色文字 (默认: displayNameOfImage 兜底) */
  fallbackLabel?: string;
  /** 自定义样式覆盖 */
  className?: string;
  style?: React.CSSProperties;
  /** 卡片整体宽度 — 默认 100%, ChipDropdown / picker 可强制固定宽 */
  width?: number | string;
  /** 缩略图区 aspect-ratio — 默认 "4 / 3",picker 常用 "1 / 1" */
  aspectRatio?: string;
  /** 进入编辑态时是否 stopPropagation(避免触发卡片 onClick).默认 true */
  stopRenameClickPropagation?: boolean;
}

/**
 * 边框颜色优先级: primary > typical > selected > inRealPool > default
 * 互斥, 只显一种.
 */
function computeBorder(
  isPrimary?: boolean,
  isTypical?: boolean,
  selected?: boolean,
  inRealPool?: boolean,
): string {
  if (isPrimary) return "2px solid var(--brand-500)";
  if (isTypical) return "2px solid var(--gold-500, #f59e0b)";
  if (selected) return "1.5px solid var(--brand-500, #7c3aed)";
  if (inRealPool) return "1px solid var(--info, #3b82f6)";
  return "1px solid var(--ink-200)";
}

export function ImageCard(props: ImageCardProps) {
  const {
    image,
    slug,
    elementId,
    selected = false,
    isPrimary = false,
    isTypical = false,
    inRealPool,
    sourceElementName,
    variant = "compact",
    onClick,
    onRenamed,
    onSaveName,
    actionsSlot,
    badgesSlot,
    topLeftSlot,
    fallbackLabel,
    className,
    style,
    width,
    aspectRatio = "4 / 3",
    stopRenameClickPropagation = true,
  } = props;

  // editable 条件: variant 不是 readonly, 并且要么 caller 传了 onSaveName, 要么传了 elementId(走内置 patch)
  const editable = variant !== "readonly" && (!!onSaveName || !!elementId);
  const thumbSrc = imageThumbUrl(slug, image);
  const computedFallback = fallbackLabel ?? displayNameOfImage(image);
  const border = computeBorder(isPrimary, isTypical, selected, inRealPool);

  // 2026-05-20 Wave T 第 7 次根因重构 — InlineLabel + forwardRef + useImperativeHandle 这条
  // 复杂路径 5 次重写都没让用户能编辑(Chrome MCP 实测 click 后 input 不出现, React state
  // 没 flush). 改用 ImageCard 内嵌 input + 自管 editing state,**完全绕开 InlineLabel** —
  // 这是最直接最可靠的方案,不依赖 ref forwarding / imperative handle / 跨组件 state.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(image.display_name ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 2026-05-20 Wave T 第 9 次根因 — onBlur 延迟 + refocus 取消, 防 ChipDropdown 内
  // input 刚渲染就 blur(用户描述"长拉蓝色瞬间被清空"). 即使有外部抢 focus 也能恢复.
  const blurTimerRef = useRef<number | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // 外部 image.display_name 变化时同步 draft (避免 SWR refresh 后 input 显示旧值)
  useEffect(() => {
    if (!editing) setDraft(image.display_name ?? "");
  }, [image.display_name, editing]);

  // 进入编辑态自动 focus + 全选(用 raf 确保 DOM 真 mount + 50ms 兜底再次 focus)
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    const focusInput = () => {
      if (cancelled) return;
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    };
    requestAnimationFrame(focusInput);
    const t1 = window.setTimeout(focusInput, 50);
    const t2 = window.setTimeout(focusInput, 200);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [editing]);

  // 卸载时清掉 blur timer
  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current);
    };
  }, []);

  async function commitName() {
    const trimmed = draft.trim();
    const current = (image.display_name ?? "").trim();
    if (trimmed === current) {
      setEditing(false);
      return;
    }
    try {
      await handleSaveName(trimmed);
      setEditing(false);
    } catch (e) {
      showErrorToast(e, "改名失败");
      setDraft(image.display_name ?? "");
    }
  }

  function cancelEdit() {
    setDraft(image.display_name ?? "");
    setEditing(false);
  }

  function enterEdit(e: React.MouseEvent) {
    if (!editable) return;
    e.stopPropagation();
    setEditing(true);
  }

  async function handleSaveName(newName: string) {
    const trimmed = newName.trim();
    // caller 提供了 onSaveName 时 override 内置 patch (caller 自己处理校验 + setElement)
    if (onSaveName) {
      await onSaveName(trimmed);
      onRenamed?.(image.image_id, trimmed);
      // 2026-05-20 Wave T — caller override 路径也要同步 SWR(caller 可能没做)
      void invalidateElements(slug);
      return;
    }
    if (!elementId) return;
    await patchElementImage(slug, elementId, image.image_id, {
      display_name: trimmed || undefined,
    });
    onRenamed?.(image.image_id, trimmed);
    // 2026-05-20 Wave T — 改名后同步所有用 elements 的页面 SWR cache(display_name 单一真理源)
    void invalidateElements(slug);
  }

  // ── 卡片整体容器 ────────────────────────────────────────────────────
  const containerStyle: React.CSSProperties = {
    padding: 0,
    overflow: "hidden",
    border,
    background: "var(--surface-card)",
    cursor: onClick ? "pointer" : undefined,
    display: "flex",
    flexDirection: "column",
    width: width ?? undefined,
    ...style,
  };

  // ── 缩略图区 ────────────────────────────────────────────────────────
  const thumbWrapperStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
    aspectRatio,
    background: "var(--surface-canvas, var(--ink-50))",
    overflow: "hidden",
  };

  const thumbImgStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
    cursor: onClick ? "zoom-in" : "default",
  };

  // 2026-05-20 Wave T 第 8 次根因 — 用户报"长拉蓝色瞬间被清空":
  //   鼠标点击 labelRow 时稍微移动, mouseup 落在缩略图上 → React click event target = 缩略图(不在 labelRow 内)
  //   → ImageCard outer onClick 触发 → onPick + onClose → ChipDropdown unmount → input 瞬间消失
  // 修法: 不在 outer div 上 onClick. 把 onClick 限制到缩略图区(thumbWrapper),
  //   labelRow 独立 handle 编辑路径. 两条路径完全独立, 鼠标无论怎么晃也不会抢事件.
  const handleThumbClick = onClick ? () => onClick(image) : undefined;

  return (
    <div
      className={className ? `mk-card ${className}` : "mk-card"}
      style={containerStyle}
    >
      {/* 缩略图区独立 onClick,跟 labelRow 完全互斥 */}
      <div
        style={{ ...thumbWrapperStyle, cursor: onClick ? "pointer" : "default" }}
        onClick={handleThumbClick}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "INPUT") {
                  onClick(image);
                }
              }
            : undefined
        }
        aria-label={onClick ? `选择 ${computedFallback}` : undefined}
      >
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={image.display_name?.trim() || computedFallback}
            loading="lazy"
            style={thumbImgStyle}
            title={onClick ? "点击放大查看 / 右键可复制图片" : undefined}
          />
        ) : (
          <div
            style={{
              display: "grid",
              placeItems: "center",
              width: "100%",
              height: "100%",
              background: "var(--ink-50)",
            }}
          >
            <Icon name="image" size={20} style={{ color: "var(--ink-400)" }} />
          </div>
        )}

        {/* 左上角自定义 slot (origin chip / angle chip 等) + 跨素材来源 chip */}
        {topLeftSlot || sourceElementName ? (
          <div
            style={{
              position: "absolute",
              top: 6,
              left: 6,
              display: "flex",
              gap: 4,
              alignItems: "center",
              flexWrap: "wrap",
              pointerEvents: "none",
              maxWidth: "calc(100% - 12px)",
            }}
          >
            {topLeftSlot}
            {sourceElementName ? (
              <span
                style={{
                  maxWidth: 120,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: 999,
                  background: "rgba(217,119,87,0.92)",
                  color: "#fff",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.16)",
                }}
                title={`来自:${sourceElementName}`}
              >
                来自:{sourceElementName}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* 选中态 check 角标 */}
        {selected ? (
          <span
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              width: 18,
              height: 18,
              borderRadius: 999,
              background: "var(--brand-500, #7c3aed)",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              zIndex: 2,
              boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
            }}
            aria-label="已选中"
          >
            <Icon name="check" size={10} />
          </span>
        ) : null}

        {/* 主图 / 典型 pill (右上角, 不与 selected check 抢位置 — selected 时不显)*/}
        {!selected && isPrimary ? (
          <span
            className="mk-pill mk-pill--approved"
            style={{ position: "absolute", top: 6, right: 6, fontSize: 10 }}
            title="主图"
          >
            主图
          </span>
        ) : !selected && isTypical ? (
          <span
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              fontSize: 10,
              fontWeight: 700,
              padding: "1px 6px",
              borderRadius: 999,
              background: "var(--gold-50, #fef3c7)",
              color: "var(--gold-700, #b45309)",
              border: "1px solid var(--gold-500, #f59e0b)",
            }}
            title="代表图 — 生分镜时自动作生图参考"
          >
            ⭐ 代表图
          </span>
        ) : null}

        {/* 2026-05-20 Wave T — 名字搬出 thumbWrapper, 放到下方独立行 (用户原话"图片名放在图片下面不是图片下半部分") */}
      </div>

      {/* 名字行 — 独立一行, 不覆盖图片. 整行(含 padding 区域)点击都进入编辑态 */}
      <div
        className="v24-card-label-row"
        onClick={editable && !editing ? enterEdit : undefined}
        onMouseDown={editable ? (e) => e.stopPropagation() : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          borderTop: "1px solid var(--ink-100)",
          background: "var(--surface-card)",
          minWidth: 0,
          cursor: editable ? "text" : "default",
        }}
      >
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={60}
            placeholder={computedFallback}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                if (blurTimerRef.current !== null) { clearTimeout(blurTimerRef.current); blurTimerRef.current = null; }
                void commitName();
              } else if (e.key === "Escape") {
                e.preventDefault();
                if (blurTimerRef.current !== null) { clearTimeout(blurTimerRef.current); blurTimerRef.current = null; }
                cancelEdit();
              }
            }}
            onFocus={() => {
              // 重新 focus 取消挂起的 commit (防 ChipDropdown 内 input 刚渲染就被某外部 focus 抢走)
              if (blurTimerRef.current !== null) {
                clearTimeout(blurTimerRef.current);
                blurTimerRef.current = null;
              }
            }}
            onBlur={() => {
              // 延迟 250ms 后 commit. 期间若 input 重新 focus(StrictMode 双 mount / 外部抢 focus race), 取消 commit.
              if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current);
              blurTimerRef.current = window.setTimeout(() => {
                blurTimerRef.current = null;
                if (editingRef.current) {
                  // 如果还在编辑态(没被外部 setEditing(false)), commit
                  void commitName();
                }
              }, 250);
            }}
            // 2026-05-20 Wave T — 让 Grammarly 等浏览器扩展不要拦截这个 input(用户报告改不了名,
            // console 显示安装了 Grammarly,它会注入事件 handler 拦截 React controlled input)
            data-gramm="false"
            data-gramm_editor="false"
            data-enable-grammarly="false"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              fontWeight: 600,
              padding: "2px 6px",
              borderRadius: 4,
              border: "1px solid var(--brand-500)",
              background: "var(--surface-card)",
              color: "var(--ink-900)",
              outline: "none",
            }}
          />
        ) : (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12,
              fontWeight: 600,
              color: image.display_name?.trim() ? "var(--ink-900)" : "var(--ink-500)",
              fontStyle: image.display_name?.trim() ? "normal" : "italic",
              textDecoration: editable ? "underline dashed" : "none",
              textDecorationColor: "var(--ink-300)",
              textUnderlineOffset: 3,
            }}
            title={editable
              ? `${image.display_name?.trim() || computedFallback} (点击改名)`
              : (image.display_name?.trim() || computedFallback)}
          >
            {image.display_name?.trim() || computedFallback}
          </span>
        )}
        {badgesSlot}
      </div>

      {/* variant=full 时操作按钮区 — 由 caller 完全自定义 */}
      {variant === "full" && actionsSlot ? (
        <div
          style={{
            padding: "8px 8px 6px",
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: 5,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {actionsSlot}
        </div>
      ) : null}
    </div>
  );
}

export default ImageCard;
