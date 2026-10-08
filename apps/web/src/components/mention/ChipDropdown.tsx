/**
 * ChipDropdown — 画面描述 textarea 里点击 @ chip 弹出的图选择下拉.
 *
 * 2026-05-20 用户原话:
 *   "如果是仅仅 @素材名比如 @小林,那么我点击 @小林这个整体,应该有一个下拉框方便我选用
 *    素材库里已经确认的哪张图,默认用主图,这个下拉框要涵盖这个元素的所有图,
 *    并且最右边一列方便打勾选用哪张。"
 *
 * 后续用户当面纠正 (2026-05-20):
 *   "同时输出多张图片那视频模型能明白吗, 到底用哪张每个地方只用特定的一张,
 *    没选的话默认主图"
 *
 * ── 设计 ───────────────────────────────────────────────────────────
 *
 * 单图主图语义:
 *   - 每个 mention 在每个 shot 只用 1 张图
 *   - 默认 = element.primary_image_id 对应的图 (主图)
 *   - 用户可单镜级 override 选第 N 张 (写到 shot.reference_overrides)
 *   - 与 ReferenceOverridePanel 写同一字段, SWR 自动同步
 *
 * UI:
 *   - 弹出小卡片下拉框 (类似 dropdown), 列该 element 所有图 + 默认主图选项
 *   - 单选 (radio): [默认 - 主图] + 每张可选图
 *   - 每个 option 显示缩略图 + display_name + 右上角 check 角标
 *   - 默认主图卡片显示真主图缩略图 (让用户直观看到默认会用哪张)
 *
 * 2026-05-20 解耦改造: 每个图选项走 <ImageCard variant="compact" /> 共享渲染, 不再重写
 * 缩略 + display_name + 选中 check + 边框. 用户原话"调用一个图片展示器".
 *
 * 数据流:
 *   - element 数据通过 props 注入 (上层 Hook 拉)
 *   - onPick(image_id | null) 由 caller 持有, 走 patchShot + SWR mutate
 *
 * 铁律:
 *   - #4 就近决策: 点 chip 就近选图, 不需要跳别处
 *   - #5 真实保存: 真写 shot.reference_overrides
 *   - #9 toC 兜底: "默认 - 主图" / display_name 全人话
 *   - #11 每按钮有名字: 选项卡有文字
 *   - #13 含全部图片: 列该 element 所有 image, 不遗漏
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../shared/Icon";
import { ImageCard } from "../shared/ImageCard";
import { Button } from "../ui/button";
import { patchElementImage, displayNameOfImage, type ElementData, type ElementImage } from "../../lib/elementApi";
import { invalidateElements } from "../../lib/swrInvalidate";

export interface ChipDropdownProps {
  /** 系列 slug — 用于拼缩略图 URL */
  slug: string;
  /** 被点击的 element (角色/场景/物件,统一视图) */
  element: ElementData | null;
  /** 当前已 override 的 image_id (null = 用默认主图) */
  currentImageId: string | null;
  /**
   * 用户选了某张 (image_id) 或选了默认 (null) 时回调.
   * caller 自己处理 patchShot + SWR mutate.
   */
  onPick: (imageId: string | null) => void;
  /** 关闭下拉 — 点外部 / Esc */
  onClose: () => void;
  /**
   * 锚点 — 触发本下拉的 chip 元素的 bounding rect.
   * 用于决定下拉位置 (默认在 chip 下方).
   */
  anchorRect: DOMRect | null;
}

/** 该图能作 reference 的最小条件: available_for_shot !== false */
function isAvailable(img: ElementImage): boolean {
  return img.available_for_shot !== false;
}

export function ChipDropdown(props: ChipDropdownProps) {
  const { slug, element, currentImageId, onPick, onClose, anchorRect } = props;
  const containerRef = useRef<HTMLDivElement>(null);

  // 2026-05-20 用户原话 + 文档"display_name 体系全工作台同步":
  //   每个图选项底下显示 display_name,InlineLabel inline 编辑,改名 patch 后端 +
  //   local mirror 更新让本下拉立刻看见新名 (其他位置依赖外部 SWR refresh)
  const [localImages, setLocalImages] = useState<ElementImage[]>(() => element?.images ?? []);
  useEffect(() => {
    setLocalImages(element?.images ?? []);
  }, [element]);

  // ── 1. 计算可选图列表 ──────────────────────────────────────────
  const images: ElementImage[] = useMemo(() => {
    return localImages.filter(isAvailable);
  }, [localImages]);

  const primaryImage: ElementImage | null = useMemo(() => {
    if (!element) return null;
    return localImages.find((img) => img.image_id === element.primary_image_id)
      ?? localImages[0]
      ?? null;
  }, [element, localImages]);

  // 改名: patch 后端 + local mirror 更新 (失败 throw 让 InlineLabel 恢复)
  // ImageCard 通过 onSaveName override 接住这个回调, 业务局部 mirror 同步.
  async function handleRename(imageId: string, newName: string) {
    if (!element) return;
    await patchElementImage(slug, element.id, imageId, { display_name: newName.trim() || undefined });
    setLocalImages((prev) => prev.map((img) =>
      img.image_id === imageId ? { ...img, display_name: newName.trim() || undefined } : img,
    ));
    // 2026-05-20 Wave T — 让其他用 elements 的页面(ElementListPage / ShotStage 等)
    // SWR cache 刷新, 用户在任意位置改名都立刻反映到所有位置(display_name 单一真理源)
    void invalidateElements(slug);
  }

  // ── 2. ESC 关闭 + 点外部关闭 ───────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── 3. 定位 ────────────────────────────────────────────────────
  const panelStyle = useMemo<React.CSSProperties>(() => {
    if (!anchorRect) return { left: 16, top: 16 };
    const width = 360;
    const left = Math.min(anchorRect.left, window.innerWidth - width - 16);
    const below = anchorRect.bottom + 6;
    const above = Math.max(16, anchorRect.top - 320);
    const fitsBelow = window.innerHeight - anchorRect.bottom > 340;
    return {
      position: "fixed",
      left: Math.max(16, left),
      top: fitsBelow ? below : above,
      width: Math.min(width, window.innerWidth - 32),
      zIndex: 1000,
    };
  }, [anchorRect]);

  // 2026-05-20: element 加载中 — 显示 loading 占位(caller 异步 getElement 拉取中)
  if (!element) {
    return (
      <>
        <div onMouseDown={onClose} style={overlayStyle} aria-label="关闭" />
        <div ref={containerRef} style={{ ...panelStyle, ...emptyPanelStyle }}>
          <div style={emptyTextStyle}>
            <span style={{ color: "var(--ink-500)" }}>加载素材数据中...</span>
          </div>
        </div>
      </>
    );
  }

  // ── 4. 空状态 (该 element 还没图) ──────────────────────────────
  if (images.length === 0) {
    return (
      <>
        <div onMouseDown={onClose} style={overlayStyle} aria-label="关闭" />
        <div ref={containerRef} style={{ ...panelStyle, ...emptyPanelStyle }}>
          <div style={headerStyle}>
            <span style={{ fontWeight: 700, fontSize: 13, color: "var(--ink-900)" }}>
              {element.name}
            </span>
            <Button variant="secondary" size="xs" iconLeft="close" onMouseDown={onClose} title="关闭" aria-label="关闭">
              关闭
            </Button>
          </div>
          <div style={emptyTextStyle}>
            <Icon name="info" size={12} style={{ color: "var(--ink-400)" }} />
            <span>该素材还没生成任何图。先去素材详情页生成,然后回来再选。</span>
          </div>
        </div>
      </>
    );
  }

  const defaultPicked = currentImageId === null;

  return (
    <>
      <div onMouseDown={onClose} style={overlayStyle} aria-label="关闭" />
      <div ref={containerRef} style={{ ...panelStyle, ...panelBaseStyle }} role="dialog" aria-label={`${element.name} 选图`}>
        {/* Header */}
        <div style={headerStyle}>
          <Icon name="image" size={12} style={{ color: "var(--brand-600)" }} />
          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--ink-900)" }}>
            {element.name}
          </span>
          <span style={{ flex: 1 }} />
          <span style={statusBadgeStyle(defaultPicked)}>
            {defaultPicked ? `默认 - 主图` : `本镜专用`}
          </span>
          <Button variant="ghost" size="sm" iconLeft="close" onMouseDown={onClose} title="关闭" aria-label="关闭">关闭</Button>
        </div>

        {/* 说明 */}
        <div style={hintStyle}>
          本镜默认用「主图」单张作参考。点其他张可本镜专用 (不改素材库主图设置)。
        </div>

        {/* Option grid */}
        <div style={optionGridStyle}>
          {/* 2026-05-20 Wave T — 主图卡也可改名(用户原话"主图也要能改名").
              variant=compact + onSaveName 改 primaryImage.display_name,
              因为这跟 images 列表里那张主图同 image_id,改一处所有位置自动同步.
              isPrimary 显示金色"主图"角标 + 品牌色边框. */}
          {primaryImage ? (
            <ImageCard
              image={primaryImage}
              slug={slug}
              elementId={element.id}
              variant="compact"
              selected={defaultPicked}
              isPrimary
              aspectRatio="1 / 1"
              fallbackLabel={`${element.name} · 主图`}
              onSaveName={(newName) => handleRename(primaryImage.image_id, newName)}
              onClick={() => { onPick(null); onClose(); }}
            />
          ) : null}

          {/* 每张图 — ImageCard variant="compact", inline 改名走 handleRename override */}
          {images.map((img) => {
            const picked = currentImageId === img.image_id;
            // V-3.2 铁律 #2: 用 display_name 作显示名, fallback 顺序 displayNameOfImage
            const fallback = displayNameOfImage(img) || "未命名图片";
            return (
              <ImageCard
                key={img.image_id}
                image={img}
                slug={slug}
                elementId={element.id}
                variant="compact"
                selected={picked}
                aspectRatio="1 / 1"
                fallbackLabel={fallback}
                onSaveName={(newName) => handleRename(img.image_id, newName)}
                onClick={() => { onPick(img.image_id); onClose(); }}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

// ─── styles ──────────────────────────────────────────────────────
const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "transparent",
  zIndex: 999,
  cursor: "default",
};

const panelBaseStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 10,
  borderRadius: 10,
  background: "var(--surface-card, #fff)",
  border: "1px solid var(--ink-150)",
  boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
  maxHeight: 360,
  overflow: "auto",
};

const emptyPanelStyle: React.CSSProperties = {
  ...panelBaseStyle,
  maxHeight: 140,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  paddingBottom: 6,
  borderBottom: "1px solid var(--ink-100)",
};

const closeBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  height: 22,
  padding: "0 7px",
  borderRadius: 6,
  border: "1px solid var(--ink-150)",
  background: "var(--ink-50)",
  cursor: "pointer",
  color: "var(--ink-600)",
  fontSize: 11,
  whiteSpace: "nowrap",
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-500)",
  lineHeight: 1.5,
  padding: "2px 0 4px",
};

const emptyTextStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "flex-start",
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--ink-600)",
  padding: "12px 8px",
};

function statusBadgeStyle(isDefault: boolean): React.CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 999,
    color: isDefault ? "var(--ink-600)" : "var(--brand-700, #5b21b6)",
    background: isDefault ? "var(--ink-100)" : "var(--brand-100, #ede9fe)",
  };
}

const optionGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(82px, 1fr))",
  gap: 6,
};

export default ChipDropdown;
