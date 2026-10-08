import path from "node:path";
import fs from "node:fs/promises";

import { updateEpisode, updateTaskRecord } from "../../api/v2/seriesStore";
import { sseBroker } from "../../api/v2/sseBroker";
import { writeJson, pathExists } from "../../../../../packages/core/src/index";
import { loggerSync } from "../../../../../packages/core/src/logger";
import { burnSubtitles } from "../../../../../packages/providers/src/video/burnSubtitles";
import { mixBgmAndNormalize } from "../../../../../packages/render/src/bgmMixer";
import { stripMentionTokens } from "../../../../../packages/drama/src/mentionParser";

import { muxTtsAudio } from "../../../../../packages/render/src/audioMux";

import type { ComposeEpisodeResult, ComposeEpisodeDeps } from "./composeEpisode";
import type { ComposeContext } from "./prepare";
import { safeSrtText } from "./prepare";

/**
 * Phase 4 — Render:
 *   - Full mode: BGM mix + loudnorm, compose manifest, burn subtitles.
 *   - Both modes: update episode/task status, build final JSON response.
 */
export async function runRenderPhase(
  ctx: ComposeContext,
  deps: ComposeEpisodeDeps,
): Promise<ComposeEpisodeResult> {
  // 2026-05-27 — 改 helper 而非 const, 让 SSE emit (line 389) + HTTP response (line 465+)
  // 都能拿到**最新** ctx.ttsFailures (audio mux 失败时会 push 新 reason, 见下方 mux 块).
  // 之前 const 在函数顶部固化, audio mux push 的 reason 拿不到 → 用户拿到无声视频毫无提示.
  const computeTtsReasonForClient = (): string | null => ctx.ttsProvInitError
    ? `TTS Provider "${ctx.ttsProvider}" 未就绪：${ctx.ttsProvInitError}。已生成无音轨视频和字幕,可重新合成或更换 TTS。`
    : ctx.ttsFailures.length > 0
      ? (() => {
          const audioMuxFailure = ctx.ttsFailures.find(f => f.shot_id === "__audio_mux__");
          if (audioMuxFailure) return audioMuxFailure.error;
          return `${ctx.ttsFailures.length} 个镜头 TTS 合成失败(共 ${ctx.shots.length} 镜)。常见原因:Key 未配置、声线 ID 与所选 Provider 不匹配。详见合成清单 compose_manifest.json。`;
        })()
      : null;
  // 2026-05-29 P0-1 (silent skip 红线): 用户选了 BGM 风格但库里没文件 / 文件无音轨 →
  // 合成不阻塞但成片无 BGM. 之前只 warn 一行, 前端 0 提示. 这里拼 toC 中文原因, render.ts
  // 把它放进 SSE compose.done + 同步 response, ComposePage 像 ttsStatus banner 那样显眼提示.
  // mood 存的是 preset id (warm/tense/...), 翻成中文给用户看 (铁律 #9 toC 兜底, 不暴露 id).
  const BGM_MOOD_ZH: Record<string, string> = {
    warm: "温馨", tense: "紧张", funny: "搞笑", epic: "史诗",
    healing: "治愈", emo: "emo", battle: "战斗",
  };
  const computeBgmMissingForClient = (): { reason: string; mood: string } | null => {
    if (!bgmMixResultForClient?.bgm_missing_reason) return null;
    const rawMood = bgmMixResultForClient.bgm_requested_mood ?? ctx.bgmMood ?? "";
    const moodZh = BGM_MOOD_ZH[rawMood] || rawMood || "所选";
    const cause = bgmMixResultForClient.bgm_missing_reason === "no_audio_track"
      ? `BGM 库里「${moodZh}」对应的音频文件没有可用音轨`
      : `BGM 库里没有「${moodZh}」对应的音乐文件`;
    return {
      mood: moodZh,
      reason: `你选了「${moodZh}」背景音乐, 但${cause}, 这一版成片没有背景音乐。请把对应音频放进 data/bgm-library/ 目录 (文件名见该目录 README, 例如 ${rawMood || "warm"}.mp3) 后重新合成。`,
    };
  };
  const computeFailedShotsReasonForClient = (): string | null => ctx.failedShots.length > 0
    ? (() => {
        const lostFiles = ctx.failedShots.filter((f) => f.code === "asset-file-missing" || f.code === "generation-not-found").length;
        const noPicks = ctx.failedShots.filter((f) => f.code === "no-picked-generation").length;
        const parts: string[] = [];
        if (lostFiles > 0) parts.push(`${lostFiles} 个镜头的视频文件已丢失`);
        if (noPicks > 0) parts.push(`${noPicks} 个镜头尚未选定视频片段`);
        return `${parts.join("，")}。已用占位画面合成,可重新导入对应镜头的视频后再次合成。详见 failed_shots 字段。`;
      })()
    : null;

  // 2026-05-29 P0-1: bgm mix 结果提到函数作用域, 让上面 computeBgmMissingForClient 闭包能读到
  // (它在 SSE done + HTTP response 两处被调, 必须拿到 bgm mix 块里赋的最新值)。
  let bgmMixResultForClient: Awaited<ReturnType<typeof mixBgmAndNormalize>> | null = null;

  // Full mode: audio_mode → BGM + manifest + burn
  if (ctx.composeMode !== "rough") {
    let sourceMp4Path = ctx._sourceMp4Path!;

    // 2026-05-22 P0 — audio_mode 接通点 (用户原话: "我说用视频原声不等于不烧录字幕"):
    //   - "original": source.mp4 已由 ffmpegConcat -c copy 保留视频原声, 这里什么都不做。
    //   - "tts":      把每镜 TTS 合成语音按整集时间轴拼成一条音轨, 替换视频原声 →
    //                 后续 BGM mix / burn 都基于这个 TTS 音轨版本。
    // 失败 (无 TTS 片段 / ffmpeg 出错) → 不阻塞, 退回视频原声并落 manifest reason。
    let audioMuxResult: Awaited<ReturnType<typeof muxTtsAudio>> | null = null;
    if (ctx.audioMode === "tts" && await pathExists(sourceMp4Path)) {
      const ttsMuxedPath = path.join(ctx.composeDir, "source_tts.mp4");
      try {
        deps.progress.progress("compose.audio_track", {
          episode_id: ctx.episodeId,
          audio_mode: "tts",
          tts_segment_count: ctx.ttsAudioSegments.length,
        });
        sseBroker.emit({
          type: "compose.stage",
          job_id: ctx.job_id,
          data: { stage: "compose.audio_track", episode_id: ctx.episodeId, percent: 89, audio_mode: "tts" },
          at: new Date().toISOString(),
        });
        audioMuxResult = await muxTtsAudio({
          input_mp4: sourceMp4Path,
          output_mp4: ttsMuxedPath,
          segments: ctx.ttsAudioSegments,
          signal: deps.signal,
        });
        if (audioMuxResult.ok) {
          sourceMp4Path = ttsMuxedPath;
        } else {
          loggerSync().warn(`[compose] audio_mode=tts mux skipped: ${audioMuxResult.reason} — 退回视频原声`);
          // 2026-05-27 — 把 audio mux 失败原因传到 ctx, 让 SSE compose.done 的 tts_reason
          // 能透给用户. 之前 silent log only, 用户拿到无声视频不知道为啥.
          if (!ctx.ttsProvInitError && ctx.ttsFailures.length === 0) {
            // 没其他 reason 占位, 把 mux 失败原因作主 reason
            const muxReasonZh = audioMuxResult.reason === "no_tts_audio_segments"
              ? "本集所有镜头都没填台词 / 旁白 / 动作描述, TTS 没生成任何音轨片段. 请回到分镜板给每镜填写台词或旁白, 然后重新合成."
              : audioMuxResult.reason === "input_mp4_not_found"
              ? "视频片段拼接产物缺失, 无法 mux 音轨. 请重新合成."
              : `TTS 音轨合并失败 (${audioMuxResult.reason}). 已退回视频原声, AI 视频通常无原声 → 整集静音.`;
            ctx.ttsOverallStatus = "failed";
            ctx.ttsFailures.push({ shot_id: "__audio_mux__", error: muxReasonZh });
          }
        }
      } catch (err) {
        loggerSync().warn("[compose] audio_mode=tts mux exception, fallback to original audio:", err);
        if (!ctx.ttsProvInitError && ctx.ttsFailures.length === 0) {
          ctx.ttsOverallStatus = "failed";
          ctx.ttsFailures.push({ shot_id: "__audio_mux__", error: `TTS 音轨合并异常: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    }

    // 2026-05-19 P1+P3: 拼接后先做 BGM 混音 + loudnorm, 然后再烧字幕
    // 输入 sourceMp4Path → 输出 sourceMixedMp4Path (含 BGM + 归一化音量)
    // 任一步失败 silent skip 用原 sourceMp4Path 继续 (不阻塞合成, BGM 是锦上添花)
    let sourceForBurn = sourceMp4Path;
    let bgmMixResult: Awaited<ReturnType<typeof mixBgmAndNormalize>> | null = null;
    if (await pathExists(sourceMp4Path)) {
      const sourceMixedMp4Path = path.join(ctx.composeDir, "source_mixed.mp4");
      try {
        deps.progress.progress("compose.audio_mix", {
          episode_id: ctx.episodeId,
          bgm_mood: ctx.bgmMood,
          normalize_loudness: ctx.normalizeLoudness,
        });
        sseBroker.emit({
          type: "compose.stage",
          job_id: ctx.job_id,
          data: { stage: "compose.audio_mix", episode_id: ctx.episodeId, percent: 90, bgm_mood: ctx.bgmMood ?? null },
          at: new Date().toISOString(),
        });
        bgmMixResult = await mixBgmAndNormalize({
          input_mp4: sourceMp4Path,
          output_mp4: sourceMixedMp4Path,
          bgm_mood: ctx.bgmMood,
          bgm_volume: ctx.bgmVolume,
          normalize_loudness: ctx.normalizeLoudness,
          signal: deps.signal,
        });
        bgmMixResultForClient = bgmMixResult;
        // 2026-05-29 P0-1: 用户选了 BGM 但没用上 (库缺文件/无音轨) → warn 升级, 让用户能定位
        if (bgmMixResult.bgm_missing_reason) {
          loggerSync().warn(`[compose] BGM requested mood="${bgmMixResult.bgm_requested_mood}" 但 ${bgmMixResult.bgm_missing_reason} — 成片无 BGM, 已透前端 banner`);
        }
        if (bgmMixResult.ok) {
          sourceForBurn = sourceMixedMp4Path;
        } else {
          loggerSync().warn(`[compose] BGM mix skipped: ${bgmMixResult.reason}`);
        }
      } catch (err) {
        loggerSync().warn("[compose] BGM mix exception, fallback to original audio:", err);
      }
    }

    await writeJson(path.join(ctx.composeDir, "compose_manifest.json"), {
      episode_id: ctx.episodeId,
      composed_at: new Date().toISOString(),
      tts_provider: ctx.ttsProvider,
      // 2026-05-22 P0 — 音轨来源 / 字幕烧录两个独立维度落 manifest, 用户能在合成日志看到实际生效值
      audio_mode: ctx.audioMode,
      burn_subtitles: ctx.burnSubtitles,
      ...(ctx.audioMode === "tts" && audioMuxResult ? {
        audio_track: {
          tts_muxed: audioMuxResult.ok,
          segment_count: audioMuxResult.segment_count ?? 0,
          reason: audioMuxResult.reason ?? null,
        },
      } : {}),
      subtitle_style: ctx.subtitleStyle,
      subtitle_animation: ctx.subtitleAnimation,
      aspect_ratio: ctx.aspectRatio,
      subtitle_safe_zone_bottom_pct: ctx.subtitleCanvas.safeZoneBottomPct,
      shot_count: ctx.shots.length,
      total_duration_ms: ctx.globalMs,
      srt_path: `episodes/${ctx.episodeId}/compose/subtitles/final.srt`,
      tts_status: ctx.ttsOverallStatus,
      // 2026-05-17 voice-sync v1: TTS 失败显式记录, 不再 silent fallback
      ...(ctx.ttsProvInitError ? { tts_init_error: ctx.ttsProvInitError } : {}),
      ...(ctx.ttsFailures.length > 0 ? { tts_failures: ctx.ttsFailures } : {}),
      ...(ctx.mockShots.length > 0 ? { mock_shots: ctx.mockShots } : {}),
      ...(ctx.trimFailures.length > 0 ? { trim_failures: ctx.trimFailures } : {}),
      // 2026-05-22 entity-first: 用户明确 picked 但解析失败的镜头详情, 给 toast/补救面板用
      ...(ctx.failedShots.length > 0 ? { failed_shots: ctx.failedShots } : {}),
      ...(ctx.isPartialRecompose ? { replaced_shot_ids: [...ctx.onlyShotIds] } : {}),
      // 2026-05-19 P1+P3: BGM 混音 + loudnorm 结果落 manifest, 用户能在合成日志看到
      // 2026-05-29 P0-1: bgm_missing_reason / bgm_requested_mood 落 manifest, 前端据此 banner 提示
      ...(bgmMixResult ? {
        audio_mix: {
          bgm_applied: bgmMixResult.ok && !!bgmMixResult.bgm_file,
          bgm_file: bgmMixResult.bgm_file ?? null,
          loudnorm_applied: bgmMixResult.loudnorm_applied ?? false,
          skipped: bgmMixResult.skipped ?? false,
          reason: bgmMixResult.reason ?? null,
          ...(bgmMixResult.bgm_missing_reason ? {
            bgm_requested_mood: bgmMixResult.bgm_requested_mood ?? null,
            bgm_missing_reason: bgmMixResult.bgm_missing_reason,
          } : {}),
        },
      } : {}),
    });

    const burnOutputPath = ctx.isPartialRecompose
      ? path.join(ctx.composeDir, "final_replaced.mp4")
      : path.join(ctx.composeDir, "final.mp4");
    ctx.finalMp4Path = burnOutputPath;

    // W7 Phase 3: 多轨字幕 — 用户传 subtitle_tracks 走 ASS Layer 0/1/2 烧录,否则单轨 SRT
    const subtitleTracksInput = (ctx.v.data as { subtitle_tracks?: { notes?: Array<{ start_sec: number; end_sec: number; text: string; shot_id?: string }>; watermark?: string } }).subtitle_tracks;
    const useMultiTrack = Boolean(subtitleTracksInput?.notes?.length || subtitleTracksInput?.watermark);

    // 2026-05-25 — 用户报"没字幕你是不是有毛病". 我自己手动跑 burnSubtitles 同款命令字幕成功烧,
    // 但用户后端跑没烧字幕 (抽帧验证). 加无条件诊断 log, 让用户重启重合成后我能看真实行为.
    const burnInvokeMarker = {
      timestamp: new Date().toISOString(),
      condition_checked: {
        burnSubtitles: ctx.burnSubtitles,
        sourceForBurn_exists: await pathExists(sourceForBurn),
        srtLines_length: ctx.srtLines.length,
        useMultiTrack: useMultiTrack,
      },
      will_invoke_burn: ctx.burnSubtitles && (ctx.srtLines.length > 0 || useMultiTrack),
      paths: {
        sourceForBurn,
        srtPath: ctx.srtPath,
        finalMp4Path: ctx.finalMp4Path,
      },
      style: ctx.subtitleStyle,
      animation: ctx.subtitleAnimation,
      canvas: ctx.subtitleCanvas,
    };
    try {
      await fs.writeFile(
        path.join(ctx.subtitleDir, "burn-invoke.json"),
        JSON.stringify(burnInvokeMarker, null, 2),
        "utf8",
      );
    } catch { /* log 失败不阻塞 */ }
    loggerSync().info(`[burn-debug] invoke check:`, burnInvokeMarker.condition_checked, `will_invoke=${burnInvokeMarker.will_invoke_burn}`);

    // 2026-05-22 P0 — burn_subtitles 是独立于 audio_mode 的开关 (用户原话: "用视频原声不等于不烧录字幕")。
    //   - true:  字幕烧进画面 (走下方 burnSubtitles / burnMultiTrackAss)。
    //   - false: 跳过烧录, final.mp4 不带字幕; final.srt 仍由 runTtsPhase 写盘作 sidecar。
    // 2026-05-19 P1+P3: 用 sourceForBurn (BGM 混音/loudnorm 后的版本, 失败 fallback 到 sourceMp4Path)
    if (ctx.burnSubtitles && await pathExists(sourceForBurn) && (ctx.srtLines.length > 0 || useMultiTrack)) {
      try {
        deps.progress.progress("compose.burning", { episode_id: ctx.episodeId });
        sseBroker.emit({
          type: "compose.stage",
          job_id: ctx.job_id,
          data: { stage: "compose.burning", episode_id: ctx.episodeId, percent: 93, multi_track: useMultiTrack },
          at: new Date().toISOString(),
        });
        // 2026-05-25 — packages/providers 的 burnSubtitles 内 log 可能没被 tsx watch reload,
        // 在 render.ts (apps/server 内) 直接写包装诊断 log, 用户能 cat 给我看真实行为.
        const burnStartedAt = Date.now();
        const burnResult: {
          timestamp: string;
          elapsed_ms?: number;
          method: "single-srt" | "multi-track-ass";
          status: "pending" | "success" | "throw";
          error?: string;
          stack?: string;
          finalMp4_existed_before: boolean;
          finalMp4_exists_after?: boolean;
          finalMp4_size_after?: number;
          finalMp4_mtime_after?: string;
        } = {
          timestamp: new Date().toISOString(),
          method: useMultiTrack ? "multi-track-ass" : "single-srt",
          status: "pending",
          finalMp4_existed_before: await pathExists(ctx.finalMp4Path),
        };

        try {
          if (useMultiTrack) {
            // 多轨 ASS
            const { buildMultiTrackAssConvenient, burnMultiTrackAss } = await import("../../../../../packages/render/src/multiTrackSubtitles");
            const assContent = buildMultiTrackAssConvenient({
              width: ctx.subtitleCanvas.width,
              height: ctx.subtitleCanvas.height,
              mainDialog: ctx.mainDialogTracks,
              notes: (subtitleTracksInput?.notes || []).map(n => ({
                startSec: n.start_sec,
                endSec: n.end_sec,
                text: safeSrtText(stripMentionTokens(n.text)),
                shot_id: n.shot_id,
              })),
              watermarkText: subtitleTracksInput?.watermark ? stripMentionTokens(subtitleTracksInput.watermark) : undefined,
              totalDurationSec: Math.max(ctx.globalMs / 1000, 1),
              animation: ctx.subtitleAnimation,
              safeZoneBottomPct: ctx.subtitleCanvas.safeZoneBottomPct,
            });
            try {
              await fs.writeFile(path.join(ctx.subtitleDir, "final_multi_track.ass"), assContent, "utf8");
            } catch { /* swallow */ }
            await burnMultiTrackAss({
              input_mp4: sourceForBurn,
              output_mp4: ctx.finalMp4Path,
              assContent,
              signal: deps.signal,
            });
          } else {
            await burnSubtitles({
              input_mp4: sourceForBurn,
              srt: ctx.srtPath,
              output_mp4: ctx.finalMp4Path,
              style: ctx.subtitleStyle,
              animation: ctx.subtitleAnimation,
              custom_style: ctx.customStyle,
              aspect_ratio: ctx.aspectRatio,
              width: ctx.subtitleCanvas.width,
              height: ctx.subtitleCanvas.height,
              safe_zone_bottom_pct: ctx.subtitleCanvas.safeZoneBottomPct,
              signal: deps.signal,
            });
          }
          burnResult.status = "success";
        } catch (burnErr) {
          burnResult.status = "throw";
          burnResult.error = burnErr instanceof Error ? burnErr.message : String(burnErr);
          burnResult.stack = burnErr instanceof Error ? burnErr.stack : undefined;
          throw burnErr; // re-throw 让外层 catch 处理 silent fallback
        } finally {
          burnResult.elapsed_ms = Date.now() - burnStartedAt;
          burnResult.finalMp4_exists_after = await pathExists(ctx.finalMp4Path);
          if (burnResult.finalMp4_exists_after) {
            try {
              const st = await fs.stat(ctx.finalMp4Path);
              burnResult.finalMp4_size_after = st.size;
              burnResult.finalMp4_mtime_after = st.mtime.toISOString();
            } catch { /* ignore */ }
          }
          try {
            await fs.writeFile(
              path.join(ctx.subtitleDir, "burn-result.json"),
              JSON.stringify(burnResult, null, 2),
              "utf8",
            );
          } catch { /* log 失败不阻塞 */ }
        }
        ctx.burned = true;
        deps.progress.progress("compose.burned", { episode_id: ctx.episodeId, output: ctx.finalMp4Path });
        sseBroker.emit({
          type: "compose.progress",
          job_id: ctx.job_id,
          data: { percent: 97, step: "字幕烧录完成", detail: `输出: ${ctx.finalMp4Path}`, multi_track: useMultiTrack },
          at: new Date().toISOString(),
        });
      } catch (err) {
        // 2026-05-25 红线修复 — 用户原话: "再给我检查一下字幕烧录是不是真在视频里".
        // 我实测发现 burn 失败被 catch 静默吞了, silent fallback 复制无字幕 source 当 final.mp4
        // → 用户看到 9MB final.mp4 以为字幕烧了, 实际抽帧 0 帧有字幕. 违反铁律 #3.
        //
        // 修: 把详细错误 + ffmpeg 命令写到 compose 目录的日志文件 (用户能 cat 给我看精确原因),
        // 仍 fallback 复制 source (否则 user 完全没成片更糟), 但**把烧字幕失败信息暴露到 manifest +
        // 通过 failedShots 类似机制让前端 banner 显示** "字幕烧录失败, final.mp4 无字幕, 请查看日志".
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error && err.stack ? err.stack : "";
        loggerSync().error("[compose] burnSubtitles failed:", err);

        // 写完整诊断 log 到 compose/subtitles/burn-failed.log, 用户能 cat 给我看
        try {
          const logPath = path.join(ctx.subtitleDir, "burn-failed.log");
          await fs.writeFile(logPath, [
            "=== burnSubtitles 失败诊断 ===",
            `时间: ${new Date().toISOString()}`,
            `episode: ${ctx.episodeId}`,
            `srt 路径: ${ctx.srtPath}`,
            `srt 行数: ${ctx.srtLines.length}`,
            `source: ${sourceForBurn}`,
            `output: ${ctx.finalMp4Path}`,
            `style: ${ctx.subtitleStyle}`,
            `animation: ${ctx.subtitleAnimation}`,
            `canvas: ${ctx.subtitleCanvas.width}x${ctx.subtitleCanvas.height} safe=${ctx.subtitleCanvas.safeZoneBottomPct}%`,
            ``,
            `=== Error ===`,
            errMsg,
            ``,
            `=== Stack ===`,
            errStack,
          ].join("\n"), "utf8");
        } catch { /* log 写失败也不阻塞 */ }

        // 在 ctx 上标记烧录失败, 让前端 banner 提示 (跟 failedShots 同款机制)
        ctx.failedShots.push({
          shot_id: "__compose_burn__",
          kind: "video",
          code: "burn-subtitles-failed",
          reason_zh: `字幕烧录失败, 成片不含字幕 (详见 compose/subtitles/burn-failed.log): ${errMsg.slice(0, 200)}`,
        });

        // 仍复制 source 作 fallback (用户至少有视频), 但前端会被 banner 警告
        try { await fs.copyFile(sourceForBurn, ctx.finalMp4Path); } catch { /* ignore */ }
      }
    } else if (await pathExists(sourceForBurn)) {
      // 不烧字幕 → 直接把 sourceForBurn (BGM+loudnorm 后) 当 final.mp4。
      // 命中两种情况: (1) 无字幕数据可烧; (2) burn_subtitles=false 用户主动关掉烧录。
      // 后者下 final.srt 仍由 runTtsPhase 写盘作 sidecar, 用户可单独下载。
      try { await fs.copyFile(sourceForBurn, ctx.finalMp4Path); } catch { /* ignore */ }
    }

    if (ctx.isPartialRecompose && await pathExists(burnOutputPath)) {
      try {
        await fs.copyFile(burnOutputPath, path.join(ctx.composeDir, "final.mp4"));
      } catch (err) {
        loggerSync().error("[compose] C4: failed to replace final.mp4:", err);
      }
    }

    // W11 D4 (2026-05-27): 整集合成产物加版本号 — 用户原话铁律 #6 "数据保留 > 直接删除".
    // 老行为: 每次合成 final.mp4 直接被覆盖, 用户合成 v2 把 v1 干掉了, 后悔无救.
    // 新行为: 把 final.mp4 同步拷一份成 final_v<N>.mp4, 既保留历史也不破坏"当前主成片"是 final.mp4 的契约.
    //   - 扫描 compose 目录现存的 final_v<N>.mp4, N 取 max+1.
    //   - 拷贝失败不阻塞主流量 (用户仍有 final.mp4 当前成片可用).
    //   - rough 模式跳过版本快照 (rough 已有自己的时间戳后缀).
    // 2026-07-10 P1-4 — 部分重合成 (partial recompose) 也纳入快照: 此处 final.mp4 已被 final_replaced.mp4
    //   覆盖成本次结果 (见上方 C4 块), 快照它即保留"这一版部分重合成产物". 之前 partial 被排除 →
    //   连续两次单镜重合成中间那版永久丢失, 与 D4 版本化初衷相悖 (final_v<N> 也进历史版本列表可回退).
    const finalMp4OutputPath = path.join(ctx.composeDir, "final.mp4");
    if (
      ctx.composeMode === "full" &&
      await pathExists(finalMp4OutputPath)
    ) {
      try {
        const entries = await fs.readdir(ctx.composeDir);
        let maxN = 0;
        for (const e of entries) {
          const m = /^final_v(\d+)\.mp4$/.exec(e);
          if (m) maxN = Math.max(maxN, Number(m[1]));
        }
        const nextN = maxN + 1;
        const snapshotPath = path.join(ctx.composeDir, `final_v${nextN}.mp4`);
        await fs.copyFile(finalMp4OutputPath, snapshotPath);
        loggerSync().info(`[compose] D4 version snapshot saved: final_v${nextN}.mp4`);
      } catch (err) {
        // 快照失败不阻塞 — 用户仍有 final.mp4
        loggerSync().warn(`[compose] D4 version snapshot skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    deps.progress.progress("compose.done", {
      episode_id: ctx.episodeId,
      burned: ctx.burned,
      srt_path: ctx.srtPath,
      total_duration_ms: ctx.globalMs,
      final_video_path: `episodes/${ctx.episodeId}/compose/final.mp4`,
      ...(ctx.isPartialRecompose ? { replaced_shot_ids: [...ctx.onlyShotIds] } : {}),
    });

    sseBroker.emit({
      type: "compose.done",
      job_id: ctx.job_id,
      data: {
        episode_id: ctx.episodeId,
        burned: ctx.burned,
        srt_path: ctx.srtPath,
        total_duration_ms: ctx.globalMs,
        final_video_path: `episodes/${ctx.episodeId}/compose/final.mp4`,
        mode: ctx.composeMode,
        tts_status: ctx.ttsOverallStatus,
        percent: 100,
        // 2026-05-27 异步化后, 主流量走 SSE, 同步 response (line 475) 用户根本拿不到
        // (POST 立即返 queued, 真合成完才发 compose.done). 这里把同步 response 的全部
        // "完成卡需要的字段" 都补上, 否则前端字幕方式 / 失败 banner / 进度条真长全部缺失.
        ...(ctx.shotEffectiveSegments.length > 0 ? { shot_segments: ctx.shotEffectiveSegments } : {}),
        ...(() => {
          const r = computeTtsReasonForClient();
          return r ? { tts_reason: r } : {};
        })(),
        ...(ctx.failedShots.length > 0 ? { failed_shots: ctx.failedShots } : {}),
        ...(() => {
          const r = computeFailedShotsReasonForClient();
          return r ? { failed_shots_reason: r } : {};
        })(),
        // 2026-05-29 P0-1: BGM 库缺文件 → 成片无 BGM, 透前端 banner (silent skip 红线修复)
        ...(() => {
          const b = computeBgmMissingForClient();
          return b ? { bgm_missing_reason: b.reason, bgm_missing_mood: b.mood } : {};
        })(),
        subtitle_align_method: ctx.alignMethodUsed,
        subtitle_align_reason_zh: (() => {
          switch (ctx.alignMethodUsed) {
            case "whisper_python": return "Python faster-whisper 本地转写 (逐字精准)";
            case "whisper_api": return "OpenAI Whisper API (逐字精准)";
            case "whisper_local": return "本地 whisper.cpp (逐字精准)";
            case "fallback_estimate": return "字符加权估算 (无 Whisper, 节奏近似)";
            default: return ctx.alignMethodUsed;
          }
        })(),
        ...(ctx.isPartialRecompose ? { replaced_shot_ids: [...ctx.onlyShotIds] } : {}),
      },
      at: new Date().toISOString(),
    });
  }

  // === Both modes: update episode + task + build response ===

  // 2026-07-10 P2-9 (铁律 #5 状态精确) — 若全部镜头都是占位/失败 (没有一个真实视频片段),
  // 不能把这集标成"已合成": 否则系列总览显示"已合成"但成片全是灰屏占位, episode.status 撒谎,
  // 用户会把真问题当"这集已完成". 部分镜失败仍写 assembled (用户可能故意跳过某镜先出片),
  // 只在"全占位"时维持原状不写. 判据: 每个真实 shot 都出现在 mockShots 或 failedShots 里.
  const placeholderShotIds = new Set<string>();
  for (const m of ctx.mockShots) placeholderShotIds.add(m.shot_id);
  for (const f of ctx.failedShots) {
    // 只算真实 shot 的失败, 排除 __audio_mux__ / __compose_burn__ / __xfade_audio__ 等伪 shot_id
    if (ctx.shots.some((s) => s.id === f.shot_id)) placeholderShotIds.add(f.shot_id);
  }
  const allShotsPlaceholder = ctx.shots.length > 0 && ctx.shots.every((s) => placeholderShotIds.has(s.id));
  if (allShotsPlaceholder) {
    loggerSync().warn(
      `[compose] 全部 ${ctx.shots.length} 镜为占位/失败, 不写 episode.status=assembled (维持原状, 避免状态撒谎)`,
    );
  } else {
    await updateEpisode(ctx.slug, ctx.episodeId, { status: "assembled" });
  }

  updateTaskRecord(ctx.taskId, {
    status: "done",
    result: {
      final_video_path: ctx.composeMode === "rough"
        ? `episodes/${ctx.episodeId}/compose/${path.basename(ctx.finalMp4Path)}`
        : `episodes/${ctx.episodeId}/compose/final.mp4`,
      tts_status: ctx.ttsOverallStatus,
      ...(ctx.ttsFailures.length > 0 ? { tts_failures: ctx.ttsFailures } : {}),
      ...(ctx.mockShots.length > 0 ? { mock_shots: ctx.mockShots } : {}),
      ...(ctx.trimFailures.length > 0 ? { trim_failures: ctx.trimFailures } : {}),
      ...(ctx.failedShots.length > 0 ? { failed_shots: ctx.failedShots } : {}),
    },
  });

  const finalRelPath = ctx.composeMode === "rough"
    ? `episodes/${ctx.episodeId}/compose/${path.basename(ctx.finalMp4Path)}`
    : `episodes/${ctx.episodeId}/compose/final.mp4`;

  // (ttsReasonForClient / failedShotsReasonForClient 已经在函数顶部声明, 让 SSE emit 也能用 —
  //  之前是定义在这里 / SSE emit 用不到, 2026-05-27 提前到顶部统一)

  return {
    kind: "json",
    body: {
      ok: true,
      job_id: ctx.job_id,
      episode_id: ctx.episodeId,
      mode: ctx.composeMode,
      compose_dir: `episodes/${ctx.episodeId}/compose`,
      total_duration_sec: Math.round(ctx.globalMs / 1000),
      shot_count: ctx.shots.length,
      srt: ctx.srtPath,
      subtitles_burned: ctx.burned,
      final_video_path: finalRelPath,
      video_count: ctx.videoFiles.length,
      ...(ctx.composeMode === "rough" ? { rough: true } : {}),
      ...(ctx.isPartialRecompose ? { replaced_shot_ids: [...ctx.onlyShotIds] } : {}),
      tts_status: ctx.ttsOverallStatus,
      ...(() => {
        const r = computeTtsReasonForClient();
        return r ? { tts_reason: r } : {};
      })(),
      ...(ctx.ttsFailures.length > 0 ? { tts_failures: ctx.ttsFailures } : {}),
      ...(ctx.mockShots.length > 0 ? { mock_shots: ctx.mockShots } : {}),
      ...(ctx.trimFailures.length > 0 ? { trim_failures: ctx.trimFailures } : {}),
      // 2026-05-22 entity-first: 暴露被 mock 占位的真实失败原因 + toC 中文 reason
      ...(ctx.failedShots.length > 0 ? { failed_shots: ctx.failedShots } : {}),
      ...(() => {
        const r = computeFailedShotsReasonForClient();
        return r ? { failed_shots_reason: r } : {};
      })(),
      // 2026-05-29 P0-1: BGM 库缺文件 → 成片无 BGM, 同步 response 也带 (短路径用)
      ...(() => {
        const b = computeBgmMissingForClient();
        return b ? { bgm_missing_reason: b.reason, bgm_missing_mood: b.mood } : {};
      })(),
      // 2026-05-26 — 真 segments 暴露 (修 12s 显示错镜 bug). 前端 FinalPreviewPlayer 用这个
      // 而非自己按 shot.duration_sec 累加 (5/4/5/5/5 = 24s 跟真 50s 错位).
      ...(ctx.shotEffectiveSegments.length > 0 ? { shot_segments: ctx.shotEffectiveSegments } : {}),
      // 2026-05-25 字幕对齐方式暴露给前端 — 让 compose 完成卡显示 "Whisper Python (small)" 或
      // "字符加权估算" 让用户知道字幕精度档位 (跟 alignment_meta.json method 字段同源)
      subtitle_align_method: ctx.alignMethodUsed,
      subtitle_align_reason_zh: (() => {
        switch (ctx.alignMethodUsed) {
          case "whisper_python": return "Python faster-whisper 本地转写 (逐字精准)";
          case "whisper_api": return "OpenAI Whisper API (逐字精准)";
          case "whisper_local": return "本地 whisper.cpp (逐字精准)";
          case "fallback_estimate": return "字符加权估算 (无 Whisper, 节奏近似)";
          default: return ctx.alignMethodUsed;
        }
      })(),
    },
  };
}
