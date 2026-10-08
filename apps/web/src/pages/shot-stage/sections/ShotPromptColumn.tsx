// P1 #17 (2026-05-21): 左栏(画面描述 + 素材连接 + 问 AI) — 从 ShotStagePage 拆出.
// 纯展示: 通过 props 接 draft / handlers / 数据列表. hook 留在主页面.
import { useMemo, useState } from "react";
import type { RefObject } from "react";
import { Icon } from "../../../components/shared/Icon";
import { Button } from "../../../components/ui/button";
// W11 A7: Input 不再使用 (问 AI 输入框合并到 ComposeBox 的"只问不抽" toggle)
import { Textarea } from "../../../components/ui/textarea";
import LibraryConnectPanel from "../../../components/library-connect/LibraryConnectPanel";
import { ShotReferenceChips } from "../../../components/shared/ShotReferenceChips";
import { MentionTextarea } from "../../../components/mention/MentionTextarea";
import { LibraryPickerModal } from "../../../components/library-picker/LibraryPickerModal";
import type { MentionOption } from "../../../components/mention/mentionTokens";
import type { ElementData } from "../../../lib/elementApi";
import type { Character } from "../../../hooks/useCharacters";
import type { Scene } from "../../../hooks/useScenes";
import { CollapsibleSection, Field, mentionHintStyle } from "../parts";

type ReferenceOverride = { element_id: string; image_id: string };

export interface DraftSlice {
  action: string;
  dialogue: string;
  voiceover: string;
  prompt_img: string;
  prompt_vid: string;
  notes: string;
  /**
   * 2026-05-27 — 负向词 / 排除内容. orchestrator 真读这字段发模型作 negative_prompt.
   * 之前"排除内容(告诉 AI 哪些不要画)"输入框绑的是 notes (反, 会被当正面提示词喂模型),
   * 灾难性 bug. 现在拆分: 这里是真 negative, 旧输入框 label 改"额外画面要求"明确正面语义.
   */
  negative_prompt: string;
  scene_id: string;
  character_ids: string[];
  element_ids: string[];
  reference_asset_ids: string[];
  reference_notes: Record<string, string>;
  reference_overrides: ReferenceOverride[];
  /** 2026-05-26 W2 组合性 — 本镜显式选的服装造型 element id (kind=wardrobe). */
  wardrobe_id: string;
  /** 2026-05-26 W2 组合性 — 本镜额外出现的道具 element id 列表 (kind=prop). */
  prop_ids: string[];
}

export interface ShotPromptColumnProps {
  slug: string;
  draft: DraftSlice;
  // 拼装好的"含 primary_image_url"的角色/场景列表(主页面已经 useMemo 出来)
  charactersWithPrimary: Array<Character & { primary_image_url?: string }>;
  scenesWithPrimary: Array<Scene & { primary_image_url?: string }>;
  elements: ElementData[];

  // draft mutation
  updateDraft: (patch: Partial<DraftSlice>) => void;
  syncMentionOptionToDraft: (option: MentionOption) => void;
  onChipImagePick: (elementId: string, imageId: string | null) => void;

  // 上传参考图
  fileInputRef: RefObject<HTMLInputElement | null>;
  onImportReference: (files: FileList | null) => void;

  // W11 A7 (2026-05-27): 问 AI 入口从左栏底部"输入框" 删除, 合并到 FirstFrameColumn / VideoColumn
  // 内 ComposeBox 顶部"只问不抽" toggle. 这里 props 保留 askAnswer 让"AI 答" 仍能在左栏底部显示
  // (跟相关画面描述就近), askText / onAskTextChange / asking / onAsk 不再使用.
  askAnswer: string | null;
}

export function ShotPromptColumn(props: ShotPromptColumnProps) {
  const {
    slug, draft, charactersWithPrimary, scenesWithPrimary, elements,
    updateDraft, syncMentionOptionToDraft, onChipImagePick,
    fileInputRef, onImportReference,
    askAnswer,
  } = props;

  return (
    <aside style={{
      display: "flex", flexDirection: "column", gap: 12,
      paddingRight: 6,
    }}>

      {/* W7-element-ux: 失败记录已迁移到右下角任务中心 GlobalQueuePanel
          顶部 chip 显示失败次数足够,详细记录在任务中心 + 切模型重试 */}

      {/* 画面描述(默认全展开 — 铁律#3) */}
      <CollapsibleSection title="画面描述" icon="doc" defaultOpen>
        <Field label="画面描述(这一镜里发生了什么)">
          {/* 2026-05-20: 用 MentionTextarea 替代普通 textarea —
              短格式 @chip 蓝色高亮 + Backspace 两阶段整体删除 + chip 点击弹下拉选图.
              数据流: chip 选图 → patchShot(reference_overrides) → 与 ReferenceOverridePanel
              同步 (写同字段) */}
          <MentionTextarea
            projectSlug={slug || undefined}
            value={draft.action}
            onChange={(v) => updateDraft({ action: v })}
            rows={5}
            placeholder="人物在做什么?镜头重点是什么?  按 @ 召唤素材"
            chipImageOverrides={draft.reference_overrides}
            onMentionPick={syncMentionOptionToDraft}
            onChipImagePick={onChipImagePick}
          />
          <span style={mentionHintStyle}>输入 @ 召唤角色/场景/物件 · 点 chip 选图 · 按 Backspace 两次整体删除</span>
          {/* 2026-05-19 Wave O Entity-first: 这镜引用的素材 chips —
              紧贴 textarea 下方,用户写文本时同时看到"已挂上哪些素材",
              避免"导入分镜后 @ 解析丢失,生成图跟项目素材库无关联"的死亡 bug. */}
          <div style={{ marginTop: 8 }}>
            <ShotReferenceChips
              slug={slug || ""}
              characterIds={draft.character_ids}
              sceneId={draft.scene_id}
              elementIds={draft.element_ids}
              density="full"
            />
          </div>
        </Field>
        {/* 2026-05-27 — 负向词 / 排除内容. 之前这位置 label "排除内容" 但绑 notes 字段,
            而 notes 在 shotPromptCompiler 被当**正面提示词**喂模型("用户批注: ..."段),
            灾难: 用户写"血腥,多余的肢体" 想排除, 实际加强了画这些 — 现在拆分清楚:
              · negative_prompt (本字段) — 真排除, orchestrator 8 处真读
              · notes (下方"额外画面要求 / 批注") — 正面补充, 走 compiler 用户批注段 */}
        <Field label="负向提示词 / 排除元素(告诉 AI 哪些不要画)">
          <Textarea
            value={draft.negative_prompt}
            onChange={(e) => updateDraft({ negative_prompt: e.target.value })}
            rows={2}
            placeholder="低分辨率, 模糊, 畸变, 多余的肢体, 文字水印, 杂乱背景, 血腥, 暴力"
          />
          <span style={mentionHintStyle}>
            告诉模型需要避开的内容。留空时使用当前系列的默认排除词。
          </span>
        </Field>
        <Field label="额外画面要求 / 批注(作正面补充给 AI)">
          <Textarea
            value={draft.notes}
            onChange={(e) => updateDraft({ notes: e.target.value })}
            rows={2}
            placeholder="导演备注 / 风格强调 / 易遗漏的细节, 例: 桌上有半杯凉透的茶"
          />
          <span style={mentionHintStyle}>
            正面语义, 拼入"用户批注"段强化 AI 理解. 想"不要画"请用上方负向词
          </span>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="对白(进 TTS / 字幕)">
            <Textarea
              value={draft.dialogue}
              onChange={(e) => updateDraft({ dialogue: e.target.value })}
              rows={3}
              placeholder="角色对白(写什么就念什么,TTS / 字幕原样使用)"
            />
          </Field>
          <Field label="旁白(画外音)">
            <Textarea
              value={draft.voiceover}
              onChange={(e) => updateDraft({ voiceover: e.target.value })}
              rows={3}
              placeholder="旁白或内心独白(写什么就念什么)"
            />
          </Field>
        </div>
        {/* W10 (2026-05-26): 默认展开 — 用户原话铁律 #3 "信息直接可见 > 模式切换".
            保留可手动折叠 (偶尔想隐藏时点 summary 收起). */}
        <details open>
          <summary style={{ fontSize: 11, color: "var(--ink-500)", cursor: "pointer", fontWeight: 600 }}>高级:直接编辑提示词</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
            <Field label="首帧基础提示词">
              <MentionTextarea
                projectSlug={slug || undefined}
                value={draft.prompt_img}
                onChange={(v) => updateDraft({ prompt_img: v })}
                rows={3}
                placeholder="按 @ 召唤素材"
                chipImageOverrides={draft.reference_overrides}
                onMentionPick={syncMentionOptionToDraft}
                onChipImagePick={onChipImagePick}
              />
              <span style={mentionHintStyle}>输入 @ 召唤素材</span>
            </Field>
            <Field label="视频运动提示词">
              <MentionTextarea
                projectSlug={slug || undefined}
                value={draft.prompt_vid}
                onChange={(v) => updateDraft({ prompt_vid: v })}
                rows={3}
                placeholder="按 @ 召唤素材"
                chipImageOverrides={draft.reference_overrides}
                onMentionPick={syncMentionOptionToDraft}
                onChipImagePick={onChipImagePick}
              />
              <span style={mentionHintStyle}>输入 @ 召唤素材</span>
            </Field>
          </div>
        </details>
        {/* W11 A7 (2026-05-27): "问 AI" 输入框已删 — 合并到 FirstFrameColumn / VideoColumn 的 ComposeBox
            "只问不抽"模式 toggle (铁律 #4 就近决策, 不再左右两套类似输入框分散心智).
            只保留答案展示 — 用户在 ComposeBox 切到"只问不抽"模式问完, 答案显示在这里. */}
        {askAnswer && (
          <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--ink-700)", background: "var(--ink-50)", borderRadius: 8, padding: "8px 10px", marginTop: 4, position: "relative" }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--brand-700)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              AI 回答
            </div>
            {askAnswer}
          </div>
        )}
      </CollapsibleSection>

      {/* 2026-05-17: 关键参数 section 已删 — 用户原话 "合并到视频生成板块,我在视频生成提示词里写就能覆盖"
          chip 快捷栏迁到右栏 "视频候选区 header → 快捷参数 details" (就近决策铁律 #4)
          字段 schema 保留(LLM 拆分镜自动填的 shot.* 仍生效),只是 UI 位置变了 */}

      {/* 素材连接 — 默认展开(铁律#3)
          2026-05-18: 项目素材(物品/服装/参考/杂物)合并进 LibraryConnectPanel 内统一展示,
                      删除外置网格 ─ 角色/场景/项目素材现在视觉一致 + 都支持挑具体哪张图作 reference. */}
      <CollapsibleSection title="素材连接(角色 / 场景 / 项目素材 / 参考图)" icon="layers" defaultOpen>
        <LibraryConnectPanel
          slug={slug}
          characters={charactersWithPrimary}
          scenes={scenesWithPrimary}
          elements={elements}
          characterIds={draft.character_ids}
          sceneId={draft.scene_id}
          elementIds={draft.element_ids}
          referenceAssetIds={draft.reference_asset_ids}
          referenceNotes={draft.reference_notes}
          onChange={updateDraft}
          onImportClick={() => fileInputRef.current?.click()}
        />
        <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => onImportReference(e.currentTarget.files)} />
      </CollapsibleSection>

      {/* 2026-05-26 W2 — 本镜服装/独立道具选择器 (组合性).
          紧贴"素材连接"下方, 用户挑完出场角色立刻能选这镜穿哪套服装 + 加哪些临时道具. */}
      <CollapsibleSection title="这场戏的装扮(服装 / 临时道具)" icon="layers" defaultOpen>
        <ShotCompositionPicker
          slug={slug}
          draft={draft}
          characters={charactersWithPrimary}
          elements={elements}
          updateDraft={updateDraft}
        />
      </CollapsibleSection>

      {/* 2026-05-20 删 ReferenceOverridePanel:跟画面描述里的 @ chip → ChipDropdown 选图是
          重复实现, 数据源同 shot.reference_overrides。用户原话"这个 tab 就没有用了,已经可以
          和提示词那个模块重复了"。统一走 chip dropdown 一站式(@ 老周 → 点击 chip → 弹下拉选第 N 张)。 */}

      {/* W7-stage-reorg: 左栏 "帧锚点 quick view" 已删除 — 整合到右栏视频候选区 header chips */}
      {/* W7-stage-reorg: 左栏 "拼接预览(常驻)" 已删除 — 整合到两个候选区 header 的 <details> */}

    </aside>
  );
}

// ─── 子组件: 本镜服装/独立道具选择器 (W2 组合性) ─────────────────────
//
// UI 设计 (对照铁律):
//   #3 信息直接可见 — 当前选了什么直接显示, 不藏 details
//   #4 就近决策     — 紧贴角色选择区下方
//   #9 toC 兜底     — 不暴露 element_id, 显示中文名 + 缩略图
//   #10 优雅空状态  — 没出场角色时禁用 + 引导文案
//   #11 按钮有名字  — 图标 + 文字

interface ShotCompositionPickerProps {
  slug: string;
  draft: DraftSlice;
  characters: Array<Character & { primary_image_url?: string }>;
  elements: ElementData[];
  updateDraft: (patch: Partial<DraftSlice>) => void;
}

function ShotCompositionPicker(props: ShotCompositionPickerProps) {
  const { slug, draft, characters, elements, updateDraft } = props;
  void slug; // LibraryPickerModal 自己拉, 不再从这里 fetch

  // 本镜出场角色们绑定的服装造型 id 集合 (union, 去重)
  const characterWardrobeIds = useMemo(() => {
    const set = new Set<string>();
    for (const cid of draft.character_ids) {
      const c = characters.find((x) => x.id === cid);
      if (!c) continue;
      const wardrobeIds = (c.attrs as Record<string, unknown> | undefined)?.["wardrobe_element_ids"];
      if (!Array.isArray(wardrobeIds)) continue;
      for (const id of wardrobeIds) {
        if (typeof id === "string" && id.length > 0) set.add(id);
      }
    }
    return Array.from(set);
  }, [draft.character_ids, characters]);

  // wardrobe id → ElementData 映射 (用于显示名字 + 缩略图)
  const wardrobeMap = useMemo(() => {
    const m = new Map<string, ElementData>();
    for (const el of elements) {
      if (el.kind === "wardrobe") m.set(el.id, el);
    }
    return m;
  }, [elements]);

  // 本镜独立道具 picker
  const [propPickerOpen, setPropPickerOpen] = useState(false);

  // 没出场角色时, 禁用整块 (服装选择需要绑定到角色)
  const hasCharacter = draft.character_ids.length > 0;

  // 当前选中的服装 (展示用)
  const selectedWardrobe = draft.wardrobe_id ? wardrobeMap.get(draft.wardrobe_id) : null;

  // 当前选中的独立道具列表 (按 id 找 element)
  const propMap = useMemo(() => {
    const m = new Map<string, ElementData>();
    for (const el of elements) {
      if (el.kind === "prop") m.set(el.id, el);
    }
    return m;
  }, [elements]);
  const selectedProps = draft.prop_ids.map((id) => ({ id, data: propMap.get(id) ?? null }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* ── 本镜服装 ────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-700)", marginBottom: 6 }}>
          这场戏穿什么
          <span style={{ marginLeft: 6, fontWeight: 400, color: "var(--ink-400)" }}>
            (不选 = 用角色默认第一套)
          </span>
        </div>
        {!hasCharacter ? (
          <div style={{
            padding: "8px 10px",
            fontSize: 11.5,
            color: "var(--ink-500)",
            background: "var(--ink-50, #f8f8f8)",
            border: "1px dashed var(--ink-200)",
            borderRadius: 6,
          }}>
            请先在上方"素材连接"添加出场角色, 才能挑这场戏穿什么
          </div>
        ) : characterWardrobeIds.length === 0 ? (
          <div style={{
            padding: "8px 10px",
            fontSize: 11.5,
            color: "var(--ink-500)",
            background: "var(--ink-50, #f8f8f8)",
            border: "1px dashed var(--ink-200)",
            borderRadius: 6,
          }}>
            出场角色还没绑定常用服装. 去"角色"页面打开角色, 在"角色装扮"面板里绑定几套服装.
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {/* "不指定 / 走角色默认" 选项 */}
            <WardrobeChip
              active={!draft.wardrobe_id}
              label="不指定(走角色默认)"
              onClick={() => updateDraft({ wardrobe_id: "" })}
            />
            {characterWardrobeIds.map((wid) => {
              const w = wardrobeMap.get(wid);
              return (
                <WardrobeChip
                  key={wid}
                  active={draft.wardrobe_id === wid}
                  label={w?.name ?? `（已删除 · ${wid.slice(0, 6)}…）`}
                  thumb={w?.primary_image_id
                    ? w.images.find((im) => im.image_id === w.primary_image_id)?.url
                    : w?.images[0]?.url}
                  onClick={() => updateDraft({ wardrobe_id: wid })}
                />
              );
            })}
            {/* 显示当前选中的描述提示 (用户更明确感知) */}
            {selectedWardrobe ? (
              <span style={{ fontSize: 11, color: "var(--ink-500)" }}>
                · 这场戏就穿「{selectedWardrobe.name}」
              </span>
            ) : null}
          </div>
        )}
      </div>

      {/* ── 本镜独立道具 ────────────────────────────────────── */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-700)" }}>
            这场戏的临时道具
            <span style={{ marginLeft: 6, fontWeight: 400, color: "var(--ink-400)" }}>
              (角色平时不带的道具, 跟"角色常带道具"叠加)
            </span>
          </div>
          <Button variant="secondary" size="xs" iconLeft="plus" onClick={() => setPropPickerOpen(true)}>
            添加道具
          </Button>
        </div>
        {selectedProps.length === 0 ? (
          <div style={{
            padding: "8px 10px",
            fontSize: 11.5,
            color: "var(--ink-500)",
            background: "var(--ink-50, #f8f8f8)",
            border: "1px dashed var(--ink-200)",
            borderRadius: 6,
          }}>
            这场戏还没加临时道具. 例如剧情里桌上有把茶壶, 点"添加道具"挑一个.
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {selectedProps.map(({ id, data }) => (
              <PropChip
                key={id}
                label={data?.name ?? `（已删除 · ${id.slice(0, 6)}…）`}
                thumb={data?.primary_image_id
                  ? data.images.find((im) => im.image_id === data.primary_image_id)?.url
                  : data?.images[0]?.url}
                onRemove={() => updateDraft({ prop_ids: draft.prop_ids.filter((x) => x !== id) })}
              />
            ))}
          </div>
        )}
      </div>

      {/* 道具选择弹窗 */}
      <LibraryPickerModal
        open={propPickerOpen}
        onClose={() => setPropPickerOpen(false)}
        slug={slug}
        source="project"
        acceptedKinds={["prop"]}
        defaultKind="prop"
        multi
        selectedIds={draft.prop_ids}
        title="挑这场戏的临时道具 (可多选)"
        onConfirm={(ids) => {
          setPropPickerOpen(false);
          updateDraft({ prop_ids: ids });
        }}
      />
    </div>
  );
}

// 服装选项 chip — 缩略图 + 名字, 选中带高亮边
function WardrobeChip(props: { active: boolean; label: string; thumb?: string; onClick: () => void }) {
  const { active, label, thumb, onClick } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px 4px 4px",
        borderRadius: 999,
        border: active
          ? "1.5px solid var(--brand-600, #d97757)"
          : "1px solid var(--ink-200)",
        background: active ? "var(--brand-50, #fff4ec)" : "var(--surface-card)",
        color: active ? "var(--brand-700, #c2410c)" : "var(--ink-700)",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        transition: "border-color 120ms, background-color 120ms",
      }}
      title={active ? "这场戏就穿这套" : "点击选这套作这场戏的服装"}
    >
      {thumb ? (
        <span style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: `center/cover no-repeat url("${thumb}")`,
          flexShrink: 0,
        }} />
      ) : (
        <span style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: "var(--ink-100)",
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
          <Icon name="layers" size={11} style={{ color: "var(--ink-400)" }} />
        </span>
      )}
      <span>{label}</span>
    </button>
  );
}

// 道具 chip — 缩略图 + 名字 + 移除按钮 (无二次确认, 因为道具是本镜级临时关联 + 一点就回来)
function PropChip(props: { label: string; thumb?: string; onRemove: () => void }) {
  const { label, thumb, onRemove } = props;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 4px 3px 4px",
        borderRadius: 999,
        border: "1px solid var(--ink-200)",
        background: "var(--surface-card)",
        fontSize: 12,
        fontWeight: 500,
        color: "var(--ink-700)",
      }}
    >
      {thumb ? (
        <span style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: `center/cover no-repeat url("${thumb}")`,
        }} />
      ) : (
        <span style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "var(--ink-100)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
          <Icon name="layers" size={10} style={{ color: "var(--ink-400)" }} />
        </span>
      )}
      <span>{label}</span>
      <button
        type="button"
        onClick={onRemove}
        title="从本镜移除该道具"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 18,
          height: 18,
          borderRadius: "50%",
          border: "none",
          background: "transparent",
          color: "var(--ink-400)",
          cursor: "pointer",
        }}
      >
        <Icon name="close" size={11} />
      </button>
    </span>
  );
}
