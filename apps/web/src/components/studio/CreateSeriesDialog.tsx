// v24-batch-all · CreateSeriesDialog · 按 b1-3 新建系列弹窗视觉骨架真改造（新组件）
// 来源: design-skill/video-generate/src/batch1.jsx (via design-source/b1-3.tsx)
// 用法: StudioHome "新建系列" 按钮触发
//
// 2026-05-26 audit #9: 加 6 个可选参数 (调性 / 节奏 / 集数预期 / 时长目标 / 默认 LLM /
// 默认图像 / 默认视频), 全部 optional, 留空走系列默认链.
import { useEffect, useState } from "react";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { BaseDialog } from "../ui/BaseDialog";
import { ModelPicker } from "./ModelPicker";
import { getLastUsedSeriesDefaults, rememberLastUsedSeriesDefaults } from "../../lib/lastUsedSeriesDefaults";
import { TitleConflictHint, detectTitleConflict } from "./TitleConflictHint";

export interface CreateSeriesData {
  title: string;
  type: string;
  synopsis: string;
  /** 2026-05-26 audit #9: 调性 — cinematic / realistic / anime / chinese / wuxia / scifi / "" */
  tone?: string;
  /** 节奏 — slow / medium / fast / "" */
  pacing?: string;
  /** 集数预期 — 1-30, undefined = 不指定 */
  episodes_target?: number;
  /** 单集时长目标秒 — 30-300, undefined = 不指定 */
  duration_target_sec?: number;
  /** 默认 LLM 模型 — provider_id 或 "provider_id:model_id"; 空 = 走全局默认链 */
  default_llm?: string;
  /** 默认图像模型 — 同上 */
  default_image?: string;
  /** 默认视频模型 — 同上 */
  default_video?: string;
}

export interface CreateSeriesDialogProps {
  open?: boolean;
  busy?: boolean;
  onClose?: () => void;
  onCreate?: (data: CreateSeriesData) => void | Promise<void>;
  /** 2026-05-21 — 已存在的系列 title 列表 (用于重名检查 + 提示) */
  existingTitles?: string[];
}

const PRESET_TYPES = [
  { id: "short", label: "短剧", desc: "竖屏 9:16 · 连续叙事" },
  { id: "skit", label: "短片", desc: "横屏 16:9 · 一个完整故事" },
  { id: "ad", label: "广告片", desc: "横屏 16:9 · 精炼表达" },
];

const TONE_OPTIONS = [
  { id: "", label: "不指定 (创作时由 AI 决定)" },
  { id: "cinematic", label: "电影感 · 油画质感" },
  { id: "realistic", label: "写实 · 真人剧" },
  { id: "anime", label: "二次元 · 日系动漫" },
  { id: "chinese_paint", label: "国风 · 水墨工笔" },
  { id: "wuxia", label: "武侠 · 写意江湖" },
  { id: "scifi", label: "科幻 · 赛博朋克" },
  { id: "cute", label: "可爱 · 治愈系" },
];

const PACING_OPTIONS = [
  { id: "", label: "不指定" },
  { id: "slow", label: "慢节奏 — 内容向 / 文艺" },
  { id: "medium", label: "中速 — 标准短剧" },
  { id: "fast", label: "快节奏 — 抓人不放" },
];

export function CreateSeriesDialog({ open = false, busy = false, onClose, onCreate, existingTitles = [] }: CreateSeriesDialogProps) {
  const [title, setTitle] = useState("");
  const [synopsis, setSynopsis] = useState("");
  const [type, setType] = useState(PRESET_TYPES[0].id);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tone, setTone] = useState("");
  const [pacing, setPacing] = useState("");
  const [episodesTarget, setEpisodesTarget] = useState("");
  const [durationTargetSec, setDurationTargetSec] = useState("");
  const [defaultLlm, setDefaultLlm] = useState("");
  const [defaultImage, setDefaultImage] = useState("");
  const [defaultVideo, setDefaultVideo] = useState("");

  useEffect(() => {
    if (open) {
      const saved = getLastUsedSeriesDefaults();
      if (saved.content_type && PRESET_TYPES.some((preset) => preset.id === saved.content_type)) setType(saved.content_type);
    } else {
      setTitle(""); setSynopsis(""); setType(PRESET_TYPES[0].id); setAdvancedOpen(false);
      setTone(""); setPacing(""); setEpisodesTarget(""); setDurationTargetSec("");
      setDefaultLlm(""); setDefaultImage(""); setDefaultVideo("");
    }
  }, [open]);

  const trimmedTitle = title.trim();
  const hasConflict = !!detectTitleConflict(title, existingTitles);
  const invalidEpisodes = episodesTarget !== "" && (!Number.isInteger(Number(episodesTarget)) || Number(episodesTarget) < 1 || Number(episodesTarget) > 30);
  const invalidDuration = durationTargetSec !== "" && (!Number.isInteger(Number(durationTargetSec)) || Number(durationTargetSec) < 5 || Number(durationTargetSec) > 600);
  const validationMessage = invalidEpisodes ? "计划集数请填写 1–30 的整数。" : invalidDuration ? "每集时长请填写 5–600 秒的整数。" : "";
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedTitle || busy || validationMessage) return;
    rememberLastUsedSeriesDefaults({ content_type: type });
    await onCreate?.({
      title: trimmedTitle, type, synopsis: synopsis.trim(),
      tone: tone || undefined, pacing: pacing || undefined,
      episodes_target: episodesTarget ? Number(episodesTarget) : undefined,
      duration_target_sec: durationTargetSec ? Number(durationTargetSec) : undefined,
      default_llm: defaultLlm || undefined, default_image: defaultImage || undefined, default_video: defaultVideo || undefined,
    });
  }

  return <BaseDialog open={open} onClose={() => onClose?.()} busy={busy} title="新建系列" subtitle="选个类型，给它起个名字，剩下的可以慢慢补。" iconName="plus" maxWidth={620} ariaLabel="新建系列"
    footerLeft={<span className="studio-create-footnote"><Icon name="folderOpen" size={13} />只创建项目，暂不调用 AI</span>}
    footer={<><Button variant="secondary" iconLeft="close" onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" iconLeft="plus" type="submit" form="studio-create-form" disabled={!trimmedTitle || busy || !!validationMessage} loading={busy}>{busy ? "创建中…" : hasConflict ? "仍创建同名系列" : "创建系列"}</Button></>}>
    <form id="studio-create-form" className="studio-create-form" onSubmit={(event) => void handleSubmit(event)}>
      <label className="studio-create-label" htmlFor="studio-series-title">系列名称 <span>必填</span></label>
      <input id="studio-series-title" className="studio-create-input studio-create-title" autoFocus required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：雨夜咖啡馆 · 都市治愈短剧" />
      <TitleConflictHint title={title} existingTitles={existingTitles} />
      <fieldset className="studio-create-presets"><legend className="studio-create-label">作品类型</legend><div>{PRESET_TYPES.map((preset, index) => <button type="button" key={preset.id} aria-pressed={type === preset.id} className={type === preset.id ? "is-selected" : ""} onClick={() => setType(preset.id)}><Icon name={index === 0 ? "video" : index === 1 ? "film" : "bolt"} size={18} /><strong>{preset.label}</strong><small>{preset.desc}</small></button>)}</div></fieldset>
      <label className="studio-create-label" htmlFor="studio-series-synopsis">故事简介 <span>可选</span></label>
      <Textarea id="studio-series-synopsis" value={synopsis} onChange={(event) => setSynopsis(event.target.value)} placeholder="一两句话讲讲这是个什么故事，AI 会基于此生成更准确的初稿" className="min-h-[95px] text-[13px] leading-[1.8]" />
      <div className="studio-create-advanced">
        <button type="button" className="studio-create-advanced-toggle" aria-expanded={advancedOpen} aria-controls="studio-create-preferences" onClick={() => setAdvancedOpen(!advancedOpen)}><Icon name={advancedOpen ? "chevDown" : "chevRight"} size={15} /><span>创作偏好</span><small>调性、节奏与默认模型 · 可稍后设置</small></button>
        {validationMessage && <p role="alert" style={{ padding: "0 14px 10px", margin: 0, color: "var(--err)", fontSize: 12 }}>{validationMessage}</p>}
        {advancedOpen && <div id="studio-create-preferences" className="studio-create-preferences">
          <div className="studio-create-pair"><label className="studio-create-field">视觉调性<select className="studio-create-input" value={tone} onChange={(event) => setTone(event.target.value)}>{TONE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><label className="studio-create-field">节奏<select className="studio-create-input" value={pacing} onChange={(event) => setPacing(event.target.value)}>{PACING_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label></div>
          <div className="studio-create-pair"><label className="studio-create-field">计划集数<input className="studio-create-input" type="number" min={1} max={30} step={1} value={episodesTarget} onChange={(event) => setEpisodesTarget(event.target.value)} placeholder="1–30 集" /></label><label className="studio-create-field">每集时长（秒）<input className="studio-create-input" type="number" min={5} max={600} step={1} value={durationTargetSec} onChange={(event) => setDurationTargetSec(event.target.value)} placeholder="5–600 秒" /></label></div>
          <div className="studio-create-field">文字模型<ModelPicker kind="text" value={defaultLlm || null} onChange={(value) => setDefaultLlm(value ?? "")} placeholder="使用已有默认模型" /></div>
          <div className="studio-create-pair"><div className="studio-create-field">图像模型<ModelPicker kind="image" value={defaultImage || null} onChange={(value) => setDefaultImage(value ?? "")} placeholder="使用已有默认模型" /></div><div className="studio-create-field">视频模型<ModelPicker kind="video" value={defaultVideo || null} onChange={(value) => setDefaultVideo(value ?? "")} placeholder="使用已有默认模型" /></div></div>
          <p>这些偏好可随时调整，每次生成时也可以单独选择模型。</p>
        </div>}
      </div>
    </form>
  </BaseDialog>;
}

export default CreateSeriesDialog;
