import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, pathExists, readJson, writeJson, type JobLogger, type SceneManifest, type AudioMode, type RenderAudioSource } from "../../core/src/index";
import type { SceneStatus } from "../../core/src/types";
import { createTtsProvider, getAudioDuration, type TtsConfig, type TtsProviderName } from "../../providers/src/tts";
import { runProcess } from "./process";

/**
 * Probe audio file duration using ffprobe.
 * Returns duration in seconds, or null if ffprobe is unavailable or fails.
 * This is the authoritative source for audio duration verification.
 */
async function probeAudioDuration(filePath: string): Promise<number | null> {
  try {
    const result = await runProcess("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath
    ], { timeoutMs: 10000 });
    if (result.code !== 0) return null;
    const duration = parseFloat(result.stdout.trim());
    return isNaN(duration) ? null : duration;
  } catch {
    return null;
  }
}

export async function buildAudio(
  manifest: SceneManifest,
  jobRoot: string,
  logger: JobLogger,
  ttsConfig?: TtsConfig,
  fallbackTtsConfig?: TtsConfig
) {
  const audioDir = path.join(jobRoot, "audio");
  await ensureDir(audioDir);
  const finalAudioPath = path.join(audioDir, "final.m4a");
  const audioManifestPath = path.join(audioDir, "audio_manifest.json");
  const existingMetadata = await readAudioMetadata(audioManifestPath);

  // Don't regenerate if we already have real TTS audio.
  // v0.2.4 fix: `!existingMetadata?.fallback_scene_count` is truthy for both
  // `fallback_scene_count === 0` (good) AND `undefined` (old manifests — bad,
  // they may still carry fallback residue). Explicitly compare to 0.
  if ((existingMetadata?.mode === "real_tts") && (await pathExists(finalAudioPath)) && existingMetadata?.real_scene_count > 0 && (existingMetadata?.fallback_scene_count ?? 0) === 0) {
    for (const scene of manifest.scenes) {
      scene.audio_path = "audio/final.m4a";
      scene.status = scene.status === "subtitle_ready" ? "audio_ready" : scene.status;
    }
    manifest.audio_mode = "real_tts";
    manifest.render_audio_source = "real_audio";
    await logger.line("Existing real TTS audio detected at audio/final.m4a; skipping regeneration.");
    return finalAudioPath;
  }

  const providerName = ttsConfig?.provider ?? "silence";
  const ttsEnabled = ttsConfig?.enabled ?? false;

  // 2026-05-28 audit P0-15: TTS 启用但失败时不再 silent fallback silence (违反铁律 #3).
  // 改 throw 让 caller (runner.ts) 知道 TTS 失败, 自己决定是否要走 buildSilentFallback.
  // runner.ts 已经 try-catch 这里的 throw, catch 后会 fallback_count++ + 走自己的 silent 路径.
  // 这样"TTS 失败"是 caller 的显式决策, 不再藏在这里.
  if (ttsEnabled && providerName !== "silence") {
    return await buildTtsAudio(manifest, jobRoot, logger, ttsConfig!, fallbackTtsConfig);
  }

  return await buildSilentFallback(manifest, jobRoot, logger);
}

type SceneAudioResult = {
  scene_id: number;
  path: string;
  mode: "real_tts" | "fallback" | "silence";
  provider: string;
  fallback_used: boolean;
  duration_sec: number;
  file_size_bytes: number;
  error_type?: string;
  probed_duration_sec?: number | null;
};

async function buildTtsAudio(
  manifest: SceneManifest,
  jobRoot: string,
  logger: JobLogger,
  ttsConfig: TtsConfig,
  fallbackTtsConfig?: TtsConfig
) {
  const audioDir = path.join(jobRoot, "audio");
  const sceneAudioDir = path.join(audioDir, "scenes");
  await ensureDir(sceneAudioDir);

  const primaryProvider = createTtsProvider(ttsConfig, logger);
  // Fallback provider: use configured fallback if different from primary
  const fallbackProviderName = fallbackTtsConfig?.provider ?? "edge_tts";
  const useFallbackProvider = fallbackProviderName !== "silence" && fallbackProviderName !== ttsConfig.provider;
  const fallbackProvider = useFallbackProvider ? createTtsProvider({ ...ttsConfig, provider: fallbackProviderName }, logger) : null;

  await logger.line(
    "TTS provider: " + primaryProvider.name + ", voice=" + ttsConfig.voice +
    (fallbackProvider ? ", fallback_provider=" + fallbackProvider.name : "") +
    ", rate=" + ttsConfig.rate
  );

  const sceneResults: SceneAudioResult[] = [];
  let realCount = 0;
  let fallbackCount = 0;

  // Serial processing: one scene at a time, with interval to avoid rate-limiting
  for (let i = 0; i < manifest.scenes.length; i++) {
    const scene = manifest.scenes[i];
    const paddedId = String(scene.scene_id).padStart(3, "0");
    const sceneAudioPath = path.join(sceneAudioDir, "scene-" + paddedId + ".m4a");

    // Add interval between scenes (500ms-1500ms) to avoid rate-limiting
    if (i > 0) {
      const delay = 500 + Math.floor(Math.random() * 1000);
      await sleep(delay);
    }

    const result = await synthesizeSceneAudio(
      primaryProvider,
      fallbackProvider,
      scene.narration_text,
      sceneAudioPath,
      scene.scene_id,
      ttsConfig,
      logger
    );

    if (result.mode === "real_tts" && result.duration_sec > 0) {
      realCount++;
      scene.actual_duration_sec = result.duration_sec;
      scene.audio_path = "audio/scenes/scene-" + paddedId + ".m4a";
      scene.fallback_used = false;
      scene.status = upgradeSceneStatus(scene.status);
      await logger.line("Scene " + scene.scene_id + ": TTS audio " + result.duration_sec.toFixed(2) + "s");
    } else {
      fallbackCount++;
      const silencePath = path.join(sceneAudioDir, "scene-" + paddedId + "_silence.m4a");
      // v0.2.4: derive silence duration from narration text length instead of
      // blindly trusting scene.duration_estimate_sec. LLM estimates are often
      // way off (especially for short narration) and made silent drafts lose
      // sync with subtitles. Use ~3.5 chars/second Chinese reading speed,
      // clamp to [3, 25] seconds, fall back to the estimate if narration empty.
      const narrationLen = (scene.narration_text || "").trim().length;
      const estimatedBySpeech = narrationLen > 0
        ? Math.max(3, Math.min(25, Math.round(narrationLen / 3.5)))
        : scene.duration_estimate_sec;
      const duration = estimatedBySpeech;
      await generateSilenceFile(silencePath, duration);
      scene.actual_duration_sec = duration;
      scene.audio_path = "audio/scenes/scene-" + paddedId + "_silence.m4a";
      scene.fallback_used = true;
      result.path = silencePath;
      result.duration_sec = duration;
      result.mode = "silence";
      result.fallback_used = true;
      await logger.line(
        "Scene " + scene.scene_id + ": TTS failed" +
        (result.error_type ? " (" + result.error_type + ")" : "") +
        ", using silence"
      );
    }

    sceneResults.push({
      scene_id: scene.scene_id,
      path: path.relative(jobRoot, result.path).replace(/\\/g, "/"),
      mode: result.mode,
      provider: result.provider,
      fallback_used: result.fallback_used,
      duration_sec: Number(result.duration_sec.toFixed(3)),
      file_size_bytes: result.file_size_bytes,
      error_type: result.error_type
    });
  }

  // Build concat file from scene results
  const concatListPath = path.join(audioDir, "concat_scenes.txt");
  const concatLines = sceneResults.map((r) => {
    // 4C: resolve to absolute path to handle Unicode/spaces
    const absPath = path.resolve(path.join(jobRoot, r.path));
    return "file '" + absPath.replace(/\\/g, "/") + "'";
  });
  await fs.writeFile(concatListPath, concatLines.join("\n") + "\n", "utf8");

  const finalAudioPath = path.join(audioDir, "final.m4a");
  const concatResult = await runProcess("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0",
    "-i", concatListPath,
    "-c:a", "aac", "-b:a", "128k",
    finalAudioPath
  ], { timeoutMs: 120000 });
  if (concatResult.code !== 0) {
    throw new Error("FFmpeg concat failed: " + concatResult.stderr.slice(-400));
  }

  const totalDuration = sceneResults.reduce((sum, r) => sum + r.duration_sec, 0);

  // Probe final audio duration for verification
  const probedFinalDuration = await probeAudioDuration(finalAudioPath);
  if (probedFinalDuration !== null) {
    const delta = Math.abs(probedFinalDuration - totalDuration);
    if (delta > 2.0) {
      await logger.line(`[QA WARNING] Probed final audio duration (${probedFinalDuration.toFixed(2)}s) differs from sum of scene durations (${totalDuration.toFixed(2)}s) by ${delta.toFixed(2)}s`);
    }
  }

  // Determine actual audio mode based on scene results
  let audioMode: AudioMode;
  let renderAudioSource: RenderAudioSource;
  if (realCount > 0 && fallbackCount === 0) {
    audioMode = "real_tts";
    renderAudioSource = "real_audio";
  } else if (realCount > 0 && fallbackCount > 0) {
    audioMode = "partial_tts";
    renderAudioSource = "partial_real_audio";
  } else {
    audioMode = "silence";
    renderAudioSource = "silence_file";
  }

  // Get final audio file size
  let finalSizeBytes = 0;
  try {
    const stat = await fs.stat(finalAudioPath);
    finalSizeBytes = stat.size;
  } catch { /* ignore */ }

  // Write detailed audio_manifest.json
  const audioManifest = {
    provider: primaryProvider.name,
    fallback_provider: fallbackProvider?.name ?? null,
    mode: audioMode,
    fallback_used: fallbackCount > 0,
    real_scene_count: realCount,
    fallback_scene_count: fallbackCount,
    total_scenes: manifest.scenes.length,
    scene_audio_files: sceneResults,
    final_audio_path: "audio/final.m4a",
    duration_sec: Number(totalDuration.toFixed(3)),
    probed_duration_sec: probedFinalDuration !== null ? Number(probedFinalDuration.toFixed(3)) : null,
    duration_policy: probedFinalDuration !== null ? "probed_by_ffprobe" : "sum_of_scene_durations",
    final_file_size_bytes: finalSizeBytes,
    generated_at: new Date().toISOString()
  };
  await writeJson(path.join(audioDir, "audio_manifest.json"), audioManifest);

  manifest.audio_mode = audioMode;
  manifest.render_audio_source = renderAudioSource;
  for (const scene of manifest.scenes) {
    scene.audio_path = "audio/final.m4a";
  }

  await logger.line(
    "TTS audio ready: " + totalDuration.toFixed(1) + "s total, " +
    realCount + " real, " + fallbackCount + " fallback, " +
    "mode=" + audioMode + ", final_size=" + finalSizeBytes + " bytes"
  );
  return finalAudioPath;
}

/** Synthesize audio for a single scene, with retry and fallback logic */
async function synthesizeSceneAudio(
  primaryProvider: { name: TtsProviderName; synthesize: Function },
  fallbackProvider: { name: TtsProviderName; synthesize: Function } | null,
  text: string,
  outputPath: string,
  sceneId: number,
  ttsConfig: TtsConfig,
  logger: JobLogger
): Promise<SceneAudioResult & { file_size_bytes: number }> {
  // Attempt 1: Primary provider
  let result = await primaryProvider.synthesize(text, outputPath, {
    voice: ttsConfig.voice,
    rate: ttsConfig.rate
  });

  if (result.ok && result.duration_sec > 0) {
    const size = await getFileSize(outputPath);
    // Probe actual audio duration with ffprobe for verification
    const probedDuration = await probeAudioDuration(outputPath);
    const verifiedDuration = probedDuration ?? result.duration_sec;
    if (probedDuration !== null) {
      const delta = Math.abs(probedDuration - result.duration_sec);
      if (delta > 1.0) {
        await logger.line(`Scene ${sceneId}: TTS reported ${result.duration_sec.toFixed(2)}s, ffprobe reports ${probedDuration.toFixed(2)}s (delta=${delta.toFixed(2)}s)`);
      }
    }
    return {
      scene_id: sceneId,
      path: outputPath,
      mode: "real_tts",
      provider: result.provider,
      fallback_used: false,
      duration_sec: verifiedDuration,
      file_size_bytes: size,
      probed_duration_sec: probedDuration
    };
  }

  const errorType1 = result.error_type ?? classifyError(result.error ?? "");
  await logger.line("Scene " + sceneId + ": primary TTS attempt 1 failed (" + errorType1 + "), retrying after 1s...");

  // Attempt 2: Retry with primary provider after 1s wait
  await sleep(1000);
  result = await primaryProvider.synthesize(text, outputPath, {
    voice: ttsConfig.voice,
    rate: ttsConfig.rate
  });

  if (result.ok && result.duration_sec > 0) {
    const size = await getFileSize(outputPath);
    const probedDuration2 = await probeAudioDuration(outputPath);
    return {
      scene_id: sceneId,
      path: outputPath,
      mode: "real_tts",
      provider: result.provider,
      fallback_used: false,
      duration_sec: probedDuration2 ?? result.duration_sec,
      file_size_bytes: size,
      probed_duration_sec: probedDuration2
    };
  }

  const errorType2 = result.error_type ?? classifyError(result.error ?? "");
  await logger.line("Scene " + sceneId + ": primary TTS attempt 2 failed (" + errorType2 + "), trying shorter text...");

  // Attempt 3: Try with shorter text (first 200 chars)
  const shortText = segmentText(text, 200)[0] ?? text.slice(0, 200);
  await sleep(800);
  result = await primaryProvider.synthesize(shortText, outputPath, {
    voice: ttsConfig.voice,
    rate: ttsConfig.rate
  });

  if (result.ok && result.duration_sec > 0) {
    const size = await getFileSize(outputPath);
    return {
      scene_id: sceneId,
      path: outputPath,
      mode: "real_tts",
      provider: result.provider,
      fallback_used: true,
      duration_sec: result.duration_sec,
      file_size_bytes: size,
      error_type: "partial_short_text"
    };
  }

  // Attempt 4: Try fallback provider (e.g. edge_tts)
  if (fallbackProvider) {
    await logger.line("Scene " + sceneId + ": falling back to " + fallbackProvider.name + "...");
    await sleep(600);
    const fallbackVoice = ttsConfig.fallbackVoice && ttsConfig.fallbackVoice.length > 0
      ? ttsConfig.fallbackVoice
      : isChineseText(text) ? "zh-CN-YunxiNeural" : "en-US-AriaNeural";
    const fallbackRate = ttsConfig.fallbackRate || ttsConfig.rate || "+0%";
    result = await fallbackProvider.synthesize(text, outputPath, {
      voice: fallbackVoice,
      rate: fallbackRate
    });

    if (result.ok && result.duration_sec > 0) {
      const size = await getFileSize(outputPath);
      const probedFallbackDuration = await probeAudioDuration(outputPath);
      return {
        scene_id: sceneId,
        path: outputPath,
        mode: "fallback",
        provider: result.provider,
        fallback_used: true,
        duration_sec: probedFallbackDuration ?? result.duration_sec,
        file_size_bytes: size,
        error_type: "primary_failed_fallback_used",
        probed_duration_sec: probedFallbackDuration
      };
    }
  }

  // All attempts failed
  return {
    scene_id: sceneId,
    path: outputPath,
    mode: "silence",
    provider: primaryProvider.name,
    fallback_used: true,
    duration_sec: 0,
    file_size_bytes: 0,
    error_type: errorType2 || "all_attempts_failed"
  };
}

function classifyError(errorMsg: string): string {
  if (/quota|rate.?limit|too.?many|429|503/i.test(errorMsg)) return "quota_or_rate_limit";
  if (/parse|json|unexpected|token/i.test(errorMsg)) return "response_parse_failed";
  if (/network|econnrefused|enotfound|timeout|fetch.?failed/i.test(errorMsg)) return "network_error";
  if (/key|unauthorized|401|403|auth/i.test(errorMsg)) return "auth_error";
  return "unknown";
}

function segmentText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const segments: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      segments.push(remaining);
      break;
    }
    // Find a good break point
    const chunk = remaining.slice(0, maxChars);
    const breakPoint = Math.max(
      chunk.lastIndexOf("。"),
      chunk.lastIndexOf("；"),
      chunk.lastIndexOf("，"),
      chunk.lastIndexOf(" "),
      0
    );
    const cutAt = breakPoint > 0 ? breakPoint + 1 : maxChars;
    segments.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }
  return segments;
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upgradeSceneStatus(status: SceneStatus): SceneStatus {
  if (status === "subtitle_ready" || status === "asset_ready") return "audio_ready";
  return status;
}

async function buildSilentFallback(manifest: SceneManifest, jobRoot: string, logger: JobLogger) {
  const audioDir = path.join(jobRoot, "audio");
  await ensureDir(audioDir);
  const silencePath = path.join(audioDir, "silence.m4a");
  const finalAudioPath = path.join(audioDir, "final.m4a");
  const totalDuration = manifest.scenes.reduce((sum, s) => sum + (s.actual_duration_sec ?? s.duration_estimate_sec), 0);

  const result = await runProcess("ffmpeg", [
    "-y", "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", totalDuration.toFixed(3),
    "-c:a", "aac", "-b:a", "128k",
    silencePath
  ], { timeoutMs: Math.max(30000, totalDuration * 5000) });
  await logger.render("Silent audio command exited " + result.code + "\n" + result.stderr.slice(-2000));
  if (result.code !== 0) {
    throw new Error("Failed to create silent audio: " + result.stderr.slice(-600));
  }

  await fsCopy(silencePath, finalAudioPath);

  let finalSizeBytes = 0;
  try {
    const stat = await fs.stat(finalAudioPath);
    finalSizeBytes = stat.size;
  } catch { /* ignore */ }

  await writeJson(path.join(audioDir, "audio_manifest.json"), {
    provider: "silence",
    fallback_provider: null,
    mode: "silence",
    fallback_used: true,
    real_scene_count: 0,
    fallback_scene_count: manifest.scenes.length,
    total_scenes: manifest.scenes.length,
    scene_audio_files: [],
    final_audio_path: "audio/final.m4a",
    duration_sec: Number(totalDuration.toFixed(3)),
    final_file_size_bytes: finalSizeBytes,
    generated_at: new Date().toISOString()
  });

  manifest.audio_mode = "silence";
  manifest.render_audio_source = "silence_file";
  for (const scene of manifest.scenes) {
    scene.audio_path = "audio/final.m4a";
    scene.fallback_used = true;
    scene.status = scene.status === "subtitle_ready" ? "audio_ready" : scene.status;
  }
  await logger.line("Silent audio fallback: audio/final.m4a (" + totalDuration.toFixed(1) + "s)");
  return finalAudioPath;
}

async function generateSilenceFile(outputPath: string, durationSec: number) {
  const result = await runProcess("ffmpeg", [
    "-y", "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", durationSec.toFixed(3),
    "-c:a", "aac", "-b:a", "128k",
    outputPath
  ], { timeoutMs: Math.max(30000, durationSec * 5000) });
  if (result.code !== 0) {
    throw new Error("Failed to generate silence file: " + result.stderr.slice(-300));
  }
}

async function fsCopy(from: string, to: string) {
  await fs.copyFile(from, to);
}

async function readAudioMetadata(filePath: string) {
  if (!(await pathExists(filePath))) return null;
  try {
    return await readJson<Record<string, any>>(filePath);
  } catch {
    return null;
  }
}

function isChineseText(text: string): boolean {
  let chineseCount = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) chineseCount++;
  }
  return chineseCount > text.length * 0.15;
}

// Legacy alias: buildAudio is the canonical function name.
// buildSilentAudio predates real TTS support; kept for backward compat.
export const buildSilentAudio = buildAudio;
