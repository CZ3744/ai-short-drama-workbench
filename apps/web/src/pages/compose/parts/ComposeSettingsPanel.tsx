// ComposeSettingsPanel — 2026-05-19 重做
// 起源:用户原话 "合成与导出界面我看乱乱的", 老 ComposeSettingsDrawer.tsx 是 orphan
// 死代码, 后端能干 13 字段但前端 UI 0 接入。本组件把 Drawer 内容**拆成 5 tab**
// 重新组织成左栏常驻 panel, 接入 ComposePage 后用户能看到全部合成配置。
//
// 5 个 tab:
//   - tts      TTS provider + 全局音色 + 多角色 voice 表
//   - subtitle 字幕样式 5 预设 + 多轨字幕注释 + 整集水印
//   - bgm      BGM mood + 音量 (P1 后端真混音已接通)
//   - transition 默认转场 + 画面比例
//   - advanced 全集音色覆盖 (导出阶段两阶段 TTS) + 高级选项
//
// 设计原则:
//   - 铁律 #3 信息直接可见: 删 details 折叠, 各 tab 内容默认全展开
//   - 铁律 #5 真实保存: 改任意字段 → 立即 onParamsChange 让父组件拿到最新 params
//   - localStorage 持久化: compose-settings:<slug>:<epId> 防 F5 / 切集丢失
//   - 切集自动 reload state
//
// 跟老 Drawer 的差异:
//   - 删 collapse toggle (左栏常驻不需要)
//   - 删底部"粗剪 / 精剪 / 预览 TTS" 按钮 (CTA 交给 TopBar)
//   - 5 tab 替代单一长 form
//   - 老 onCompose / onPreviewTts callback 改成 onParamsChange (持续推 params)

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../../components/shared/Icon";
import { PresetSelect } from "../../../components/studio/PresetSelect";
import { Slider } from "../../../components/ui/slider";
import { useSessionStore } from "../../../stores/sessionStore";
import type { ComposeParams } from "../../../hooks/useCompose";
import { useCharacters } from "../../../hooks/useCharacters";
import { useShots } from "../../../hooks/useShots";
import { CharacterVoiceTable } from "../../../components/compose/CharacterVoiceTable";
import {
  SUBTITLE_ANIMATIONS,
  SUBTITLE_PRESETS,
  subtitleSafeZoneBottomPct,
  type SubtitleAnimation,
  type CustomSubtitleStyle,
  CUSTOM_SUBTITLE_DEFAULTS,
} from "../../../lib/subtitlePresets";
import { VoiceSelector } from "../../../components/element/VoiceSelector";
import { Button } from "../../../components/ui/button";
import { seriesAspectToCss } from "../../../lib/aspectRatio";

// ─── 持久化 ──────────────────────────────────────────────────────────

type PersistedSettings = {
  /** 2026-05-22 — 音轨来源: 用视频自带 vs TTS 朗读 (用户原话: "想直接用视频里的语音, 不想再统一二次烧录") */
  audioMode?: "original" | "tts";
  /** 2026-05-22 P0 — 字幕是否烧进画面 (独立于 audioMode, 用户原话: "用视频原声不等于不烧录字幕") */
  burnSubtitles?: boolean;
  ttsProvider?: string;
  ttsVoice?: string;
  subtitleStyle?: string;
  subtitleAnimation?: SubtitleAnimation;
  bgmMood?: string;
  bgmVolume?: number[];
  aspectRatio?: string;
  transition?: string;
  voicePerCharacter?: Record<string, string>;
  watermark?: string;
  subtitleNotes?: Array<{ start_sec: number; end_sec: number; text: string }>;
  useEpisodeVoiceOverride?: boolean;
  episodeVoiceOverride?: string;
  episodeVoiceProvider?: string;
  customSubtitleStyle?: CustomSubtitleStyle;
};

// 2026-05-28 audit P2: 统一 localStorage 命名前缀, 跟 tasksStore (video-generate.tasks.v2) 一致.
// 读时兼容老 key 防丢用户偏好.
function storageKey(slug?: string, epId?: string): string {
  return `video-generate.compose.settings:${slug || "_default"}:${epId || "_default"}`;
}
function legacyStorageKey(slug?: string, epId?: string): string {
  return `compose-settings:${slug || "_default"}:${epId || "_default"}`;
}

function loadPersisted(slug?: string, epId?: string): PersistedSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(storageKey(slug, epId)) ?? localStorage.getItem(legacyStorageKey(slug, epId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function savePersisted(slug: string | undefined, epId: string | undefined, s: PersistedSettings) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storageKey(slug, epId), JSON.stringify(s));
    // 清理老 key (audit P2 统一前缀)
    localStorage.removeItem(legacyStorageKey(slug, epId));
  }
  catch (err) { /* 后台日志: localStorage 写入失败不影响用户操作, 无需 toast */ console.warn("[ComposeSettingsPanel] localStorage 写入失败", err); }
}

// ─── 类型 ────────────────────────────────────────────────────────────

type TabKey = "tts" | "subtitle" | "bgm" | "transition" | "advanced";

const TABS: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: "tts",        label: "配音",   icon: "mic" },
  { key: "subtitle",   label: "字幕",   icon: "type" },
  { key: "bgm",        label: "BGM",   icon: "music" },
  { key: "transition", label: "转场",   icon: "film" },
  { key: "advanced",   label: "高级",   icon: "settings" },
];

export interface ComposeSettingsPanelProps {
  seriesSlug?: string;
  epId?: string;
  defaultAspectRatio?: string;
  /** 任意字段变化都会触发, 父组件用最新 params 调 compose */
  onParamsChange?: (params: ComposeParams) => void;
  className?: string;
}

// ─── 组件 ────────────────────────────────────────────────────────────

export function ComposeSettingsPanel({ seriesSlug, epId, defaultAspectRatio = "9:16", onParamsChange, className }: ComposeSettingsPanelProps) {
  const providers = useSessionStore((s) => s.providers);
  const setProvider = useSessionStore((s) => s.setProvider);

  const persisted = useMemo(() => loadPersisted(seriesSlug, epId), [seriesSlug, epId]);

  const [activeTab, setActiveTab] = useState<TabKey>("tts");

  // 13 字段 state (跟老 Drawer 一致)
  // 2026-05-22: audio_mode — "original" 用视频自带音轨 / "tts" 走 TTS 朗读。与字幕烧录无关。
  const [audioMode, setAudioMode] = useState<"original" | "tts">(persisted.audioMode ?? "original");
  // 2026-05-22 P0: burn_subtitles — 字幕是否烧进画面, 独立于 audioMode。默认烧录。
  const [burnSubtitles, setBurnSubtitles] = useState<boolean>(persisted.burnSubtitles ?? true);
  const [ttsProvider, setTtsProvider] = useState<string>(persisted.ttsProvider ?? providers.tts);
  const [ttsVoice, setTtsVoice] = useState<string>(persisted.ttsVoice ?? "");
  const [subtitleStyle, setSubtitleStyle] = useState<string>(persisted.subtitleStyle ?? "default");
  const [subtitleAnimation, setSubtitleAnimation] = useState<SubtitleAnimation>(persisted.subtitleAnimation ?? "none");
  const [customSubtitleStyle, setCustomSubtitleStyle] = useState<CustomSubtitleStyle>(persisted.customSubtitleStyle ?? { ...CUSTOM_SUBTITLE_DEFAULTS });
  const [bgmMood, setBgmMood] = useState<string>(persisted.bgmMood ?? "");
  const [bgmVolume, setBgmVolume] = useState<number[]>(persisted.bgmVolume ?? [50]);
  const [aspectRatio, setAspectRatio] = useState<string>(persisted.aspectRatio ?? defaultAspectRatio);
  const [transition, setTransition] = useState<string>(persisted.transition ?? "");
  const [voicePerCharacter, setVoicePerCharacter] = useState<Record<string, string>>(persisted.voicePerCharacter ?? {});
  const [watermark, setWatermark] = useState<string>(persisted.watermark ?? "");
  const [subtitleNotes, setSubtitleNotes] = useState<Array<{ start_sec: number; end_sec: number; text: string }>>(persisted.subtitleNotes ?? []);
  const [useEpisodeVoiceOverride, setUseEpisodeVoiceOverride] = useState<boolean>(persisted.useEpisodeVoiceOverride ?? false);
  const [episodeVoiceOverride, setEpisodeVoiceOverride] = useState<string>(persisted.episodeVoiceOverride ?? "");
  const [episodeVoiceProvider, setEpisodeVoiceProvider] = useState<string>(persisted.episodeVoiceProvider ?? providers.tts);

  // 切集 reload
  const lastKeyRef = useRef<string>(storageKey(seriesSlug, epId));
  useEffect(() => {
    const next = storageKey(seriesSlug, epId);
    if (next === lastKeyRef.current) return;
    lastKeyRef.current = next;
    const s = loadPersisted(seriesSlug, epId);
    setAudioMode(s.audioMode ?? "original");
    setBurnSubtitles(s.burnSubtitles ?? true);
    setTtsProvider(s.ttsProvider ?? providers.tts);
    setTtsVoice(s.ttsVoice ?? "");
    setSubtitleStyle(s.subtitleStyle ?? "default");
    setSubtitleAnimation(s.subtitleAnimation ?? "none");
    setCustomSubtitleStyle(s.customSubtitleStyle ?? { ...CUSTOM_SUBTITLE_DEFAULTS });
    setBgmMood(s.bgmMood ?? "");
    setBgmVolume(s.bgmVolume ?? [50]);
    setAspectRatio(s.aspectRatio ?? defaultAspectRatio);
    setTransition(s.transition ?? "");
    setVoicePerCharacter(s.voicePerCharacter ?? {});
    setWatermark(s.watermark ?? "");
    setSubtitleNotes(s.subtitleNotes ?? []);
    setUseEpisodeVoiceOverride(s.useEpisodeVoiceOverride ?? false);
    setEpisodeVoiceOverride(s.episodeVoiceOverride ?? "");
    setEpisodeVoiceProvider(s.episodeVoiceProvider ?? providers.tts);
  }, [seriesSlug, epId, providers.tts, defaultAspectRatio]);

  useEffect(() => {
    if (persisted.aspectRatio) return;
    setAspectRatio((current) => (current === "9:16" ? defaultAspectRatio : current));
  }, [defaultAspectRatio, persisted.aspectRatio]);

  // 500ms 防抖写盘
  useEffect(() => {
    const t = setTimeout(() => {
      savePersisted(seriesSlug, epId, {
        audioMode, burnSubtitles,
        ttsProvider, ttsVoice, subtitleStyle, subtitleAnimation, customSubtitleStyle, bgmMood, bgmVolume,
        aspectRatio, transition, voicePerCharacter,
        watermark, subtitleNotes,
        useEpisodeVoiceOverride, episodeVoiceOverride, episodeVoiceProvider,
      });
    }, 500);
    return () => clearTimeout(t);
  }, [
    seriesSlug, epId,
    audioMode, burnSubtitles,
    ttsProvider, ttsVoice, subtitleStyle, subtitleAnimation, customSubtitleStyle, bgmMood, bgmVolume,
    aspectRatio, transition, voicePerCharacter,
    watermark, subtitleNotes,
    useEpisodeVoiceOverride, episodeVoiceOverride, episodeVoiceProvider,
  ]);

  // 拉本集角色列表
  const { data: charactersData } = useCharacters(seriesSlug);
  const characters = useMemo(
    () => (charactersData || []).map((c) => ({ id: c.id, name: c.name })),
    [charactersData],
  );

  // 2026-05-29 P0-5: 字幕安全区预览框显真台词 — 取第 1 个有台词/旁白的镜头, 让用户看到
  // 真实字数能不能塞进安全区 (之前写死"字幕预览"4 字, "雨夜便利店我等你三天了" 15 字 vs "嗯" 1 字
  // 视觉效果天差地别). 空则保留占位文本.
  const { shots } = useShots(seriesSlug, epId);
  const subtitlePreviewText = useMemo(() => {
    for (const s of shots) {
      const line = (s.dialogue?.trim() || s.voiceover?.trim() || "");
      if (line) return line.length > 24 ? `${line.slice(0, 24)}…` : line;
    }
    return "字幕预览";
  }, [shots]);
  const activeSubtitlePreset = useMemo(
    () => SUBTITLE_PRESETS.find((p) => p.id === subtitleStyle),
    [subtitleStyle],
  );
  const subtitleSafeZonePct = subtitleSafeZoneBottomPct(aspectRatio, activeSubtitlePreset);
  // 2026-05-25: 原三元只覆盖 3 种比例 (9:16/16:9/1:1), 4:3/3:4/2.39:1 等都 fallback 错的 "9 / 16".
  // 改用 seriesAspectToCss helper, 跟 FinalPreviewPlayer 同款 (P1 #71 修过同种 bug).
  const subtitlePreviewAspect = seriesAspectToCss(aspectRatio, "9/16");

  // 构造 voice_style_map
  function buildVoiceStyleMap(): Record<string, Record<string, string>> | undefined {
    const ids = Object.keys(voicePerCharacter);
    if (ids.length === 0) return undefined;
    const map: Record<string, Record<string, string>> = {};
    for (const charId of ids) {
      const voice = voicePerCharacter[charId];
      if (!voice) continue;
      map[charId] = { default: voice };
    }
    return Object.keys(map).length > 0 ? map : undefined;
  }

  // 构造 subtitle_tracks
  function buildSubtitleTracks(): { notes?: Array<{ start_sec: number; end_sec: number; text: string }>; watermark?: string } | undefined {
    const validNotes = subtitleNotes.filter((n) => n.text.trim() && n.end_sec > n.start_sec);
    const hasAny = Boolean(watermark.trim()) || validNotes.length > 0;
    if (!hasAny) return undefined;
    return {
      ...(watermark.trim() ? { watermark: watermark.trim() } : {}),
      ...(validNotes.length > 0 ? { notes: validNotes } : {}),
    };
  }

  // 把当前所有字段拼成 ComposeParams 推给父组件
  useEffect(() => {
    if (!onParamsChange) return;
    const voice_style_map = buildVoiceStyleMap();
    const subtitle_tracks = buildSubtitleTracks();
    const useEpiOverride = useEpisodeVoiceOverride && episodeVoiceOverride.trim();
    const params: ComposeParams = {
      audio_mode: audioMode,
      // 2026-05-22 P0: burn_subtitles 独立维度 — 音轨来源选 original 也能烧字幕
      burn_subtitles: burnSubtitles,
      // 2026-05-22: audio_mode=original 时不发 tts_provider, 后端跳过 TTS 合成用视频自带音轨
      tts_provider_id: audioMode === "tts" ? (ttsProvider || undefined) : undefined,
      tts_voice_id: audioMode === "tts" ? (ttsVoice || undefined) : undefined,
      subtitle_style: subtitleStyle || undefined,
      subtitle_animation: subtitleAnimation,
      ...(subtitleStyle === "custom" ? { custom_style: customSubtitleStyle } : {}),
      bgm_mood: bgmMood || undefined,
      bgm_volume: bgmVolume[0] / 100, // 0-1 归一化给后端
      transition: transition || undefined,
      aspect_ratio: aspectRatio || undefined,
      ...(voice_style_map ? { voice_style_map } : {}),
      ...(subtitle_tracks ? { subtitle_tracks } : {}),
      ...(useEpiOverride
        ? {
            episode_voice_override: episodeVoiceOverride.trim(),
            episode_voice_provider_override: episodeVoiceProvider,
          }
        : {}),
    };
    onParamsChange(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    audioMode, burnSubtitles,
    ttsProvider, ttsVoice, subtitleStyle, subtitleAnimation, customSubtitleStyle, bgmMood, bgmVolume,
    aspectRatio, transition, voicePerCharacter,
    watermark, subtitleNotes,
    useEpisodeVoiceOverride, episodeVoiceOverride, episodeVoiceProvider,
  ]);

  // ─── tab 列表 — 2026-05-25 合成 UI #4: 改竖排清晰层级 ─────────────────
  // 原 grid 3+2 横排在 280px 宽度下视觉混乱 (用户截图反馈"配音/字幕/BGM" + "转场/(空)/高级"层级丢失).
  // 改竖排: 每个 tab 一行 icon+label, 左侧 active indicator + brand 背景, 简洁清晰.
  const tabBar = (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 14 }}>
      {TABS.map((t) => {
        const active = t.key === activeTab;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              borderRadius: 7,
              border: "none",
              background: active ? "var(--brand-50, #eaf3ff)" : "transparent",
              color: active ? "var(--brand-700)" : "var(--ink-700)",
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              cursor: "pointer",
              textAlign: "left",
              transition: "background 0.15s, color 0.15s",
              position: "relative",
            }}
          >
            {/* active 左侧 indicator bar */}
            <span
              style={{
                width: 3,
                height: 16,
                borderRadius: 2,
                background: active ? "var(--brand-500, #2f86ff)" : "transparent",
                flexShrink: 0,
              }}
            />
            <Icon name={t.icon} size={14} />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );

  // ─── tab 内容 ──────────────────────────────────────────────────────

  const ttsTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* 2026-05-22 音轨来源 — 2026-05-25 合成 UI #5: 加 radio dot 视觉, 不再是孤立两个 button. */}
      <div>
        <SectionLabel>音轨来源</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {([
            { id: "original" as const, label: "用视频自带音轨", hint: "直接保留每镜视频的原声" },
            { id: "tts" as const, label: "用 TTS 朗读对白", hint: "对白文本走 TTS 合成配音" },
          ]).map((opt) => {
            const active = audioMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setAudioMode(opt.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: `1px solid ${active ? "var(--brand-500)" : "var(--ink-200)"}`,
                  background: active ? "var(--brand-50)" : "var(--surface-card)",
                  color: active ? "var(--brand-700)" : "var(--ink-700)",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all 0.15s",
                }}
                title={opt.hint}
              >
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    border: `1.5px solid ${active ? "var(--brand-500)" : "var(--ink-300)"}`,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {active && (
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--brand-500)" }} />
                  )}
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{opt.label}</span>
                  <span style={{ fontSize: 10.5, color: active ? "var(--brand-600)" : "var(--ink-400)" }}>{opt.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {audioMode === "tts" ? (
        <>
          <div>
            <SectionLabel>TTS 模型</SectionLabel>
            <PresetSelect dictId="tts_provider" value={ttsProvider} onValueChange={(val) => { setTtsProvider(val); setProvider("tts", val); }} />
          </div>
          <div>
            <SectionLabel>全局默认音色 (▶ 试听)</SectionLabel>
            {/* 2026-05-29 P0-3: 全局默认音色换 VoiceSelector(compact), 自带 ▶ 试听 —
                之前 PresetSelect 无试听, 用户选完全局音色得等合成跑完才知道对不对路. */}
            <VoiceSelector
              value={ttsVoice}
              providerId={ttsProvider}
              onChange={setTtsVoice}
              previewText="你好，这是全局默认配音的试听样本。"
              compact
            />
          </div>
          <div>
            <SectionLabel>每角色独立声线(本集)</SectionLabel>
            <p style={{ fontSize: 10.5, color: "var(--ink-400)", marginTop: -4, marginBottom: 6 }}>
              不设置则走"全局默认音色"
            </p>
            <CharacterVoiceTable
              characters={characters}
              voicePerCharacter={voicePerCharacter}
              defaultVoice={ttsVoice}
              ttsProviderId={ttsProvider}
              onChange={setVoicePerCharacter}
            />
          </div>
        </>
      ) : (
        <div style={{ padding: "10px 12px", borderRadius: 8, background: "var(--ok-bg, rgba(16,185,129,0.08))", color: "var(--ok, #059669)", fontSize: 12, lineHeight: 1.5 }}>
          已选「用视频自带音轨」 — 合成时不调 TTS,直接保留每镜视频的原声。字幕是独立的:到「字幕」tab 的「烧录字幕到画面」开关单独控制,用原声照样能烧字幕。
        </div>
      )}
    </div>
  );

  const subtitleTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* 2026-05-22 P0 — 烧录字幕开关 (用户原话: "我说用视频原声不等于不烧录字幕")。
          独立于「配音」tab 的音轨来源, 音轨选 original 也能烧字幕。 */}
      <div
        style={{
          padding: "10px 12px",
          borderRadius: 8,
          border: `1px solid ${burnSubtitles ? "var(--brand-500)" : "var(--ink-200)"}`,
          background: burnSubtitles ? "var(--brand-50)" : "var(--surface-card)",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={burnSubtitles}
            onChange={(e) => setBurnSubtitles(e.target.checked)}
            style={{ cursor: "pointer", width: 15, height: 15, flexShrink: 0 }}
          />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: burnSubtitles ? "var(--brand-700)" : "var(--ink-700)" }}>
            烧录字幕到画面
          </span>
        </label>
        <p style={{ fontSize: 10.5, color: "var(--ink-400)", marginTop: 6, marginBottom: 0, lineHeight: 1.5 }}>
          {burnSubtitles
            ? "字幕会直接烧进视频画面。下方样式 / 动画 / 安全区设置生效。"
            : "已关闭烧录 — 字幕仍会生成 .srt 文件随成片保存,但不烧进视频画面。"}
        </p>
      </div>

      <div>
        <SectionLabel>字幕样式</SectionLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {SUBTITLE_PRESETS.map((preset) => {
            const active = subtitleStyle === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setSubtitleStyle(preset.id);
                  setSubtitleAnimation(preset.animation);
                }}
                title={preset.description}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 9px",
                  borderRadius: 8,
                  border: `1px solid ${active ? "var(--brand-500)" : "var(--ink-200)"}`,
                  background: active ? "var(--brand-50)" : "var(--surface-card)",
                  color: active ? "var(--brand-700)" : "var(--ink-700)",
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <span
                  style={{ width: 10, height: 10, borderRadius: 2, background: preset.preview_color, border: "1px solid rgba(0,0,0,0.15)" }}
                />
                {preset.label}
              </button>
            );
          })}
        </div>
        {(() => {
          const found = SUBTITLE_PRESETS.find((p) => p.id === subtitleStyle);
          return found ? (
            <p style={{ fontSize: 10.5, color: "var(--ink-400)", marginTop: 6 }}>{found.description}</p>
          ) : null;
        })()}
        {/* P1-8: 自定义字幕样式面板 — 仅 subtitleStyle="custom" 时展开 */}
        {subtitleStyle === "custom" && (
          <div style={{
            marginTop: 10, padding: "12px 14px", borderRadius: 8,
            background: "var(--surface-canvas, #f9fafb)", border: "1px solid var(--ink-100, #e5e7eb)",
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10,
          }}>
            {/* 字体 */}
            <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: "var(--ink-600)" }}>字体</span>
              <select
                value={customSubtitleStyle.font_family ?? "Noto Sans SC"}
                onChange={(e) => setCustomSubtitleStyle((s) => ({ ...s, font_family: e.target.value }))}
                style={{ height: 30, borderRadius: 5, border: "1px solid var(--ink-200)", padding: "0 8px", fontSize: 11.5, background: "var(--surface-card)" }}
              >
                {["Noto Sans SC", "PingFang SC", "Microsoft YaHei", "SimHei", "Arial", "Helvetica", "Georgia"].map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
                ))}
              </select>
            </label>
            {/* 字号 */}
            <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: "var(--ink-600)" }}>字号 <span style={{ color: "var(--ink-400)" }}>{customSubtitleStyle.font_size ?? 42}px</span></span>
              <input type="range" min={24} max={80} step={2}
                value={customSubtitleStyle.font_size ?? 42}
                onChange={(e) => setCustomSubtitleStyle((s) => ({ ...s, font_size: Number(e.target.value) }))}
                style={{ width: "100%" }}
              />
            </label>
            {/* 字色 */}
            <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: "var(--ink-600)" }}>字色</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="color" value={customSubtitleStyle.color ?? "#ffffff"}
                  onChange={(e) => setCustomSubtitleStyle((s) => ({ ...s, color: e.target.value }))}
                  style={{ width: 28, height: 28, border: "none", borderRadius: 4, cursor: "pointer" }}
                />
                <span style={{ fontSize: 10.5, color: "var(--ink-400)", fontFamily: "monospace" }}>{customSubtitleStyle.color ?? "#ffffff"}</span>
              </div>
            </label>
            {/* 描边 */}
            <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: "var(--ink-600)" }}>描边</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="color" value={customSubtitleStyle.stroke_color ?? "#000000"}
                  onChange={(e) => setCustomSubtitleStyle((s) => ({ ...s, stroke_color: e.target.value }))}
                  style={{ width: 28, height: 28, border: "none", borderRadius: 4, cursor: "pointer" }}
                />
                <span style={{ fontSize: 10.5, color: "var(--ink-400)" }}>宽度</span>
                <input type="number" min={0} max={8} step={0.5}
                  value={customSubtitleStyle.stroke_width ?? 2}
                  onChange={(e) => setCustomSubtitleStyle((s) => ({ ...s, stroke_width: Number(e.target.value) }))}
                  style={{ width: 48, height: 26, borderRadius: 4, border: "1px solid var(--ink-200)", padding: "0 6px", fontSize: 11, textAlign: "center" }}
                />
              </div>
            </label>
            {/* 背景 */}
            <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: "var(--ink-600)" }}>背景</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="color" value={customSubtitleStyle.bg_color ?? "#000000"}
                  onChange={(e) => setCustomSubtitleStyle((s) => ({ ...s, bg_color: e.target.value }))}
                  style={{ width: 28, height: 28, border: "none", borderRadius: 4, cursor: "pointer" }}
                />
                <span style={{ fontSize: 10.5, color: "var(--ink-400)" }}>透明度</span>
                <input type="range" min={0} max={1} step={0.05}
                  value={customSubtitleStyle.bg_opacity ?? 0.5}
                  onChange={(e) => setCustomSubtitleStyle((s) => ({ ...s, bg_opacity: Number(e.target.value) }))}
                  style={{ width: 60 }}
                />
                <span style={{ fontSize: 10.5, color: "var(--ink-400)", minWidth: 28 }}>{Math.round((customSubtitleStyle.bg_opacity ?? 0.5) * 100)}%</span>
              </div>
            </label>
            {/* 位置 */}
            <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: "var(--ink-600)" }}>位置</span>
              <select
                value={customSubtitleStyle.position ?? "bottom"}
                onChange={(e) => setCustomSubtitleStyle((s) => ({ ...s, position: e.target.value as "bottom" | "top" | "center" }))}
                style={{ height: 30, borderRadius: 5, border: "1px solid var(--ink-200)", padding: "0 8px", fontSize: 11.5, background: "var(--surface-card)" }}
              >
                <option value="bottom">底部</option>
                <option value="top">顶部</option>
                <option value="center">居中</option>
              </select>
            </label>
          </div>
        )}
      </div>

      <div>
        <SectionLabel>字幕动画</SectionLabel>
        <select
          value={subtitleAnimation}
          onChange={(e) => setSubtitleAnimation(e.target.value as SubtitleAnimation)}
          style={{
            width: "100%",
            height: 34,
            padding: "0 10px",
            borderRadius: 6,
            border: "1px solid var(--ink-200)",
            background: "var(--surface-card)",
            color: "var(--ink-800)",
            fontSize: 12,
            outline: "none",
          }}
        >
          {SUBTITLE_ANIMATIONS.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        {(() => {
          const found = SUBTITLE_ANIMATIONS.find((item) => item.id === subtitleAnimation);
          return found ? (
            <p style={{ fontSize: 10.5, color: "var(--ink-400)", marginTop: 6 }}>{found.description}</p>
          ) : null;
        })()}
      </div>

      <div>
        <SectionLabel>字幕安全区</SectionLabel>
        <div
          style={{
            position: "relative",
            width: "min(100%, 170px)",
            aspectRatio: subtitlePreviewAspect,
            margin: "0 auto",
            borderRadius: 12,
            overflow: "hidden",
            border: "1px solid var(--ink-200)",
            background: "linear-gradient(180deg, #202434 0%, #111827 100%)",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: `${subtitleSafeZonePct}%`,
              background: "rgba(245,158,11,0.22)",
              borderTop: "1px dashed rgba(245,158,11,0.78)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "12%",
              right: "12%",
              bottom: `calc(${subtitleSafeZonePct}% + 8px)`,
              padding: "4px 7px",
              borderRadius: 999,
              background: "rgba(0,0,0,0.72)",
              color: activeSubtitlePreset?.preview_color ?? "#fff",
              fontSize: 10.5,
              fontWeight: 700,
              textAlign: "center",
              border: "1px solid rgba(255,255,255,0.16)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={subtitlePreviewText === "字幕预览" ? "本集还没填台词 / 旁白" : `第 1 条台词预览: ${subtitlePreviewText}`}
          >
            {subtitlePreviewText}
          </div>
        </div>
        <p style={{ fontSize: 10.5, color: "var(--ink-400)", marginTop: 6, lineHeight: 1.5 }}>
          当前画幅底部保留 {subtitleSafeZonePct}% 安全区，字幕会自动避开平台按钮区。
        </p>
      </div>

      <div>
        <SectionLabel>整集角标(右下角)</SectionLabel>
        <input
          type="text"
          value={watermark}
          onChange={(e) => setWatermark(e.target.value)}
          placeholder='例如:第 1 集 · 序章'
          maxLength={60}
          style={{
            width: "100%",
            padding: "8px 10px",
            fontSize: 12,
            borderRadius: 6,
            border: "1px solid var(--ink-200)",
            outline: "none",
          }}
        />
        <p style={{ fontSize: 10.5, color: "var(--ink-400)", marginTop: 4 }}>
          留空 = 不显示。
        </p>
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <SectionLabel style={{ marginBottom: 0 }}>注释字幕(顶部 / 翻译)</SectionLabel>
          <Button
            variant="outline"
            size="xs"
            iconLeft="plus"
            onClick={() => setSubtitleNotes((prev) => [...prev, { start_sec: 0, end_sec: 3, text: "" }])}
          >
            添加
          </Button>
        </div>
        {subtitleNotes.length === 0 ? (
          <p style={{ fontSize: 10.5, color: "var(--ink-400)", fontStyle: "italic" }}>
            暂无注释字幕。点"+ 添加"逐条配置时间与文本。
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {subtitleNotes.map((note, idx) => (
              <div key={idx} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={note.start_sec}
                  onChange={(e) => {
                    const v = Number(e.target.value) || 0;
                    setSubtitleNotes((prev) => prev.map((n, i) => (i === idx ? { ...n, start_sec: v } : n)));
                  }}
                  title="开始秒"
                  style={{ width: 44, padding: "4px 6px", fontSize: 10.5, borderRadius: 4, border: "1px solid var(--ink-200)" }}
                />
                <span style={{ fontSize: 10, color: "var(--ink-400)" }}>→</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={note.end_sec}
                  onChange={(e) => {
                    const v = Number(e.target.value) || 0;
                    setSubtitleNotes((prev) => prev.map((n, i) => (i === idx ? { ...n, end_sec: v } : n)));
                  }}
                  title="结束秒"
                  style={{ width: 44, padding: "4px 6px", fontSize: 10.5, borderRadius: 4, border: "1px solid var(--ink-200)" }}
                />
                <input
                  type="text"
                  value={note.text}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSubtitleNotes((prev) => prev.map((n, i) => (i === idx ? { ...n, text: v } : n)));
                  }}
                  placeholder="注释文本"
                  maxLength={200}
                  style={{ flex: 1, minWidth: 0, padding: "4px 6px", fontSize: 10.5, borderRadius: 4, border: "1px solid var(--ink-200)" }}
                />
                <Button
                  variant="ghost"
                  size="xs"
                  iconLeft="close"
                  onClick={() => setSubtitleNotes((prev) => prev.filter((_, i) => i !== idx))}
                  title="删除这一条"
                >
                  删除
                </Button>
              </div>
            ))}
          </div>
        )}
        {subtitleNotes.some((n) => n.text.trim() && n.end_sec <= n.start_sec) ? (
          <p style={{ fontSize: 10, color: "var(--err)", marginTop: 4 }}>
            存在结束秒 ≤ 开始秒的条目, 合成时会被跳过。
          </p>
        ) : null}
        <p style={{ fontSize: 10, color: "var(--ink-400)", marginTop: 6, lineHeight: 1.5 }}>
          {/* 2026-07-09 终验: 原文案暴露字幕封装格式内部术语("多轨 ASS(Layer 0/1/2)…单轨 SRT"),
              违反铁律 #9 toC 兜底 — 创作者不关心字幕文件格式, 只关心"填了会不会一起显示"。 */}
          填了上方的注释字幕或角标后, 合成时会和主字幕一起分层显示; 都留空则只烧主字幕。
        </p>
      </div>
    </div>
  );

  const bgmTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* 2026-05-29 P0-1 (silent skip 红线) — BGM 库为空的明确提示.
          BGM 风格只是个"标签", 真正放音乐要把音频文件丢进 data/bgm-library/ 目录 (文件名 = 风格 id).
          库里没对应文件时合成不报错但成片无 BGM (合成完会有 banner 提示). 这里提前告诉用户,
          避免"选了才发现没用". 没有 API 列库内容, 所以给静态引导, 不假装"库里有 X 首". */}
      {bgmMood && (
        <div
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            background: "var(--warn-bg, #fff7ed)",
            border: "1px solid #fdba74",
            fontSize: 11,
            color: "var(--ink-700)",
            lineHeight: 1.5,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "#c2410c", marginBottom: 4 }}>
            <Icon name="info" size={12} />
            BGM 库要自己放音乐文件
          </div>
          需把音频文件放到项目 <code style={{ background: "var(--ink-50)", padding: "0 4px", borderRadius: 3 }}>data/bgm-library/</code> 目录,
          文件名按风格 id 命名 (如 <code style={{ background: "var(--ink-50)", padding: "0 4px", borderRadius: 3 }}>{bgmMood}.mp3</code>)。
          库里没有对应文件时, 合成不会报错但成片<strong>没有背景音乐</strong> (合成完会提示)。详见该目录 README。
        </div>
      )}
      <div>
        <SectionLabel>BGM 风格</SectionLabel>
        <PresetSelect dictId="bgm_mood" value={bgmMood} onValueChange={setBgmMood} placeholder="选择风格(留空 = 无 BGM)" />
        <p style={{ fontSize: 10.5, color: "var(--ink-400)", marginTop: 6 }}>
          选风格后合成时自动从 BGM 库 (data/bgm-library/) 挑同名曲并叠到对白下方。库里没有 = 成片无 BGM。
        </p>
      </div>
      <div>
        <SectionLabel>BGM 音量</SectionLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Slider
            value={bgmVolume}
            onValueChange={setBgmVolume}
            max={100}
            step={1}
          />
          <span style={{ width: 38, fontSize: 11.5, fontWeight: 600, color: "var(--ink-700)", fontFamily: "ui-monospace, Consolas, monospace", textAlign: "right" }}>
            {bgmVolume[0]}%
          </span>
        </div>
        <p style={{ fontSize: 10.5, color: "var(--ink-400)", marginTop: 6 }}>
          对白有声段, BGM 自动 ducking 让位 → 听感专业。
        </p>
      </div>
    </div>
  );

  const transitionTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <SectionLabel>默认转场</SectionLabel>
        <PresetSelect dictId="transition" value={transition} onValueChange={setTransition} placeholder="选择默认转场(留空 = 硬切)" />
        <p style={{ fontSize: 10.5, color: "var(--ink-400)", marginTop: 6 }}>
          应用于未在单镜级别指定 transition 的镜头。
        </p>
      </div>
      <div>
        <SectionLabel>画面比例</SectionLabel>
        <PresetSelect dictId="aspect_ratio" value={aspectRatio} onValueChange={setAspectRatio} />
        <p style={{ fontSize: 10.5, color: "var(--ink-400)", marginTop: 6 }}>
          决定最终成片画幅, 跟导出规格独立。
        </p>
      </div>
    </div>
  );

  const advancedTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ padding: 12, borderRadius: 8, background: "var(--warn-bg, #fff7ed)", border: "1px solid var(--warn, #f59e0b)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "var(--ink-800)", marginBottom: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--warn, #f59e0b)" }} />
          全集统一音色(导出阶段)
          {useEpisodeVoiceOverride && episodeVoiceOverride ? (
            <span style={{ marginLeft: "auto", padding: "1px 6px", fontSize: 10, borderRadius: 999, background: "rgba(245,158,11,0.18)", color: "var(--warn, #b45309)" }}>
              已启用
            </span>
          ) : null}
        </div>
        <p style={{ fontSize: 10.5, color: "var(--ink-600)", lineHeight: 1.5, marginBottom: 8 }}>
          抽视频时用快速 TTS 对口型, 导出时整集强制换高质量音色,
          覆盖每角色独立声线 / 单镜级 voice / 角色默认音色。优先级最高。
        </p>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={useEpisodeVoiceOverride}
            onChange={(e) => setUseEpisodeVoiceOverride(e.target.checked)}
            style={{ cursor: "pointer" }}
          />
          <span>启用全集音色覆盖</span>
        </label>
        {useEpisodeVoiceOverride && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            <div>
              <SectionLabel small>导出用 TTS 模型</SectionLabel>
              <PresetSelect
                dictId="tts_provider"
                value={episodeVoiceProvider}
                onValueChange={(val) => {
                  setEpisodeVoiceProvider(val);
                  setEpisodeVoiceOverride("");
                }}
              />
            </div>
            <div>
              <SectionLabel small>导出用音色 (▶ 试听)</SectionLabel>
              <VoiceSelector
                value={episodeVoiceOverride}
                providerId={episodeVoiceProvider}
                onChange={setEpisodeVoiceOverride}
                previewText="这是导出阶段使用的音色试听样本。"
                compact
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // ─── 渲染 ──────────────────────────────────────────────────────────

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--surface-card)",
        borderRight: "1px solid var(--ink-100)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "14px 14px 0", flexShrink: 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.08em", color: "var(--brand-700)", textTransform: "uppercase", marginBottom: 6 }}>
          合成设置
        </div>
        {tabBar}
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "0 14px 14px" }}>
        {activeTab === "tts" && ttsTab}
        {activeTab === "subtitle" && subtitleTab}
        {activeTab === "bgm" && bgmTab}
        {activeTab === "transition" && transitionTab}
        {activeTab === "advanced" && advancedTab}
      </div>
    </div>
  );
}

// ─── helper ──────────────────────────────────────────────────────────

function SectionLabel({ children, small, style }: { children: React.ReactNode; small?: boolean; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontSize: small ? 10 : 11,
        fontWeight: 700,
        letterSpacing: "0.06em",
        color: "var(--ink-500)",
        textTransform: "uppercase",
        marginBottom: 6,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export default ComposeSettingsPanel;
