import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "../../lib/cn";
import { Icon } from "../shared/Icon";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Button } from "../ui/button";
import { ROUTES } from "../../lib/routes";
import {
  GROUP_META,
  normalize,
  readMentionMru,
  recordMentionMru,
  mentionOptionKey,
  type MentionOption,
} from "./mentionTokens";

export function MentionPopover({
  open,
  options,
  query,
  onPick,
  onClose,
  anchorRect,
  className,
  projectSlug,
  onTriggerBatchImage,
}: {
  open: boolean;
  options: MentionOption[];
  query: string;
  onPick: (option: MentionOption) => void;
  onClose: () => void;
  anchorRect?: DOMRect | null;
  className?: string;
  /**
   * 2026-05-19 #6: 用户原话 "没有图片的时候检查和提示用户自己去生成还是一键补全".
   * - projectSlug: 用于"去生成"跳 ElementWorkbench / "管理素材库" 跳 elements list.
   * - onTriggerBatchImage: 可选, 触发 caller 打开 BatchElementImageDialog (一键补全).
   *   不传则 footer 只展示"管理素材库",不展示"一键补全".
   */
  projectSlug?: string;
  onTriggerBatchImage?: () => void;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState(query);
  const [activeIndex, setActiveIndex] = useState(0);
  // 2026-05-20: 分类 tab(顺序与素材库 KIND_ORDER 一致)
  const [activeTab, setActiveTab] = useState<"all" | "character" | "scene" | "prop" | "wardrobe" | "reference" | "misc">("all");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSearch(query);
      setActiveIndex(0);
      setActiveTab("all"); // 每次弹窗打开重置 tab
      const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [open, query]);

  // 2026-05-20: tab 计数(显示数字角标)— 不被 search filter 影响,显示原始分类数量
  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: options.length,
      character: 0, scene: 0, prop: 0, wardrobe: 0, reference: 0, misc: 0,
    };
    for (const opt of options) {
      if (opt.kind === "character") counts.character++;
      else if (opt.kind === "scene") counts.scene++;
      else if (opt.kind === "element" && opt.elementKind) counts[opt.elementKind]++;
    }
    return counts;
  }, [options]);

  // 2026-07-22 X9-2 (A4-10 差距#1): 读该 series 的 MRU 排名 (id → 名次, 越小越近).
  // 弹窗每次打开重读一次 (open 入 deps) —— 上次选中写的 MRU 下次打开即生效.
  const mruRank = useMemo(() => {
    const ids = readMentionMru(projectSlug);
    const rank = new Map<string, number>();
    ids.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
    return rank;
  }, [projectSlug, open]);

  // 同 kind 内稳定排序: MRU 命中的按名次升序前置, 未命中的保持原相对顺序
  // (Array.prototype.sort 自 ES2019 起稳定, 未命中项 rank=Infinity 相等 → 原序不变).
  const mruFirst = useCallback((arr: MentionOption[]): MentionOption[] => {
    return arr.slice().sort((a, b) => {
      const ra = mruRank.get(mentionOptionKey(a)) ?? Number.POSITIVE_INFINITY;
      const rb = mruRank.get(mentionOptionKey(b)) ?? Number.POSITIVE_INFINITY;
      return ra - rb;
    });
  }, [mruRank]);

  // filtered = 键盘导航 / 渲染共用的**扁平**数组 (headers 不进此数组 → activeIndex 与视觉顺序天然一致).
  // recentCount = 开头有几条属于"最近"分组 (仅"全部"tab 且无搜索时 > 0).
  const { filtered, recentCount } = useMemo<{ filtered: MentionOption[]; recentCount: number }>(() => {
    const needle = normalize(search);
    const items = needle
      ? options.filter((opt) => {
          const haystack = normalize(`${opt.label} ${opt.token} ${opt.description ?? ""} ${opt.groupLabel}`);
          return haystack.includes(needle);
        })
      : options.slice();

    // 单类 tab — 只显示对应分类, 分类内 MRU 前置, 无"最近"分组
    if (activeTab !== "all") {
      const tabItems = (activeTab === "character" || activeTab === "scene")
        ? items.filter((i) => i.kind === activeTab)
        : items.filter((i) => i.kind === "element" && i.elementKind === activeTab);
      return { filtered: mruFirst(tabItems), recentCount: 0 };
    }

    // "全部" tab — 按素材库 KIND_ORDER 分组, 组内 MRU 前置
    const ORDER: Array<{ kind: MentionOption["kind"]; elementKind?: string }> = [
      { kind: "character" },
      { kind: "scene" },
      { kind: "element", elementKind: "prop" },
      { kind: "element", elementKind: "wardrobe" },
      { kind: "element", elementKind: "reference" },
      { kind: "element", elementKind: "misc" },
    ];
    const grouped = (source: MentionOption[]): MentionOption[] =>
      ORDER.flatMap(({ kind, elementKind }) =>
        mruFirst(source.filter((i) => i.kind === kind && (elementKind === undefined || i.elementKind === elementKind))),
      );

    // 搜索中不显示"最近"分组 (结果已按关键词收窄), 只在各 kind 组内 MRU 前置
    if (needle) {
      return { filtered: grouped(items), recentCount: 0 };
    }

    // 无搜索: 顶部"最近"分组 (≤5, 仅真正用过的), 并从下方 kind 组中排除避免同项重复出现
    const recent = mruFirst(items)
      .filter((i) => mruRank.has(mentionOptionKey(i)))
      .slice(0, 5);
    const recentKeys = new Set(recent.map(mentionOptionKey));
    const rest = grouped(items.filter((i) => !recentKeys.has(mentionOptionKey(i))));
    return { filtered: [...recent, ...rest], recentCount: recent.length };
  }, [options, search, activeTab, mruFirst, mruRank]);

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(filtered.length > 0 ? filtered.length - 1 : 0);
    }
  }, [activeIndex, filtered.length]);

  const selectIndex = useCallback(
    (index: number) => {
      const item = filtered[index];
      if (!item) return;
      // 2026-07-22 X9-2: 选中即记 MRU (弹窗鼠标点选 / 键盘 Enter / ScriptCanvas 均走这里).
      recordMentionMru(projectSlug, item);
      onPick(item);
      onClose();
    },
    [filtered, onClose, onPick, projectSlug],
  );

  const panelStyle = useMemo<React.CSSProperties>(() => {
    if (!anchorRect) {
      return { left: 16, top: 16 };
    }
    const width = 420;
    const left = Math.min(anchorRect.left, window.innerWidth - width - 16);
    const below = anchorRect.bottom + 8;
    const above = Math.max(16, anchorRect.top - 360);
    const fitsBelow = window.innerHeight - anchorRect.bottom > 380;
    return {
      left: Math.max(16, left),
      top: fitsBelow ? below : above,
      width: Math.min(width, window.innerWidth - 32),
    };
  }, [anchorRect]);

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[var(--z-dropdown)] cursor-default"
        onMouseDown={onClose}
        aria-label="关闭引用候选"
      />
      <div
        className={cn(
          "fixed z-[calc(var(--z-dropdown)+1)] overflow-hidden rounded-[var(--r-lg)] border border-[var(--ink-100)] bg-white shadow-[var(--shadow-lg)]",
          "v24-mention-popover",
          className,
        )}
        style={panelStyle}
      >
        <div className="border-b border-[var(--ink-100)] px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-semibold text-[var(--ink-900)]">@ 选择素材</div>
            {/* W8-sweep (2026-05-16): icon-only → icon + 文字 (铁律 #11) */}
            <Button variant="ghost" size="xs" iconLeft="close" onClick={onClose} title="关闭引用面板">
              关闭
            </Button>
          </div>
          {/* 2026-05-20: 分类 tab — 跟素材库 KIND_ORDER 一致(角色/场景/道具/服装/参考图/杂项) */}
          <div className="mt-2 flex items-center gap-1 overflow-x-auto pb-1">
            {([
              { id: "all", label: "全部" },
              { id: "character", label: "角色" },
              { id: "scene", label: "场景" },
              { id: "prop", label: "道具" },
              { id: "wardrobe", label: "服装" },
              { id: "reference", label: "参考图" },
              { id: "misc", label: "杂项" },
            ] as const).map((tab) => {
              const isActive = activeTab === tab.id;
              const count = tabCounts[tab.id] ?? 0;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setActiveTab(tab.id);
                    setActiveIndex(0);
                  }}
                  className={cn(
                    "shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors border",
                    isActive
                      ? "bg-[var(--brand-50)] text-[var(--brand-700)] border-[var(--brand-200)]"
                      : "text-[var(--ink-600)] hover:bg-[var(--ink-50)] border-transparent",
                  )}
                  title={`${tab.label}(${count})`}
                >
                  <span>{tab.label}</span>
                  <span className={cn(
                    "tabular-nums text-[10px] rounded-full px-1 min-w-[16px] text-center",
                    isActive ? "bg-white text-[var(--brand-700)]" : "bg-[var(--ink-100)] text-[var(--ink-500)]",
                  )}>{count}</span>
                </button>
              );
            })}
          </div>
          <Input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((prev) => Math.min(filtered.length - 1, prev + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((prev) => Math.max(0, prev - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                selectIndex(activeIndex);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="搜索引用..."
            className="mt-2 h-8 text-[var(--fs-sm)]"
          />
        </div>

        <ScrollArea className="max-h-[320px]">
          <div className="p-2">
            {filtered.length === 0 ? (
              <div className="px-3 py-8 text-center text-[11px] text-[var(--ink-400)]">
                没找到匹配项
              </div>
            ) : (
              filtered.map((item, index) => {
                const active = index === activeIndex;
                const group = GROUP_META[item.kind];
                // 2026-05-19 #6: 元素卡片要区分有图/无图.
                //   - kind=element 必须显式 hasImage 才视为有图(否则提示先生成)
                //   - kind=character/scene/style/voice/vault 不依赖图,不显示无图提示
                const isElementKind = item.kind === "element";
                const showMissingImage = isElementKind && !item.hasImage;
                // 2026-07-22 X9-2: "最近"分组 header (index 0) + "全部"分隔 (recentCount 处).
                // header 只是视觉元素, 不进 filtered/activeIndex → 键盘导航顺序与视觉顺序一致.
                const showRecentHeader = recentCount > 0 && index === 0;
                const showAllHeader = recentCount > 0 && index === recentCount;
                return (
                  <Fragment key={`${item.kind}:${item.token}:${item.label}`}>
                    {showRecentHeader && (
                      <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-400)]">
                        最近
                      </div>
                    )}
                    {showAllHeader && (
                      <div className="mt-1 border-t border-[var(--ink-100)] px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-400)]">
                        全部
                      </div>
                    )}
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectIndex(index);
                    }}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-[var(--r-md)] px-3 py-2 text-left transition-colors",
                      active ? "bg-[var(--brand-50)]" : "hover:bg-[var(--ink-50)]",
                    )}
                  >
                    {/* 有缩略图 → 用图; 无缩略图 → 用 group icon */}
                    {item.thumbnail ? (
                      <img
                        src={item.thumbnail}
                        alt={item.label}
                        className="mt-0.5 h-7 w-7 shrink-0 rounded-[var(--r-md)] border border-[var(--ink-150)] object-cover"
                      />
                    ) : (
                      <span
                        className={cn(
                          "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-md)] border",
                          item.kind === "character" && "border-[var(--info-bg)] bg-[var(--info-bg)] text-[var(--info)]",
                          item.kind === "scene" && "border-[var(--brand-100)] bg-[var(--brand-50)] text-[var(--brand-700)]",
                          item.kind === "element" && "border-purple-100 bg-purple-50 text-purple-700",
                          item.kind === "style" && "border-[var(--ok-bg)] bg-[var(--ok-bg)] text-[var(--ok)]",
                          item.kind === "voice" && "border-[var(--warn-bg)] bg-[var(--warn-bg)] text-[var(--warn)]",
                          item.kind === "vault" && "border-[var(--ink-200)] bg-[var(--ink-50)] text-[var(--ink-700)]",
                        )}
                      >
                        <Icon name={group.icon} size={14} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-[var(--ink-900)]">{item.label}</span>
                        <span className="mk-chip mk-chip--outline text-[10px]">{group.label}</span>
                        {/* 无图提示徽章 — 用户原话"没有图片的时候提示用户自己去生成" */}
                        {showMissingImage && (
                          <span className="mk-chip mk-chip--warn text-[10px]" title="该素材还没生图,先去生成才能拿到典型代表图">
                            暂无图
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-[var(--ink-400)]">
                        {item.token} {item.description ? `· ${item.description}` : ""}
                      </span>
                    </span>
                    {/* 无图元素旁的"去生成"小按钮 — 跳 ElementWorkbench */}
                    {showMissingImage && projectSlug && item.resourceId && (
                      <Button
                        variant="ghost"
                        size="xs"
                        iconLeft="sparkles"
                        className="shrink-0"
                        title="跳到该素材详情,自己写提示词生成代表图"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onClose();
                          navigate(ROUTES.elementDetail(projectSlug, item.resourceId!));
                        }}
                      >
                        去生成
                      </Button>
                    )}
                  </button>
                  </Fragment>
                );
              })
            )}
          </div>
        </ScrollArea>

        {/* 2026-05-19 #6: 底部 footer — 给"暂无图"元素一个统一补全入口.
            用户原话"没有图片的时候检查和提示用户自己去生成还是一键补全".
            - 一键补全: 触发外部 BatchElementImageDialog (走 element_images stage)
            - 管理素材库: 跳 elements list, 自己挑选/批量操作 */}
        {(projectSlug || onTriggerBatchImage) && (
          <div className="flex items-center justify-between gap-2 border-t border-[var(--ink-100)] bg-[var(--ink-50)] px-3 py-2">
            <span className="text-[10px] text-[var(--ink-500)]">
              没找到合适素材?或者素材暂无图?
            </span>
            <span className="flex items-center gap-1">
              {onTriggerBatchImage && (
                <Button
                  variant="primary"
                  size="xs"
                  iconLeft="sparkles"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onClose();
                    onTriggerBatchImage();
                  }}
                  title="一键给所有素材按顺序生成代表图(走素材库批量补全)"
                >
                  一键补全
                </Button>
              )}
              {projectSlug && (
                <Button
                  variant="ghost"
                  size="xs"
                  iconLeft="layers"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onClose();
                    navigate(ROUTES.elements(projectSlug));
                  }}
                  title="去素材库管理 / 新增 / 排查无图素材"
                >
                  管理素材库
                </Button>
              )}
            </span>
          </div>
        )}
      </div>
    </>
  );
}

export default MentionPopover;
