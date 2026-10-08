import fs from "node:fs/promises";
import path from "node:path";
import {
  jobPath,
  pathExists,
  readJson,
  resolveVideoFormat,
  type AudioMode,
  type ContentQa,
  type PublishQa,
  type QaReport,
  type RenderAudioSource,
  type SceneManifest,
  type SubtitleMode,
  type JobLogger
} from "../../../../packages/core/src/index";
import { probeVideo } from "../../../../packages/render/src/index";
import { loadPrompt, fillTemplate, type OldLlmProvider } from "../../../../packages/providers/src/index";

export async function engineeringValidation(jobId: string) {
  const checks: QaReport["checks"] = [];
  const finalPath = jobPath(jobId, "final", "final.mp4");
  const manifestPath = jobPath(jobId, "manifests", "scene_manifest.json");
  const subtitlesPath = jobPath(jobId, "subtitles", "final.srt");
  const subtitlesAssPath = jobPath(jobId, "subtitles", "final.ass");
  const jobLogPath = jobPath(jobId, "logs", "job.log");
  const renderLogPath = jobPath(jobId, "logs", "render.log");
  const llmLogPath = jobPath(jobId, "logs", "llm_calls.jsonl");
  const audioManifestPath = jobPath(jobId, "audio", "audio_manifest.json");

  await pushExists(checks, "final.mp4 exists", finalPath);
  if (await pathExists(finalPath)) {
    const stat = await fs.stat(finalPath);
    checks.push({
      name: "final.mp4 size",
      status: stat.size > 200_000 ? "pass" : "warning",
      detail: `${stat.size} bytes`
    });
  }
  await pushExists(checks, "scene_manifest.json exists", manifestPath);
  await pushExists(checks, "subtitles.srt exists", subtitlesPath);
  await pushExists(checks, "subtitles.ass exists", subtitlesAssPath);
  await pushExists(checks, "job.log exists", jobLogPath);
  await pushExists(checks, "render.log exists", renderLogPath);

  let manifest: SceneManifest | null = null;
  let subtitleMode: SubtitleMode = "both";
  let audioMode: AudioMode = "anullsrc_fallback";
  let renderAudioSource: RenderAudioSource = "anullsrc_fallback";
  let burnedSubtitles = false;
  let llmMode: "real" | "mock" = "mock";

  // Audio health fields
  let realAudioSceneCount = 0;
  let fallbackAudioSceneCount = 0;
  let audioSilenceSuspected = false;
  let audioHealthWarning = "";
  let finalAudioSizeBytes = 0;
  let ttsProviderFromManifest = "silence";
  let ttsFallbackProviderFromManifest: string | null = null;
  let ttsFallbackUsed = false;
  let audioDurationSec = 0;

  if (await pathExists(manifestPath)) {
    manifest = await readJson<SceneManifest>(manifestPath);
    if (manifest) {
      subtitleMode = manifest.subtitle_mode ?? "both";
    audioMode = manifest.audio_mode ?? "anullsrc_fallback";
    renderAudioSource = manifest.render_audio_source ?? "anullsrc_fallback";
    burnedSubtitles = Boolean(manifest.burned_subtitles);
    llmMode = manifest.llm_mock === false ? "real" : "mock";
    checks.push({
      name: "scenes non-empty",
      status: manifest.scenes.length > 0 ? "pass" : "fail",
      detail: `${manifest.scenes.length} scenes`
    });
    for (const scene of manifest.scenes) {
      checks.push({
        name: `scene ${scene.scene_id} fields`,
        status: scene.scene_title && scene.narration_text && scene.visual_prompt ? "pass" : "fail",
        detail: `title=${Boolean(scene.scene_title)}, narration=${Boolean(scene.narration_text)}, prompt=${Boolean(scene.visual_prompt)}`
      });
      checks.push({
        name: `scene ${scene.scene_id} asset`,
        status: scene.asset_path && (await pathExists(path.join(jobPath(jobId), scene.asset_path))) ? "pass" : "fail",
        detail: scene.asset_path ?? "missing"
      });
      checks.push({
        name: `scene ${scene.scene_id} audio_path`,
        status: scene.audio_path && (await pathExists(path.join(jobPath(jobId), scene.audio_path))) ? "pass" : "fail",
        detail: scene.audio_path ?? "missing"
      });
      const sceneText = `${scene.scene_title}\n${scene.narration_text}\n${scene.visual_prompt}\n${(scene.screen_text || []).join("\n")}`;
      const promptLeak = /#\s*(Visual Director|Scene Planner|Revision|QA|Script Understanding|Metadata|LLM Check) Agent|Return JSON only|CURRENT_MANIFEST|SOURCE_SCRIPT|USER_REVISION|\\n##\s|你是.*AI.*创作|返回严格 JSON|不要.*Markdown|项目圣经|可用工具\n|Provider 能力|禁止事项\n|失败处理|输出 JSON Schema|上一次返回的 JSON 校验失败/.test(sceneText);
      checks.push({
        name: `scene ${scene.scene_id} prompt leakage`,
        status: promptLeak ? "fail" : "pass",
        detail: promptLeak ? "scene text appears to include prompt/template content" : "clean"
      });
      if (scene.duration_estimate_sec > 28) {
        checks.push({
          name: `scene ${scene.scene_id} duration`,
          status: "warning",
          detail: `${scene.duration_estimate_sec}s is long for one beat`
        });
      }
      const longestText = Math.max(...scene.screen_text.map((item) => [...item].length), 0);
      if (longestText > 32) {
        checks.push({
          name: `scene ${scene.scene_id} screen_text density`,
          status: "warning",
          detail: `longest screen text has ${longestText} chars`
        });
      }
    }

    // Per-scene fallback check from manifest
    const fallbackScenes = manifest.scenes.filter((s) => s.fallback_used);
    const realScenes = manifest.scenes.filter((s) => !s.fallback_used && s.audio_path && !s.audio_path.includes("silence"));
    if (fallbackScenes.length > 0) {
      checks.push({
        name: "scene audio fallback count",
        status: fallbackScenes.length === manifest.scenes.length ? "fail" : "warning",
        detail: `${realScenes.length} real, ${fallbackScenes.length} fallback (of ${manifest.scenes.length} scenes)`
      });
    }
    }
  }

  // Read audio_manifest.json for detailed audio tracking
  if (await pathExists(audioManifestPath)) {
    try {
      const audioManifest = await readJson<Record<string, any>>(audioManifestPath);
      if (audioManifest) {
        ttsProviderFromManifest = audioManifest.provider ?? "silence";
      ttsFallbackProviderFromManifest = audioManifest.fallback_provider ?? null;
      ttsFallbackUsed = audioManifest.fallback_used ?? false;
      audioDurationSec = audioManifest.duration_sec ?? 0;
      finalAudioSizeBytes = audioManifest.final_file_size_bytes ?? 0;
      realAudioSceneCount = audioManifest.real_scene_count ?? 0;
      fallbackAudioSceneCount = audioManifest.fallback_scene_count ?? 0;

      // Update audioMode based on actual audio manifest (more authoritative than manifest)
      const manifestMode = audioManifest.mode;
      if (manifestMode === "real_tts") {
        audioMode = "real_tts";
        renderAudioSource = "real_audio";
      } else if (manifestMode === "partial_tts" || manifestMode === "fallback") {
        audioMode = "partial_tts";
        renderAudioSource = "partial_real_audio";
      } else if (manifestMode === "silence") {
        audioMode = "silence";
        renderAudioSource = "silence_file";
      }

      // Audio health: check real vs fallback scene counts
      if (realAudioSceneCount === 0 && fallbackAudioSceneCount > 0) {
        audioSilenceSuspected = true;
        audioHealthWarning = "All scenes used silence fallback; final audio is likely silent.";
      } else if (fallbackAudioSceneCount > 0) {
        audioHealthWarning = `${fallbackAudioSceneCount}/${audioManifest.total_scenes ?? fallbackAudioSceneCount + realAudioSceneCount} scenes used fallback.`;
      }

      // Audio health: check file size heuristic
      if (audioDurationSec > 0 && finalAudioSizeBytes > 0) {
        const expectedMinBytes = audioDurationSec * 16000; // ~16kbps minimum for real speech AAC
        if (finalAudioSizeBytes < expectedMinBytes * 0.3) {
          audioSilenceSuspected = true;
          audioHealthWarning = (audioHealthWarning ? audioHealthWarning + " " : "") +
            `File size (${finalAudioSizeBytes} bytes) is suspiciously small for ${audioDurationSec.toFixed(1)}s duration. Likely silent.`;
        }
      }

      // Check individual scene audio files for silence-based paths
      const rawSceneFiles = audioManifest.scene_audio_files;
      const sceneFiles: Array<{ path?: string; mode?: string }> | undefined = Array.isArray(rawSceneFiles)
        ? rawSceneFiles
        : undefined;
      if (sceneFiles && sceneFiles.length > 0) {
        const silenceFileCount = sceneFiles.filter((f) =>
          String(f.path ?? "").includes("silence") || f.mode === "silence"
        ).length;
        if (silenceFileCount === sceneFiles.length && realAudioSceneCount === 0) {
          audioSilenceSuspected = true;
        }
      }

      checks.push({
        name: "audio manifest real/fallback counts",
        status: realAudioSceneCount > 0 ? "pass" : "fail",
        detail: `real=${realAudioSceneCount}, fallback=${fallbackAudioSceneCount}`
      });

      if (audioSilenceSuspected) {
        checks.push({
          name: "audio silence suspected",
          status: "fail",
          detail: audioHealthWarning
        });
      }
      }
    } catch { /* ignore */ }
  }

  if (await pathExists(renderLogPath)) {
    const renderLog = await fs.readFile(renderLogPath, "utf8");
    const audioMatch = renderLog.match(/audio_source=(real_audio|partial_real_audio|silence_file|anullsrc_fallback)/);
    if (audioMatch) {
      const src = audioMatch[1] as string;
      renderAudioSource = src as RenderAudioSource;
      if (src === "real_audio") audioMode = "real_tts";
      else if (src === "partial_real_audio") audioMode = "partial_tts";
      else if (src === "silence_file") audioMode = "silence";
      else audioMode = "anullsrc_fallback";
    }
    burnedSubtitles = /burned_subtitles=true|Subtitles burned/i.test(renderLog);
    checks.push({
      name: "render audio source logged",
      status: audioMatch ? "pass" : "fail",
      detail: audioMatch?.[1] ?? "missing audio_source marker"
    });
    checks.push({
      name: "anullsrc fallback trace",
      status: audioMatch?.[1] !== "anullsrc_fallback" || /audio_source=anullsrc_fallback/.test(renderLog) ? "pass" : "fail",
      detail: audioMatch?.[1] === "anullsrc_fallback" ? "anullsrc fallback explicitly logged" : "file audio source used"
    });
    if (subtitleMode === "burn" || subtitleMode === "both") {
      checks.push({
        name: "subtitle burn logged",
        status: burnedSubtitles ? "pass" : "fail",
        detail: burnedSubtitles ? `subtitle_mode=${subtitleMode}` : "render.log does not show subtitle burning"
      });
    }
  }

  if (await pathExists(llmLogPath)) {
    const llmLog = await fs.readFile(llmLogPath, "utf8");
    const hasReal = /"llm_mode"\s*:\s*"real"/.test(llmLog);
    const hasMock = /"llm_mode"\s*:\s*"mock"|"status"\s*:\s*"mock_fallback"/.test(llmLog);
    if (hasReal) llmMode = "real";
    if (hasMock && !hasReal) llmMode = "mock";
    checks.push({
      name: "llm_calls mode trace",
      status: hasReal || hasMock ? "pass" : "fail",
      detail: hasReal ? "real LLM calls logged" : hasMock ? "mock LLM calls logged" : "missing llm_mode markers"
    });
  }

  // Audio health: try ffprobe volume detection on final.m4a
  const finalAudioFile = jobPath(jobId, "audio", "final.m4a");
  if (await pathExists(finalAudioFile)) {
    try {
      const volResult = await runVolumedetect(finalAudioFile);
      if (volResult) {
        checks.push({
          name: "audio volume detection",
          status: volResult.maxVolume < -40 ? "warning" : "pass",
          detail: `max_volume=${volResult.maxVolume}dB, mean_volume=${volResult.meanVolume}dB`
        });
        if (volResult.maxVolume < -60) {
          audioSilenceSuspected = true;
          if (!audioHealthWarning) {
            audioHealthWarning = "Volume detection indicates near-silent audio.";
          }
        }
      }
    } catch { /* ffprobe may not support volumedetect */ }
  }

  // Clip manifest consistency check
  const clipManifestPath = jobPath(jobId, "manifests", "clip_manifest.json");
  let clipManifestConsistency: { status: string; issues: string[] } = { status: "not_applicable", issues: [] };
  if (await pathExists(clipManifestPath)) {
    try {
      const clipManifest = await readJson<Record<string, any>>(clipManifestPath);
      const manifestScene = manifest as SceneManifest | null;
      if (manifestScene) {
        const clipIssues: string[] = [];
        for (const scene of manifestScene.scenes) {
          if (!scene.active_clip_version_id) continue;
          const cv = (scene.clip_versions || []).find(v => v.version_id === scene.active_clip_version_id);
          if (!cv) {
            clipIssues.push(`scene ${scene.stable_scene_id}: active_clip_version_id ${scene.active_clip_version_id} not in clip_versions`);
          } else if (cv.status !== "active") {
            clipIssues.push(`scene ${scene.stable_scene_id}: active clip ${cv.version_id} status ${cv.status} (expected active)`);
          } else if (cv.path) {
            const jobRoot = jobPath(jobId);
            const clipAbs = path.join(jobRoot, cv.path);
            if (!(await pathExists(clipAbs))) {
              clipIssues.push(`scene ${scene.stable_scene_id}: active clip file missing: ${cv.path}`);
            }
          }
        }
        clipManifestConsistency = {
          status: clipIssues.length === 0 ? "pass" : clipIssues.some(i => i.includes("missing") || i.includes("not found")) ? "fail" : "warning",
          issues: clipIssues
        };
      }
    } catch { /* ignore */ }
  }
  checks.push({
    name: "clip manifest consistency",
    status: clipManifestConsistency.status === "fail" ? "fail" : clipManifestConsistency.status === "warning" ? "warning" : "pass",
    detail: clipManifestConsistency.issues.length > 0 ? clipManifestConsistency.issues.join("; ") : "consistent"
  });

  let ffprobe: QaReport["ffprobe"] | undefined;
  if (await pathExists(finalPath)) {
    try {
      ffprobe = await probeVideo(finalPath);
      // Compute expected dimensions from manifest, not hardcoded 1920x1080
      const fmt = manifest ? resolveVideoFormat({ resolution: manifest.resolution, aspectRatio: manifest.aspect_ratio }) : null;
      const expectedW = fmt?.width;
      const expectedH = fmt?.height;
      const fw = ffprobe?.width ?? 0;
      const fh = ffprobe?.height ?? 0;
      const dimOk = expectedW != null && expectedH != null
        ? fw === expectedW && fh === expectedH
        : (fw > 0 && fh > 0);
      checks.push({
        name: "ffprobe video",
        status: dimOk ? "pass" : "warning",
        detail: `${fw}x${fh}${expectedW ? ` (expected ${expectedW}x${expectedH})` : ""}, ${ffprobe?.video_codec ?? "?"}, duration ${ffprobe?.duration_sec?.toFixed(2) ?? "?"}s`
      });
      checks.push({
        name: "ffprobe audio",
        status: ffprobe.has_audio ? "pass" : "warning",
        detail: ffprobe.has_audio ? `audio=${ffprobe.audio_codec}` : "no audio track"
      });
    } catch (error) {
      checks.push({
        name: "ffprobe",
        status: "warning",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    checks, ffprobe, manifest, llmMode, subtitleMode, audioMode, renderAudioSource, burnedSubtitles,
    realAudioSceneCount, fallbackAudioSceneCount, audioSilenceSuspected, audioHealthWarning,
    ttsProviderFromManifest, ttsFallbackProviderFromManifest, ttsFallbackUsed, audioDurationSec, finalAudioSizeBytes
  };
}

async function runVolumedetect(filePath: string): Promise<{ maxVolume: number; meanVolume: number } | null> {
  const { spawn } = await import("node:child_process");
  // 4C: resolve path to handle Unicode/spaces
  const resolvedPath = path.resolve(filePath);
  return new Promise((resolve) => {
    // volumedetect 应该秒级出结果, 给 60s 上限防御坏文件
    const child = spawn("ffmpeg", [
      "-i", resolvedPath,
      "-af", "volumedetect",
      "-vn", "-sn", "-dn",
      "-f", "null", "NUL"
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 });
    let stderr = "";
    let killed = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      // ring-buffer 防 OOM
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.on("close", () => {
      if (killed) return;
      const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
      const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
      if (maxMatch) {
        resolve({
          maxVolume: parseFloat(maxMatch[1]),
          meanVolume: meanMatch ? parseFloat(meanMatch[1]) : -91
        });
      } else {
        resolve(null);
      }
    });
    child.on("error", () => {
      killed = true;
      resolve(null);
    });
  });
}

export function summarizeQaStatus(checks: QaReport["checks"]): QaReport["status"] {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "pass";
}

async function pushExists(checks: QaReport["checks"], name: string, filePath: string) {
  checks.push({
    name,
    status: (await pathExists(filePath)) ? "pass" : "fail",
    detail: filePath
  });
}

export async function contentValidation(jobId: string, provider?: OldLlmProvider, logger?: JobLogger): Promise<ContentQa> {
  const manifestPath = jobPath(jobId, "manifests", "scene_manifest.json");
  const biblePath = jobPath(jobId, "manifests", "project_bible.json");

  if (!(await pathExists(manifestPath))) {
    return { status: "fail", issues: ["manifest 不存在"], recommendations: ["请先完成视频生成流程"] };
  }

  const manifest = await readJson<SceneManifest>(manifestPath);
  if (!manifest) return { status: "fail", issues: ["manifest 读取失败或损坏"], recommendations: ["请重新生成视频"] };
  const bible = await pathExists(biblePath) ? await readJson<any>(biblePath) : null;
  const issues: string[] = [];
  const recommendations: string[] = [];

  // Basic content checks
  if (manifest.scenes.length === 0) {
    issues.push("没有分镜");
  }

  // Check narration length per scene
  for (const scene of manifest.scenes) {
    if (scene.narration_text && scene.narration_text.length > 500) {
      issues.push(`Scene ${scene.scene_id}: 旁白过长 (${scene.narration_text.length} 字)`);
    }
    if (scene.screen_text.length === 0) {
      issues.push(`Scene ${scene.scene_id}: 缺少屏幕文字`);
    }
  }

  // Check for duplicate narration
  const narrations = manifest.scenes.map(s => s.narration_text?.slice(0, 50)).filter(Boolean);
  const uniqueNarrations = new Set(narrations);
  if (uniqueNarrations.size < narrations.length * 0.8) {
    issues.push("存在较多重复或相似的旁白内容");
  }

  if (issues.length === 0) {
    recommendations.push("内容结构清晰，建议人工复核事实准确性");
  }
  recommendations.push("建议接入真实 TTS 提升配音质量");

  const status = issues.length === 0 ? "pass" : issues.length > 3 ? "fail" : "warning";
  return { status, issues, recommendations };
}

export async function publishValidation(jobId: string, provider?: OldLlmProvider, logger?: JobLogger): Promise<PublishQa> {
  const manifestPath = jobPath(jobId, "manifests", "scene_manifest.json");
  const metaPath = jobPath(jobId, "manifests", "bilibili_metadata.json");

  if (!(await pathExists(manifestPath))) {
    return { status: "fail", platform: "bilibili", title_quality: "无法评估", cover_quality: "无法评估", publish_notes: ["manifest 不存在"] };
  }

  const metadata = await pathExists(metaPath) ? await readJson<any>(metaPath) : null;
  const publishNotes: string[] = [];

  let titleQuality = "未生成";
  let coverQuality = "未生成";

  if (metadata) {
    // Title quality
    if (metadata.bilibili_title) {
      const titleLen = metadata.bilibili_title.length;
      if (titleLen >= 10 && titleLen <= 40) {
        titleQuality = "长度合适";
      } else if (titleLen < 10) {
        titleQuality = "标题偏短，建议增加吸引力关键词";
        publishNotes.push("标题偏短");
      } else {
        titleQuality = "标题偏长，B站标题建议 40 字以内";
        publishNotes.push("标题偏长");
      }
    }

    // Cover text
    if (metadata.cover_text) {
      coverQuality = metadata.cover_text.length <= 20 ? "简洁清晰" : "文字较多，建议精简";
    }

    // Tags
    if (!metadata.bilibili_tags || metadata.bilibili_tags.length === 0) {
      publishNotes.push("缺少标签");
    }

    // Description
    if (!metadata.bilibili_description || metadata.bilibili_description.length < 20) {
      publishNotes.push("简介过短");
    }
  } else {
    publishNotes.push("B站元数据未生成");
  }

  publishNotes.push("建议人工复核标题吸引力和封面效果");

  const status = publishNotes.length <= 2 ? "pass" : publishNotes.length <= 4 ? "warning" : "fail";
  return {
    status,
    platform: "bilibili",
    title_quality: titleQuality,
    cover_quality: coverQuality,
    publish_notes: publishNotes
  };
}
