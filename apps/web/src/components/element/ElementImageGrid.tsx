/**
 * ElementImageGrid — 图库瀑布流 + 每张图的操作按钮 (§11)
 *
 * 展示 element.images 列表，支持：
 * - 主图标记（品牌色边框）
 * - 设为主图 / 用此图微调(RegenModal 一站式) / 复制提示词 / 入废案
 *
 * 2026-05-16 五件 UX 反馈 5: 删除"彻底删"按钮 (用户原话"在这里不需要彻底删除功能,
 * 不要的直接移到废案库就行,废案库里再彻底清理"). onDelete prop 整条移除.
 * 入废案在父层包 confirm — 铁律 #6 数据保留.
 *
 * 2026-05-20 单卡迁 ImageCard (解耦信仰): 每张图的渲染走 <ImageCard variant="full"
 * actionsSlot={...} />, 不再各自手写缩略图 / display_name / 边框 / pill 等. 视觉与
 * 之前 ElementImageGrid 老实现保持像素级一致 (用户验收过).
 */

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../shared/Icon";
import { ImageCard } from "../shared/ImageCard";
import { formatBeijingTime } from "../../lib/format";
import { ImageDropZone } from "../shared/ImageDropZone";
import type { ElementAngle, ElementImage, ImageTag } from "../../lib/elementApi";
import {
  ELEMENT_ANGLE_LABEL,
  ELEMENT_ANGLE_ORDER,
  IMAGE_TAG_AXES,
  IMAGE_TAG_AXIS_LABEL,
} from "../../lib/elementApi";
import { labelOfSource } from "../../lib/sourceLabels";
import { showErrorToast } from "../../lib/errorTranslate";
import { Button } from "../ui/button";

export interface ElementImageGridProps {
  images: ElementImage[];
  primaryImageId?: string;
  /** 系列 slug — ImageCard 内置 inline 改名需要(走 patchElementImage) */
  slug: string;
  /** element id — ImageCard 内置 inline 改名需要 */
  elementId: string;
  /** W8-A: 仅 kind=character 时显示角度 chip / 打标 dropdown(其他 kind 隐藏). */
  showAngleControls?: boolean;
  onSetPrimary: (imageId: string) => void;
  /** 取消主图锚定 — 图片保留, 仅清空 primary_image_id (铁律 #6). 不传则取消按钮不显示. */
  onClearPrimary?: () => void;
  onCopyPrompt: (image: ElementImage) => void;
  onReject: (imageId: string) => void;
  /**
   * 2026-05-16 反馈 5: 删除"彻底删"按钮.
   * 此 prop 已废弃, 仅保留作向后兼容(传了也不渲染). caller 直接不传即可.
   */
  onDelete?: (imageId: string) => void;
  onImportLocal: (files: FileList | null) => void;
  /** W8-A: 给图片打 / 取消角度标签(传 null 取消). 不传则 dropdown 隐藏. */
  onSetAngle?: (imageId: string, angle: ElementAngle | null) => void;
  /**
   * W2 (2026-05-26): 给图片打 / 更新维度标签 (pose/expression/outfit/lighting/free).
   * 不传则维度标签按钮隐藏 (caller 不支持此功能).
   */
  onSetImageTags?: (imageId: string, tags: ImageTag[]) => Promise<void>;
  /**
   * W8-sweep (2026-05-16): 点击候选图缩略 → 父组件接管放大查看(MediaLightbox).
   * 不传则点图无放大入口(老行为). 推荐 caller 接 MediaLightbox.
   */
  onOpenImage?: (image: ElementImage) => void;
  /**
   * W8-sweep: 点击"用此图微调重抽"按钮 → 父组件弹 RegenModal (一站式).
   * 不传则不显示该按钮.
   */
  onRegen?: (image: ElementImage) => void;
  /**
   * 2026-05-19 #2: inline 重命名 — 用户原话"图片名直接点击就编辑, 不要走重命名按钮 modal".
   * 签名改为接收 newName 参数, throw 让 InlineLabel 显回退.
   * caller (ElementWorkbench) 内部做去重 / 长度 / 字符校验, 异常 throw.
   *
   * 2026-05-20: ImageCard 通过 onSaveName override 接住这个回调, 业务校验完全保留.
   */
  onRename?: (image: ElementImage, newName: string) => Promise<void>;
  onToggleAvailable?: (image: ElementImage, next: boolean) => void;
  /**
   * 2026-05-18 三池模型: 用户点"⭐ 标为典型" / "取消典型".
   * - typical=true → 自动作 reference_images 一并发给生图模型
   * - typical=false → 仍可在真池里挑选, 但不自动作 reference
   * 不传 = 该 caller 没接通典型管理 (历史 caller 向后兼容).
   */
  onToggleTypical?: (image: ElementImage, next: boolean) => void;
  rejectCount?: number;

  /**
   * 2026-05-16 渐进式落盘 — 生成中的"骨架占位卡"数量.
   * 用户原话: "回来一张落盘一张, 其他未完成请求在图库该落盘的地方做生成中占位."
   *
   * pendingSkeletonCount = max(0, total - completed); caller (Workbench) 通过
   * useImageGeneration().totalRequested - partialReceived 算出来传进来.
   * 0 时不渲染任何 skeleton.
   */
  pendingSkeletonCount?: number;

  /**
   * 渐进式落盘进度文案数据 — 给每个 skeleton 卡贴 "第 K/N 张生成中..." 文字标签.
   * 不传则文案为简化版.
   */
  pendingProgress?: { completed: number; total: number };
  /** 系列宽高比 CSS 值, 传给 SkeletonCard 使 placeholder 与真图比例一致. 默认 "4/3". */
  aspectRatio?: string;
}

// 将 File[] 适配为旧的 FileList 接口
function filesToFileList(files: File[]): FileList {
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  return dt.files;
}

// W7-element-ux: 候选图按钮统一样式 — 圆角矩形 + 边框 + 图标 + 文字 + 分级配色
//   主操作"设为主图" → 品牌色填充
//   "用此图微调"     → 品牌色填充(RegenModal 一站式入口)
//   "复制提示词"     → 默认 secondary
//   "入废案"+"彻底删除" → 红描边/红填充
//
// 2026-05-16: 按钮区改 3×2 grid,按钮要能在 grid cell 内自适应宽度 —
// 不用 whiteSpace: nowrap 让文字溢出,minWidth: 0 让 grid item 可缩。
const gridBtnBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  height: 26,
  padding: "0 6px",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  minWidth: 0,
  background: "var(--surface-card)",
  transition: "background-color 120ms, border-color 120ms",
};

export function ElementImageGrid(props: ElementImageGridProps) {
  const {
    images,
    primaryImageId,
    slug,
    elementId,
    showAngleControls = false,
    onSetPrimary,
    onClearPrimary,
    onCopyPrompt,
    onReject,
    onImportLocal,
    onSetAngle,
    onSetImageTags,
    onOpenImage,
    onRegen,
    onRename,
    onToggleAvailable,
    onToggleTypical,
    rejectCount = 0,
    pendingSkeletonCount = 0,
    pendingProgress,
    aspectRatio = "4/3",
  } = props;
  // 2026-05-16 反馈 5: onDelete 已废弃, 解构丢弃以免 ts unused-warn
  void props.onDelete;

  const handleImportFiles = (files: File[]) => {
    onImportLocal(filesToFileList(files));
  };

  // 2026-05-16 渐进式落盘: skeleton 卡 = 整数 [0..pendingSkeletonCount). 渲染在真实图前面.
  // 用户原话: "回来一张落盘一张, 其他未完成请求在图库该落盘的地方做生成中占位."
  const skeletonCards =
    pendingSkeletonCount > 0
      ? Array.from({ length: pendingSkeletonCount }, (_, i) => i)
      : [];
  const showSkeletons = skeletonCards.length > 0;
  // 2026-05-18 三池模型统计:
  //   typical = 主图级别(自动作 reference,带 ⭐ 金边)
  //   real    = 真素材池(可被分镜挑选)
  //   raw     = 原始素材(犹豫未决,不入真池)
  const typicalCount = images.filter((im) => im.is_typical === true).length;
  const availableCount = images.filter((im) => im.available_for_shot !== false).length;
  const rawCount = images.length - availableCount;

  // 2026-05-27 — 已选用 / 主图 / 代表图排前面 (用户原话: "选用的素材要放在前面").
  // 排序优先级:
  //   1. 主图 (primary, image_id === primaryImageId) — 最优先, 列表卡片封面
  //   2. 代表图 (is_typical=true) — 自动作生图参考
  //   3. 选用集 (available_for_shot !== false) — 可被分镜挑选
  //   4. 草稿池 (available_for_shot === false) — 未确认要用
  // 同分内保持原顺序 (后端按生成时间) — JS sort 是 stable.
  const sortedImages = useMemo(() => {
    const score = (im: ElementImage): number => {
      if (im.image_id === primaryImageId) return 0;
      if (im.is_typical === true) return 1;
      if (im.available_for_shot !== false) return 2;
      return 3;
    };
    return [...images].sort((a, b) => score(a) - score(b));
  }, [images, primaryImageId]);

  return (
    <div className="mk-card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div className="mk-label">
          {/* 2026-05-19 #1 文案改造 — 真池→选用集, 原始→草稿池 (toC 友好) */}
          图库 · <span title="标 ⭐ 自动作生图参考的代表图" style={{ color: "var(--brand-700, #c2410c)", fontWeight: 700 }}>{typicalCount} 代表图</span>
          <span> · </span>
          <span title="已确认要用、可被分镜挑选的图(含代表图)">{availableCount} 选用集</span>
          {rawCount > 0 ? (<><span> · </span><span title="抽卡落盘但未确认是否要用(草稿,只在本素材内可见)" style={{ color: "var(--ink-500)" }}>{rawCount} 草稿池</span></>) : null}
          {rejectCount > 0 ? (<><span> · </span><span title="已废弃">{rejectCount} 废案</span></>) : null}
          {showSkeletons && pendingProgress ? (
            <span style={{ marginLeft: 8, color: "var(--brand-700, #c2410c)", fontSize: 11, fontWeight: 500 }}>
              · 正在生成 {pendingProgress.completed}/{pendingProgress.total} 张
            </span>
          ) : null}
        </div>
      </div>

      {/* W7-element-ux: 粘贴/拖拽导入区默认始终可见(铁律 #3 信息直接可见 + #10 优雅空状态 CTA) */}
      <div style={{ marginBottom: 12 }}>
        <ImageDropZone
          onImport={handleImportFiles}
          label="导入图片到图库"
          accept="image/*"
          multiple
        />
      </div>

      {images.length === 0 && !showSkeletons ? (
        <div style={{ fontSize: 12.5, color: "var(--ink-400)", padding: "12px 0 4px" }}>
          还没有图。下方"生成"标签页 AI 生图,或直接在上方导入区拖拽 / 粘贴 / 点击选文件。
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 10,
          }}
        >
          {/* skeleton 占位卡 — 渲染在真实图前, 用户从上到下逐个看到生成中 → 真图 替换 */}
          {skeletonCards.map((idx) => {
            const order = (pendingProgress?.completed ?? 0) + idx + 1;
            const total = pendingProgress?.total ?? skeletonCards.length;
            return (
              <SkeletonCard key={`__pending_${idx}`} order={order} total={total} aspectRatio={aspectRatio} />
            );
          })}
          {sortedImages.map((im) => {
            const isPrimary = im.image_id === primaryImageId;
            const isTypical = im.is_typical === true;
            const inRealPool = im.available_for_shot !== false; // 默认 true 历史兼容

            // 三池 pill (底部 badgesSlot) — 视觉与老实现 1:1 对齐
            const poolBadge = (
              <span
                className="mk-pill"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: isTypical
                    ? "var(--gold-700, #b45309)"
                    : inRealPool
                      ? "var(--info-700, #1d4ed8)"
                      : "var(--ink-500)",
                  background: "var(--surface-card)",
                  border: `1px solid ${isTypical ? "var(--gold-500, #f59e0b)" : inRealPool ? "var(--info, #3b82f6)" : "var(--ink-300)"}`,
                }}
                title={isTypical ? "代表图(自动作生图参考)" : inRealPool ? "选用集(可被分镜挑选)" : "草稿池(尚未确认要用)"}
              >
                {isTypical ? "⭐ 代表图" : inRealPool ? "已选用" : "草稿"}
              </span>
            );

            // 左上角 chip (origin + angle 字段 + W2 image_tags 维度; ImageCard topLeftSlot wrapper 默认 pointer-events:none
            // 让点击穿透到外层 onClick → lightbox)
            const tagsForChip = (im.image_tags ?? []).filter((t) => t.axis && t.value);
            const topLeftChips = (
              <>
                <span
                  className="mk-chip mk-chip--ghost"
                  style={{ fontSize: 10 }}
                >
                  {labelOfSource(im.origin)}
                </span>
                {showAngleControls && im.angle ? (
                  <span
                    className="mk-chip"
                    style={{
                      fontSize: 10,
                      background: "var(--info-bg, #dbeafe)",
                      color: "var(--info-700, #1d4ed8)",
                      border: "1px solid var(--info, #3b82f6)",
                      padding: "1px 6px",
                      borderRadius: 999,
                    }}
                    title={`已标记为「${ELEMENT_ANGLE_LABEL[im.angle]}」角度参考`}
                  >
                    <Icon name="user" size={9} /> {ELEMENT_ANGLE_LABEL[im.angle]}
                  </span>
                ) : null}
                {/* W2 (2026-05-26): 维度标签 chip 在角度 chip 之后, 最多显示 3 条防溢出 */}
                {tagsForChip.slice(0, 3).map((t, ti) => (
                  <span
                    key={`tag_${ti}`}
                    className="mk-chip"
                    style={{
                      fontSize: 10,
                      background: "var(--brand-50, #fff4ec)",
                      color: "var(--brand-700, #c2410c)",
                      border: "1px solid var(--brand-300, rgba(217,119,87,0.5))",
                      padding: "1px 6px",
                      borderRadius: 999,
                    }}
                    title={`图片标签: ${IMAGE_TAG_AXIS_LABEL[t.axis] ?? t.axis} = ${t.value}`}
                  >
                    {(IMAGE_TAG_AXIS_LABEL[t.axis] ?? t.axis)}: {t.value}
                  </span>
                ))}
                {tagsForChip.length > 3 ? (
                  <span
                    className="mk-chip mk-chip--ghost"
                    style={{ fontSize: 10 }}
                    title={tagsForChip.slice(3).map((t) => `${IMAGE_TAG_AXIS_LABEL[t.axis] ?? t.axis}: ${t.value}`).join(" · ")}
                  >
                    +{tagsForChip.length - 3}
                  </span>
                ) : null}
              </>
            );

            // 操作按钮 slot — 完全保留老实现的所有按钮 + 顺序 + 配色 + 提示
            const actions = (
              <>
                {/* W8-A: 角度打标自定义 dropdown(铁律 #7/#8/#11) */}
                {showAngleControls && onSetAngle ? (
                  <AngleDropdown
                    imageId={im.image_id}
                    angle={im.angle ?? null}
                    onSetAngle={onSetAngle}
                  />
                ) : null}
                {/* W2 (2026-05-26): 维度标签弹窗按钮 (pose/expression/outfit/lighting/free) */}
                {onSetImageTags ? (
                  <ImageTagsButton
                    imageId={im.image_id}
                    tags={im.image_tags ?? []}
                    onSave={(next) => onSetImageTags(im.image_id, next)}
                  />
                ) : null}
                {isPrimary ? (
                  onClearPrimary ? (
                    <Button
                      variant="secondary"
                      size="xs"
                      iconLeft="pin"
                      onClick={onClearPrimary}
                      title="取消主图锚定 — 主图 = 列表卡片封面(单张). 取消后图片保留, 列表回到默认首图"
                    >
                      取消主图
                    </Button>
                  ) : null
                ) : (
                  <Button
                    variant="primary"
                    size="xs"
                    iconLeft="pin"
                    onClick={() => onSetPrimary(im.image_id)}
                    title="设为主图 — 列表卡片封面(单张). 不影响生图参考集. 想多角度参考请用 ⭐ 代表图"
                  >
                    设为主图 · 封面
                  </Button>
                )}
                {/* W8-sweep (2026-05-16): "用此图微调重抽" — 一站式入口(对照 ShotStagePage RegenModal). */}
                {onRegen ? (
                  <Button
                    variant="primary"
                    size="xs"
                    iconLeft="sparkles"
                    onClick={() => onRegen(im)}
                    title="用此图作参考底图 + 加修改意见,弹窗里一步完成重抽"
                  >
                    用此图微调
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  size="xs"
                  iconLeft="copy"
                  onClick={() => onCopyPrompt(im)}
                  title="复制这张图生成时用的完整提示词"
                >
                  复制提示词
                </Button>
                {/* 2026-05-18 三池模型按钮组 */}
                {onToggleTypical && !isPrimary ? (
                  <Button
                    variant="secondary"
                    size="xs"
                    iconLeft={isTypical ? "slash" : "sparkles"}
                    onClick={() => onToggleTypical(im, !isTypical)}
                    title={
                      isTypical
                        ? "取消代表图标记 — 代表图 = 多角度/多形象参考集(可多张). 取消后不再自动作生图参考,但仍在选用集里可被分镜挑选"
                        : "标为代表图 — 多角度/多形象参考集(可多张). 分镜抽卡 + 同元素抽新图时自动一并发给模型,保持五官统一. 与主图(单张封面)不同"
                    }
                  >
                    {isTypical ? "取消代表" : "⭐ 设为代表图 · 参考集"}
                  </Button>
                ) : null}
                {onToggleAvailable && !isPrimary && !isTypical ? (
                  <Button
                    variant="secondary"
                    size="xs"
                    iconLeft={!inRealPool ? "check" : "slash"}
                    onClick={() => onToggleAvailable(im, !inRealPool)}
                    title={!inRealPool ? "纳入选用集 — 可被分镜挑选" : "退回草稿池 — 暂不被分镜显示(仅在本素材内可见)"}
                  >
                    {!inRealPool ? "纳入选用" : "退回草稿"}
                  </Button>
                ) : null}
                <Button
                  variant="danger"
                  size="xs"
                  iconLeft="warning"
                  onClick={() => onReject(im.image_id)}
                  title="移入该素材的废案库(可恢复) — 点击有二次确认"
                >
                  入废案
                </Button>
              </>
            );

            // 2026-05-27 — 用户原话"不要只写生成来源的模型名字, 多了之后就乱了不好记".
            // display_name 没设时, fallback 显示 "代表图 / 选用 / 草稿 · #N · 14:47" —
            // N 按创建时间正序的本元素内稳定序号, 时间是北京时间 HH:MM.
            const indexByCreation =
              [...sortedImages]
                .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
                .findIndex((x) => x.image_id === im.image_id) + 1;
            const poolPart = isTypical ? "代表图" : inRealPool ? "选用" : "草稿";
            let timePart = "";
            if (im.created_at) {
              try {
                const fmt = formatBeijingTime(im.created_at, { mode: "short" });
                const m = fmt.match(/(\d{2}:\d{2})/);
                timePart = m ? m[1] : fmt;
              } catch { /* noop */ }
            }
            const richFallback = [poolPart, `#${indexByCreation}/${sortedImages.length}`, timePart]
              .filter(Boolean)
              .join(" · ");

            return (
              <ImageCard
                key={im.image_id}
                image={im}
                slug={slug}
                elementId={elementId}
                variant="full"
                isPrimary={isPrimary}
                isTypical={isTypical}
                inRealPool={inRealPool}
                topLeftSlot={topLeftChips}
                badgesSlot={poolBadge}
                actionsSlot={actions}
                fallbackLabel={richFallback}
                onClick={onOpenImage ? () => onOpenImage(im) : undefined}
                // ElementWorkbench 含重名/长度/字符校验, override 内置 patch
                onSaveName={onRename ? (newName) => onRename(im, newName) : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── AngleDropdown ────────────────────────────────────────────────────────────
// 铁律 #7 标准创作工具语义:自定义浮层菜单代替原生 <select>
// 铁律 #8 视觉一致性:与项目 mk-chip 风格对齐
// 铁律 #11 按钮有名字:默认 CTA "标角度",已选时显示角度名

interface AngleDropdownProps {
  imageId: string;
  angle: ElementAngle | null;
  onSetAngle: (imageId: string, angle: ElementAngle | null) => void;
}

function AngleDropdown({ imageId, angle, onSetAngle }: AngleDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭 — 铁律 #7 标准创作工具交互
  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const hasAngle = !!angle;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          ...gridBtnBase,
          background: hasAngle ? "var(--info-bg, #dbeafe)" : "var(--surface-card)",
          border: `1px solid ${hasAngle ? "var(--info, #3b82f6)" : "var(--ink-200)"}`,
          color: hasAngle ? "var(--info-700, #1d4ed8)" : "var(--ink-600)",
        }}
        title="给这张图打一个角度标签(正脸/侧脸/全身等),代表图集就会显示它作为该角度的代表"
      >
        <Icon name="user" size={11} />
        {hasAngle ? ELEMENT_ANGLE_LABEL[angle!] : "标角度"}
        <Icon name="chevDown" size={10} />
      </button>
      {open ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 40,
            background: "var(--surface-card)",
            border: "1px solid var(--ink-200)",
            borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            minWidth: 120,
            padding: "4px 0",
          }}
        >
          <button
            type="button"
            onClick={() => { onSetAngle(imageId, null); setOpen(false); }}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "5px 12px",
              fontSize: 11,
              fontWeight: 500,
              background: !hasAngle ? "var(--ink-50, #f8f8f8)" : "transparent",
              color: "var(--ink-500)",
              cursor: "pointer",
              border: "none",
            }}
          >
            未指定
          </button>
          {ELEMENT_ANGLE_ORDER.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => { onSetAngle(imageId, a); setOpen(false); }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "5px 12px",
                fontSize: 11,
                fontWeight: 500,
                background: angle === a ? "var(--info-bg, #dbeafe)" : "transparent",
                color: angle === a ? "var(--info-700, #1d4ed8)" : "var(--ink-800)",
                cursor: "pointer",
                border: "none",
              }}
            >
              {ELEMENT_ANGLE_LABEL[a]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ─── ImageTagsButton (W2 2026-05-26) ────────────────────────────────────
// 维度标签弹窗按钮:点开后显示 5 个 axis 段落, 每段一个 input chip 让用户填 value.
// 保存 = 调 onSave(下游 patchElementImage 落 image_tags).
//
// 铁律 #11 按钮有名字: "维度标签" 文字 + tag icon, 不准 icon-only.
// 铁律 #8 视觉一致性: 跟 AngleDropdown 同款定位 + 浮层风格.

interface ImageTagsButtonProps {
  imageId: string;
  tags: ImageTag[];
  onSave: (next: ImageTag[]) => Promise<void>;
}

function ImageTagsButton({ imageId, tags, onSave }: ImageTagsButtonProps) {
  void imageId;
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const containerRef = useRef<HTMLDivElement>(null);

  // 弹窗打开时, 把现有 tags 加载进 draft (按 axis 取值)
  useEffect(() => {
    if (!open) return;
    const initial: Record<string, string> = {};
    for (const ax of IMAGE_TAG_AXES) {
      const t = tags.find((x) => x.axis === ax.key);
      initial[ax.key] = t?.value ?? "";
    }
    setDraftValues(initial);
  }, [open, tags]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const hasTags = tags.filter((t) => t.value).length > 0;

  async function handleSave() {
    setSaving(true);
    try {
      const next: ImageTag[] = [];
      for (const [k, v] of Object.entries(draftValues)) {
        const val = v.trim();
        if (val) next.push({ axis: k, value: val });
      }
      await onSave(next);
      setOpen(false);
    } catch (e) {
      // P1-33 (2026-05-28 audit wave 4): caller (handleSetImageTags) 只 throw 不 toast, 这里单点
      // 处理 toast, 保留弹窗 + 输入. 老 bug: caller toast + 这里 finally 看似没 toast 但是 throw
      // 后 unhandled rejection, 现在合并到这里一处.
      showErrorToast(e, "保存维度标签失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          ...gridBtnBase,
          background: hasTags ? "var(--brand-50, #fff4ec)" : "var(--surface-card)",
          border: `1px solid ${hasTags ? "var(--brand-300, rgba(217,119,87,0.5))" : "var(--ink-200)"}`,
          color: hasTags ? "var(--brand-700, #c2410c)" : "var(--ink-600)",
        }}
        title="给这张图打标签 (姿势/表情/造型等). 分镜抽帧时按标签过滤代表图."
      >
        <Icon name="layers" size={11} />
        {hasTags ? `图片标签 (${tags.filter((t) => t.value).length})` : "图片标签"}
      </button>
      {open ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            background: "var(--surface-card)",
            border: "1px solid var(--ink-200)",
            borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.16)",
            minWidth: 240,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-700)", marginBottom: 2 }}>
            图片标签 (留空 = 不打这一项)
          </div>
          {IMAGE_TAG_AXES.map((ax) => (
            <div key={ax.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ minWidth: 56, fontSize: 11, color: "var(--ink-600)", fontWeight: 500 }}>
                {ax.label}
              </label>
              <input
                type="text"
                value={draftValues[ax.key] ?? ""}
                onChange={(e) => setDraftValues((prev) => ({ ...prev, [ax.key]: e.target.value }))}
                placeholder={ax.placeholder}
                maxLength={60}
                style={{
                  flex: 1,
                  height: 26,
                  padding: "0 8px",
                  fontSize: 11.5,
                  border: "1px solid var(--ink-200)",
                  borderRadius: 4,
                  background: "var(--surface-canvas)",
                  color: "var(--ink-800)",
                }}
              />
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 4, justifyContent: "flex-end" }}>
            <Button variant="ghost" size="xs" iconLeft="close" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="xs" iconLeft="check" onClick={handleSave} disabled={saving} loading={saving}>
              {saving ? "保存中..." : "保存图片标签"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── SkeletonCard ─────────────────────────────────────────────────────
// 2026-05-16 渐进式落盘: 生成中占位卡, 与真实图卡视觉一致(铁律 #8) — 同 aspect-ratio,
// 灰底 + 旋转 spinner + 文字标签 "第 K/N 张生成中..." (铁律 #11 按钮有名字 ↔ skeleton 有标签).

interface SkeletonCardProps {
  order: number;
  total: number;
  aspectRatio?: string;
}

function SkeletonCard({ order, total, aspectRatio = "4/3" }: SkeletonCardProps) {
  return (
    <div
      className="mk-card"
      style={{
        padding: 0,
        overflow: "hidden",
        border: "1px dashed var(--brand-300, rgba(217,119,87,0.4))",
        background: "var(--surface-card)",
      }}
      role="status"
      aria-live="polite"
      aria-label={`第 ${order} / ${total} 张生成中`}
    >
      <div
        style={{
          width: "100%",
          aspectRatio: aspectRatio,
          background:
            "linear-gradient(135deg, var(--surface-canvas, #fafafa) 0%, var(--ink-50, #f3f4f6) 100%)",
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <SkeletonSpinner />
        <span
          style={{
            fontSize: 11.5,
            color: "var(--brand-700, #c2410c)",
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 999,
            background: "var(--surface-card)",
            border: "1px solid var(--brand-200, rgba(217,119,87,0.3))",
          }}
        >
          第 {order} / {total} 张生成中…
        </span>
      </div>
      <div
        style={{
          padding: "8px 8px 6px",
          fontSize: 11,
          color: "var(--ink-400)",
          textAlign: "center",
        }}
      >
        生成完成后自动出现在这里
      </div>
    </div>
  );
}

// 简化版 CSS spinner — 不引第三方动画库, 用 inline keyframes via <style>
function SkeletonSpinner() {
  return (
    <>
      <style>{`
        @keyframes mk-skeleton-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div
        style={{
          width: 28,
          height: 28,
          border: "3px solid var(--ink-200, #e5e7eb)",
          borderTopColor: "var(--brand-600, #d97757)",
          borderRadius: "50%",
          animation: "mk-skeleton-spin 0.9s linear infinite",
        }}
      />
    </>
  );
}

export default ElementImageGrid;
