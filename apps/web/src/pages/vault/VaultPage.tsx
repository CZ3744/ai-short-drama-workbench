// v24-batch-all · VaultPage · 接真 API (listVault + trash + restore)
// 数据源: GET /api/v2/vault → { entries: VaultEntry[], stats: VaultStats }
// 操作: POST /api/v2/vault/:id/trash (软删) · POST /api/v2/vault/:id/restore
//
// 2026-05-26 audit #2: 合并旧 /library — 顶部加 scope tab "本系列 / 全局" 切换. 没系列时强制 全局.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "../../components/shared/Icon";
import { Button } from "../../components/ui/button";
import { PageTransition } from "../../components/studio/PageTransition";
import { Empty } from "../../components/ui/empty";
import { useSessionStore } from "../../stores/sessionStore";
import {
  listVault, vaultTrash, vaultRestore, vaultThumbUrl, vaultRawUrl,
  vaultRemix,
  type VaultEntry, type VaultStats, type VaultListOpts,
} from "../../lib/api";
import { showErrorToast } from "../../lib/errorTranslate";
import { labelOfSource } from "../../lib/sourceLabels";
import { formatBytes } from "../../lib/format";
import { seriesAspectToCss } from "../../lib/aspectRatio";
import { MediaLightbox } from "../../components/shared/MediaLightbox";
import { useConfirm } from "../../components/ui/ConfirmModal";
import { InlineLabel } from "../../components/shot-stage/InlineLabel";
import { apiPatch } from "../../lib/_apiClient";
import { toast } from "sonner";
// 2026-05-26: "风格变体" 弹小 popover — 让用户显式选图像模型, 避免 silent 走默认导致
// "该 Provider 当前不可用" 用户无措.
import { VaultRemixPopover } from "../../components/vault/VaultRemixPopover";

type TabId = "all" | "paid" | "trashed";

interface Tab { id: TabId; l: string; hint?: string; }
const TABS: Tab[] = [
  { id: "all",     l: "全部",            hint: "所有活跃归档"  },
  { id: "paid",    l: "付费资产",        hint: "已记录生成费用的图片与视频" },
  { id: "trashed", l: "回收站 (90 天)",  hint: "回收站中, 可恢复"  },
];


function entryTitle(e: VaultEntry): string {
  // 铁律 #9 toC 兜底: 不暴露任何 hash/UUID/ULID.
  // 优先级: 来源类型(人话) → shot context → character context → scene context → "未命名素材"
  // shot_id / character_id / scene_id 是技术 ULID 不显示; 只用 source 得到人话.
  if (e.context?.source) return labelOfSource(e.context.source);
  if (e.context?.shot_id) return "分镜素材";
  if (e.context?.character_id) return "角色素材";
  if (e.context?.scene_id) return "场景素材";
  return "未命名素材";
}

function entryMeta(e: VaultEntry): string {
  const parts: string[] = [];
  if (e.context?.source) parts.push(labelOfSource(e.context.source));
  // V-3.5 铁律 #9 toC 兜底: model_id 不暴露技术字段, 用 provider_id 或 "AI 生成" 替代
  if (e.provider_id) parts.push(labelProviderId(e.provider_id));
  if (e.cost_cny != null && e.cost_cny > 0) parts.push(`¥${e.cost_cny.toFixed(2)}`);
  parts.push(formatBytes(e.bytes));
  return parts.join(" · ");
}

/** 铁律 #9: provider_id toC 映射 — 不暴露蛇形/下划线/技术 token */
function labelProviderId(pid: string): string {
  const map: Record<string, string> = {
    chatgpt_codex_image: "ChatGPT 生图",
    local_card_image: "本地卡片",
    openclaw_local: "本机 SDXL",
    aliyun_wan_t2v: "阿里云",
    minimax_hailuo: "MiniMax",
    jimeng_video_3pro: "即梦",
    kling_3: "Kling",
    vidu_q3_ref: "Vidu",
    edge_tts: "Edge TTS",
    local_mock_video: "本地模拟",
  };
  return map[pid] ?? pid;
}

export default function VaultPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentSlug = useSessionStore((s) => s.currentSeriesSlug);
  // 2026-05-26 audit #2: scope 切换 "本系列 / 全局".
  // - 没系列时强制 "global" (没 series filter 可用).
  // - 旧 /library?scope=global 重定向命中, 老 /vault 默认 series (有 slug 时).
  const initialScope = useMemo<"series" | "global">(() => {
    const s = searchParams.get("scope");
    if (s === "global") return "global";
    if (s === "series" && currentSlug) return "series";
    return currentSlug ? "series" : "global";
  }, [searchParams, currentSlug]);
  const [scope, setScope] = useState<"series" | "global">(initialScope);

  // 2026-05-26 audit #4 修复 — currentSlug 是 SSE 异步加载, 首次 mount 时常为 null →
  // initialScope 落 "global", 但用户进入 /vault 期望默认 "series". 加 useEffect 监听首次
  // currentSlug 变化时同步一次 scope. 用 ref 守住 "只同步一次", 避免覆盖用户后续主动切换.
  const slugSyncedRef = useRef(false);
  useEffect(() => {
    if (slugSyncedRef.current) return;
    if (!currentSlug) return;
    // URL 显式带 ?scope= 时优先 URL, 不动. 没带时把 scope 从 global 跳到 series.
    const urlScope = searchParams.get("scope");
    if (urlScope === "global" || urlScope === "series") {
      slugSyncedRef.current = true;
      return;
    }
    slugSyncedRef.current = true;
    setScope("series");
  }, [currentSlug, searchParams]);

  const handleScopeChange = (next: "series" | "global") => {
    // 用户主动切换 → 后续 currentSlug 变化不再覆盖
    slugSyncedRef.current = true;
    setScope(next);
    const sp = new URLSearchParams(searchParams);
    sp.set("scope", next);
    setSearchParams(sp, { replace: true });
  };
  const [tab, setTab] = useState<TabId>("all");
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [loading, setLoading] = useState(false);
  // P0-1 (2026-05-29): 分页状态 — 后端真实总数 + 是否还有更多
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // P0-1: 每页 200 条，加载更多追加
  const PAGE_LIMIT = 200;
  const [busyId, setBusyId] = useState<string | null>(null);
  // W8-sweep (2026-05-16): 点击归档缩略图 → MediaLightbox 放大查看
  const [lightboxEntry, setLightboxEntry] = useState<VaultEntry | null>(null);

  const reload = async () => {
    // P0-1 (2026-05-29): 修数据无声丢失 — 改为分页加载, 第一页 200 条 + "加载更多" 追加.
    // 之前 limit:1000 被后端 Math.min(1000, 200) 截成 200, 剩余数据无声消失.
    // 注: "付费资产"tab 仍在前端过滤 (cost_cny>0), 分页后 paid tab 计数来自 stats.
    const opts: VaultListOpts = { limit: PAGE_LIMIT, offset: 0 };
    if (tab === "trashed") opts.status = "trashed";
    else opts.status = "active";
    // 2026-05-26 audit #2: 接 scope 范围过滤. series scope + 有 slug 才传 series_slug 过滤.
    if (scope === "series" && currentSlug) opts.series_slug = currentSlug;
    setLoading(true);
    try {
      const res = await listVault(opts);
      setEntries(res.entries);
      setStats(res.stats);
      setHasMore(res.has_more ?? false);
    } catch (err) {
      showErrorToast(err, "加载归档柜失败");
    } finally {
      setLoading(false);
    }
  };

  // P0-1: 加载更多 — 用当前 entries.length 作 offset, 追加到列表末
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    const opts: VaultListOpts = { limit: PAGE_LIMIT, offset: entries.length };
    if (tab === "trashed") opts.status = "trashed";
    else opts.status = "active";
    if (scope === "series" && currentSlug) opts.series_slug = currentSlug;
    setLoadingMore(true);
    try {
      const res = await listVault(opts);
      setEntries((prev) => [...prev, ...res.entries]);
      setHasMore(res.has_more ?? false);
    } catch (err) {
      showErrorToast(err, "加载更多归档失败");
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab, scope, currentSlug]);

  const filtered = useMemo(() => {
    if (tab === "paid") return entries.filter((e) => (e.cost_cny ?? 0) > 0);
    return entries;
  }, [entries, tab]);

  const counts = useMemo(() => {
    const paid = entries.filter((e) => (e.cost_cny ?? 0) > 0).length;
    return {
      all: stats?.total ?? entries.length,
      paid,
      trashed: stats?.trashed ?? 0,
    };
  }, [entries, stats]);

  // V-19 (2026-05-26 重写): 风格变体 — 弹 popover 让用户显式选图像模型 + 改修改意见,
  // 再调 vaultRemix。原直接走默认 provider 的 silent 路径已弃用 — 默认模型不可用时
  // 会弹"该 Provider 当前不可用"用户摸不着头脑.
  const [remixBusyId, setRemixBusyId] = useState<string | null>(null);
  const [remixPopoverId, setRemixPopoverId] = useState<string | null>(null);
  const handleRemixSubmit = async (
    vaultId: string,
    opts: { provider_id: string; user_note: string },
  ) => {
    if (remixBusyId === vaultId) return;
    setRemixBusyId(vaultId);
    try {
      const result = await vaultRemix(vaultId, {
        user_note: opts.user_note,
        provider_id: opts.provider_id,
      });
      setRemixPopoverId(null); // 关弹层
      if (result.mock_fallback) {
        toast.info("风格变体功能暂未接入真实 provider，已用模拟结果");
      } else {
        toast.success(`风格变体已生成 ${result.count} 张`, { duration: 4000 });
      }
      await reload();
    } catch (err) {
      showErrorToast(err, "风格变体生成失败");
    } finally {
      setRemixBusyId(null);
    }
  };

  const handleTrash = async (id: string) => {
    if (busyId) return;
    const ok = await confirm({
      title: "移到回收站?",
      description: "付费资产会保留, 90 天后可恢复。",
      variant: "warning",
      confirmLabel: "移到回收站",
    });
    if (!ok) return;
    setBusyId(id);
    try {
      await vaultTrash(id);
      await reload();
    } catch (err) {
      showErrorToast(err, "移入回收站失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleRestore = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await vaultRestore(id);
      await reload();
    } catch (err) {
      showErrorToast(err, "恢复失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <PageTransition>
      <div className="v24-vault-page" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-canvas)" }}>
        <div style={{ padding: "20px 28px", background: "var(--surface-card)", borderBottom: "1px solid var(--ink-100)", display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--brand-700)", textTransform: "uppercase" }}>归档柜</div>
            <h2 style={{ margin: "2px 0 0", fontFamily: "'Noto Serif SC', serif", fontSize: 22, fontWeight: 600, color: "var(--ink-900)" }}>付费资产永不删 · 回收站 90 天</h2>
          </div>
          {/* 2026-05-26 audit #2: scope 切换 "本系列 / 全局" — 替代旧公共资源库 /library 入口. */}
          <div className="mk-tab-group" style={{ marginLeft: 12 }}>
            <button
              type="button"
              className={`mk-tab ${scope === "series" ? "mk-tab--active" : ""}`}
              onClick={() => handleScopeChange("series")}
              disabled={!currentSlug}
              title={currentSlug ? "只看当前系列的归档" : "请先在主页选系列, 才能切回 '本系列'"}
              style={!currentSlug ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
            >本系列</button>
            <button
              type="button"
              className={`mk-tab ${scope === "global" ? "mk-tab--active" : ""}`}
              onClick={() => handleScopeChange("global")}
              title="跨项目浏览全部 vault 条目"
            >全局</button>
          </div>
          <span style={{ flex: 1 }} />
          {stats && (
            <div style={{ fontSize: 12, color: "var(--ink-600)" }}>
              {/* P0-1 (2026-05-29): 如果还有更多未加载的, 明确告知"已显示 N / 共 M 项", 杜绝数据无声消失 */}
              {hasMore
                ? `已显示 ${entries.length} 项 / 共 ${stats.total} 项`
                : `共 ${stats.total} 项`} · 图 {stats.images} · 视频 {stats.videos} · 存储 {formatBytes(stats.total_bytes)}
            </div>
          )}
        </div>

        <div className="mk-scroll" style={{ flex: 1, overflow: "auto", padding: "20px 28px" }}>
          {/* 2026-05-25 D4 R-01: 迁 mk-tab-group/mk-tab 统一视觉, 跟 ElementListPage / LibraryPickerModal 等其他 tab 视觉一致 */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <div className="mk-tab-group">
              {TABS.map((t) => {
                const on = t.id === tab;
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={on ? "mk-tab mk-tab--active" : "mk-tab"}
                    onClick={() => setTab(t.id)}
                  >{t.l} {counts[t.id]}</button>
                );
              })}
            </div>
            <span style={{ fontSize: 11, color: "var(--ink-400)" }}>
              {TABS.find((t) => t.id === tab)?.hint}
            </span>
          </div>

          {loading ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
              {Array.from({ length: 12 }).map((_, i) => <div key={i} className="mk-card" style={{ height: 140, background: "var(--ink-50)" }} />)}
            </div>
          ) : filtered.length === 0 ? (
            <Empty
              icon={<Icon name="image" size={40} />}
              title={tab === "trashed" ? "回收站为空" : tab === "paid" ? "暂无付费素材" : "为创作留下每一份素材"}
              description={tab === "trashed" ? "90 天内移入回收站的素材会出现在这里，可以随时恢复。" : tab === "paid" ? "这里会收集已记录生成费用的素材，也可以查看全部归档。" : "生成的图片与视频会自动收藏在这里，方便预览、重用和恢复。"}
              cta={tab !== "all" ? "查看全部归档" : currentSlug ? "去制作素材" : "选择作品"}
              onCta={() => tab !== "all" ? setTab("all") : navigate(currentSlug ? `/studio/${encodeURIComponent(currentSlug)}/elements` : "/studio")}
            />
          ) : (
            <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
              {filtered.map((e) => {
                const isVideo = e.kind === "video";
                const isPaid = (e.cost_cny ?? 0) > 0;
                const isTrashed = e.status === "trashed";
                return (
                  <div key={e.vault_id} className="mk-card mk-card-hov" style={{ padding: 0, overflow: "hidden", opacity: isTrashed ? 0.65 : 1 }}>
                    <div style={{ position: "relative", aspectRatio: e.width && e.height ? `${e.width}/${e.height}` : seriesAspectToCss(undefined) }}>
                      {/* A 类内容图：vault 归档资产缩略图，点击放大 / 右键复制 (W8-sweep) */}
                      <img
                        src={vaultThumbUrl(e.vault_id, 384)}
                        alt={e.display_name || entryTitle(e)}
                        title="点击放大 / 右键可复制图片"
                        onClick={() => setLightboxEntry(e)}
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "var(--ink-100)", cursor: "zoom-in" }}
                        onError={(ev) => { (ev.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
                      />
                      {isPaid && <span style={{ position: "absolute", top: 4, right: 4, padding: "2px 6px", borderRadius: 999, background: "var(--brand-500)", color: "#fff", fontSize: 9, fontWeight: 700 }}>付费</span>}
                      {isVideo && <span style={{ position: "absolute", top: 4, left: 4, height: 16, padding: "0 6px", borderRadius: 4, background: "rgba(0,0,0,0.65)", color: "#fff", fontSize: 9, fontWeight: 600 }}>VIDEO</span>}
                    </div>
                    <div style={{ padding: "6px 8px" }}>
                      {/* V-3.4 铁律 #2: display_name inline edit — VaultEntry 展示名走 InlineLabel */}
                      <div style={{ marginBottom: 1 }}>
                        <InlineLabel
                          value={e.display_name || ""}
                          fallback={entryTitle(e)}
                          onSave={async (newName) => {
                            const trimmed = newName.trim();
                            if (trimmed === (e.display_name || "")) return;
                            try {
                              await apiPatch(`/api/v2/vault/${e.vault_id}`, { display_name: trimmed || undefined });
                              // 本地 mirror 更新
                              e.display_name = trimmed || undefined;
                            } catch (e) { showErrorToast(e, "改名失败"); throw e; }
                          }}
                        />
                      </div>
                      <div style={{ fontSize: 9.5, color: "var(--ink-400)" }}>{entryMeta(e)}</div>
                    </div>
                    <div style={{ padding: "4px 8px 8px", display: "flex", gap: 4 }}>
                      {isTrashed ? (
                        <Button
                          variant="primary"
                          size="xs"
                          style={{ flex: 1 }}
                          loading={busyId === e.vault_id}
                          disabled={busyId === e.vault_id}
                          onClick={() => void handleRestore(e.vault_id)}
                        >恢复</Button>
                      ) : (
                        <>
                          {/* V-19 (2026-05-26 重写): 风格变体入口 — 包 VaultRemixPopover, 点开弹小弹层
                              让用户先选图像模型再触发, 不再 silent 走默认 provider. */}
                          {!isVideo && (
                            <VaultRemixPopover
                              open={remixPopoverId === e.vault_id}
                              onOpenChange={(v) => setRemixPopoverId(v ? e.vault_id : null)}
                              busy={remixBusyId === e.vault_id}
                              onSubmit={(opts) => void handleRemixSubmit(e.vault_id, opts)}
                              triggerEl={
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  iconLeft="sparkles"
                                  style={{ flex: 1 }}
                                  loading={remixBusyId === e.vault_id}
                                  disabled={remixBusyId === e.vault_id}
                                >风格变体</Button>
                              }
                            />
                          )}
                          <Button
                            variant="ghost"
                            size="xs"
                            iconLeft="trash"
                            style={{ flex: 1 }}
                            loading={busyId === e.vault_id}
                            disabled={busyId === e.vault_id}
                            onClick={() => void handleTrash(e.vault_id)}
                          >移到回收站</Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* P0-1 (2026-05-29): 加载更多 — 明确告知已显/总数, 提供按钮追加后续批次.
                杜绝后端截 200 条数据静默丢失的情况. */}
            {hasMore && (
              <div style={{ marginTop: 20, textAlign: "center" }}>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={loadingMore}
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >加载更多（已显示 {entries.length} 项）</Button>
              </div>
            )}
            </>
          )}
        </div>
      </div>
      {/* W8-sweep (2026-05-16): MediaLightbox 放大查看(图/视频自动判断)
          2026-05-27 bugfix: src 走 vaultRawUrl 拿原图 /raw,
          之前用 vaultThumbUrl(_, 1920) 仍是 thumbnail 端点 — 视频 vault
          走 thumbnail 端点会返 JPG 首帧, <video src> 根本不能播放. */}
      <MediaLightbox
        open={!!lightboxEntry}
        src={lightboxEntry ? vaultRawUrl(lightboxEntry.vault_id) : ""}
        kind={lightboxEntry?.kind === "video" ? "video" : "image"}
        metadata={lightboxEntry ? {
          provider: lightboxEntry.context?.source ? labelOfSource(lightboxEntry.context.source) : undefined,
          cost_cny: lightboxEntry.cost_cny ?? undefined,
        } : undefined}
        onClose={() => setLightboxEntry(null)}
      />
    </PageTransition>
  );
}
