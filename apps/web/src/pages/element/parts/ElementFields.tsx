/**
 * ElementFields — 按 KIND_FIELD_SCHEMA 渲染各字段编辑表单.
 *
 * 内容:
 *   · 按 kind 的字段 schema 渲染 text/textarea/number/voice_id 字段
 *   · character.voice_id 走 VoiceSelector(下拉 + 试听)
 *   · character 在表单底部展示 VoiceCloneSampleUploader
 *   · 其他字段统一 input/textarea + label + hint
 *
 * 从 ElementWorkbench 拆出(Wave P2 解耦). 视觉零变更.
 */

import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { VoiceSelector } from "../../../components/element/VoiceSelector";
import { VoiceCloneSampleUploader } from "../../../components/element/VoiceCloneSampleUploader";
import { ELEMENT_KIND_LABEL, type ElementData } from "../../../lib/elementApi";
import type { KindField } from "./ElementDescriptionEditor";

interface Props {
  slug: string;
  element: ElementData;
  elementId: string;
  attrs: Record<string, unknown>;
  kindFields: KindField[];
  seriesTtsProviderId: string;
  onUpdateAttr: (key: string, value: string) => void;
  onUpdateVoiceCloneSampleUrl: (newUrl: string | undefined) => void;
  onFlash: (msg: string) => void;
  onReloadElement: () => void;
}

export function ElementFields({
  slug,
  element,
  elementId,
  attrs,
  kindFields,
  seriesTtsProviderId,
  onUpdateAttr,
  onUpdateVoiceCloneSampleUrl,
  onFlash,
  onReloadElement,
}: Props) {
  if (kindFields.length === 0) return null;

  return (
    <div className="mk-card" style={{ padding: 16 }}>
      <div className="mk-label" style={{ marginBottom: 8 }}>
        {ELEMENT_KIND_LABEL[element.kind]}字段
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
        {kindFields.map((field) => {
          const raw = attrs[field.key];
          const value = raw === undefined || raw === null ? "" : String(raw);
          // 2026-05-17 voice-sync v1: character.voice_id 走 VoiceSelector(下拉 + 试听),
          // 不再用裸 text input (铁律 #2 可干预 + #9 toC 兜底 + #11 按钮有名字).
          if (field.key === "voice_id" && element.kind === "character") {
            return (
              <div key={field.key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-500)" }}>{field.label}</span>
                <span style={{ fontSize: 10.5, color: "var(--ink-400)", lineHeight: 1.4 }}>
                  这个角色在合成阶段用的声线 — 跨分镜保持同步(同一角色同一个声音)。留空则用系列默认。
                </span>
                <VoiceSelector
                  value={value || undefined}
                  providerId={seriesTtsProviderId}
                  onChange={(v) => onUpdateAttr("voice_id", v)}
                />
              </div>
            );
          }
          return (
            <label key={field.key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-500)" }}>{field.label}</span>
              {/* Wave B-3 (2026-05-16): hint 提示文字 — 给用户讲清楚每段字段进哪个 prompt */}
              {field.hint ? (
                <span style={{ fontSize: 10.5, color: "var(--ink-400)", lineHeight: 1.4 }}>{field.hint}</span>
              ) : null}
              {field.type === "textarea" ? (
                <Textarea
                  value={value}
                  placeholder={field.placeholder}
                  onChange={(e) => onUpdateAttr(field.key, e.target.value)}
                  className="min-h-[58px] text-[12.5px]"
                />
              ) : (
                <Input
                  type={field.type === "number" ? "number" : "text"}
                  value={value}
                  placeholder={field.placeholder}
                  onChange={(e) => onUpdateAttr(field.key, e.target.value)}
                  className="text-[12.5px]"
                />
              )}
            </label>
          );
        })}
      </div>

      {/* 2026-05-17 voice-sync v1: 角色 kind 下方加"声音克隆样本"上传(高级,占位 v2 调用) */}
      {element.kind === "character" ? (
        <div style={{ marginTop: 12 }}>
          <VoiceCloneSampleUploader
            slug={slug}
            charId={elementId}
            currentSampleUrl={(attrs.voice_clone_sample_url as string | undefined) ?? undefined}
            onUpdated={(newUrl) => {
              onUpdateVoiceCloneSampleUrl(newUrl ?? undefined);
              onFlash(
                newUrl
                  ? "声音克隆样本已保存。语音克隆功能待 v2(各 TTS provider 接入方式不同)"
                  : "已删除声音克隆样本",
              );
              // 重新加载 element 拿最新数据
              onReloadElement();
            }}
          />
        </div>
      ) : null}

      {/* Wave A (2026-05-16) 删除 locked_seed UI — 用户看不懂,后端 schema 保留兼容历史 */}
    </div>
  );
}
