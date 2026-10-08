import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists, readJson, resolveVideoFormat, type JobLogger, type RenderAudioSource, type SceneManifest, type SubtitleMode } from "../../core/src/index";
import { runProcess, runFfmpegWorker } from "./process";

export interface SegmentManifestEntry {
  scene_id: number;
  scene_stable_id: string;
  source_type: "clip" | "card";
  source_path: string;
  segment_path: string;
  duration_sec: number;
  width: number;
  height: number;
  fps: number;
  status: "ready" | "fallback" | "failed";
  fallback_reason: string;
}

export interface SegmentManifest {
  job_id: string;
  created_at: string;
  segment_render_mode: string;
  segments: SegmentManifestEntry[];
}

export async function renderFinalVideo(manifest: SceneManifest, jobRoot: string, logger: JobLogger, subtitleMode: SubtitleMode = "both") {
  const rendersDir = path.join(jobRoot, "renders");
  const segmentsDir = path.join(rendersDir, "segments");
  const finalDir = path.join(jobRoot, "final");
  const manifestsDir = path.join(jobRoot, "manifests");
  await ensureDir(segmentsDir);
  await ensureDir(finalDir);
  await ensureDir(manifestsDir);
  const concatPath = path.join(rendersDir, "concat.txt");
  const finalPath = path.join(finalDir, "final.mp4");

  // Resolve target dimensions from manifest
  const fmt = resolveVideoFormat({ resolution: manifest.resolution, aspectRatio: manifest.aspect_ratio });
  const targetW = fmt.width;
  const targetH = fmt.height;
  const targetRes = fmt.resolution;

  // Empty scenes check
  if (!manifest.scenes || manifest.scenes.length === 0) {
    throw new Error("No scenes to render. Please generate storyboard first.");
  }

  let clipSceneCount = 0;
  let cardFallbackSceneCount = 0;
  const segmentEntries: SegmentManifestEntry[] = [];

  // Step 1: Generate normalized segment mp4 for each scene
  await logger.render("=== Normalized Segment Rendering ===");
  for (const scene of manifest.scenes) {
    const segmentPath = path.join(segmentsDir, `scene-${padNum(scene.scene_id)}.mp4`);
    const duration = scene.actual_duration_sec ?? scene.duration_estimate_sec;

    const activeClipId = scene.active_clip_version_id;
    const activeClip = activeClipId
      ? (scene.clip_versions || []).find((cv) => cv.status === "active" && cv.version_id === activeClipId)
      : null;
    const clipPath = activeClip?.path ? path.join(jobRoot, activeClip.path) : "";
    const clipExists = clipPath ? await pathExists(clipPath) : false;

    if (clipExists) {
      // Normalize clip to target resolution, 30fps, h264, yuv420p, no audio
      const result = await runFfmpegWorker([
        "-y", "-i", clipPath,
        "-vf", `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2`,
        "-r", "30",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-pix_fmt", "yuv420p",
        "-an",
        "-t", duration.toFixed(3),
        "-movflags", "+faststart",
        segmentPath
      ], { cwd: jobRoot, timeoutMs: Math.max(120000, duration * 10000) });
      if (result.code !== 0) {
        await logger.render(`Scene ${scene.scene_id}: clip normalize failed, falling back to card. ${result.stderr.slice(-300)}`);
        // Fallback to card
        const assetPath = scene.asset_path ? path.join(jobRoot, scene.asset_path) : "";
        if (!(await pathExists(assetPath))) throw new Error(`Scene ${scene.scene_id} missing both clip and asset`);
        await generateCardSegment(assetPath, segmentPath, duration, scene.scene_id, jobRoot, logger, { width: targetW, height: targetH });
        cardFallbackSceneCount++;
        segmentEntries.push({
          scene_id: scene.scene_id,
          scene_stable_id: scene.stable_scene_id,
          source_type: "card",
          source_path: scene.asset_path || "",
          segment_path: `renders/segments/scene-${padNum(scene.scene_id)}.mp4`,
          duration_sec: duration,
          width: targetW,
          height: targetH,
          fps: 30,
          status: "fallback",
          fallback_reason: `clip normalize failed: ${result.stderr.slice(-200)}`
        });
      } else {
        clipSceneCount++;
        await logger.render(`Scene ${scene.scene_id}: normalized clip segment`);
        segmentEntries.push({
          scene_id: scene.scene_id,
          scene_stable_id: scene.stable_scene_id,
          source_type: "clip",
          source_path: activeClip?.path || clipPath,
          segment_path: `renders/segments/scene-${padNum(scene.scene_id)}.mp4`,
          duration_sec: duration,
          width: targetW,
          height: targetH,
          fps: 30,
          status: "ready",
          fallback_reason: ""
        });
      }
    } else {
      // Generate card segment
      const assetPath = scene.asset_path ? path.join(jobRoot, scene.asset_path) : "";
      if (!(await pathExists(assetPath))) {
        throw new Error(`Scene ${scene.scene_id} missing both clip and asset: ${scene.asset_path}`);
      }
      await generateCardSegment(assetPath, segmentPath, duration, scene.scene_id, jobRoot, logger, { width: targetW, height: targetH });
      cardFallbackSceneCount++;
      if (activeClipId) {
        await logger.render(`Scene ${scene.scene_id}: active clip ${activeClipId} not found, fallback to card`);
      }
      segmentEntries.push({
        scene_id: scene.scene_id,
        scene_stable_id: scene.stable_scene_id,
        source_type: "card",
        source_path: scene.asset_path || "",
        segment_path: `renders/segments/scene-${padNum(scene.scene_id)}.mp4`,
        duration_sec: duration,
        width: targetW,
        height: targetH,
        fps: 30,
        status: activeClipId ? "fallback" : "ready",
        fallback_reason: activeClipId ? `active clip ${activeClipId} not found` : ""
      });
    }
  }

  // Write segment manifest
  const segmentManifest: SegmentManifest = {
    job_id: manifest.job_id,
    created_at: new Date().toISOString(),
    segment_render_mode: "normalized_mp4_segments",
    segments: segmentEntries
  };
  await fs.writeFile(
    path.join(manifestsDir, "segment_manifest.json"),
    `${JSON.stringify(segmentManifest, null, 2)}\n`,
    "utf8"
  );
  await logger.render(`Segment manifest written: manifests/segment_manifest.json (${segmentEntries.length} segments)`);

  // Step 2: Concat all segments
  const lines: string[] = ["ffconcat version 1.0"];
  for (const scene of manifest.scenes) {
    const segmentPath = path.join(segmentsDir, `scene-${padNum(scene.scene_id)}.mp4`);
    lines.push(`file '${ffconcatPath(segmentPath)}'`);
    const duration = scene.actual_duration_sec ?? scene.duration_estimate_sec;
    // ffconcat 的 duration 要写到 1ms 精度;raw JS 浮点直接 toString 会出 1.3666666666666667
    // 这种长尾, ffmpeg 拿到后会读到不一致的 segment 边界, 累积导致音视频对不齐。
    lines.push(`duration ${duration.toFixed(3)}`);
  }
  // Repeat last file for ffconcat compatibility
  const lastScene = manifest.scenes.at(-1);
  if (lastScene) {
    const lastSegment = path.join(segmentsDir, `scene-${padNum(lastScene.scene_id)}.mp4`);
    lines.push(`file '${ffconcatPath(lastSegment)}'`);
  }
  await fs.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");

  await logger.render(`Clip mode: ${clipSceneCount} clips + ${cardFallbackSceneCount} card fallbacks`);

  const total = manifest.scenes.reduce((sum, scene) => sum + (scene.actual_duration_sec ?? scene.duration_estimate_sec), 0);
  const estimatedRenderMs = Math.max(300000, total * 10000);
  const concatVideoPath = path.join(rendersDir, "concat_normalized.mp4");
  const concatResult = await runFfmpegWorker([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    concatVideoPath
  ], { cwd: jobRoot, timeoutMs: Math.max(120000, total * 5000) });
  await logger.render(`Concat command exited ${concatResult.code}\n${concatResult.stderr}`);
  if (concatResult.code !== 0) {
    throw new Error(`FFmpeg concat failed: ${concatResult.stderr.slice(-1200)}`);
  }

  const audio = await resolveAudioSource(manifest, jobRoot);
  const burnSubtitles = subtitleMode === "burn" || subtitleMode === "both";
  const subtitlePath = path.join(jobRoot, "subtitles", "final.ass");
  const subtitleFilter = burnSubtitles ? `ass=filename=${escapeFfmpegFilterPath(subtitlePath, jobRoot)}` : null;
  const vf = [subtitleFilter, "format=yuv420p"].filter(Boolean).join(",");
  const audioInputArgs =
    audio.source === "anullsrc_fallback"
      ? ["-f", "lavfi", "-t", total.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
      : ["-i", audio.inputPath];

  await logger.render(
    `Render configuration: audio_source=${audio.source}, audio_input=${audio.relativeInput}, subtitle_mode=${subtitleMode}, burned_subtitles=${burnSubtitles}`
  );
  if (burnSubtitles) {
    await logger.render(`Subtitles burned from ${subtitlePath}`);
  }

  const result = await runFfmpegWorker([
    "-y",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-i",
    concatVideoPath,
    ...audioInputArgs,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-threads",
    "2",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    "-movflags",
    "+faststart",
    finalPath
  ], { cwd: jobRoot, timeoutMs: estimatedRenderMs });
  await logger.render(`Render command exited ${result.code}\n${result.stderr}`);
  if (result.code !== 0) {
    throw new Error(`FFmpeg render failed: ${result.stderr.slice(-1200)}`);
  }
  manifest.render_audio_source = audio.source;
  manifest.audio_mode = audio.source === "real_audio" ? "real_tts" : audio.source === "partial_real_audio" ? "partial_tts" : audio.source === "silence_file" ? "silence" : "anullsrc_fallback";
  manifest.burned_subtitles = burnSubtitles;
  for (const scene of manifest.scenes) scene.status = "rendered";

  // QA warnings for -shortest
  await logger.render(`[QA] final_duration_policy=shortest_may_truncate`);
  await logger.render(`[QA] segment_count=${segmentEntries.length}, scenes_length=${manifest.scenes.length}`);
  if (segmentEntries.length !== manifest.scenes.length) {
    await logger.render(`[QA] WARNING: segment_count (${segmentEntries.length}) != scenes.length (${manifest.scenes.length})`);
  }

  await logger.line(`Final video ready: final/final.mp4`);
  return { finalPath, audioSource: audio.source, burnedSubtitles: burnSubtitles, clipSceneCount, cardFallbackSceneCount, segmentCount: manifest.scenes.length, segmentRenderMode: "normalized_mp4_segments" };
}

function padNum(value: number) {
  return value.toString().padStart(3, "0");
}

export async function probeVideo(filePath: string) {
  const result = await runProcess("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath
  ], { timeoutMs: 30000 });
  if (result.code !== 0) {
    throw new Error(`ffprobe failed: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  const video = parsed.streams?.find((stream: any) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream: any) => stream.codec_type === "audio");
  return {
    duration_sec: Number(parsed.format?.duration ?? video?.duration ?? 0),
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    video_codec: video?.codec_name,
    audio_codec: audio?.codec_name,
    has_audio: Boolean(audio)
  };
}

function ffconcatPath(filePath: string) {
  // 4C: resolve to absolute path to handle Unicode/spaces
  const resolved = path.resolve(filePath);
  return resolved.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

/**
 * Escape a file path for use in an ffmpeg filter string (e.g. ASS subtitle path).
 *
 * ffmpeg filter paths require special escaping:
 * - Colons (:) separate filter options, so they must be escaped as \:
 * - Commas (,) separate filters, so they must be escaped as \,
 * - Brackets ([]) delimit filter options, so they must be escaped
 * - Single quotes need escaping for shell safety
 * - Backslashes are normalized to forward slashes for cross-platform consistency
 *
 * The path is wrapped in single quotes after escaping.
 */
function escapeFfmpegFilterPath(filePath: string, baseDir?: string): string {
  // 4C: resolve to absolute path relative to jobRoot to handle Unicode/spaces
  const resolved = baseDir ? path.resolve(baseDir, filePath) : path.resolve(filePath);
  const normalized = resolved.replace(/\\/g, "/");
  const escaped = normalized
    .replace(/'/g, "'\\''")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
  return `'${escaped}'`;
}

async function generateCardSegment(assetPath: string, outputPath: string, duration: number, sceneId: number, jobRoot: string, logger: JobLogger, dimensions?: { width: number; height: number }) {
  const w = dimensions?.width ?? 1920;
  const h = dimensions?.height ?? 1080;
  const result = await runFfmpegWorker([
    "-y", "-loop", "1", "-i", assetPath,
    "-t", duration.toFixed(3),
    "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    "-r", "30",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
    "-pix_fmt", "yuv420p", "-an",
    "-movflags", "+faststart",
    outputPath
  ], { cwd: jobRoot, timeoutMs: Math.max(120000, duration * 10000) });
  if (result.code !== 0) {
    const errMsg = `Scene ${sceneId}: card segment render failed. asset=${assetPath}, stderr=${result.stderr.slice(-500)}`;
    await logger.render(`[ERROR] ${errMsg}`);
    throw new Error(errMsg);
  }
}

async function resolveAudioSource(manifest: SceneManifest, jobRoot: string): Promise<{ source: RenderAudioSource; inputPath: string; relativeInput: string }> {
  const finalAudioPath = path.join(jobRoot, "audio", "final.m4a");
  const silencePath = path.join(jobRoot, "audio", "silence.m4a");
  const audioManifestPath = path.join(jobRoot, "audio", "audio_manifest.json");
  if (await pathExists(finalAudioPath)) {
    const metadata = await readAudioMetadata(audioManifestPath);
    const mode = metadata?.mode ?? manifest.audio_mode;
    let source: RenderAudioSource = "real_audio";
    if (mode === "silence") {
      source = "silence_file";
    } else if (mode === "partial_tts") {
      source = "partial_real_audio";
    } else if (mode === "fallback") {
      source = "partial_real_audio";
    }
    for (const scene of manifest.scenes) {
      scene.audio_path = "audio/final.m4a";
    }
    return { source, inputPath: finalAudioPath, relativeInput: "audio/final.m4a" };
  }
  if (await pathExists(silencePath)) {
    for (const scene of manifest.scenes) {
      scene.audio_path = "audio/silence.m4a";
      scene.fallback_used = true;
    }
    return { source: "silence_file", inputPath: silencePath, relativeInput: "audio/silence.m4a" };
  }
  return { source: "anullsrc_fallback", inputPath: "anullsrc=channel_layout=stereo:sample_rate=48000", relativeInput: "lavfi:anullsrc" };
}

async function readAudioMetadata(filePath: string) {
  if (!(await pathExists(filePath))) return null;
  try {
    return await readJson<{ mode?: string }>(filePath);
  } catch {
    return null;
  }
}
