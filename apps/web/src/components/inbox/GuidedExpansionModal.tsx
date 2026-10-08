// W8-E · GuidedExpansionModal · 对话式灵感起点(3 题收集 → 汇总 extra prompt → 走 expand-script)
// 铁律 #4: ModelPicker 内嵌就近决策 · 铁律 #11: 所有按钮图标+文字 · 铁律 #1: 不强制跳转
// 2026-05-18 (铁律 #2 可干预性): 加 PromptReviewButton, 用户能在 "开始扩写" 前看到完整提示词.
import { useState } from "react";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ModelPicker } from "../studio/ModelPicker";
import { PromptReviewButton, type PromptPreview } from "../shared/PromptReviewButton";
import { BaseDialog } from "../ui/BaseDialog";
import { apiPost } from "../../lib/api";

// ─── 3 道引导问题 ─────────────────────────────────────────────────────────────

const QUESTIONS: Array<{ key: "protagonist" | "conflict" | "audience"; label: string; placeholder: string }> = [
  {
    key: "protagonist",
    label: "主角是谁？",
    placeholder: "例如：一个在深夜便利店打工的失业程序员",
  },
  {
    key: "conflict",
    label: "核心冲突是什么？",
    placeholder: "例如：他发现收银台里藏着一个神秘女孩的秘密日记",
  },
  {
    key: "audience",
    label: "目标受众是谁？",
    placeholder: "例如：18-35 岁的都市青年，喜欢细腻情感短剧",
  },
];

// P1-1: Beat Sheet 剧本结构模板 — Sudowrite / NovelAI Story Beats 同款
const BEAT_SHEET_TEMPLATES = [
  { id: "free", label: "自由创作", desc: "不限结构，AI 自由发挥" },
  { id: "save_the_cat", label: "Save the Cat", desc: "8 拍结构：开场画面 → 主题陈述 → 铺垫 → 催化剂 → B 故事 → 游戏时间 → 万籁俱寂 → 终局" },
  { id: "kishotenketsu", label: "起承转合", desc: "东亚经典四段式：起（引入）→ 承（发展）→ 转（转折）→ 合（结局）" },
  { id: "three_act", label: "三幕剧", desc: "好莱坞标准：第一幕（建置 25%）→ 第二幕（对抗 50%）→ 第三幕（解决 25%）" },
  { id: "anthology", label: "单元剧", desc: "每集独立故事 + 贯穿主线，适合系列短剧" },
];

// ─── Props ────────────────────────────────────────────────────────────────────

export interface GuidedExpansionModalProps {
  /** 当前系列 slug — 2026-05-18 加, PromptReviewButton 调 preview-expand-prompt 端点需要 */
  slug: string;
  /** 初始灵感文本（来自灵感卡，可选） */
  initialText?: string;
  /** 发起扩写时调用，传入已合并的 extra prompt + 模型 ref */
  onExpand: (extraPrompt: string, llmModelRef: string | null) => void;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GuidedExpansionModal({ slug, initialText, onExpand, onClose }: GuidedExpansionModalProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({
    protagonist: "",
    conflict: "",
    audience: "",
  });
  const [llmModelRef, setLlmModelRef] = useState<string | null>(null);
  // P1-1: 加第 4 步 "选剧本结构"
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0); // 当前第几道题 (0-indexed)
  const [beatSheet, setBeatSheet] = useState("free");
  const [submitting, setSubmitting] = useState(false);

  function setAnswer(key: string, val: string) {
    setAnswers((prev) => ({ ...prev, [key]: val }));
  }

  const allDone = step === 3;
  const currentQ = step < 3 ? QUESTIONS[step] : null;

  function handleNext() {
    if (step < 3) {
      setStep((s) => (s + 1) as 0 | 1 | 2 | 3);
    }
  }

  function handleBack() {
    if (step > 0) {
      setStep((s) => (s - 1) as 0 | 1 | 2 | 3);
    }
  }

  function buildExtraPrompt(): string {
    const lines: string[] = [];
    if (initialText?.trim()) {
      lines.push(`【原始灵感】${initialText.trim()}`);
    }
    QUESTIONS.forEach(({ key, label }) => {
      const val = answers[key]?.trim();
      if (val) lines.push(`${label}${val}`);
    });
    // P1-1: 选了非"自由"的剧本结构时，告诉 AI 用对应模板
    if (beatSheet && beatSheet !== "free") {
      const tpl = BEAT_SHEET_TEMPLATES.find((t) => t.id === beatSheet);
      if (tpl) lines.push(`【剧本结构】请按「${tpl.label}」结构编写：${tpl.desc}`);
    }
    return lines.join("\n");
  }

  function handleExpand() {
    if (submitting) return;
    setSubmitting(true);
    const extra = buildExtraPrompt();
    onExpand(extra, llmModelRef);
  }

  return (
    <BaseDialog
      open={true}
      onClose={onClose}
      title="先聊聊你的故事"
      subtitle="3 个问题 + 选剧本结构，帮 AI 更准确地扩写剧本"
      ariaLabel="引导式灵感扩写"
      maxWidth={520}
      zIndex={120}
      footer={
        <>
          {step > 0 && (
            <Button variant="ghost" iconLeft="arrowLeft" disabled={submitting} onClick={handleBack}>
              上一题
            </Button>
          )}
          <span style={{ flex: 1 }} />
          {!allDone ? (
            <Button variant="primary" iconRight="arrowRight" onClick={handleNext}>
              下一题
            </Button>
          ) : (
            <>
              {/* 2026-05-18 (铁律 #2 可干预性): 开始扩写前用户能看完整提示词, 改完再发或外送复制. */}
              <PromptReviewButton
                size="sm"
                label="查看提示词"
                disabled={submitting}
                loadPrompt={async (): Promise<PromptPreview> => {
                  const extra = buildExtraPrompt();
                  const r = await apiPost<PromptPreview>(
                    `/api/v2/series/${encodeURIComponent(slug)}/preview-expand-prompt`,
                    {
                      raw_inspiration: extra || initialText || "",
                      overrides: llmModelRef ? { llm_provider_id: llmModelRef } : {},
                    },
                  );
                  return r;
                }}
              />
              <Button
                variant="primary"
                iconLeft="sparkles"
                loading={submitting}
                disabled={submitting}
                onClick={handleExpand}
              >
                {submitting ? "扩写中…" : "开始扩写"}
              </Button>
            </>
          )}
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* 步骤指示器 */}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                height: 4, flex: 1, borderRadius: 999,
                background: i <= step ? "var(--brand-500)" : "var(--ink-100)",
                transition: "background 0.2s",
              }}
            />
          ))}
          <span style={{ fontSize: 11, color: "var(--ink-400)", marginLeft: 4, flexShrink: 0 }}>
            {step + 1} / 4
          </span>
        </div>

        {/* P1-1: 步骤 3 = 选剧本结构, 步骤 0-2 = 原 3 道问题 */}
        {currentQ ? (
          <div
            style={{
              padding: "16px 18px",
              background: "var(--brand-25, rgba(217,119,87,0.04))",
              border: "1.5px solid var(--brand-100, #f3d9cc)",
              borderRadius: 12,
            }}
          >
            <label
              htmlFor={`guided-q-${currentQ.key}`}
              style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: "var(--ink-900)", marginBottom: 10 }}
            >
              {step + 1}. {currentQ.label}
            </label>
            <Textarea
              id={`guided-q-${currentQ.key}`}
              value={answers[currentQ.key]}
              onChange={(e) => setAnswer(currentQ.key, e.target.value)}
              placeholder={currentQ.placeholder}
              rows={3}
              autoFocus
              className="font-serif text-[13px] leading-[1.65]"
            />
          </div>
        ) : (
          /* 步骤 4: 选剧本结构 (Beat Sheet 模板) */
          <div
            style={{
              padding: "16px 18px",
              background: "var(--brand-25, rgba(217,119,87,0.04))",
              border: "1.5px solid var(--brand-100, #f3d9cc)",
              borderRadius: 12,
            }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink-900)", marginBottom: 10 }}>
              4. 选一个剧本结构
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-600)", marginBottom: 12, lineHeight: 1.5 }}>
              选择一个叙事模板，AI 会按该结构组织剧本。不确定就选"自由创作"。
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {BEAT_SHEET_TEMPLATES.map((tpl) => {
                const active = beatSheet === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => setBeatSheet(tpl.id)}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: active ? "1.5px solid var(--brand-400)" : "1px solid var(--ink-150)",
                      background: active ? "var(--brand-50)" : "var(--surface-card)",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "border-color 0.15s, background 0.15s",
                    }}
                  >
                    <span style={{
                      width: 18, height: 18, borderRadius: 999, flexShrink: 0, marginTop: 1,
                      border: active ? "5px solid var(--brand-500)" : "2px solid var(--ink-300)",
                      transition: "border 0.15s",
                    }} />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 650, color: active ? "var(--brand-700)" : "var(--ink-900)" }}>
                        {tpl.label}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-500)", lineHeight: 1.4, marginTop: 2 }}>
                        {tpl.desc}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 已答题预览（除当前外） */}
        {QUESTIONS.some((q, i) => i !== step && answers[q.key]?.trim()) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--ink-400)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              已填内容
            </div>
            {QUESTIONS.map((q, i) =>
              i !== step && answers[q.key]?.trim() ? (
                <div key={q.key} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ fontSize: 11, color: "var(--ok)", flexShrink: 0, marginTop: 1 }}>
                    <Icon name="check" size={11} />
                  </span>
                  <div style={{ fontSize: 12, color: "var(--ink-700)", lineHeight: 1.5 }}>
                    <span style={{ fontWeight: 600 }}>{q.label}</span>
                    {answers[q.key].trim()}
                  </div>
                </div>
              ) : null
            )}
          </div>
        )}

        {/* 模型选择（最后一步才展示） */}
        {allDone && (
          <div
            style={{
              padding: "12px 14px",
              background: "var(--ink-25, rgba(0,0,0,0.02))",
              border: "1px solid var(--ink-100)",
              borderRadius: 10,
              display: "flex", alignItems: "center", gap: 10,
            }}
          >
            <Icon name="sparkles" size={13} style={{ color: "var(--brand-500)", flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: "var(--ink-700)", flex: 1 }}>AI 扩写模型</span>
            <ModelPicker kind="text" value={llmModelRef} onChange={setLlmModelRef} size="sm" placeholder="默认文字模型" />
          </div>
        )}

      </div>
    </BaseDialog>
  );
}
