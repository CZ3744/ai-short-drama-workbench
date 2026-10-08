// 拆自 ShotboardPage.tsx — 单个分镜卡片(article).
// 整张可点(导航到 shot-stage), 左边拖拽把手 + 勾选框, 双格首帧/视频缩略图,
// 中间文字 + ShotReferenceChips, 右边显示"⋯"按钮 (hover 显示, 点开下拉菜单).
//
// 拖拽 / 勾选 / 操作 handler 全部 props 传入,卡片本身无业务 state。
//
// W10 (2026-05-26): 删右侧竖排 4 按钮 ("抽首帧/抽视频" 这俩只是跳进单镜带 query 误导用户),
//                   改用 "⋯" 菜单收纳 (进单镜 / 在此后插入 / 删除). 整张卡 click 进单镜.
import { useRef, useState, useEffect } from "react";
import type { useNavigate } from "react-router-dom";
import { Icon, type IconName } from "../../../components/shared/Icon";
import { MediaLightbox } from "../../../components/shared/MediaLightbox";
import { ShotReferenceChips } from "../../../components/shared/ShotReferenceChips";
import { labelOfStatus } from "../../../lib/sourceLabels";
import { shotTypeDisplayLabel } from "../../../lib/shotMetaPresets";
import { cameraMovementDisplayLabel } from "../../../lib/cameraMovementPresets";
import type { Shot } from "../../../hooks/useShots";

export function pickThumb(shot: Shot): string | undefined {
  const picked = shot.first_frame_candidates.find((c) => c.id === shot.picked_first_frame_id);
  const first = shot.first_frame_candidates[0];
  return picked?.thumbnail ?? picked?.url ?? first?.thumbnail ?? first?.url;
}

export function shotText(shot: Shot): string {
  return shot.action || shot.action_description || shot.voiceover || shot.dialogue || "这一镜还没有文字描述";
}

export function shotMeta(shot: Shot): string {
  // 2026-05-19: 走 toC 翻译表, 不再让 close_up / wide_shot 等英文直显给用户 (铁律 #9)
  // P1-8: 补充 lighting / mood / time_of_day 让分镜卡片信息密度更高
  const shotTypeLabel = shotTypeDisplayLabel(shot.shot_type) || "景别待定";
  const cameraLabel = cameraMovementDisplayLabel(shot.camera_movement) || "运镜待定";
  const bits = [
    shotTypeLabel,
    cameraLabel,
    `${shot.duration_sec || 5}s`,
  ];
  if (shot.scene_name || shot.scene_id) bits.unshift(shot.scene_name || `场景 ${shot.scene_id}`);
  if (shot.time_of_day) bits.push(shot.time_of_day);
  if (shot.lighting) bits.push(shot.lighting);
  if (shot.mood) bits.push(shot.mood);
  return bits.join(" · ");
}

export function ShotCard({
  shot,
  slug,
  selectedEpId,
  aspectRatio = "16/9",
  selected,
  isDragging,
  isDragOver,
  creatingShot,
  navigate,
  onToggleSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onInsertAfter,
  onDelete,
}: {
  shot: Shot;
  slug: string;
  selectedEpId: string;
  aspectRatio?: string;
  selected: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  creatingShot: boolean;
  navigate: ReturnType<typeof useNavigate>;
  onToggleSelect: (shotId: string) => void;
  onDragStart: (e: React.DragEvent, shotId: string) => void;
  onDragOver: (e: React.DragEvent, shotId: string) => void;
  onDrop: (e: React.DragEvent, shotId: string) => void;
  onDragEnd: () => void;
  onInsertAfter: (shotId: string) => void;
  onDelete: (shotId: string, shotIndex: number | undefined, e: React.MouseEvent) => void;
}) {
  const thumb = pickThumb(shot);
  const videoThumb =
    shot.video_candidates?.find((c) => c.id === shot.picked_video_id)?.thumbnail
    ?? shot.video_candidates?.[0]?.thumbnail
    ?? undefined;
  const shotRoute = `/studio/${slug}/shot-stage/${selectedEpId}/${shot.id}`;

  // 2026-05-27 — 缩略图点击 lightbox 预览 (用户原话: "分镜界面应该可以点击查看缩略
  // 图和视频"). 之前缩略图只 stopPropagation 没 onClick handler, 点击没反应.
  // 取真实 url (原图 / 视频), 比 thumbnail 高清.
  const pickedFirst = shot.first_frame_candidates.find((c) => c.id === shot.picked_first_frame_id)
    ?? shot.first_frame_candidates[0];
  const pickedVideo = shot.video_candidates?.find((c) => c.id === shot.picked_video_id)
    ?? shot.video_candidates?.[0];
  const firstFrameFullUrl = pickedFirst?.url || thumb;
  const videoFullUrl = pickedVideo?.url || videoThumb;
  const [lightbox, setLightbox] = useState<{
    open: boolean;
    src: string;
    kind: "image" | "video";
    label?: string;
  }>({ open: false, src: "", kind: "image" });

  // W10: ⋯ 菜单状态 — 点击外面或选项后自动收起
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  return (
    <article
      key={shot.id}
      // T2: 整张卡片点击进入创作页
      onClick={() => navigate(shotRoute)}
      // T3: draggable
      draggable={true}
      onDragStart={(e) => onDragStart(e, shot.id)}
      onDragOver={(e) => onDragOver(e, shot.id)}
      onDrop={(e) => onDrop(e, shot.id)}
      onDragEnd={onDragEnd}
      className="mk-card shotboard-shot-card"
      style={{
        // 2026-05-19 #15 缩窄分镜卡片: minHeight 104→80, padding 12→"8px 12px"
        // #16 App Store 风格: hover 微妙阴影 + 圆角保持 10
        // W10: 删右侧竖排按钮列 → grid 收紧 (末列放 ⋮ 更多按钮, 2026-07-22 X4: 固定 36px→auto 容纳"更多"文字)
        minHeight: 80,
        borderRadius: 10,
        padding: "8px 12px",
        display: "grid",
        gridTemplateColumns: "22px 22px 184px minmax(0, 1fr) auto",
        gap: 10,
        alignItems: "center",
        cursor: "pointer",
        opacity: isDragging ? 0.45 : 1,
        position: "relative",
        transition: "opacity 0.15s, box-shadow 0.15s, border-color 0.15s, transform 0.15s",
        // T3: 拖拽目标位置蓝色分割线
        boxShadow: isDragOver ? "0 -3px 0 0 var(--brand-500), var(--shadow-md)" : "0 1px 2px rgba(0,0,0,0.03)",
        borderColor: selected ? "var(--brand-300)" : isDragOver ? "var(--brand-400)" : undefined,
        background: selected ? "var(--brand-25, rgba(217,119,87,0.04))" : "var(--surface-card)",
      }}
      onMouseEnter={(e) => {
        if (isDragging) return;
        (e.currentTarget as HTMLElement).style.boxShadow = "0 4px 12px rgba(0,0,0,0.06)";
        (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        if (isDragging) return;
        (e.currentTarget as HTMLElement).style.boxShadow = isDragOver ? "0 -3px 0 0 var(--brand-500), var(--shadow-md)" : "0 1px 2px rgba(0,0,0,0.03)";
        (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
      }}
    >
      {/* T3: 拖拽把手 */}
      <div
        className="shotboard-shot-grip"
        style={{ display: "grid", placeItems: "center", color: "var(--ink-300)", cursor: "grab" }}
        onClick={(e) => e.stopPropagation()}
        title="拖拽调整顺序"
      >
        <Icon name="grip" size={14} />
      </div>

      {/* T4: 勾选框 */}
      <div className="shotboard-shot-select" style={{ display: "grid", placeItems: "center" }} onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelect(shot.id);
          }}
          onClick={(e) => e.stopPropagation()}
          aria-label={`选择分镜 ${shot.index}`}
          style={{ width: 16, height: 16, accentColor: "var(--brand-500)", cursor: "pointer" }}
        />
      </div>

      {/* 缩略图双格 — 2026-05-19 #15 缩小 96→84 让卡更紧凑.
          2026-05-27 — 点击缩略图开 MediaLightbox 看大图/播放视频 (用户原话:
          "分镜界面应该可以点击查看缩略图和视频"). */}
      <div className="shotboard-shot-previews" style={{ display: "grid", gridTemplateColumns: "repeat(2, 84px)", gap: 8, alignItems: "start" }}>
        <div>
          <div
            onClick={(e) => {
              e.stopPropagation();
              if (firstFrameFullUrl) {
                setLightbox({ open: true, src: firstFrameFullUrl, kind: "image", label: `分镜 ${shot.index} 首帧` });
              }
            }}
            style={{
              position: "relative",
              width: 84, aspectRatio, borderRadius: 5,
              border: "1px solid var(--ink-100)",
              background: thumb ? undefined : "linear-gradient(135deg, var(--ink-50), var(--ink-100))",
              display: "grid", placeItems: "center", color: "var(--ink-300)", overflow: "hidden",
              cursor: firstFrameFullUrl ? "zoom-in" : "default",
            }}
            title={firstFrameFullUrl ? "点击放大查看首帧" : "还没生成首帧"}
          >
            {thumb ? (
              <img
                src={thumb}
                alt={`分镜 ${shot.index} 首帧`}
                loading="lazy"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              <Icon name="image" size={18} />
            )}
          </div>
          <div style={{ marginTop: 4, fontSize: 10, fontWeight: 650, color: "var(--ink-400)", textAlign: "center" }}>首帧</div>
        </div>
        <div>
          <div
            onClick={(e) => {
              e.stopPropagation();
              if (videoFullUrl) {
                setLightbox({ open: true, src: videoFullUrl, kind: "video", label: `分镜 ${shot.index} 视频` });
              }
            }}
            style={{
              position: "relative",
              width: 84, aspectRatio, borderRadius: 5,
              border: "1px solid var(--ink-100)",
              background: videoThumb ? undefined : "linear-gradient(135deg, var(--ink-50), var(--ink-100))",
              display: "grid", placeItems: "center", color: "var(--ink-300)", overflow: "hidden",
              cursor: videoFullUrl ? "pointer" : "default",
            }}
            title={videoFullUrl ? "点击播放视频" : "还没生成视频"}
          >
            {videoThumb ? (
              <img
                src={videoThumb}
                alt={`分镜 ${shot.index} 视频缩略图`}
                loading="lazy"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              <Icon name="video" size={18} />
            )}
            {/* 视频缩略图右下 ▶ 提示 */}
            {videoFullUrl && (
              <span style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                pointerEvents: "none",
              }}>
                <span style={{
                  width: 28, height: 28, borderRadius: 999,
                  background: "rgba(0,0,0,0.55)",
                  display: "grid", placeItems: "center",
                  color: "rgba(255,255,255,0.95)",
                }}>
                  <Icon name="play" size={12} />
                </span>
              </span>
            )}
          </div>
          <div style={{ marginTop: 4, fontSize: 10, fontWeight: 650, color: "var(--ink-400)", textAlign: "center" }}>视频</div>
        </div>
      </div>

      {/* lightbox — 点击缩略图弹出, 内部 Esc / 背景点击 / × 按钮关闭. 不阻塞外层 onClick navigate */}
      <MediaLightbox
        open={lightbox.open}
        src={lightbox.src}
        kind={lightbox.kind}
        metadata={lightbox.label ? { provider: lightbox.label } : undefined}
        onClose={() => setLightbox((s) => ({ ...s, open: false }))}
      />

      {/* 文字信息 */}
      <div className="shotboard-shot-copy" style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 750, color: "var(--ink-900)" }}>分镜 {shot.index}</span>
          {(() => {
            // 2026-05-27 兜底: 如果 shot.status="failed" 但实际已经有 picked_first_frame /
            // picked_video, 显示真状态 (用户报告"为什么有首帧还是写失败标签").
            //   场景: 之前生图全失败 → status=failed, 后续重抽成功 picked_first_frame_generation_id
            //   被设, 但老 autoPickGenerations 没翻 status → UI 一直显失败.
            //   后端已修, 老数据这里前端兜底翻译, 不依赖重跑 pipeline.
            let effective = shot.status;
            if (shot.status === "failed") {
              if (shot.picked_video_id) effective = "approved";
              else if (shot.picked_first_frame_id) effective = "picked";
            }
            return (
              <span className={`mk-pill mk-pill--${effective}`} style={{ height: 20, fontSize: 10.5 }}>
                {labelOfStatus(effective)}
              </span>
            );
          })()}
          {/* 2026-05-28 深度打磨 #2: 失败计数徽章 — 让分镜板上一眼看出"这镜上次有失败".
              之前用户得点进单镜创作页才能看见"失败 N 次", 抖音/即创/智影 都在镜头列表
              直接显失败角标. 失败 >= 1 时显示红色圆点 + 数字, hover 看最近错误摘要.
              status 已恢复 (有 picked) 时不显, 避免信息冗余. */}
          {shot.failures && shot.failures.length > 0
            && !shot.picked_video_id && !shot.picked_first_frame_id && (
            <span
              title={`${shot.failures.length} 次失败 · 最近: ${shot.failures[shot.failures.length - 1]?.error || "未知错误"}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                height: 18,
                padding: "0 6px",
                borderRadius: 9,
                background: "rgba(220,38,38,0.10)",
                color: "var(--danger, #dc2626)",
                fontSize: 10,
                fontWeight: 700,
                border: "1px solid rgba(220,38,38,0.28)",
              }}
            >
              <Icon name="warning" size={10} />
              {shot.failures.length} 次失败
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--ink-800)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {shotText(shot)}
        </div>
        {/* 2026-05-19 Wave O: 引用素材 chips — 紧贴 action 文本下方,
            用户一眼能看清这镜引用了哪些角色/场景/项目素材 */}
        <div style={{ marginTop: 6 }}>
          <ShotReferenceChips
            slug={slug}
            characterIds={shot.character_ids}
            sceneId={shot.scene_id}
            elementIds={shot.element_ids}
            density="compact"
          />
        </div>
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--ink-500)" }}>{shotMeta(shot)}</div>
      </div>

      {/* W10: 右上角 ⋯ 菜单. 收纳"进单镜 / 在此后插入 / 删除".
          旧的"抽首帧/抽视频"独立按钮删除 (它们实际只是跳单镜页带 query, 误导用户以为原地生成).
          整张卡片 click = 进单镜 (旧语义保留, 也跟铁律 #7 标准创作工具一致). */}
      <div className="shotboard-shot-menu" ref={menuRef} style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={`分镜 ${shot.index} 更多操作`}
          title="更多操作"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 30,
            padding: "0 8px",
            borderRadius: 8,
            border: "1px solid var(--ink-150)",
            background: menuOpen ? "var(--brand-50, rgba(217,119,87,0.08))" : "var(--surface-card)",
            color: "var(--ink-600)",
            fontSize: 11.5,
            fontWeight: 600,
            whiteSpace: "nowrap",
            cursor: "pointer",
            transition: "background 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--brand-50, rgba(217,119,87,0.08))"; }}
          onMouseLeave={(e) => { if (!menuOpen) (e.currentTarget as HTMLElement).style.background = "var(--surface-card)"; }}
        >
          <Icon name="more" size={14} />
          更多
        </button>
        {menuOpen && (
          <div
            role="menu"
            style={{
              position: "absolute",
              top: 36,
              right: 0,
              zIndex: 20,
              minWidth: 168,
              padding: 4,
              borderRadius: 10,
              background: "var(--surface-card)",
              border: "1px solid var(--ink-150)",
              boxShadow: "0 10px 26px rgba(0,0,0,0.12)",
            }}
          >
            <MenuItem
              icon="edit"
              label="进单镜页编辑"
              onClick={() => { setMenuOpen(false); navigate(shotRoute); }}
            />
            <MenuItem
              icon="plus"
              label="在此后插入空镜"
              disabled={creatingShot}
              onClick={() => { setMenuOpen(false); onInsertAfter(shot.id); }}
            />
            <div style={{ height: 1, margin: "4px 2px", background: "var(--ink-100)" }} />
            <MenuItem
              icon="trash"
              label="删除本镜"
              tone="danger"
              onClick={(e) => { setMenuOpen(false); onDelete(shot.id, shot.index, e); }}
            />
          </div>
        )}
      </div>
    </article>
  );
}

// 菜单项 — 整行可点, hover 浅色背景, danger 红色文字
function MenuItem(props: {
  icon: IconName;
  label: string;
  tone?: "default" | "danger";
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const { icon, label, tone = "default", disabled = false, onClick } = props;
  const color = tone === "danger" ? "var(--danger, #dc2626)" : "var(--ink-800)";
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "8px 10px",
        borderRadius: 7,
        border: "none",
        background: "transparent",
        color,
        fontSize: 13,
        fontWeight: 500,
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.background = tone === "danger" ? "rgba(220,38,38,0.08)" : "var(--ink-50)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      <Icon name={icon} size={14} />
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  );
}
