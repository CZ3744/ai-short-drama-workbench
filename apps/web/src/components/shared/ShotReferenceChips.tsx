/**
 * ShotReferenceChips — 显示分镜引用的角色 / 场景 / 项目素材 chips.
 *
 * 2026-05-19 Wave O Entity-first:
 *   用户看到 action 文本时同时看到这镜引用了哪些素材库的素材,
 *   一眼能看清"为什么生成的图跟场景对得上 / 对不上".
 *
 * 用户原话(2026-05-19):
 *   "按照系统提示词导入的分镜,画面描述里依旧没有解析 @ 发生的地点。
 *    这样就会导致生成的分镜图和场景图一毛钱关系没有"
 *
 * 设计:
 *   - 单 series 内所有 chip 实例共享同一份 elements 列表 (SWR 同 key 去重),
 *     就算 N 个 shot 卡同时挂载也只会发 1 个 /elements 请求.
 *   - chip 视觉沿用 mk-chip 类: 场景=brand(品牌橙) / 角色=info(蓝) / 素材=ok(绿).
 *   - chip 可点击跳转到对应素材详情页 (`/studio/:slug/elements/:id`).
 *   - 失败 fallback: 取不到 element name 时显示 toC 友好文案
 *     ("未命名场景" / "未命名角色" / "未知素材"),绝不暴露 raw id (铁律 #9).
 *   - 空状态: density=full 显示"无素材引用 — 生成的图可能跟项目素材库无关联",
 *            density=compact 直接返回 null (避免分镜板列表里到处灰条噪音).
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import useSWR from "swr";
import { Icon, type IconName } from "./Icon";
import { listElements, ELEMENT_KIND_LABEL, type ElementData, type ElementKind } from "../../lib/elementApi";
import { ROUTES } from "../../lib/routes";

export interface ShotReferenceChipsProps {
  /** 系列 slug,用于拉 elements + 跳转素材页 */
  slug: string;
  /** shot.character_ids — 角色绑定 */
  characterIds?: string[];
  /** shot.scene_id — 场景绑定 (单选) */
  sceneId?: string | null;
  /** shot.element_ids — 项目素材绑定 (prop / wardrobe / reference / misc) */
  elementIds?: string[];
  /**
   * 显示密度:
   *   - "full" (默认):完整一行,空状态显示提示,chip 可换行
   *   - "compact":一行省略,空状态不显示
   */
  density?: "full" | "compact";
  /**
   * 点击行为:
   *   - 默认每个 chip 是 <Link> 跳到 `/studio/:slug/elements/:id`
   *   - 传 `onClickEntity` 可覆盖跳转行为 (例如打开 modal / 让宿主页接管)
   */
  onClickEntity?: (entityId: string, kind: ElementKind) => void;
  /** 自定义最外层 className(可选)*/
  className?: string;
  /** 自定义最外层 style(可选)*/
  style?: React.CSSProperties;
}

interface ChipMeta {
  id: string;
  name: string;
  kind: ElementKind;
  /** chip 视觉变体: brand=场景 / info=角色 / ok=项目素材 */
  variant: "brand" | "info" | "ok";
  /** chip 前置 icon */
  icon: IconName;
  /** chip 前置 label "场景"/"角色"/"道具" 等(用户语言)*/
  kindLabel: string;
}

function iconForKind(kind: ElementKind): IconName {
  switch (kind) {
    case "scene": return "map";
    case "character": return "user";
    case "prop": return "package";
    case "wardrobe": return "layers";
    case "reference": return "image";
    case "misc": return "info";
    default: return "info";
  }
}

function variantForKind(kind: ElementKind): "brand" | "info" | "ok" {
  if (kind === "scene") return "brand";
  if (kind === "character") return "info";
  return "ok"; // prop / wardrobe / reference / misc 都归为"素材"绿色
}

function fallbackName(kind: ElementKind): string {
  if (kind === "scene") return "未命名场景";
  if (kind === "character") return "未命名角色";
  return "未知素材";
}

/**
 * 模块级 SWR fetcher — 同一 slug 在整页内只发 1 次请求,所有 chip 实例共享.
 * key: `chip-elements:${slug}`
 */
function useAllElements(slug: string) {
  return useSWR<ElementData[]>(
    slug ? `chip-elements:${slug}` : null,
    async () => {
      const res = await listElements(slug);
      return res.elements;
    },
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
      // 失败静默 — 失败时回 fallback name,不打扰用户
      onError: () => undefined,
    },
  );
}

export default function ShotReferenceChips(props: ShotReferenceChipsProps) {
  const {
    slug, characterIds = [], sceneId, elementIds = [],
    density = "full",
    onClickEntity,
    className, style,
  } = props;

  const { data: allElements } = useAllElements(slug);

  const chips: ChipMeta[] = useMemo(() => {
    const byId = new Map<string, ElementData>();
    for (const el of allElements ?? []) byId.set(el.id, el);

    const result: ChipMeta[] = [];

    // 场景优先(单个)
    if (sceneId) {
      const el = byId.get(sceneId);
      const kind: ElementKind = el?.kind ?? "scene";
      result.push({
        id: sceneId,
        name: el?.name?.trim() || fallbackName("scene"),
        kind,
        variant: variantForKind(kind),
        icon: iconForKind(kind),
        kindLabel: ELEMENT_KIND_LABEL[kind] ?? "场景",
      });
    }

    // 角色
    for (const id of characterIds) {
      const el = byId.get(id);
      const kind: ElementKind = el?.kind ?? "character";
      result.push({
        id,
        name: el?.name?.trim() || fallbackName("character"),
        kind,
        variant: variantForKind(kind),
        icon: iconForKind(kind),
        kindLabel: ELEMENT_KIND_LABEL[kind] ?? "角色",
      });
    }

    // 项目素材 (prop / wardrobe / reference / misc)
    for (const id of elementIds) {
      const el = byId.get(id);
      const kind: ElementKind = el?.kind ?? "misc";
      result.push({
        id,
        name: el?.name?.trim() || fallbackName(kind),
        kind,
        variant: variantForKind(kind),
        icon: iconForKind(kind),
        kindLabel: ELEMENT_KIND_LABEL[kind] ?? "素材",
      });
    }

    return result;
  }, [allElements, sceneId, characterIds, elementIds]);

  const empty = chips.length === 0;

  // ── 空状态 ──────────────────────────────────────────────────────────
  if (empty) {
    if (density === "compact") return null;
    return (
      <div
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          borderRadius: 8,
          background: "var(--warn-bg, #fdf8eb)",
          border: "1px dashed var(--warn, #d97706)",
          color: "#8c6500",
          fontSize: 11.5,
          lineHeight: 1.4,
          ...style,
        }}
        title="这镜没有引用任何角色 / 场景 / 项目素材 — 生成的图跟项目素材库无关联,建议先去素材库挂上。"
      >
        <Icon name="warning" size={12} />
        <span>无素材引用 — 生成的图可能跟项目素材库无关联</span>
      </div>
    );
  }

  // ── 有 chips ────────────────────────────────────────────────────────
  // compact 一行省略 (overflow hidden + flex no-wrap), full 允许换行
  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexWrap: density === "compact" ? "nowrap" : "wrap",
        alignItems: "center",
        gap: 6,
        overflow: density === "compact" ? "hidden" : undefined,
        minWidth: 0,
        ...style,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {chips.map((chip) => {
        const content = (
          <>
            <Icon name={chip.icon} size={11} />
            <span style={{ fontWeight: 650, opacity: 0.85 }}>{chip.kindLabel}</span>
            <span style={{ opacity: 0.45 }}>·</span>
            <span
              style={{
                fontWeight: 600,
                maxWidth: density === "compact" ? 100 : 160,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              @{chip.name}
            </span>
          </>
        );

        const baseStyle: React.CSSProperties = {
          height: 22,
          fontSize: 11,
          padding: "0 9px",
          textDecoration: "none",
          cursor: "pointer",
          flexShrink: 0,
        };

        const title = `${chip.kindLabel}:${chip.name} — 点击查看素材详情`;

        if (onClickEntity) {
          return (
            // 保留原因: mk-chip 已建立的非-mk-btn 语义 class (规则 1) — chip 形态独立于普通按钮
            <button
              key={`${chip.kind}:${chip.id}`}
              type="button"
              className={`mk-chip mk-chip--${chip.variant}`}
              style={{ ...baseStyle, border: "none" }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClickEntity(chip.id, chip.kind);
              }}
              title={title}
            >
              {content}
            </button>
          );
        }

        return (
          <Link
            key={`${chip.kind}:${chip.id}`}
            to={ROUTES.elementDetail(slug, chip.id)}
            className={`mk-chip mk-chip--${chip.variant}`}
            style={baseStyle}
            title={title}
            onClick={(e) => e.stopPropagation()}
          >
            {content}
          </Link>
        );
      })}
    </div>
  );
}

export { ShotReferenceChips };
