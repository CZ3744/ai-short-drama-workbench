import { useEffect, useRef, useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { ModelPicker } from "./ModelPicker";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { PromptReviewModal } from "../element/PromptReviewModal";
import { getLastUsedModel, rememberLastUsed } from "../../lib/lastUsedModel";
import { apiGet, previewCoverPrompt, type CoverGenerationOptions, type CoverPromptPreview } from "../../lib/api";
import { showErrorToast } from "../../lib/errorTranslate";

export interface CoverGenPopoverProps {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  triggerEl: React.ReactNode;
  busy: boolean;
  onSubmit: (options: CoverGenerationOptions) => void;
  title?: string;
  subtitle?: string;
  slug: string;
  episodeId?: string;
}

interface CandidateFrame { shot_id: string; shot_index: number; thumbnail_url: string; title?: string }

export function CoverGenPopover({ open, onOpenChange, triggerEl, busy, onSubmit, title = "生成系列封面", subtitle = "竖屏封面 · 1080 × 1920", slug, episodeId }: CoverGenPopoverProps) {
  const [modelRef, setModelRef] = useState(() => getLastUsedModel("image") || "");
  const [style, setStyle] = useState("");
  const [candidates, setCandidates] = useState<CandidateFrame[]>([]);
  const [refShotId, setRefShotId] = useState("");
  const [loadingFrames, setLoadingFrames] = useState(false);
  const [frameError, setFrameError] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [review, setReview] = useState<{ preview: CoverPromptPreview; options: CoverGenerationOptions } | null>(null);
  const previewRequest = useRef(0);
  const showRefPicker = !!episodeId;
  const canSubmit = !!modelRef && !busy && !loadingFrames && !frameError && !loadingPreview;

  useEffect(() => {
    if (!open) { previewRequest.current += 1; setLoadingPreview(false); }
  }, [open]);
  useEffect(() => () => { previewRequest.current += 1; }, []);

  useEffect(() => {
    if (!open || !episodeId) return;
    let alive = true;
    setLoadingFrames(true); setFrameError(false); setCandidates([]); setRefShotId("");
    void (async () => {
      try {
        const data = await apiGet<{ shots: Array<Record<string, unknown>> }>(`/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(episodeId)}/shots`);
        if (!alive) return;
        const frames: CandidateFrame[] = [];
        for (const shot of data.shots ?? []) {
          const pickedId = shot.picked_first_frame_id ?? shot.picked_first_frame_generation_id;
          if (!pickedId) continue;
          const frameCandidates = (shot.first_frame_candidates as Array<Record<string, unknown>> | undefined) ?? [];
          const candidate = frameCandidates.find((item) => item.generation_id === pickedId || item.id === pickedId);
          const thumbnail = candidate?.thumbnail || candidate?.url;
          if (typeof thumbnail !== "string" || typeof shot.id !== "string") continue;
          frames.push({ shot_id: shot.id, shot_index: typeof shot.index === "number" ? shot.index : frames.length + 1, thumbnail_url: thumbnail, title: typeof shot.title === "string" ? shot.title : undefined });
        }
        frames.sort((a, b) => a.shot_index - b.shot_index);
        setCandidates(frames); setRefShotId(frames[0]?.shot_id ?? "");
      } catch { if (alive) setFrameError(true); }
      finally { if (alive) setLoadingFrames(false); }
    })();
    return () => { alive = false; };
  }, [open, slug, episodeId]);

  async function reviewPrompt() {
    if (!canSubmit) return;
    const request = ++previewRequest.current;
    const options: CoverGenerationOptions = { provider_override: modelRef, style: style.trim() || undefined, reference_shot_id: refShotId || undefined };
    setLoadingPreview(true);
    try {
      const preview = await previewCoverPrompt(slug, options, episodeId);
      if (request !== previewRequest.current) return;
      onOpenChange(false);
      setReview({ preview, options: { ...options, reference_asset_id: preview.reference_asset_id } });
    } catch (error) { if (request === previewRequest.current) showErrorToast(error, "无法加载封面提示词，请重试"); }
    finally { if (request === previewRequest.current) setLoadingPreview(false); }
  }

  return <>
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{triggerEl}</PopoverTrigger>
      <PopoverContent align="center" className="w-[360px] max-w-[calc(100vw-24px)]" onClick={(event) => event.stopPropagation()}>
        <div className="studio-cover-popover">
          <div><h3>{title}</h3><p>{subtitle}</p></div>
          {showRefPicker && <div className="studio-cover-references">
            <strong>参考画面</strong>
            {loadingFrames ? <p role="status">正在读取本集已确认的首帧…</p> : frameError ? <div role="alert"><p>参考画面未能加载。请关闭后重试，或明确选择仅用文字创作。</p><Button variant="secondary" size="sm" iconLeft="doc" onClick={() => { setFrameError(false); setRefShotId(""); }}>仅用文字生成</Button></div> : candidates.length === 0 ? <p>还没有已确认的首帧。本次封面使用剧名和简介生成，之后可以加入参考画面。</p> : <><div className="studio-cover-reference-list"><button type="button" aria-pressed={!refShotId} disabled={loadingPreview} onClick={() => setRefShotId("")}><Icon name="doc" size={17} /><span>不使用参考</span></button>{candidates.map((frame) => <button type="button" key={frame.shot_id} aria-pressed={refShotId === frame.shot_id} disabled={loadingPreview} onClick={() => setRefShotId(frame.shot_id)} title={frame.title}><img src={frame.thumbnail_url} alt={`第 ${frame.shot_index} 镜首帧`} /><span>第 {frame.shot_index} 镜</span></button>)}</div><p>{refShotId ? "生成时将使用所选首帧，帮助保持人物与场景一致。" : "本次不发送参考图片，仅使用文字生成。"}</p></>}
          </div>}
          <div className="studio-create-field">图像模型<ModelPicker kind="image" value={modelRef} onChange={(value) => { setModelRef(value ?? ""); if (value) rememberLastUsed("image", value); }} disabled={loadingPreview || busy} size="sm" placeholder="选图像模型" /></div>
          <label className="studio-create-field">风格关键词（可选）<input className="studio-create-input" value={style} disabled={loadingPreview || busy} onChange={(event) => setStyle(event.target.value)} placeholder="例如：古风插画、电影感写实" maxLength={100} /></label>
          <p>生成前可以查看、修改并复制完整提示词和参考图片。</p>
          <div className="studio-cover-popover-actions"><Button variant="secondary" size="sm" iconLeft="eye" disabled={!canSubmit} loading={loadingPreview} onClick={() => void reviewPrompt()}>查看完整提示词</Button><Button variant="primary" size="sm" iconLeft="image" disabled={!canSubmit} onClick={() => void reviewPrompt()}>审核并生成</Button></div>
        </div>
      </PopoverContent>
    </Popover>
    {review && <div onClick={(event) => event.stopPropagation()}><PromptReviewModal open title="审核封面提示词" kind="image" fullPrompt={review.preview.prompt} referenceImages={review.preview.reference_images} busy={busy} onClose={() => setReview(null)} introHint="这里是本次实际发送的完整内容。你可以修改文字或复制含图提示词；确认后才会调用所选图像模型。" onConfirm={(editedPrompt) => {
      if (busy || !editedPrompt.trim()) return;
      onSubmit({ ...review.options, prompt_override: editedPrompt });
      setReview(null);
    }} /></div>}
  </>;
}
