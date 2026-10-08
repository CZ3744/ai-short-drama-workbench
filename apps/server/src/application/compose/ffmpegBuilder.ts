import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { SSR_BASE, episodeBase } from "../../api/v2/orchestration/_shared/paths";
import { generateMockVideo, ffmpegConcat } from "../../api/v2/orchestration/_shared/media";
import { sseBroker } from "../../api/v2/sseBroker";
import { writeJson, pathExists } from "../../../../../packages/core/src/index";
import { loggerSync } from "../../../../../packages/core/src/logger";
import { burnSubtitles } from "../../../../../packages/providers/src/video/burnSubtitles";
import { generateRoughShotSegment } from "../../../../../packages/render/src/roughCompose";
import { buildXfadeFilterChain, type TransitionType } from "../../../../../packages/render/src/transitions";
import { killProcessTree, registerChildProcess } from "../../../../../packages/render/src/process";

import type { ComposeContext, ComposeEpisodeDeps } from "./prepare";
import {
  resolvePickedAsset,
  PickedAssetUnresolvedError,
} from "./pickedAssetResolver";

/**
 * 2026-05-22 P0 — 用 ffprobe 探测视频文件是否含音频流。
 * xfade + audio_mode="original" 拼音轨前逐个片段检查; 任一片段无音轨则降级 -an。
 * 铁律 #1: 不设本地 timeout, 只透传 caller 的 signal。
 */
function probeHasAudioStream(filePath: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type",
      "-of", "csv=p=0", filePath,
    ], { windowsHide: true });
    if (signal) {
      const onAbort = () => { if (child.pid !== undefined) void killProcessTree(child.pid); }; // X7-3: tree-kill
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); if (out.length > 4096) out = out.slice(-4096); });
    child.on("close", () => resolve(out.trim().toLowerCase().includes("audio")));
    child.on("error", () => resolve(false));
  });
}

/**
 * Phase 3 — Concat / Build:
 *   - Rough mode: generate per-shot segments from first-frames + TTS, concat, burn, manifest.
 *   - Full mode: build concat list, transition chain (xfade), concat.
 * Mutates ctx in place (sets finalMp4Path, burned, etc.).
 */
export async function runConcatPhase(
  ctx: ComposeContext,
  deps: ComposeEpisodeDeps,
): Promise<void> {
  let finalMp4Path: string;
  let burned = false;

  if (ctx.composeMode === "rough") {
    // W7 Phase 1: 真草稿模式
    // 用 picked_first_frame 静态图 + TTS 拉伸成单镜片段 → concat → 烧字幕。
    // 30 秒拼出整集预览,零真实视频 API 成本。
    const roughTs = Date.now();
    const roughFilename = `rough_${roughTs}.mp4`;
    finalMp4Path = path.join(ctx.composeDir, roughFilename);
    const roughSourcePath = path.join(ctx.composeDir, `rough_${roughTs}_source.mp4`);

    sseBroker.emit({
      type: "compose.stage",
      job_id: ctx.job_id,
      data: { stage: "compose.rough.start", episode_id: ctx.episodeId, mode: "rough", percent: 60 },
      at: new Date().toISOString(),
    });

    const roughVideoFiles: Array<{ shotId: string; absPath: string; source: string }> = [];

    for (let i = 0; i < ctx.shots.length; i++) {
      const shot = ctx.shots[i];
      const shotId = shot.id;

      // 2026-05-22 entity-first: rough 模式同样以 shot.picked_first_frame_generation_id 为准.
      // 找不到 → 收集到 failedShots (顶层 response 暴露给前端 toast),
      // 但 rough 路径下"缺首帧 → 用 mock 占位"是允许的 (用户可能就是急着看节奏先不要图).
      let firstFramePath: string | null = null;
      try {
        const resolved = await resolvePickedAsset(shot, "first_frame", ctx.slug, ctx.baseDir);
        firstFramePath = resolved.absPath;
      } catch (err) {
        if (err instanceof PickedAssetUnresolvedError) {
          // rough 模式下"没首帧"是常见路径 (no-picked-generation), 不算硬错;
          // 但"picked 设了但 record 丢 / 文件丢"是真异常, 必须收集让用户看到.
          if (err.code !== "no-picked-generation") {
            ctx.failedShots.push({
              shot_id: shotId,
              kind: "first_frame",
              code: err.code,
              reason_zh: err.reasonZh,
            });
          }
        } else {
          throw err;
        }
      }

      const audioPath = path.join(ctx.audioDir, `${shotId}.mp3`);
      const audioExists = await pathExists(audioPath);
      const roughShotPath = path.join(ctx.composeDir, `rough_${roughTs}_${shotId}.mp4`);

      // W7 Phase 4: rough 模式 trim 等效于"缩短 duration"(静态图无时间线,trim_start 不影响画面)
      const baseDurSec = shot.duration_sec || 5;
      const trimStartSec = (shot as { trim_start_sec?: number }).trim_start_sec ?? 0;
      const trimEndSec = (shot as { trim_end_sec?: number }).trim_end_sec ?? baseDurSec;
      const roughDurSec = (trimEndSec > trimStartSec) ? (trimEndSec - trimStartSec) : baseDurSec;
      const roughShotTimeoutMs = Math.max(60_000, roughDurSec * 3000);

      let segmentSource = "no_first_frame";
      if (firstFramePath) {
        try {
          await generateRoughShotSegment({
            imagePath: firstFramePath,
            audioPath: audioExists ? audioPath : undefined,
            durationSec: roughDurSec,
            outputPath: roughShotPath,
            width: ctx.subtitleCanvas.width,
            height: ctx.subtitleCanvas.height,
            signal: deps.signal,
            timeoutMs: roughShotTimeoutMs,
          });
          segmentSource = audioExists ? "first_frame_loop_with_tts" : "first_frame_loop_silent";
        } catch (err) {
          loggerSync().warn(`[compose:rough] ${shotId} 首帧片段失败,改用占位:`, err);
          try {
            await generateMockVideo(roughShotPath, roughDurSec, ctx.aspectRatio);
            segmentSource = "mock_fallback_after_error";
          } catch (mockErr) {
            loggerSync().error(`[compose:rough] ${shotId} 占位 mock 也失败:`, mockErr);
            continue;
          }
        }
      } else {
        // 无首帧 → 用占位 mock,UI 上应提醒用户先去挑首帧
        // UP-7 (2026-07-22): 漏传第三参 aspectRatio, 兄弟调用 (:131/:239/:487) 都传了 —
        // 9:16 系列无首帧占位镜落到 generateMockVideo 默认 1920×1080 横屏, 粗剪整条画幅错乱.
        try {
          await generateMockVideo(roughShotPath, roughDurSec, ctx.aspectRatio);
          segmentSource = "no_first_frame_mock";
        } catch (mockErr) {
          loggerSync().error(`[compose:rough] ${shotId} 无首帧 mock 也失败:`, mockErr);
          continue;
        }
      }

      roughVideoFiles.push({ shotId, absPath: roughShotPath, source: segmentSource });

      // SSE 进度推送 — 显式带 "草稿合成" 字样(铁律 #5)
      sseBroker.emit({
        type: "compose.progress",
        job_id: ctx.job_id,
        data: {
          percent: 60 + Math.round(((i + 1) / ctx.shots.length) * 20),
          step: `草稿合成 ${i + 1}/${ctx.shots.length}`,
          detail: firstFramePath ? `首帧片段 ${shotId}` : `占位片段 ${shotId} (无首帧)`,
          mode: "rough",
          shot_id: shotId,
          index: i + 1,
          total: ctx.shots.length,
        },
        at: new Date().toISOString(),
      });
    }

    // concat 所有 rough 片段
    let burnedRough = false;
    if (roughVideoFiles.length > 0) {
      const concatListPath = path.join(ctx.composeDir, `rough_${roughTs}_concat.txt`);
      const concatLines = roughVideoFiles
        .map(vf => `file '${path.resolve(vf.absPath).replace(/'/g, "'\\''")}'\n`);
      await fs.writeFile(concatListPath, concatLines.join(""), "utf8");

      sseBroker.emit({
        type: "compose.stage",
        job_id: ctx.job_id,
        data: { stage: "compose.rough.concat", episode_id: ctx.episodeId, mode: "rough", percent: 85 },
        at: new Date().toISOString(),
      });

      try {
        await ffmpegConcat(concatListPath, roughSourcePath, deps.signal);
      } catch (err) {
        loggerSync().error("[compose:rough] concat 失败,使用单镜 fallback:", err);
        if (roughVideoFiles[0]) {
          try { await fs.copyFile(roughVideoFiles[0].absPath, roughSourcePath); } catch { /* ignore */ }
        }
      }

      // 烧字幕(草稿默认烧,便于看清节奏)
      if (ctx.burnSubtitles && ctx.srtLines.length > 0 && await pathExists(roughSourcePath)) {
        try {
          sseBroker.emit({
            type: "compose.stage",
            job_id: ctx.job_id,
            data: { stage: "compose.rough.burning", episode_id: ctx.episodeId, mode: "rough", percent: 93 },
            at: new Date().toISOString(),
          });
          await burnSubtitles({
            input_mp4: roughSourcePath,
            srt: ctx.srtPath,
            output_mp4: finalMp4Path,
            style: ctx.subtitleStyle,
            animation: ctx.subtitleAnimation,
            custom_style: ctx.customStyle,
            aspect_ratio: ctx.aspectRatio,
            width: ctx.subtitleCanvas.width,
            height: ctx.subtitleCanvas.height,
            safe_zone_bottom_pct: ctx.subtitleCanvas.safeZoneBottomPct,
            signal: deps.signal,
          });
          burnedRough = true;
        } catch (burnErr) {
          loggerSync().warn("[compose:rough] burnSubtitles 失败,降级复制源:", burnErr);
          try { await fs.copyFile(roughSourcePath, finalMp4Path); } catch { /* ignore */ }
        }
      } else if (await pathExists(roughSourcePath)) {
        try { await fs.copyFile(roughSourcePath, finalMp4Path); } catch { /* ignore */ }
      }
    } else {
      // 2026-05-22 P0-C silent mock fallback 红线修复:
      //   原写法 `await generateMockVideo(finalMp4Path, 1)` 在所有 shot 都没首帧时
      //   生成 1 秒黑屏冒充"合成完成", 用户看 "compose.done" 实际是黑屏.
      //   改为: 每个 shot 显式 push 到 ctx.failedShots, 顶层 response 暴露给前端 toast.
      //   仍写 finalMp4Path (老 caller 兼容 + 让 manifest 路径一致), 但 toast 必须显式触发.
      for (const s of ctx.shots) {
        ctx.failedShots.push({
          shot_id: s.id,
          kind: "first_frame",
          code: "no-picked-generation",
          reason_zh: "整集没有任一可用首帧,无法生成草稿成片,请先去单镜创作页生成或导入首帧",
        });
      }
      loggerSync().error(
        `[compose:rough] 整集零可用片段 (shots=${ctx.shots.length}), 不生成黑屏占位 → failedShots 显式暴露`,
      );
      try {
        await generateMockVideo(finalMp4Path, 1, ctx.aspectRatio);
      } catch { /* ignore */ }
    }

    burned = burnedRough;

    await writeJson(path.join(ctx.composeDir, `rough_${roughTs}_manifest.json`), {
      episode_id: ctx.episodeId,
      composed_at: new Date().toISOString(),
      mode: "rough",
      tts_provider: ctx.ttsProvider,
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
      rough: true,
      burned: burnedRough,
      video_sources: roughVideoFiles.map(vf => ({ shotId: vf.shotId, source: vf.source })),
    });

    deps.progress.progress("compose.rough.done", {
      episode_id: ctx.episodeId,
      mode: "rough",
      output: roughFilename,
      total_duration_ms: ctx.globalMs,
      burned: burnedRough,
    });
    sseBroker.emit({
      type: "compose.done",
      job_id: ctx.job_id,
      data: {
        episode_id: ctx.episodeId,
        mode: "rough",
        output: roughFilename,
        total_duration_ms: ctx.globalMs,
        final_video_path: `episodes/${ctx.episodeId}/compose/${roughFilename}`,
        percent: 100,
        burned: burnedRough,
        tts_status: ctx.ttsOverallStatus,
        // 2026-05-27 — 跟 render.ts 主路径对齐, 让 rough 模式 SSE 也带 shot_segments 真长
        ...(ctx.shotEffectiveSegments.length > 0 ? { shot_segments: ctx.shotEffectiveSegments } : {}),
      },
      at: new Date().toISOString(),
    });

    ctx.finalMp4Path = finalMp4Path;
    ctx.burned = burned;
  } else {
    // ===== Full mode concat =====
    const concatListPath = path.join(ctx.composeDir, "concat_list.txt");
    const validVideos = ctx.videoFiles.filter(vf => vf.absPath);
    const concatLines = validVideos
      .map(vf => `file '${path.resolve(vf.absPath).replace(/'/g, "'\\''")}'\n`);
    await fs.writeFile(concatListPath, concatLines.join(""), "utf8");

    const sourceMp4Path = path.join(ctx.composeDir, "source.mp4");

    if (concatLines.length > 0) {
      deps.progress.progress("compose.concat", { episode_id: ctx.episodeId, video_count: concatLines.length });
      sseBroker.emit({
        type: "compose.stage",
        job_id: ctx.job_id,
        data: { stage: "compose.concat", episode_id: ctx.episodeId, video_count: concatLines.length, percent: 88 },
        at: new Date().toISOString(),
      });

      // W7 Phase 2: 转场体系 — 用 packages/render/transitions.buildXfadeFilterChain 替代内联
      // 支持 4 大类: crossfade / fade / wipe-{left,right,up,down}
      // 旧字段(fade / dissolve / wipe)经 normalizeTransition 自动兼容
      const DEFAULT_TRANSITION_DURATION = 0.5;

      const { normalizeTransition } = await import("../../../../../packages/render/src/transitions");
      // 2026-05-25 字幕对齐根因修复 — xfade 转场点用视频片段真长 (ffprobe), 不再用 shot.duration_sec.
      // 用户实测: AI provider 给 10s 视频, shot.duration_sec=5s, 转场点错 5s → 画面切早了/晚了.
      const { probeVideoFile } = await import("../../../../../packages/render/src/ffprobe");
      // 2026-05-26 audit 修复 — 整集"默认转场"原 ComposeSchema 接但 prepare/ffmpegBuilder 完全不读.
      // 前端 ComposeSettingsPanel:695 提示"应用于未在单镜级别指定 transition 的镜头",
      // 但后端只看 shot.transition_in, 整集 v.data.transition silent 丢. 用户选"全集 fade" 一律 hard cut.
      // 修: shot.transition_in 取不到时 fallback 到 v.data.transition (整集默认), 再 fallback 到 hard.
      const episodeDefaultTransition = (ctx.v.data as { transition?: string }).transition;
      const transSegments = await Promise.all(validVideos.map(async vf => {
        const shot = ctx.shots.find(s => s.id === vf.shotId);
        const fallbackSec = shot?.duration_sec ?? 5;
        let realSec = fallbackSec;
        try {
          const probe = await probeVideoFile(path.resolve(vf.absPath), deps.signal);
          if (probe.duration_sec > 0) realSec = probe.duration_sec;
        } catch { /* ignore, use fallback */ }
        const shotTransRaw = (shot as { transition_in?: string } | undefined)?.transition_in;
        // P1-1: 读单镜级转场时长, 未设则 fallback 到全局默认 0.5s
        const shotTransDuration = (shot as { transition_duration?: number } | undefined)?.transition_duration;
        // 优先级: shot.transition_in (单镜明确指定) → v.data.transition (整集默认) → hard
        const effectiveRaw = (shotTransRaw && shotTransRaw.trim()) ? shotTransRaw : (episodeDefaultTransition || undefined);
        return {
          shotId: vf.shotId,
          duration_sec: realSec,
          transition_in: normalizeTransition(effectiveRaw),
          transition_duration: (shotTransDuration && shotTransDuration > 0) ? shotTransDuration : undefined,
        };
      }));

      // 注意:shot.transition_in 表达"从上一镜如何切入本镜",
      // 所以第 i 段的"出场转场" = transSegments[i+1].transition_in
      const transitionChainInput: Array<{ durationSec: number; transitionToNext: TransitionType; transitionDurationSec?: number }> = transSegments.map((s, i) => ({
        durationSec: s.duration_sec,
        transitionToNext: i < transSegments.length - 1 ? transSegments[i + 1].transition_in : "hard",
        // 2026-07-09 audit (C5 前置崩溃修复) — 最后一段无"下一段", transSegments[i+1] 为 undefined.
        // 旧写法 transSegments[i + 1].transition_duration 直接属性访问 → 末段 TypeError 崩掉整条
        // full-mode xfade 合成 (2026-06-01 加 transition_duration 时漏抄 line 352 同款越界保护).
        // C5 音画同步修复就在这条 xfade 链路上, 不修此崩溃 C5 根本走不到. 补 optional chaining.
        transitionDurationSec: transSegments[i + 1]?.transition_duration ?? DEFAULT_TRANSITION_DURATION,
      }));

      await writeJson(path.join(ctx.composeDir, "transition_manifest.json"), {
        generated_at: new Date().toISOString(),
        version: 2,
        default_duration_sec: DEFAULT_TRANSITION_DURATION,
        entries: transitionChainInput.map((s, i) => ({
          shotId: transSegments[i].shotId,
          transition_to_next: s.transitionToNext,
          duration_sec: s.transitionDurationSec ?? DEFAULT_TRANSITION_DURATION,
        })),
      });

      const anyXfade = transitionChainInput.some((s, i) => i < transitionChainInput.length - 1 && s.transitionToNext !== "hard");

      if (anyXfade && validVideos.length >= 2) {
        const chain = buildXfadeFilterChain(transitionChainInput);
        const inputs = validVideos.flatMap(vf => ["-i", path.resolve(vf.absPath)]);

        // 2026-05-22 P0 — xfade 路径音轨处理 (用户原话: "用视频原声不等于不烧录字幕"):
        //   - audio_mode="original": 把各视频片段音轨用 concat filter 拼成一条接进 xfade 产物,
        //     这样转场场景下视频原声不丢 (旧版写死 -an, original 模式 + 转场会变静音)。
        //   - audio_mode="tts": 仍 -an, 因为 render 阶段 muxTtsAudio 会用 TTS 音轨替换全部音轨。
        // concat filter 要求每路输入都有音轨; 缺音轨的片段 (mock 占位) 会让 filter 报错,
        // 故先 ffprobe 逐个探测, 任一片段无音轨则降级 -an (落 manifest reason, 不阻塞合成)。
        let xfadeAudioFilter = "";
        let xfadeAudioMapLabel: string | null = null;
        if (ctx.audioMode === "original") {
          const audioFlags = await Promise.all(
            validVideos.map((vf) => probeHasAudioStream(path.resolve(vf.absPath), deps.signal)),
          );
          if (audioFlags.every(Boolean)) {
            // 2026-07-09 audit C5 修复 (铁律 #4 音画同步) — 旧写法 `concat=n=N` 把各段音轨平铺拼全长
            // (总长 = Σ 各段时长), 但视频走 xfade 每个非 hard 转场吃掉 transDur 秒
            // (总长 = Σ 时长 − Σ transDur). 音频比视频长 → 人声渐进落后口型 + 尾部超出画面,
            // 镜头越多偏移越大 (4 段 0.5s 转场末镜落后 1.5s).
            // 修: 音轨镜像视频 xfade 链 — 非 hard 边界用 acrossfade (与视频 xfade 同 transDur) 交叉淡化,
            // hard 边界用 2 输入 concat 平接 (对齐视频 xfade duration=0 的瞬切). 这样音频总长 == 视频总长,
            // 且每段音频锚定在自己的视频段上. transDur clamp 公式与 buildXfadeFilterChain
            // (transitions.ts:141-145) 逐字一致, 否则 A/V 会重新错位; 若那边改公式此处必须同步.
            const audioParts: string[] = [];
            let prevA = "[0:a]";
            for (let bi = 1; bi < validVideos.length; bi++) {
              const outA = bi === validVideos.length - 1 ? "[aout]" : `[a${bi}]`;
              const seg = transitionChainInput[bi - 1];
              if (seg.transitionToNext === "hard") {
                audioParts.push(`${prevA}[${bi}:a]concat=n=2:v=0:a=1${outA}`);
              } else {
                const rawT = seg.transitionDurationSec;
                const safeT = typeof rawT === "number" && Number.isFinite(rawT) && rawT > 0 ? rawT : DEFAULT_TRANSITION_DURATION;
                const capT = Math.max(0.1, Math.min(transitionChainInput[bi - 1].durationSec, transitionChainInput[bi].durationSec) - 0.05);
                const transDur = Math.min(Math.max(safeT, 0.1), capT);
                audioParts.push(`${prevA}[${bi}:a]acrossfade=d=${transDur.toFixed(3)}${outA}`);
              }
              prevA = outA;
            }
            xfadeAudioFilter = `;${audioParts.join(";")}`;
            xfadeAudioMapLabel = "[aout]";
          } else {
            loggerSync().warn(
              "[compose] xfade + audio_mode=original: 部分片段无音轨, 转场产物降级为静音 (建议改用硬切保留原声)",
            );
            ctx.trimFailures.push({
              shot_id: "__xfade_audio__",
              error: "转场合成时部分镜头视频无音轨,无法保留视频原声,转场段为静音",
            });
          }
        }

        const ffmpegXfadeArgs = [
          "-y",
          ...inputs,
          "-filter_complex", chain.filterComplex + xfadeAudioFilter,
          "-map", chain.outputLabel,
          ...(xfadeAudioMapLabel ? ["-map", xfadeAudioMapLabel, "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
          "-c:v", "libx264",
          "-preset", "fast",
          path.resolve(sourceMp4Path),
        ];

        await new Promise<void>((resolve, reject) => {
          const child = spawn("ffmpeg", ffmpegXfadeArgs, {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 600_000,
          });
          registerChildProcess(child); // X7-4: 登记活跃子进程, shutdown 时树杀防孤儿
          // T5: AbortSignal 接通 — 请求中断时 SIGKILL ffmpeg (compose 长流程)
          if (deps.signal) {
            const killOnAbort = () => { if (child.pid !== undefined) void killProcessTree(child.pid); }; // X7-3: tree-kill
            deps.signal.addEventListener("abort", killOnAbort, { once: true });
            child.on("close", () => deps.signal!.removeEventListener("abort", killOnAbort));
          }
          let stderr = "";
          const STDERR_LIMIT = 64 * 1024;
          child.stderr?.on("data", (d: Buffer) => {
            stderr += d.toString();
            if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(stderr.length - STDERR_LIMIT);
          });
          child.on("close", (code) => {
            if (deps.signal?.aborted) { reject(new Error("compose aborted by client")); return; }
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg xfade exited ${code}: ${stderr.slice(-500)}`));
          });
          child.on("error", reject);
        });
      } else {
        await ffmpegConcat(concatListPath, sourceMp4Path, deps.signal);
      }
    } else {
      // 2026-05-22 P0-C silent mock fallback 红线修复 (full mode):
      //   原写法 `await generateMockVideo(sourceMp4Path, fallbackDur)` 在所有 shot 都没
      //   picked video / first_frame 时, 生成 globalMs 长黑屏冒充"合成完成".
      //   用户看 "compose.done" 实际是 N 分钟黑屏, 严重违反 silent mock fallback 红线 #1.
      //   改为: 每个 shot 显式 push 到 ctx.failedShots, 仍写 sourceMp4Path 让 render 阶段
      //   不崩 (老 caller 兼容), 但 failedShots 顶层 response 暴露 → 前端 toast.
      for (const s of ctx.shots) {
        ctx.failedShots.push({
          shot_id: s.id,
          kind: "video",
          code: "no-picked-generation",
          reason_zh: "整集没有任一可用视频片段,无法合成正片. 请先去单镜创作页生成视频或挑选已有候选",
        });
      }
      loggerSync().error(
        `[compose:full] 整集零可用 video 片段 (shots=${ctx.shots.length}), 不生成黑屏占位 → failedShots 显式暴露`,
      );
      const fallbackDur = Math.max(Math.round(ctx.globalMs / 1000), 1);
      await generateMockVideo(sourceMp4Path, fallbackDur, ctx.aspectRatio);
    }

    // Store sourceMp4Path in ctx for render phase to use
    ctx._sourceMp4Path = sourceMp4Path;
  }
}
