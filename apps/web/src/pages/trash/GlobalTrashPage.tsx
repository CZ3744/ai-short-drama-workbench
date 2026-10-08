/**
 * GlobalTrashPage — 统一垃圾桶 (2026-05-26 audit P1 #1).
 *
 * 之前删除的东西去 5 个不同地方:
 *   /trash/series                  系列回收站
 *   /studio/:slug/trash            分镜垃圾桶
 *   /studio/:slug/elements/trash   素材垃圾桶
 *   /vault?status=trashed          归档柜回收站 (在 VaultPage 自己的 tab)
 *   ElementImageGrid "入废案" 按钮 (素材内部废案库)
 *
 * 重构: 一个 /trash 页, 顶部 tab 切 "分镜 / 素材 / 系列" 三类.
 *   vault 回收站不动 — 它是 vault 自己的"付费资产 90 天保留"机制, 仍由 VaultPage 接管.
 *   element "入废案" 不动 — 是 element 内部的废稿池, 保留位置.
 *
 * 旧路由 /studio/:slug/trash 和 /studio/:slug/elements/trash 重定向到 /trash?tab=shots / ?tab=elements
 * 旧路由 /trash/series 重定向到 /trash?tab=series
 *
 * 设计:
 *   - tab "分镜" — 需要当前 slug, 没 slug 提示选系列
 *   - tab "素材" — 需要当前 slug, 同上
 *   - tab "系列" — 全局, 列所有项目 _trash
 */

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import useSWR from "swr";
import { PageTransition } from "../../components/studio/PageTransition";
import { Empty } from "../../components/ui/empty";
import { Icon } from "../../components/shared/Icon";
import { useConfirm } from "../../components/ui/ConfirmModal";
import { useSessionStore } from "../../stores/sessionStore";
import {
  apiGet, apiPost, apiDelete,
  listTrashedSeries, restoreTrashedSeries, permanentDeleteTrashedSeries,
  listSeries,
  type TrashedSeriesEntry,
  type SeriesRecord,
} from "../../lib/api";
import { Select, type SelectOption } from "../../components/ui/select";
import {
  listElementTrash, restoreElementTrash, permanentDeleteElementTrash,
  type ElementTrashEntry, type ElementTrashKind,
} from "../../lib/elementApi";
import {
  listDeletedCasts, restoreCast,
  type CastWithUsage,
} from "../../lib/castApi";
import { showErrorToast } from "../../lib/errorTranslate";
import { imageThumbUrl } from "../../lib/imageThumb";
import { ROUTES } from "../../lib/routes";
import { Button } from "../../components/ui/button";
import { formatRelativeTime } from "../../lib/format";

type TabId = "shots" | "episodes" | "elements" | "series" | "casts";

const TABS: Array<{ id: TabId; label: string; hint: string }> = [
  { id: "shots", label: "分镜", hint: "本系列被删的分镜" },
  { id: "episodes", label: "分集", hint: "本系列被删的整集 (可一键恢复)" },
  { id: "elements", label: "素材", hint: "本系列被删的角色 / 场景 / 物品" },
  { id: "series", label: "系列", hint: "全局: 被删的整个系列 (90 天保留)" },
  { id: "casts", label: "素材组", hint: "全局: 被删的素材组 (IP 容器)" },
];

interface TrashedShot {
  id: string;
  index: number;
  title?: string;
  action?: string;
  action_description?: string;
  voiceover?: string;
  dialogue?: string;
  episode_id?: string;
  /** P0-2 (2026-05-29): 铁律 #9 toC 兜底 — 后端多回 episode.index, 前端渲染"第 N 集"而非 ULID */
  episode_index?: number;
  trashed_at: string;
  status?: string;
}

const ELEMENT_KIND_LABEL: Record<ElementTrashKind, string> = {
  character: "角色",
  scene: "场景",
  element: "素材",
};

/**
 * 2026-07-22 Y6 UP-11: "分镜/分集/素材" 三个 tab 都按系列查看, 缺 slug 时原来只给
 * "去主页选系列" 一条路 (离开 /trash 绕一圈). 这里三个 tab 共用同一份系列选择器 props.
 */
interface TabSeriesPickerProps {
  seriesOptions: SelectOption[];
  seriesLoading: boolean;
  onPickSlug: (slug: string) => void;
}

/** 无 slug 时的页内选剧器 — 替代"去主页选系列"这条被迫绕路, 当场选当场看. */
function TrashSeriesPicker({ seriesOptions, seriesLoading, onPickSlug }: TabSeriesPickerProps) {
  return (
    <div
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: 12, padding: "64px 20px", textAlign: "center",
      }}
    >
      <div style={{ color: "var(--ink-300)" }}>
        <Icon name="trash" size={40} />
      </div>
      <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--ink-700)", margin: 0 }}>还没有选系列</h3>
      <p style={{ fontSize: 13, color: "var(--ink-400)", margin: 0, maxWidth: 320, lineHeight: 1.6 }}>
        这个页签按系列查看已删内容。直接在下面选一部剧, 当场就能看到它的回收站, 不用跳去主页再绕回来。
      </p>
      <div style={{ marginTop: 4, minWidth: 220 }}>
        <Select
          options={seriesOptions}
          value={null}
          placeholder={seriesLoading ? "系列加载中…" : seriesOptions.length === 0 ? "还没有任何系列" : "选择系列…"}
          disabled={seriesLoading || seriesOptions.length === 0}
          onChange={onPickSlug}
          ariaLabel="选择要查看回收站的系列"
        />
      </div>
    </div>
  );
}

// ── 分镜 tab ────────────────────────────────────────────────
function ShotsTab({ slug, seriesOptions, seriesLoading, onPickSlug }: { slug: string | null } & TabSeriesPickerProps) {
  const [shots, setShots] = useState<TrashedShot[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const data = await apiGet<{ shots: TrashedShot[] }>(`/api/v2/series/${slug}/trash`);
      setShots(data.shots ?? []);
    } catch (err) {
      showErrorToast(err, "加载分镜垃圾桶失败");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { void reload(); }, [reload]);

  const handleRestore = useCallback(async (shot: TrashedShot) => {
    if (!slug || !shot.episode_id) return;
    setBusyId(`r_${shot.id}`);
    try {
      await apiPost(`/api/v2/series/${slug}/episodes/${shot.episode_id}/shots/${shot.id}/restore`, {});
      toast.success("分镜已恢复");
      await reload();
    } catch (err) {
      showErrorToast(err, "恢复失败");
    } finally {
      setBusyId(null);
    }
  }, [slug, reload]);

  const handlePermDelete = useCallback(async (shot: TrashedShot) => {
    if (!slug || !shot.episode_id) return;
    setBusyId(`p_${shot.id}`);
    try {
      await apiDelete(`/api/v2/series/${slug}/episodes/${shot.episode_id}/shots/${shot.id}/trash`);
      toast.success("已永久删除");
      await reload();
    } catch (err) {
      showErrorToast(err, "永久删除失败");
    } finally {
      setBusyId(null);
    }
  }, [slug, reload]);

  if (!slug) {
    return <TrashSeriesPicker seriesOptions={seriesOptions} seriesLoading={seriesLoading} onPickSlug={onPickSlug} />;
  }

  if (loading) {
    return (
      <div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="mk-card" style={{ height: 80, marginBottom: 10, background: "var(--ink-50)" }} />
        ))}
      </div>
    );
  }

  if (shots.length === 0) {
    return <Empty title="分镜垃圾桶为空" description="删除的分镜会出现在这里, 可恢复或永久删除" />;
  }

  return (
    <div>
      {shots.map((shot) => {
        const restoring = busyId === `r_${shot.id}`;
        const permDeleting = busyId === `p_${shot.id}`;
        const text = shot.action || shot.action_description || shot.voiceover || shot.dialogue || "无文字描述";
        return (
          <article
            key={shot.id}
            className="mk-card"
            style={{
              marginBottom: 10, padding: "12px 16px",
              display: "flex", alignItems: "center", gap: 14, borderRadius: 12,
              opacity: restoring || permDeleting ? 0.55 : 1,
              transition: "opacity 0.15s",
            }}
          >
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--ink-50)", display: "grid", placeItems: "center", color: "var(--ink-400)", flexShrink: 0 }}>
              <Icon name="shot" size={16} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 13, fontWeight: 650, color: "var(--ink-900)" }}>
                  分镜 {shot.index ?? "?"}{shot.title ? ` — ${shot.title}` : ""}
                </span>
                <span className="mk-chip" style={{ fontSize: 10, height: 18, padding: "0 6px" }}>分镜</span>
                {/* P0-2 (2026-05-29): 铁律 #9 toC 兜底 — 用 episode_index 渲染"第 N 集"而非暴露 ULID */}
                {shot.episode_id && (
                  <span style={{ fontSize: 11, color: "var(--ink-500)" }}>
                    {shot.episode_index !== undefined ? `第 ${shot.episode_index} 集` : "未知集数"}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-600)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 480 }}>
                {text}
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-400)" }}>
                {formatRelativeTime(shot.trashed_at)} 删除
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <Button
                variant="secondary" size="sm" iconLeft="refresh"
                disabled={restoring || !shot.episode_id} loading={restoring}
                onClick={() => void handleRestore(shot)}
              >恢复</Button>
              <Button
                variant="danger" size="sm" iconLeft="trash"
                disabled={permDeleting || !shot.episode_id} loading={permDeleting}
                onClick={() => void handlePermDelete(shot)}
              >永久删除</Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

// ── 分集 tab (2026-07-22 X6-2 / A3-8) ───────────────────────
interface TrashedEpisode {
  trash_id: string;
  episode_id: string;
  title?: string;
  index?: number;
  trashed_at: string;
  shot_count: number;
}

function EpisodesTab({ slug, seriesOptions, seriesLoading, onPickSlug }: { slug: string | null } & TabSeriesPickerProps) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [episodes, setEpisodes] = useState<TrashedEpisode[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const data = await apiGet<{ episodes: TrashedEpisode[] }>(`/api/v2/series/${slug}/episodes-trash`);
      setEpisodes(data.episodes ?? []);
    } catch (err) {
      showErrorToast(err, "加载分集回收站失败");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { void reload(); }, [reload]);

  const labelOf = (ep: TrashedEpisode) => ep.title || `第 ${ep.index ?? "?"} 集`;

  const handleRestore = useCallback(async (ep: TrashedEpisode) => {
    if (!slug) return;
    setBusyId(`r_${ep.trash_id}`);
    try {
      const res = await apiPost<{ ok: boolean; episode_id?: string }>(
        `/api/v2/series/${slug}/episodes-trash/${ep.trash_id}/restore`, {},
      );
      toast.success(`「${labelOf(ep)}」已恢复`, {
        duration: 6000,
        action: res.episode_id
          ? { label: "查看", onClick: () => navigate(ROUTES.storyboard(slug, res.episode_id!)) }
          : undefined,
      });
      await reload();
    } catch (err) {
      showErrorToast(err, "恢复失败");
    } finally {
      setBusyId(null);
    }
  }, [slug, reload, navigate]);

  const handlePermDelete = useCallback(async (ep: TrashedEpisode) => {
    if (!slug) return;
    const label = labelOf(ep);
    const ok = await confirm({
      title: `永久删除「${label}」?`,
      description: [
        "这一集 (剧本 + 分镜 + 版本历史 + 合成索引) 会从回收站物理删除, 不可恢复.",
        "",
        "已产出的图 / 视频 / vault 资源在归档柜里仍保留 (不随集删).",
      ].join("\n"),
      variant: "destructive",
      confirmLabel: "永久删除",
    });
    if (!ok) return;
    setBusyId(`p_${ep.trash_id}`);
    try {
      await apiDelete(`/api/v2/series/${slug}/episodes-trash/${ep.trash_id}`);
      toast.success(`「${label}」已永久删除`);
      await reload();
    } catch (err) {
      showErrorToast(err, "永久删除失败");
    } finally {
      setBusyId(null);
    }
  }, [slug, reload, confirm]);

  if (!slug) {
    return <TrashSeriesPicker seriesOptions={seriesOptions} seriesLoading={seriesLoading} onPickSlug={onPickSlug} />;
  }

  if (loading) {
    return (
      <div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="mk-card" style={{ height: 80, marginBottom: 10, background: "var(--ink-50)" }} />
        ))}
      </div>
    );
  }

  if (episodes.length === 0) {
    return <Empty title="分集回收站为空" description="删除的整集会出现在这里, 可一键恢复 (数据保留, 不会自动消失)" />;
  }

  return (
    <div>
      {episodes.map((ep) => {
        const restoring = busyId === `r_${ep.trash_id}`;
        const permDeleting = busyId === `p_${ep.trash_id}`;
        const label = labelOf(ep);
        return (
          <article
            key={ep.trash_id}
            className="mk-card"
            style={{
              marginBottom: 10, padding: "12px 16px",
              display: "flex", alignItems: "center", gap: 14, borderRadius: 12,
              opacity: restoring || permDeleting ? 0.55 : 1,
              transition: "opacity 0.15s",
            }}
          >
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--ink-50)", display: "grid", placeItems: "center", color: "var(--ink-400)", flexShrink: 0 }}>
              <Icon name="film" size={16} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 13, fontWeight: 650, color: "var(--ink-900)" }}>{label}</span>
                <span className="mk-chip" style={{ fontSize: 10, height: 18, padding: "0 6px" }}>分集</span>
                <span style={{ fontSize: 11, color: "var(--ink-500)" }}>{ep.shot_count} 个分镜</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-400)" }}>
                {formatRelativeTime(ep.trashed_at)} 删除
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <Button
                variant="primary" size="sm" iconLeft="refresh"
                disabled={restoring} loading={restoring}
                onClick={() => void handleRestore(ep)}
              >恢复</Button>
              <Button
                variant="danger" size="sm" iconLeft="trash"
                disabled={permDeleting} loading={permDeleting}
                onClick={() => void handlePermDelete(ep)}
              >永久删除</Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

// ── 素材 tab ────────────────────────────────────────────────
function ElementsTab({ slug, seriesOptions, seriesLoading, onPickSlug }: { slug: string | null } & TabSeriesPickerProps) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<ElementTrashKind | "all">("all");
  const { data, isLoading, mutate } = useSWR(
    slug ? ["element-trash", slug, filter] : null,
    () => listElementTrash(slug!, filter === "all" ? undefined : filter),
    { revalidateOnFocus: false, onError: (err) => showErrorToast(err, "加载素材回收站失败") },
  );

  const items = data?.items ?? [];

  async function handleRestore(entry: ElementTrashEntry) {
    if (!slug) return;
    try {
      const result = await restoreElementTrash(slug, entry.trash_id);
      await mutate();
      toast.success(`「${entry.name}」已恢复到素材库`);
      navigate(ROUTES.elementDetail(slug, result.restored_id));
    } catch (err) {
      showErrorToast(err, "恢复失败");
    }
  }

  async function handlePermanentDelete(entry: ElementTrashEntry) {
    if (!slug) return;
    const ok = await confirm({
      title: `永久删除「${entry.name}」?`,
      description: [
        "这条素材记录会从回收站中物理删除, 不可恢复.",
        "",
        "如果只是暂时不想看到, 可以让它保留到 90 天自动清理.",
        "",
        `· ${ELEMENT_KIND_LABEL[entry.kind]} · ${formatRelativeTime(entry.deleted_at)} 删除`,
      ].join("\n"),
      variant: "destructive",
      confirmLabel: "永久删除",
    });
    if (!ok) return;
    try {
      await permanentDeleteElementTrash(slug, entry.trash_id);
      await mutate();
      toast.success(`「${entry.name}」已永久删除`);
    } catch (err) {
      showErrorToast(err, "永久删除失败");
    }
  }

  if (!slug) {
    return <TrashSeriesPicker seriesOptions={seriesOptions} seriesLoading={seriesLoading} onPickSlug={onPickSlug} />;
  }

  return (
    <div>
      <div className="mk-tab-group" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        {([
          { kind: "all", label: "全部" },
          { kind: "character", label: "角色" },
          { kind: "scene", label: "场景" },
          { kind: "element", label: "物品 / 服装 / 杂物" },
        ] as const).map((tab) => (
          <button
            key={tab.kind}
            type="button"
            className={`mk-tab ${filter === tab.kind ? "mk-tab--active" : ""}`}
            onClick={() => setFilter(tab.kind)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div style={{ padding: "80px 0", textAlign: "center", color: "var(--ink-400)", fontSize: 13 }}>
          <Icon name="refresh" size={20} style={{ marginBottom: 8 }} />
          <div>加载中…</div>
        </div>
      ) : items.length === 0 ? (
        <Empty title="素材回收站为空" description="删除的角色/场景/物品会在这里保留 90 天" />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
          {items.map((entry) => {
            const urgent = entry.days_remaining <= 7;
            const thumb = entry.thumbnail_url
              ? entry.thumbnail_url
              : entry.thumbnail_asset_id
                ? imageThumbUrl(slug, { asset_id: entry.thumbnail_asset_id })
                : entry.thumbnail_vault_id
                  ? imageThumbUrl(slug, { vault_id: entry.thumbnail_vault_id })
                  : null;
            return (
              <article
                key={entry.trash_id}
                className="mk-card"
                style={{
                  padding: 14,
                  display: "grid",
                  gridTemplateColumns: "72px minmax(0, 1fr)",
                  gap: 12,
                  border: urgent ? "1.5px solid var(--warn, #f59e0b)" : undefined,
                  background: urgent ? "var(--warn-bg, rgba(245,158,11,0.04))" : undefined,
                }}
              >
                <div style={{ width: 72, height: 72, borderRadius: 10, overflow: "hidden", background: "var(--ink-50)", display: "grid", placeItems: "center", color: "var(--ink-300)" }}>
                  {thumb ? (
                    <img src={thumb} alt={entry.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <Icon name={entry.kind === "character" ? "user" : "image"} size={24} />
                  )}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span className="mk-chip mk-chip--ghost" style={{ fontSize: 11 }}>{ELEMENT_KIND_LABEL[entry.kind]}</span>
                    {entry.expired ? <span className="mk-pill mk-pill--failed" style={{ fontSize: 10.5 }}>已到期</span>
                    : urgent ? <span className="mk-pill mk-pill--generating" style={{ fontSize: 10.5 }}>快到期</span> : null}
                  </div>
                  <h2 style={{ margin: "0 0 4px", fontSize: 15, color: "var(--ink-900)" }}>{entry.name}</h2>
                  <p style={{ margin: 0, minHeight: 34, fontSize: 12, lineHeight: 1.45, color: "var(--ink-500)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {entry.description || "暂无描述"}
                  </p>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, fontSize: 11, color: "var(--ink-450)" }}>
                    <span>{formatRelativeTime(entry.deleted_at)} 删除</span>
                    <span>剩 {entry.days_remaining} 天</span>
                    {entry.image_count ? <span>{entry.image_count} 张图</span> : null}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                    <Button variant="primary" size="sm" iconLeft="refresh" onClick={() => handleRestore(entry)}>恢复</Button>
                    <Button variant="danger" size="sm" iconLeft="trash" onClick={() => handlePermanentDelete(entry)}>永久删除</Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── 系列 tab ────────────────────────────────────────────────
function SeriesTab() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { data, isLoading, mutate } = useSWR(
    "trash:series",
    listTrashedSeries,
    { revalidateOnFocus: false, onError: (err) => showErrorToast(err) },
  );
  const records: TrashedSeriesEntry[] = data?.records ?? [];

  async function handleRestore(entry: TrashedSeriesEntry) {
    try {
      const result = await restoreTrashedSeries(entry.trash_id);
      await mutate();
      const titleText = entry.title ? `「${entry.title}」` : `「${entry.original_slug}」`;
      toast.success(
        result.slug !== entry.original_slug
          ? `${titleText} 已恢复 (重命名为 "${result.slug}" 防覆盖)`
          : `${titleText} 已恢复`,
        {
          duration: 6000,
          action: { label: "查看", onClick: () => navigate(ROUTES.seriesInbox(result.slug)) },
        },
      );
    } catch (err) {
      showErrorToast(err, "恢复失败");
    }
  }

  async function handlePermanentDelete(entry: TrashedSeriesEntry) {
    const titleText = entry.title || entry.original_slug;
    const ok = await confirm({
      title: `永久删除「${titleText}」?`,
      description: [
        "整个系列 (剧本/分镜/角色/场景/素材/已合成视频) 将物理删除, **不可恢复**.",
        "",
        "如果只想暂时清理列表, 可以等系统在 90 天后自动清理.",
        "",
        `· ${entry.episode_count ?? 0} 集 · ${formatRelativeTime(entry.trashed_at)} 删除`,
      ].join("\n"),
      variant: "destructive",
      confirmLabel: "永久删除",
    });
    if (!ok) return;
    try {
      await permanentDeleteTrashedSeries(entry.trash_id);
      await mutate();
      toast.success(`「${titleText}」已永久删除`);
    } catch (err) {
      showErrorToast(err, "永久删除失败");
    }
  }

  if (isLoading) {
    return (
      <div style={{ padding: "80px 0", textAlign: "center", color: "var(--ink-400)", fontSize: 13 }}>
        <Icon name="refresh" size={20} style={{ marginBottom: 8 }} />
        <div>加载中…</div>
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <Empty
        title="系列回收站为空"
        description="删除的系列会在这里保留 90 天, 可一键恢复"
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {records.map((entry) => {
        const titleText = entry.title || entry.original_slug;
        const urgent = entry.days_remaining <= 7;
        return (
          <div
            key={entry.trash_id}
            className="mk-card"
            style={{
              padding: 16, borderRadius: 12,
              display: "flex", alignItems: "center", gap: 16,
              ...(urgent ? { border: "1.5px solid var(--warn, #f59e0b)", background: "var(--warn-bg, rgba(245,158,11,0.04))" } : {}),
            }}
          >
            <div style={{ width: 48, height: 48, borderRadius: 12, background: "var(--ink-50)", display: "grid", placeItems: "center", color: "var(--ink-500)", flexShrink: 0 }}>
              <Icon name="trash" size={22} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink-900)", marginBottom: 4, fontFamily: '"Noto Serif SC", serif' }}>
                {titleText}
              </div>
              {entry.synopsis ? (
                <div style={{ fontSize: 12, color: "var(--ink-500)", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical" }}>
                  {entry.synopsis}
                </div>
              ) : null}
              <div style={{ fontSize: 12, color: "var(--ink-500)", display: "flex", gap: 10, flexWrap: "wrap" }}>
                <span>{entry.episode_count ?? 0} 集</span>
                {(entry.total_cost ?? 0) > 0 ? (
                  <>
                    <span style={{ opacity: 0.4 }}>·</span>
                    <span style={{ fontFeatureSettings: '"tnum"' }}>累计 ¥{((entry.total_cost ?? 0) / 100).toFixed(2)}</span>
                  </>
                ) : null}
                <span style={{ opacity: 0.4 }}>·</span>
                <span>{formatRelativeTime(entry.trashed_at)} 删除</span>
                <span style={{ opacity: 0.4 }}>·</span>
                <span style={{ color: urgent ? "var(--warn, #f59e0b)" : "var(--ink-600)", fontWeight: urgent ? 600 : 400 }}>
                  剩 {entry.days_remaining} 天自动永久删除
                </span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <Button variant="primary" size="sm" iconLeft="refresh" onClick={() => handleRestore(entry)}>恢复</Button>
              <Button variant="danger" size="sm" iconLeft="trash" onClick={() => handlePermanentDelete(entry)}>永久删除</Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 素材组 tab ────────────────────────────────────────────────
function CastsTab() {
  const { data, isLoading, mutate } = useSWR(
    "trash:casts",
    listDeletedCasts,
    { revalidateOnFocus: false, onError: (err) => showErrorToast(err, "加载素材组回收站失败") },
  );
  const casts: CastWithUsage[] = data?.casts ?? [];
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleRestore(cast: CastWithUsage) {
    setBusyId(cast.id);
    try {
      await restoreCast(cast.id);
      await mutate();
      toast.success(`素材组「${cast.name}」已恢复`);
    } catch (err) {
      showErrorToast(err, "恢复失败");
    } finally {
      setBusyId(null);
    }
  }

  if (isLoading) {
    return (
      <div style={{ padding: "80px 0", textAlign: "center", color: "var(--ink-400)", fontSize: 13 }}>
        <Icon name="refresh" size={20} style={{ marginBottom: 8 }} />
        <div>加载中…</div>
      </div>
    );
  }

  if (casts.length === 0) {
    return (
      <Empty
        title="素材组回收站为空"
        description="删除的素材组 (IP 容器) 会出现在这里, 可一键恢复"
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {casts.map((cast) => {
        const restoring = busyId === cast.id;
        return (
          <div
            key={cast.id}
            className="mk-card"
            style={{
              padding: 16, borderRadius: 12,
              display: "flex", alignItems: "center", gap: 16,
              opacity: restoring ? 0.55 : 1,
              transition: "opacity 0.15s",
            }}
          >
            <div style={{ width: 48, height: 48, borderRadius: 12, background: "var(--ink-50)", display: "grid", placeItems: "center", color: "var(--ink-500)", flexShrink: 0 }}>
              <Icon name="grid" size={22} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink-900)", marginBottom: 4, fontFamily: '"Noto Serif SC", serif' }}>
                {cast.name}
              </div>
              {cast.description ? (
                <div style={{ fontSize: 12, color: "var(--ink-500)", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical" }}>
                  {cast.description}
                </div>
              ) : null}
              <div style={{ fontSize: 12, color: "var(--ink-500)", display: "flex", gap: 10, flexWrap: "wrap" }}>
                <span>{cast.member_element_ids.length} 个素材</span>
                {cast.referencing_series_count > 0 ? (
                  <>
                    <span style={{ opacity: 0.4 }}>·</span>
                    <span>被 {cast.referencing_series_count} 部系列引用</span>
                  </>
                ) : null}
                <span style={{ opacity: 0.4 }}>·</span>
                <span>{formatRelativeTime(cast._deleted_at ?? cast.updated_at)} 删除</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <Button
                variant="primary" size="sm" iconLeft="refresh"
                disabled={restoring} loading={restoring}
                onClick={() => void handleRestore(cast)}
              >恢复</Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 主页 ────────────────────────────────────────────────
export default function GlobalTrashPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentSlug = useSessionStore((s) => s.currentSeriesSlug);

  // 2026-07-22 Y6 UP-11: 直接打开 /trash (无当前系列上下文, currentSlug 为 null) 时,
  // "分镜/分集/素材" 三个 tab 原本只能"去主页选系列"被迫绕路. 这里页内自己拉一份系列列表,
  // 让用户当场从下拉里选一部剧查看回收站 —— pickedSlug 优先于全局 currentSlug (用户在本页
  // 显式选了就按选的走), 不写回 useSessionStore (不影响本页以外的"当前系列"语义).
  const { data: seriesListData, isLoading: seriesListLoading } = useSWR(
    "trash:all-series-for-picker",
    () => listSeries(),
    { revalidateOnFocus: false, onError: (err) => showErrorToast(err, "加载系列列表失败") },
  );
  const [pickedSlug, setPickedSlug] = useState<string | null>(null);
  const effectiveSlug = pickedSlug ?? currentSlug ?? null;
  const seriesOptions = useMemo<SelectOption[]>(
    () => (seriesListData?.series ?? []).map((s: SeriesRecord) => ({
      value: s.slug,
      label: s.title,
      description: `${s.episode_count} 集`,
    })),
    [seriesListData],
  );

  // 默认 tab: ?tab= URL 参数优先, 没传则 "系列" (全局可用), 有 slug 则默认 "分镜".
  const initialTab = useMemo<TabId>(() => {
    const t = searchParams.get("tab");
    if (t === "shots" || t === "episodes" || t === "elements" || t === "series" || t === "casts") return t;
    return currentSlug ? "shots" : "series";
  }, [searchParams, currentSlug]);

  const [tab, setTab] = useState<TabId>(initialTab);

  // 2026-05-26 audit #4 修复 — currentSlug 是 SSE 异步加载, 首次 mount 时常为 null →
  // initialTab 落 "series", 但用户期望落 "shots". 加 useEffect 监听首次 currentSlug 变化时
  // 同步一次 tab. 用 ref 守住 "只同步一次", 避免覆盖用户后续主动切换.
  const slugSyncedRef = useRef(false);
  useEffect(() => {
    if (slugSyncedRef.current) return;
    if (!currentSlug) return;
    // URL 显式带 ?tab= 时优先 URL, 不动. 没带时把 tab 从 series 跳到 shots.
    const urlTab = searchParams.get("tab");
    if (urlTab === "shots" || urlTab === "episodes" || urlTab === "elements" || urlTab === "series" || urlTab === "casts") {
      slugSyncedRef.current = true;
      return;
    }
    slugSyncedRef.current = true;
    setTab("shots");
  }, [currentSlug, searchParams]);

  const handleTabChange = useCallback((id: TabId) => {
    // 用户主动切换 → 后续 currentSlug 变化不再覆盖
    slugSyncedRef.current = true;
    setTab(id);
    const next = new URLSearchParams(searchParams);
    next.set("tab", id);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <PageTransition>
      <div style={{ padding: "32px 40px", minHeight: "100%", background: "var(--surface-canvas)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 22, gap: 18, flexWrap: "wrap" }}>
          <div>
            <div className="mk-label" style={{ marginBottom: 6 }}>TRASH</div>
            <h1 style={{ fontSize: 28, lineHeight: 1.18, margin: "0 0 6px", color: "var(--ink-950)", fontWeight: 600, fontFamily: '"Noto Serif SC", serif' }}>
              回收站
            </h1>
            <div style={{ fontSize: 13, color: "var(--ink-500)" }}>
              所有被删的分镜 / 素材 / 系列都在这里, 可随时恢复或手动永久删除. 素材和系列超过 90 天自动清理, 分镜长期保留、不会自动删除.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* 2026-07-22 Y6 UP-11: 常驻页内系列选择器 — 只在按系列查看的 3 个 tab 显示,
                跟三个 Tab 共用同一份 pickedSlug, 切换后三个 tab 同步刷新(不止刷当前这个). */}
            {(tab === "shots" || tab === "episodes" || tab === "elements") ? (
              <Select
                options={seriesOptions}
                value={effectiveSlug}
                placeholder={seriesListLoading ? "系列加载中…" : "选择系列…"}
                disabled={seriesListLoading || seriesOptions.length === 0}
                onChange={setPickedSlug}
                prefix="系列"
                ariaLabel="切换要查看回收站的系列"
                maxWidth={220}
              />
            ) : null}
            <Button variant="secondary" iconLeft="arrowLeft" onClick={() => navigate("/studio")}>返回工作站</Button>
          </div>
        </div>

        <div className="mk-tab-group" style={{ marginBottom: 22, flexWrap: "wrap" }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`mk-tab ${tab === t.id ? "mk-tab--active" : ""}`}
              onClick={() => handleTabChange(t.id)}
              title={t.hint}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          {tab === "shots" && (
            <ShotsTab slug={effectiveSlug} seriesOptions={seriesOptions} seriesLoading={seriesListLoading} onPickSlug={setPickedSlug} />
          )}
          {tab === "episodes" && (
            <EpisodesTab slug={effectiveSlug} seriesOptions={seriesOptions} seriesLoading={seriesListLoading} onPickSlug={setPickedSlug} />
          )}
          {tab === "elements" && (
            <ElementsTab slug={effectiveSlug} seriesOptions={seriesOptions} seriesLoading={seriesListLoading} onPickSlug={setPickedSlug} />
          )}
          {tab === "series" && <SeriesTab />}
          {tab === "casts" && <CastsTab />}
        </div>
      </div>
    </PageTransition>
  );
}
