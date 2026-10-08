import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useToggleSet } from "../../hooks/useToggleSet";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { BaseDialog } from "../ui/BaseDialog";
import { formatBeijingTime } from "../../lib/format";
import {
  ELEMENT_KIND_LABEL,
  aspectRatioByKind,
  displayNameOfImage,
  listElements,
  listRejects,
  type ElementKind,
  type RejectItem,
} from "../../lib/elementApi";

export type LibraryPickerSource = "project" | "public" | "reject" | "misc";

/**
 * 2026-05-17 P1.2: PickerItem 暴露为公开类型 — RejectPoolBrowserModal 等 caller
 * 通过 `items` prop 直接喂入预先 fetch 的素材, 跳过内部 fetch.
 */
export interface PickerItem {
  id: string;
  kind: ElementKind | "reject";
  name: string;
  /** 铁律 #2: 用户可改的展示名, fallback 到 name */
  display_name?: string;
  sub: string;
  imageUrl?: string;
  imageCount?: number;
  /** 创建时间 — itemActions 渲染需要 */
  created_at?: string;
  /** 2026-05-17 P1.2: 任意 caller 数据,itemActions 可通过此字段拿回原对象 */
  raw?: unknown;
}

/**
 * 2026-05-17 P1.2: 顶部 tab 配置项 — 用于 reject 浏览的"本素材/本项目/公共"切换
 * 默认 source="project" 时按 ELEMENT_KIND tabs 渲染;传 customTabs 则改用 caller 自定义 tabs.
 */
export interface PickerTab {
  key: string;
  label: string;
  count?: number;
}

export interface LibraryPickerModalProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  source: LibraryPickerSource;
  acceptedKinds?: ElementKind[];
  defaultKind?: ElementKind | "all";
  multi?: boolean;
  selectedIds?: string[];
  onConfirm: (ids: string[]) => void;
  title?: string;
  /**
   * 2026-05-17 P1.2: 由 caller 预先 fetch 的素材列表. 不传则按 source 自己 fetch.
   * 用于 RejectPoolBrowserModal 这种父组件需要控制 tier + 已有 rejects 数据的场景.
   */
  items?: PickerItem[];
  /**
   * 2026-05-17 P1.2: 自定义 tab 配置 (替代默认 element-kind tabs).
   * 用于 reject 浏览的 "本素材 / 本项目 / 公共" 切换.
   */
  customTabs?: PickerTab[];
  /** 2026-05-17 P1.2: 当前激活 tab (customTabs 模式下受控) */
  activeTab?: string;
  /** 2026-05-17 P1.2: tab 切换回调 */
  onTabChange?: (key: string) => void;
  /**
   * 2026-05-17 P1.2: 每张素材底部的操作按钮组 (替代默认 "点击选中" 交互).
   * 传入则 modal 进入"操作模式": 不再走 click-to-select + confirm, 改由 caller 给每张图渲染按钮.
   */
  itemActions?: (item: PickerItem, source: LibraryPickerSource) => ReactNode;
  /**
   * 2026-05-17 P1.2: 隐藏底部"确认选择 / 取消"按钮 (操作模式下没意义).
   */
  hideConfirmFooter?: boolean;
  /**
   * 2026-05-17 P1.2: 点击缩略图回调 (lightbox 放大场景).
   * 不传则 click 走默认选择交互.
   */
  onItemClick?: (item: PickerItem) => void;
}

const KIND_ORDER: ElementKind[] = ["character", "scene", "prop", "wardrobe", "reference", "misc"];

function rejectToItem(item: RejectItem): PickerItem {
  // 2026-05-17 P1.2: 把 element_kind id 翻成中文 (toC 兜底, 铁律 #9)
  const kindLabel = item.element_kind
    ? ((ELEMENT_KIND_LABEL as Record<string, string>)[item.element_kind] ?? item.element_kind)
    : "";
  return {
    id: item.vault_id,
    kind: "reject",
    name: item.element_name || item.note || "未命名废案",
    sub: kindLabel ? `${kindLabel} · 废案` : "废案",
    imageUrl: item.thumbnail || item.url,
    imageCount: 1,
    created_at: item.created_at,
    raw: item,
  };
}

/**
 * 2026-05-17 P1.2: 暴露给 RejectPoolBrowserModal 等 caller 复用
 */
export function rejectItemToPickerItem(item: RejectItem): PickerItem {
  return rejectToItem(item);
}

export function LibraryPickerModal(props: LibraryPickerModalProps) {
  const {
    open,
    onClose,
    slug,
    source,
    acceptedKinds,
    defaultKind = "all",
    multi = false,
    selectedIds = [],
    onConfirm,
    title,
    items: externalItems,
    customTabs,
    activeTab,
    onTabChange,
    itemActions,
    hideConfirmFooter,
    onItemClick,
  } = props;

  const allowedKinds = acceptedKinds?.length
    ? acceptedKinds
    : source === "misc"
      ? (["misc"] as ElementKind[])
      : KIND_ORDER;

  const [activeKind, setActiveKind] = useState<ElementKind | "all">(defaultKind);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PickerItem[]>([]);
  const { ids: picked, toggle: togglePicked, replace: replacePicked, has: hasPicked, size: pickedSize } = useToggleSet<string>(selectedIds);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 2026-07-09 audit C8: caller 不传 selectedIds 时默认参数 [] 每次 render 都是新数组引用 →
  // 本 effect 依赖每次都变 → replacePicked 每次 setState → 无限重渲染 (Maximum update depth,
  // 打开即崩, "引用其他素材典型图作参考" 100% 不可用). 依赖改用 join 出的稳定基元 key: 内容不变
  // 则字符串恒等 (省略/内联 caller 皆稳定), effect 不再空转; 换了一组 id 时才重新初始化选中集.
  // 逗号分隔避免无分隔 join 的拼接歧义 (元素/场景/vault id 均不含逗号).
  const selectedIdsKey = selectedIds.join(",");
  useEffect(() => {
    if (!open) return;
    replacePicked(selectedIds);
    setActiveKind(defaultKind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedIdsKey, defaultKind]);

  useEffect(() => {
    // 2026-05-17 P1.2: 如果 caller 用 externalItems 喂数据,跳过内部 fetch.
    if (!open) return;
    if (externalItems) {
      setItems(externalItems);
      setLoading(false);
      setError(null);
      return;
    }
    if (!slug) return;
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (source === "reject" || source === "public") {
          const r = await listRejects({
            tier: source === "public" ? "public" : "project",
            slug: source === "public" ? undefined : slug,
          });
          if (!alive) return;
          setItems(r.items.map(rejectToItem));
          return;
        }

        const kind = source === "misc" ? "misc" : activeKind === "all" ? undefined : activeKind;
        const r = await listElements(slug, kind);
        if (!alive) return;
        const next: PickerItem[] = r.elements
          .filter((el) => allowedKinds.includes(el.kind))
          .map((el) => {
            const primary = el.images.find((im) => im.image_id === el.primary_image_id) ?? el.images[0];
            const imageNames = el.images.map(displayNameOfImage).filter(Boolean).slice(0, 3).join(" / ");
            return {
              id: el.id,
              kind: el.kind,
              name: el.name,
              sub: imageNames || `${el.images.length} 张图`,
              imageUrl: primary?.url,
              imageCount: el.images.length,
            };
          });
        setItems(next);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setItems([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, slug, source, activeKind, allowedKinds.join("|"), externalItems]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      `${item.name} ${item.sub}`.toLowerCase().includes(q),
    );
  }, [items, query]);

  function toggle(id: string) {
    if (!multi) {
      // 单选模式: 清空后选中，如果已选则取消
      replacePicked(hasPicked(id) ? [] : [id]);
    } else {
      togglePicked(id);
    }
  }

  function confirm() {
    onConfirm(Array.from(picked));
    onClose();
  }

  if (!open) return null;

  const header = title ?? (source === "misc" ? "选择杂物素材" : source === "reject" ? "选择废案素材" : source === "public" ? "选择公共素材" : "选择项目素材");
  const kindTabs = ["all", ...allowedKinds] as Array<ElementKind | "all">;
  // 2026-05-17 P1.2: 当 caller 用 itemActions 时关闭"点击选中"交互,改"点击放大"或自定义.
  const actionMode = Boolean(itemActions);
  const showConfirmFooter = !hideConfirmFooter && !actionMode;

  const headerExtra = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <span className="mk-chip mk-chip--ghost">{multi ? `已选 ${pickedSize} 项` : pickedSize ? "已选择" : "未选择"}</span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {customTabs || source === "project" ? (
        <div className="mk-tab-group">
          {customTabs ? customTabs.map((tab) => (
            <button
              key={tab.key}
              className={`mk-tab ${activeTab === tab.key ? "mk-tab--active" : ""}`}
              onClick={() => onTabChange?.(tab.key)}
            >
              {tab.label}
              {typeof tab.count === "number" ? ` ${tab.count}` : null}
            </button>
          )) : source === "project" ? kindTabs.map((kind) => (
            <button
              key={kind}
              className={`mk-tab ${activeKind === kind ? "mk-tab--active" : ""}`}
              onClick={() => setActiveKind(kind)}
            >
              {kind === "all" ? "全部" : ELEMENT_KIND_LABEL[kind]}
            </button>
          )) : null}
        </div>
        ) : null}
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称 / 图片展示名"
          className="ml-auto w-[240px] h-8"
        />
      </div>
    </>
  );

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      title={header}
      ariaLabel={typeof header === "string" ? header : undefined}
      maxWidth={920}
      zIndex={260}
      headerExtra={headerExtra}
      footerLeft={showConfirmFooter ? <span style={{ fontSize: 12, color: "var(--ink-500)" }}>已选 {pickedSize} 项</span> : undefined}
      footer={showConfirmFooter ? (
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={pickedSize === 0} onClick={confirm}>
            确认选择
          </Button>
        </>
      ) : undefined}
    >
      <div style={{ minHeight: 260, paddingRight: 4 }}>{/* 内部 grid */}
          {loading ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--ink-400)" }}>加载素材中…</div>
          ) : error ? (
            <div style={{ padding: 18, color: "var(--err)" }}>加载失败：{error}</div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--ink-400)" }}>
              还没有素材。可以先去对应素材页创建或导入。
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(138px, 1fr))", gap: 10 }}>
              {visible.map((item) => {
                const isPicked = hasPicked(item.id);
                // 2026-05-17 P1.2: 操作模式下 tile 是 div + 内部 actions, 不是 button (避免按钮嵌套).
                if (actionMode) {
                  return (
                    <div
                      key={`${item.kind}:${item.id}`}
                      className="mk-card"
                      style={{
                        padding: 8,
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                        }}
                      >
                        <div
                          style={{
                          aspectRatio: aspectRatioByKind(item.kind),
                          background: "var(--ink-50)",
                          position: "relative",
                          overflow: "hidden",
                          borderRadius: 5,
                          border: "1px solid var(--ink-200)",
                          cursor: onItemClick ? "zoom-in" : "default",
                        }}
                        onClick={onItemClick ? () => onItemClick(item) : undefined}
                        title={onItemClick ? "点击放大查看 / 右键可复制" : undefined}
                      >
                        {item.imageUrl ? (
                          <img src={item.imageUrl} alt={item.display_name || item.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                        ) : (
                          <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "var(--ink-300)" }}>
                            <Icon name="image" size={22} />
                          </div>
                        )}
                      </div>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.display_name || item.name}</div>
                        <div style={{ marginTop: 2, fontSize: 10.5, color: "var(--ink-500)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.sub}</div>
                        {item.created_at ? (
                          <div style={{ marginTop: 2, fontSize: 10, color: "var(--ink-400)" }}>
                            {formatBeijingTime(item.created_at, { mode: "datetime" })}
                          </div>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
                        {itemActions!(item, source)}
                      </div>
                    </div>
                  );
                }
                return (
                  <button
                    key={`${item.kind}:${item.id}`}
                    type="button"
                    onClick={() => (onItemClick ? onItemClick(item) : toggle(item.id))}
                    style={{
                      padding: 0,
                      overflow: "hidden",
                      borderRadius: 8,
                      border: isPicked ? "2px solid var(--brand-500)" : "1px solid var(--ink-150)",
                      background: isPicked ? "var(--brand-50)" : "var(--surface-card)",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <div style={{ aspectRatio: aspectRatioByKind(item.kind), background: "var(--ink-50)", position: "relative", overflow: "hidden" }}>
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt={item.display_name || item.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      ) : (
                        <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "var(--ink-300)" }}>
                          <Icon name="image" size={22} />
                        </div>
                      )}
                      {isPicked ? <span style={{ position: "absolute", top: 6, right: 6 }} className="mk-pill mk-pill--approved">已选</span> : null}
                    </div>
                    <div style={{ padding: "7px 8px" }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.display_name || item.name}</div>
                      <div style={{ marginTop: 2, fontSize: 10.5, color: "var(--ink-500)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.sub}</div>
                      <div style={{ marginTop: 4, fontSize: 10, color: "var(--ink-400)" }}>
                        {item.kind === "reject" ? "废案" : ELEMENT_KIND_LABEL[item.kind]} · {item.imageCount ?? 0} 张图
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
      </div>
    </BaseDialog>
  );
}

export default LibraryPickerModal;
