// P1 #17 (2026-05-21): 废案库 section (本镜/项目/公共) — 从 ShotStagePage 拆出.
// 纯展示: 通过 props 接所有 state / handler. hook 与业务逻辑留在主页面.
import { Icon } from "../../../components/shared/Icon";
import { ModelPicker } from "../../../components/studio/ModelPicker";
import {
  RejectPoolStrip,
  stripBtnImport, stripBtnPromote, stripBtnNeutral,
  type RejectTier as RejectPoolStripTier,
} from "../../../components/element/RejectPoolStrip";
import type { RejectItem } from "../../../lib/elementApi";
import type { ShotCandidate, RejectPoolItem } from "../../../lib/shotApi";
import { CollapsibleSection } from "../parts";

export type RejectTier = "shot" | "project" | "public";
export type ShotRejectLookup =
  | { kind: "candidate"; candidate: ShotCandidate }
  | { kind: "pool"; item: RejectPoolItem };

export interface RejectPoolSectionProps {
  rejectTier: RejectTier;
  onTierChange: (tier: RejectTier) => void;

  rejectMediaType: "all" | "image" | "video";
  onMediaTypeChange: (m: "all" | "image" | "video") => void;

  trashedCandidatesCount: number;
  projectPoolCount: number;
  publicPoolCount: number;

  shotRejectItems: RejectItem[];
  shotRejectLookup: Map<string, ShotRejectLookup>;

  // ModelPicker (微调用模型, 跟主候选区共享 ref)
  imageModelRef: string | null;
  videoModelRef: string | null;
  onImageModelChange: (next: string | null) => void;
  onVideoModelChange: (next: string | null) => void;

  // tune state
  rejectTuneMap: Record<string, string>;
  onSetTune: (id: string, text: string) => void;

  // busy (re-gen)
  busyTag: string | null;

  // actions
  onOpenImage: (lookup: ShotRejectLookup) => void;
  onRestoreCandidate: (c: ShotCandidate) => void;
  onPromote: (c: ShotCandidate, target: "project" | "public") => void;
  onRegenImage: (cid: string, tune: string) => void;
  onRegenVideo: (cid: string, tune: string) => void;
  onPullFromPool: (item: RejectPoolItem) => void;
  getLabelFromProvider: (providerId: string) => string;
}

export function RejectPoolSection(props: RejectPoolSectionProps) {
  const {
    rejectTier, onTierChange,
    rejectMediaType, onMediaTypeChange,
    trashedCandidatesCount, projectPoolCount, publicPoolCount,
    shotRejectItems, shotRejectLookup,
    imageModelRef, videoModelRef, onImageModelChange, onVideoModelChange,
    rejectTuneMap, onSetTune,
    busyTag,
    onOpenImage, onRestoreCandidate, onPromote,
    onRegenImage, onRegenVideo, onPullFromPool,
    getLabelFromProvider,
  } = props;

  return (
    <CollapsibleSection title="废案库(本镜/项目/公共)" icon="archive" defaultOpen={false} borderColor="var(--ink-300)">
      <RejectPoolStrip
        tier={rejectTier as RejectPoolStripTier}
        tileWidth={180}
        tierOptions={[
          { key: "shot", label: "本镜", count: trashedCandidatesCount },
          { key: "project", label: "本项目", count: projectPoolCount },
          { key: "public", label: "公共", count: publicPoolCount },
        ]}
        mediaType={rejectMediaType}
        onMediaTypeChange={onMediaTypeChange}
        extraToolbar={
          /* 2026-05-17: 微调重抽就近选 model — 跟 mediaType tab 联动
             "图像" / "全部" tab → image ModelPicker (共享 draft.image_model_ref)
             "视频" tab → video ModelPicker (共享 draft.video_model_ref)
             改一边另一边同步, 跟主候选区 ModelPicker 共享 state */
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 8, paddingLeft: 8, borderLeft: "1px solid var(--ink-150)" }}>
            <span style={{ fontSize: 10.5, color: "var(--ink-500)" }}>微调用模型</span>
            <div style={{ minWidth: 160 }}>
              {rejectMediaType === "video" ? (
                <ModelPicker
                  kind="video"
                  value={videoModelRef}
                  onChange={(ref) => onVideoModelChange(ref || null)}
                  size="sm"
                  placeholder="选视频模型"
                />
              ) : (
                <ModelPicker
                  kind="image"
                  value={imageModelRef}
                  onChange={(ref) => onImageModelChange(ref || null)}
                  size="sm"
                  placeholder="选图像模型"
                />
              )}
            </div>
          </div>
        }
        onTierChange={(t) => onTierChange(t as RejectTier)}
        rejects={shotRejectItems}
        onImport={() => { /* 由 itemActions 接管 */ }}
        onPromote={() => { /* 由 itemActions 接管 */ }}
        onOpenImage={(item) => {
          const lookup = shotRejectLookup.get(item.vault_id);
          if (!lookup) return;
          onOpenImage(lookup);
        }}
        getLabel={(item) => {
          const lookup = shotRejectLookup.get(item.vault_id);
          if (!lookup) return item.element_name || "废案";
          if (lookup.kind === "candidate") {
            // 2026-05-28 P1#17: 后端 toCandidate (shotStageController/shared.ts:182)
            // 不写 origin 字段, 旧代码用 candidate.origin 强类型读取永远拿到 undefined → 等同
            // 直接读 provider. 现去掉无效强转, 让类型如实反映后端 schema.
            return getLabelFromProvider(lookup.candidate.provider || "");
          }
          return getLabelFromProvider(lookup.item.provider_id || "");
        }}
        emptyText={
          rejectTier === "shot"
            ? "本镜废案库为空 — 抽卡时点「入废案」的图会进这里。"
            : rejectTier === "project"
              ? "项目废案库为空(在本镜废案库点「升项目」放进来)"
              : "公共废案库为空(跨项目共享)"
        }
        itemActions={(item) => {
          const lookup = shotRejectLookup.get(item.vault_id);
          if (!lookup) return null;
          if (lookup.kind === "candidate") {
            const c = lookup.candidate;
            const cid = c.generation_id || c.id;
            // 2026-05-17: 图像走 regen-from-reject 后端 (基于此图作 i2i 参考重抽);
            //   视频走 handleGenerateVideo (基于当前 shot 配置重抽一段, 默认拼 tune 到 prompt)
            const isVideoReject = c.type === "video";
            const tune = rejectTuneMap[cid] ?? "";
            const regenning = busyTag === `regen-${cid}` || busyTag === `regen-video-${cid}`;
            return (
              <>
                {/* 基础操作组 (恢复/升级) — 横向 wrap 节省垂直空间 */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                  <button style={{ ...stripBtnNeutral, flex: "1 1 auto" }} onClick={() => onRestoreCandidate(c)} title="把这张恢复到候选池">
                    <Icon name="refresh" size={10} /> 恢复
                  </button>
                  <button style={{ ...stripBtnPromote, flex: "1 1 auto" }} onClick={() => onPromote(c, "project")} title="升级到项目废案库">
                    <Icon name="arrowRight" size={10} /> 升项目
                  </button>
                  <button style={{ ...stripBtnPromote, flex: "1 1 auto" }} onClick={() => onPromote(c, "public")} title="升级到公共废案库">
                    <Icon name="arrowRight" size={10} /> 升公共
                  </button>
                </div>
                {/* W10 (2026-05-26): "再抽" 入口统一 refresh 图标 + "再抽" 文字 — 跟候选卡 5 处入口视觉一致 */}
                <div style={{ borderTop: "1px dashed var(--ink-200)", paddingTop: 4, marginTop: 1, display: "flex", flexDirection: "column", gap: 3 }}>
                  <button
                    style={{ ...stripBtnImport, opacity: regenning ? 0.6 : 1 }}
                    disabled={regenning}
                    onClick={() => isVideoReject ? onRegenVideo(cid, "") : onRegenImage(cid, "")}
                    title={isVideoReject
                      ? "用当前 shot 设置 + 同首帧重抽一段视频 (motion / camera 变化)"
                      : "基于此图作 i2i 参考重抽一张"}
                  >
                    <Icon name="refresh" size={10} /> {isVideoReject ? "从废案再抽" : "从废案再抽"}
                  </button>
                  <input
                    value={tune}
                    onChange={(e) => onSetTune(cid, e.target.value)}
                    placeholder={isVideoReject ? "加一句 motion 微调..." : "加一句微调..."}
                    style={{ width: "100%", height: 22, borderRadius: 6, border: "1px solid var(--ink-200)", padding: "0 6px", fontSize: 10.5, outline: "none" }}
                  />
                  <button
                    style={{ ...stripBtnImport, opacity: regenning || !tune.trim() ? 0.55 : 1, background: "var(--brand-600, #d97757)", color: "#fff", borderColor: "var(--brand-700, #c2410c)" }}
                    disabled={regenning || !tune.trim()}
                    onClick={() => isVideoReject ? onRegenVideo(cid, tune) : onRegenImage(cid, tune)}
                    title={isVideoReject
                      ? "把微调文字加到 motion_prompt 后重抽视频"
                      : "把微调文字加到提示词后再抽图"}
                  >
                    <Icon name="refresh" size={10} /> {regenning ? "重抽中..." : "用微调再抽"}
                  </button>
                </div>
              </>
            );
          }
          return (
            <button style={stripBtnImport} onClick={() => onPullFromPool(lookup.item)} title="把这张废案拉回本镜的候选池">
              <Icon name="download" size={10} /> 拉回本镜
            </button>
          );
        }}
      />
    </CollapsibleSection>
  );
}
