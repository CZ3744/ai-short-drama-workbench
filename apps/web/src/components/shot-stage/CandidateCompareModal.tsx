// W8-BC (2026-05-16) · 候选并排对比 modal
// 触发: ShotStagePage 首帧候选区 toolbar "对比 (N)" 按钮(N≥2 启用)
// 输入: candidates 2-4 张 ShotCandidate
// 行为:
//   - 网格 1-4 列等分并排,图完整显示不裁剪(铁律#3 信息直接可见)
//   - 每张底部三按钮:设为主图(品牌橙填充) / 完整提示词(灰描边) / 下载(灰描边)
//   - 都是圆角+边框+icon+文字(铁律#11 永不 icon-only)
//   - ESC / 点遮罩 / 右上角 X 关闭
// 设计要点:
//   - 候选已经在主页面渲染过缩略图,这里允许"看大图并排"决策
//   - 不在 modal 内拉新数据,所有 props 透传,父组件持有 state
//   - 命名 vs RegenModal/MediaLightbox 区分:Compare 专司"并排比较",Lightbox 单张全屏
// 2026-05-20 P1 解耦: 改用 BaseDialog 统一 shell, 删自己的 backdrop / ESC listener / 头部容器.

import { toast } from "sonner";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { BaseDialog } from "../ui/BaseDialog";
import type { ShotCandidate } from "../../lib/shotApi";
import { videoFirstFrameSrc } from "../../lib/videoSrc";
import { candidateOriginalUrl } from "../../lib/imageThumb";
import { CandidateLabel } from "../shared/CandidateLabel";

export interface CandidateCompareModalProps {
  open: boolean;
  candidates: ShotCandidate[];
  /**
   * 2026-05-27 — 并排查看用大图需要 slug 拼 /raw, asset-only 候选不传 slug 会拿 64px thumbnail.
   * 历史调用方 (ShotStagePage) 已经在 useParams 里拿到 slug, 传进来即可.
   */
  slug: string;
  /** 设为主图(首帧):image-side 走 applyAnchor(c, "first"); video-side 走 selectVideo(c) */
  onPickAsMain: (candidate: ShotCandidate) => void;
  /** 查看完整提示词 — 让父打开 PromptReviewModal(可携带 candidate 上下文) */
  onViewPrompt: (candidate: ShotCandidate) => void;
  onClose: () => void;
}

export function CandidateCompareModal(props: CandidateCompareModalProps) {
  const { open, candidates, slug, onPickAsMain, onViewPrompt, onClose } = props;

  if (!open) return null;
  if (candidates.length === 0) return null;

  const cols = Math.min(candidates.length, 4);
  const isVideoKind = candidates[0]?.type === "video";

  const handleDownload = (c: ShotCandidate) => {
    // 2026-05-27 bugfix: 下载也要走原图 /raw, 不能用 c.url (asset-only 时是 64px thumbnail).
    const url = candidateOriginalUrl(slug, c);
    if (!url) {
      toast.error("候选无可下载源");
      return;
    }
    // 同浏览器原生右键"另存"路径 — a 标签 + download attr
    const a = document.createElement("a");
    a.href = url;
    a.download = `candidate-${c.id}.${isVideoKind ? "mp4" : "png"}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
    toast.success("已触发下载");
  };

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      iconName="grid"
      title={`候选并排对比 · ${candidates.length} 张`}
      subtitle="点「关闭」返回候选区"
      ariaLabel="候选并排对比"
      maxWidth={1400}
      zIndex={240}
    >
      {/* 候选网格 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gap: 16,
          alignItems: "start",
        }}
      >
        {candidates.map((c, i) => (
          <CompareTile
            key={c.id}
            candidate={c}
            index={i}
            slug={slug}
            onPickAsMain={() => onPickAsMain(c)}
            onViewPrompt={() => onViewPrompt(c)}
            onDownload={() => handleDownload(c)}
            isVideo={isVideoKind}
          />
        ))}
      </div>
    </BaseDialog>
  );
}

function CompareTile({
  candidate, index, slug, onPickAsMain, onViewPrompt, onDownload, isVideo,
}: {
  candidate: ShotCandidate;
  /** 2026-07-22 X5-1 (A4-2): 本次对比里的 0-based 位置, 供未命名候选 fallback "第 N 张" */
  index: number;
  slug: string;
  onPickAsMain: () => void;
  onViewPrompt: () => void;
  onDownload: () => void;
  isVideo: boolean;
}) {
  // 2026-05-27 bugfix: 并排查看是放大决策场景, src 必须走 /raw 原图,
  //   不能用 candidate.url (asset-only 候选会拿到 64px thumbnail).
  const url = candidateOriginalUrl(slug, candidate);
  return (
    <div
      style={{
        display: "flex", flexDirection: "column", gap: 10,
        borderRadius: 12,
        border: "1px solid var(--ink-150)",
        background: "var(--surface-card)",
        padding: 10,
      }}
    >
      {/* 2026-07-22 X5-1 (A4-2): tile 顶部可见名字行, 复用 CandidateLabel 只读态 (display_name 优先 fallback) */}
      <CandidateLabel candidate={candidate} fallbackIndex={index + 1} style={{ fontSize: 12.5 }} />
      <div
        style={{
          background: "var(--ink-50)",
          borderRadius: 5,
          overflow: "hidden",
          display: "grid", placeItems: "center",
          // 不裁剪:用 maxHeight 限制,但 objectFit contain 显示完整
          minHeight: 200,
          maxHeight: "60vh",
        }}
      >
        {isVideo && url ? (
          <video
            // 2026-05-27 bugfix: 视频也走 candidateOriginalUrl → /raw, 不能用 candidate.url
            //   (asset-only 时是 thumbnail JPG, <video src> 不能播放).
            src={videoFirstFrameSrc(url)}
            poster={candidate.thumbnail || undefined}
            controls
            preload="metadata"
            playsInline
            style={{ width: "100%", height: "auto", maxHeight: "60vh", objectFit: "contain", display: "block" }}
            title="右键可下载视频"
          />
        ) : url ? (
          <img
            src={url}
            alt={candidate.display_name ?? "候选图"}
            style={{ width: "100%", height: "auto", maxHeight: "60vh", objectFit: "contain", display: "block" }}
            title="右键可复制 / 另存"
          />
        ) : (
          <span style={{ color: "var(--ink-400)", fontSize: 12, padding: 24 }}>该候选暂无可显示资源</span>
        )}
      </div>

      {/* 三按钮:都圆角+边框+图标+文字 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button
          variant="primary"
          size="sm"
          iconLeft={isVideo ? "check" : "pin"}
          onClick={onPickAsMain}
          title={isVideo ? "选定此视频作为最终视频" : "设为主图(首帧锚点)"}
        >
          {isVideo ? "选定为最终视频" : "设为主图"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          iconLeft="doc"
          onClick={onViewPrompt}
          title="查看这张候选发给 API 时的完整提示词"
        >
          完整提示词
        </Button>
        <Button
          variant="secondary"
          size="sm"
          iconLeft="download"
          onClick={onDownload}
          title="下载到本地"
        >
          下载
        </Button>
      </div>
    </div>
  );
}


export default CandidateCompareModal;
