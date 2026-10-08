import type { CoverGenerationOptions } from "../../lib/seriesApi";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { CoverGenPopover } from "./CoverGenPopover";
import type { SeriesRecord } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";

const COVERS = [
  "linear-gradient(145deg, #ead6c4, #b7795e)",
  "linear-gradient(145deg, #d8d4c5, #777b67)",
  "linear-gradient(145deg, #c9d5dc, #607985)",
  "linear-gradient(145deg, #e2cfc9, #9d706c)",
  "linear-gradient(145deg, #dcd4c7, #887b67)",
  "linear-gradient(145deg, #d5d7cb, #6f8079)",
];

export function coverFor(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  return COVERS[hash % COVERS.length];
}

interface Props {
  series: SeriesRecord;
  onDuplicate: () => void;
  onDelete: () => void;
  onGenerateCover: (opts: CoverGenerationOptions) => void;
  generatingCover: boolean;
  busy: boolean;
  batchMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}

/** The primary link covers the card; adjacent controls remain independent keyboard targets. */
export function StudioSeriesCard({ series, onDuplicate, onDelete, onGenerateCover, generatingCover, busy, batchMode, selected, onToggleSelect }: Props) {
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const [coverOpen, setCoverOpen] = useState(false);
  const coverCandidates = [
    ...(series.cover_vault_id ? [`/api/v2/vault/${encodeURIComponent(series.cover_vault_id)}/raw`] : []),
    `/api/v2/series/${encodeURIComponent(series.slug)}/cover-fallback`,
  ];
  const requestedCover = coverCandidates.find((url) => !failedImages.includes(url));
  const hasCover = !!requestedCover;
  const contentType = series.defaults?.content_type;
  const typeLabel = contentType === "skit" ? "短片" : contentType === "ad" ? "广告片" : "短剧";
  const synopsis = series.synopsis || series.description;

  return (
    <article className={`studio-project-card${selected ? " is-selected" : ""}${busy ? " is-busy" : ""}`} aria-busy={busy || generatingCover}>
      <div className="studio-project-cover" style={{ background: coverFor(series.slug) }}>
        {requestedCover ? <img src={requestedCover} alt="" loading="lazy" onError={() => setFailedImages((previous) => [...previous, requestedCover])} /> : (
          <div className="studio-cover-placeholder" aria-hidden="true">
            <span className="studio-cover-frame"><Icon name="film" size={29} /></span>
            <span>{series.title.slice(0, 14)}</span>
          </div>
        )}
        <span className="studio-project-type">{typeLabel}{series.defaults?.aspect_ratio ? ` · ${series.defaults.aspect_ratio}` : ""}</span>
        {batchMode && <span className={`studio-project-check${selected ? " is-selected" : ""}`} aria-hidden="true">{selected && <Icon name="check" size={15} />}</span>}
      </div>
      <div className="studio-project-copy">
        <h3>{series.title}</h3>
        <p className="studio-project-synopsis">{synopsis || "故事从这里开始，随时补充你的想法。"}</p>
        <div className="studio-project-meta">
          <span><Icon name="layers" size={13} />{series.episode_count} 集</span>
          <span><Icon name="clock" size={13} />{formatRelativeTime(series.updated_at)}</span>
        </div>
      </div>
      {batchMode ? (
        <button type="button" className="studio-project-hitarea" aria-pressed={selected} aria-label={`${selected ? "取消选择" : "选择"}${series.title}`} disabled={busy} onClick={onToggleSelect} />
      ) : (
        <Link className="studio-project-hitarea" to={`/studio/${encodeURIComponent(series.slug)}/inbox`} aria-label={`打开${series.title}`} />
      )}
      {!batchMode && <div className="studio-project-actions">
        <CoverGenPopover slug={series.slug} open={coverOpen} onOpenChange={setCoverOpen} busy={generatingCover}
          onSubmit={(opts) => { setCoverOpen(false); onGenerateCover(opts); }}
          triggerEl={<Button variant="ghost" size="xs" iconLeft="image" disabled={busy || generatingCover} loading={generatingCover}>{generatingCover ? "生成中" : hasCover ? "更换封面" : "生成封面"}</Button>} />
        <span className="studio-project-cost">{series.total_cost > 0 ? `¥${(series.total_cost / 100).toFixed(2)}` : ""}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="xs" iconLeft="more" disabled={busy} aria-label={`${series.title} 更多操作`}>更多</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onDuplicate}><Icon name="copy" size={14} />复制系列</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDelete} className="text-[var(--err)]"><Icon name="trash" size={14} />移到回收站</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>}
    </article>
  );
}

