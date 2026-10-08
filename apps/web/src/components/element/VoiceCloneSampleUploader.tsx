/**
 * VoiceCloneSampleUploader — 角色"声音克隆参考样本"上传 UI.
 *
 * 2026-05-17 voice-sync v1 Phase 3:
 *   - backend 已有 POST /api/v2/series/:slug/characters/:charId/voice-clone-sample,
 *     接 multipart form 写入 series/<slug>/assets/voices/, 然后 PATCH character.voice_clone_sample_url.
 *   - UI 显示已上传样本(audio 播放器 + 文件名), 提供"重新上传"/"删除"按钮.
 *   - 提示文案:克隆功能 v2 实施(各 TTS provider 接入方式不同, 当前为占位).
 *
 * 走 character endpoint 而非 element endpoint,因为 character.voice_clone_sample_url
 * 是 Character schema 上的字段(element 走 attrs 但 ElementData 在 element.id ===
 * character.id 时与 character 一一对应,所以直接用 elementId 当 charId).
 */

import { useRef, useState } from "react";
import { useConfirm } from "../ui/ConfirmModal";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { Button } from "../ui/button";

interface Props {
  /** series slug */
  slug: string;
  /** character id (== element id when kind=character) */
  charId: string;
  /** 当前已上传的样本 series-relative 路径,如 "assets/voices/xxx.mp3" */
  currentSampleUrl?: string;
  /** 上传/删除成功后回调,父组件可 refresh */
  onUpdated?: (newSampleUrl: string | null) => void;
  disabled?: boolean;
}

const ACCEPT = ".mp3,.wav,.m4a,.aac,.webm,.ogg,audio/*";
const MAX_BYTES = 10 * 1024 * 1024;

export function VoiceCloneSampleUploader({
  slug,
  charId,
  currentSampleUrl,
  onUpdated,
  disabled,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const confirm = useConfirm();

  // err 是 inline 显示而非 toast,用 silent: true 让 useAsyncAction 不弹 toast
  // 但仍管 busy + try/catch
  const uploadAction = useAsyncAction(
    async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch(
        `/api/v2/series/${encodeURIComponent(slug)}/characters/${encodeURIComponent(charId)}/voice-clone-sample`,
        { method: "POST", body: form },
      );
      if (!resp.ok) {
        let msg = `上传失败 (HTTP ${resp.status})`;
        try {
          const errBody = await resp.json();
          if (errBody?.error?.message) msg = errBody.error.message;
        } catch { /* not JSON */ }
        throw new Error(msg);
      }
      return resp.json() as Promise<{ voice_clone_sample_url?: string | null }>;
    },
    {
      silent: true,
      onSuccess: (data) => {
        setErr(null);
        onUpdated?.(data?.voice_clone_sample_url ?? null);
      },
      onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
    },
  );

  const deleteAction = useAsyncAction(
    async () => {
      const resp = await fetch(
        `/api/v2/series/${encodeURIComponent(slug)}/characters/${encodeURIComponent(charId)}/voice-clone-sample`,
        { method: "DELETE" },
      );
      if (!resp.ok) throw new Error(`删除失败 (HTTP ${resp.status})`);
    },
    {
      silent: true,
      onSuccess: () => {
        setErr(null);
        onUpdated?.(null);
      },
      onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
    },
  );

  const busy = uploadAction.busy || deleteAction.busy;

  function triggerSelect() {
    setErr(null);
    fileInputRef.current?.click();
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重复选同一文件
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setErr(`样本太大(${(file.size / 1024 / 1024).toFixed(1)}MB), 上限 10MB`);
      return;
    }
    setErr(null);
    await uploadAction.run(file);
  }

  async function handleDelete() {
    if (!currentSampleUrl) return;
    const ok = await confirm({
      title: "删除已上传的声音克隆样本?",
      description: "声音克隆样本会从该角色移除, 该角色将回到无克隆样本状态。",
      variant: "destructive",
      confirmLabel: "删除样本",
    });
    if (!ok) return;
    setErr(null);
    await deleteAction.run();
  }

  // 已上传样本的 audio src — 走 series-relative 静态接口
  // (series/<slug>/assets/voices/xxx.mp3 → /api/v2/series/<slug>/raw/<relPath>?)
  // 项目里没有显式 raw 接口给 voices 目录, 但 vault raw 接口可作 fallback.
  // 浏览器直接 fetch series-relative path 不会成功,所以我们用 audio + dev server proxy.
  // 实现降级:如有 vault raw 接口可走;否则只显示文件名 + "已上传".
  const filename = currentSampleUrl ? currentSampleUrl.split(/[/\\]/).pop() ?? currentSampleUrl : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        border: "1px dashed var(--ink-300)",
        borderRadius: 8,
        background: "var(--ink-050)",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-700)" }}>
        声音克隆参考样本(高级,选填)
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-400)", lineHeight: 1.5 }}>
        上传 10MB 以内的 mp3/wav/m4a 样本(建议 15-30 秒清晰朗读),
        作为后续接入 MiniMax / 字节豆包等支持声音克隆的 TTS provider 的克隆素材。
        <br />
        <span style={{ color: "var(--warn-600)" }}>
          注意:克隆调用还在 v2 实施中,当前样本只保存到本地,不会发给 TTS。
        </span>
      </div>

      {filename ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: 8,
            background: "#fff",
            border: "1px solid var(--ink-200)",
            borderRadius: 6,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--ink-700)", flex: 1, wordBreak: "break-all" }}>
            🎵 {filename}
          </span>
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: "var(--ink-400)", fontStyle: "italic" }}>
          尚未上传样本
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={busy ? "refresh" : "upload"}
          loading={busy}
          disabled={busy || disabled}
          onClick={triggerSelect}
        >
          {busy ? "上传中…" : filename ? "更换样本" : "上传样本文件"}
        </Button>
        {filename ? (
          <Button
            variant="danger"
            size="sm"
            disabled={busy || disabled}
            onClick={handleDelete}
          >
            删除样本
          </Button>
        ) : null}
      </div>
      {err ? (
        <div style={{ fontSize: 11, color: "var(--err)" }}>{err}</div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        style={{ display: "none" }}
        onChange={handleFiles}
      />
    </div>
  );
}
