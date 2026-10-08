/**
 * VoiceSelector — 角色音色选择器 + 试听按钮.
 *
 * 2026-05-17 voice-sync v1: ElementWorkbench character kind 的 voice_id 字段从
 * 文本 input 升级为下拉 + 试听 (铁律 #2 可干预 + #9 toC 兜底 + #11 按钮有名字).
 *
 * 数据源:GET /api/v2/tts/voices (preset + provider.listVoices 合并).
 * 试听:POST /api/v2/tts/preview 后端合成短音频 buffer → blob URL → <audio>.play().
 */

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Select } from "../ui/select";
import { listTtsVoices, previewTtsVoice, type TtsVoiceListed } from "../../lib/ttsApi";
import { Button } from "../ui/button";
import { PromptReviewButton, type PromptPreview } from "../shared/PromptReviewButton";

interface Props {
  /** 当前已选 voice_id;空串/undefined = 跟随系列默认音色 */
  value?: string;
  /** 当前 TTS provider (来自 series.defaults.tts_provider_id 或 edge_tts);不传则不过滤 */
  providerId?: string;
  onChange: (voiceId: string) => void;
  /** 试听样本文本,默认 "你好,这是声音试听样本。" */
  previewText?: string;
  disabled?: boolean;
  /** 紧凑模式: select + 小试听按钮一行, 无 hint 文字, 给 ShotStagePage 快捷参数用 */
  compact?: boolean;
}

const DEFAULT_PREVIEW_TEXT = "你好,这是声音试听样本。";

export function VoiceSelector({
  value,
  providerId,
  onChange,
  previewText,
  disabled,
  compact = false,
}: Props) {
  const swrKey = providerId ? `tts:voices:${providerId}` : "tts:voices:all";
  const { data, error, isLoading } = useSWR(
    swrKey,
    () => listTtsVoices(providerId),
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );

  const [playing, setPlaying] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // 卸载时清理 blob URL + 停止音频
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  async function handlePreview(voiceId: string) {
    if (!voiceId) return;
    setPreviewError(null);
    setPlaying(voiceId);
    try {
      const blob = await previewTtsVoice({
        voice_id: voiceId,
        text: previewText ?? DEFAULT_PREVIEW_TEXT,
        provider_id: providerId,
      });
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = url;
      audioRef.current.onended = () => setPlaying(null);
      audioRef.current.onerror = () => {
        setPlaying(null);
        setPreviewError("浏览器无法播放该音频");
      };
      await audioRef.current.play();
    } catch (err) {
      setPlaying(null);
      const msg = err instanceof Error ? err.message : String(err);
      // toC 友好: 把 provider 端的 missing_key / 网络错误翻译成短句
      let toC = msg;
      if (/missing_key|TTS Provider .* 未就绪|未配置|未注册/i.test(msg)) {
        toC = "该 TTS Provider 还没配 Key,先去「设置」里填上。";
      } else if (/HTTP 5\d\d/i.test(msg)) {
        toC = "TTS 服务暂时不可达,稍后再试。";
      } else if (/HTTP 4\d\d/i.test(msg)) {
        toC = "TTS 试听参数有误,可能是该声线和当前 Provider 不匹配。";
      }
      setPreviewError(toC);
    }
  }

  if (isLoading) {
    return <div style={{ fontSize: 12, color: "var(--ink-400)" }}>正在加载可用声线…</div>;
  }
  if (error) {
    return (
      <div style={{ fontSize: 12, color: "var(--err)" }}>
        加载声线失败:{error instanceof Error ? error.message : String(error)}
      </div>
    );
  }
  if (!data || data.voices.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--ink-400)" }}>
        当前 TTS Provider 没有可用声线。可在「设置 → TTS」切换到 Edge TTS(免费,中文)。
      </div>
    );
  }

  // 公共: 把 voices 转成 SelectOption[] + 加 "跟随默认" sentinel
  const voiceOptions = [
    { value: "__follow__", label: compact ? "— 跟随默认 —" : "— 跟随系列默认音色 —" },
    ...data.voices.map((v) => ({
      value: v.voice_id,
      label: voiceOptionLabel(v),
    })),
  ];
  const loadPreviewPrompt = async (): Promise<PromptPreview> => ({
    kind: "tts",
    full_prompt: previewText ?? DEFAULT_PREVIEW_TEXT,
    target_provider: providerId,
    target_model: value || undefined,
  });

  // 紧凑模式: select + 小试听按钮一行, 无 hint
  if (compact) {
    return (
      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
        <Select
          value={value || "__follow__"}
          onChange={(v) => onChange(v === "__follow__" ? "" : v)}
          options={voiceOptions}
          disabled={disabled}
          size="sm"
          ariaLabel="音色选择"
          className="flex-1 min-w-0"
        />
        <Button
          variant="secondary"
          size="sm"
          iconLeft={playing === value ? "refresh" : "play"}
          loading={playing === value}
          disabled={!value || !!playing || disabled}
          title={value ? (previewError || "用这个声线试听一段话") : "请先选一个声线"}
          style={{ flexShrink: 0 }}
          onClick={() => value && handlePreview(value)}
        >
          试听
        </Button>
        <PromptReviewButton
          label="查看试听请求"
          size="sm"
          disabled={!value || disabled}
          loadPrompt={loadPreviewPrompt}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Select
        value={value || "__follow__"}
        onChange={(v) => onChange(v === "__follow__" ? "" : v)}
        options={voiceOptions}
        disabled={disabled}
        ariaLabel="音色选择"
        className="w-full"
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button
          variant="secondary"
          size="sm"
          iconLeft="play"
          loading={playing === value}
          disabled={!value || !!playing || disabled}
          title={value ? "用这个声线试听一段话" : "请先选一个声线"}
          onClick={() => value && handlePreview(value)}
        >
          {playing === value ? "试听中…" : "试听这个声线"}
        </Button>
        <PromptReviewButton
          label="查看试听请求"
          size="sm"
          disabled={!value || disabled}
          loadPrompt={loadPreviewPrompt}
        />
        {value ? (
          <span style={{ fontSize: 11, color: "var(--ink-400)" }}>
            {currentVoiceDescription(data.voices, value)}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "var(--ink-400)" }}>
            未选则用系列默认音色
          </span>
        )}
      </div>
      {previewError ? (
        <div style={{ fontSize: 11, color: "var(--err)" }}>{previewError}</div>
      ) : null}
    </div>
  );
}

function voiceOptionLabel(v: TtsVoiceListed): string {
  // preset 的 label_zh 已经带性别 (例: "晓晓 (女)"), 不再重复;
  // provider 动态拉的 voice 用 voice_id 兜底.
  const styleSuffix = v.style ? ` · ${v.style}` : "";
  const keyHint = v.requires_key ? " · 需 Key" : "";
  return `${v.label_zh}${styleSuffix}${keyHint}`;
}

function currentVoiceDescription(voices: TtsVoiceListed[], voiceId: string): string {
  const v = voices.find((x) => x.voice_id === voiceId);
  if (!v) return "已选:" + voiceId + "(不在当前 Provider 声线列表里)";
  const parts: string[] = [v.label_zh];
  if (v.style) parts.push(v.style);
  if (v.requires_key) parts.push("需配 Key");
  return "已选:" + parts.join(" · ");
}
