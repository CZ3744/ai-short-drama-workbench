import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";

import { validate, ExportSchema } from "../../api/v2/validators";
import {
  readEpisode,
  updateEpisode,
  createVersion,
  loadVersionFiles,
  readVersionFile,
  listComposeVersions,
  type EpisodeVersion,
} from "../../api/v2/seriesStore";
import { episodeBase } from "../../api/v2/orchestration/_shared/paths";
import type { ProgressSink } from "../../api/v2/orchestration/_shared/progressSink";

import { ensureDir, pathExists, DATA_ROOT } from "../../../../../packages/core/src/index";
import { exportMultiFormat, resolveFormats } from "../../../../../packages/render/src/multiFormatExporter";
import { trimSrtToWindow, trimAssToWindow } from "./subtitleTrim";
import { createZipArchive } from "../../lib/archive";

// 2026-05-28 P0-17: archiver 之前 `await import("archiver") as any` 把类型完全擦掉,
// archive.file / archive.finalize 全是 any.
// 2026-07-22 XT-T1 (X7-2 兄弟点收口): 这里原来是跟 dataManagement.ts 修复前完全同款的坏
// createRequire 工厂写法 —— archiver@8 是 ESM-only 重写, 只导出具名类, `require("archiver")`
// 拿到的是不可调用的模块 namespace, 运行时炸 "archiver is not a function" (@types/archiver@7
// 仍描述旧工厂签名, tsc 看不出来). 改用共享的版本无关工厂 createZipArchive (v8 具名类 / v7 可调用
// 工厂 / interop default 三路兜底), 与 dataManagement.ts 同源, 不再各自维护一份。

// 2026-05-28 P0-17: library target 之前 hardcode 三层 ../ + "claw-shared/ToPhone/video",
// 改 env LIBRARY_VIDEO_DIR + 启动时检查 + fallback 兼容旧行为.
export function resolveLibraryVideoDir(): string {
  const envDir = process.env.LIBRARY_VIDEO_DIR;
  if (envDir && envDir.trim()) {
    if (!path.isAbsolute(envDir)) {
      throw new Error(`LIBRARY_VIDEO_DIR 必须是绝对路径, 当前: ${envDir}`);
    }
    return envDir;
  }
  return path.resolve(DATA_ROOT, "..", "..", "..", "claw-shared", "ToPhone", "video");
}

export async function assertLibraryVideoDirOnStartup(): Promise<void> {
  const dir = resolveLibraryVideoDir();
  if (!(await pathExists(dir))) {
    const envSet = !!(process.env.LIBRARY_VIDEO_DIR && process.env.LIBRARY_VIDEO_DIR.trim());
    if (envSet) {
      throw new Error(`LIBRARY_VIDEO_DIR=${dir} 不存在, 请创建该目录或配置正确路径`);
    }
    await ensureDir(dir);
  }
}

export type ExportUseCaseResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "json"; body: Record<string, unknown> }
  | { kind: "file"; path: string };

export interface ExportEpisodeInput {
  slug: string;
  episodeId: string;
  body: unknown;
}

export interface ExportEpisodeDeps {
  progress: ProgressSink;
  /** T5: optional AbortSignal — aborted when client disconnects */
  signal?: AbortSignal;
}

/**
 * 2026-05-26 — 整集片头片尾 trim. 用户在 FinalPreviewPlayer 时间轴拖把手选 [start, end] 范围.
 * 用 -c copy 复制流速度极快 (不重编码), 但可能首帧不是 keyframe → 用 `-ss` 放 `-i` 之后(精确切但慢),
 * 取舍: 用 `-ss BEFORE -i` (快, ~10x realtime) + `-c copy`, 大多数 mp4 keyframe 间隔 < 2s 误差可接受.
 *
 * 失败兜底: ffmpeg 失败 / signal aborted → return false, caller 走原 final.mp4 (silent fallback 但 log warn).
 * 铁律 #1: 不本地 timeout, 透传 signal.
 */
async function trimEpisodeMp4(
  sourcePath: string,
  outputPath: string,
  startSec: number,
  endSec: number | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  const args = ["-y"];
  if (startSec > 0.001) args.push("-ss", startSec.toFixed(3));
  args.push("-i", sourcePath);
  if (endSec !== undefined && endSec > startSec) {
    args.push("-to", (endSec - startSec).toFixed(3));  // -ss 已 seek, -to 是 input-relative
  }
  args.push("-c", "copy", "-movflags", "+faststart", outputPath);

  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    if (signal) {
      const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* dead */ } };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    // 2026-05-28 P0-26 修: SIGKILL / 失败时清掉残留破损 outputPath, 不然下次导出
    // pathExists 假阳性 → silent 用 0 字节的死文件继续处理. fs.unlink 失败静默
    // (文件可能根本没创建).
    child.on("close", async (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        console.warn(`[export] trim 失败 code=${code}: ${stderr.slice(-400)}`);
        await fs.unlink(outputPath).catch(() => {});
        resolve(false);
      }
    });
    child.on("error", async () => {
      await fs.unlink(outputPath).catch(() => {});
      resolve(false);
    });
  });
}

/**
 * 2026-07-22 X2-2 (A2-3): 探 sourcePath 里 <= targetSec 的最近视频关键帧时间 (秒)。
 *
 * trimEpisodeMp4 用 `-ss ... -c copy` 是关键帧级 seek: 实际裁点会吸附到 <= 请求值的最近关键帧,
 * 而外挂 srt/ass 若按用户请求的精确 trimStart 平移, 两者最多差一个关键帧间隔 (~1-2s) →
 * "没烧字幕、靠外挂字幕投稿"的用户拿到字幕比画面早最多一个关键帧间隔。
 * 修法: 先探出实际会命中的关键帧时间 K, 把 K 同时用于视频 -ss 和字幕平移量 (同一来源), 消除漂移。
 *
 * 用 ffprobe 读 [0, targetSec+2] 区间的视频 packet (不解码, 快), 取 flags 含 "K" (keyframe)、
 * pts_time <= targetSec 的最大 pts_time。探测失败 / 无关键帧 → 返回 targetSec (退回原行为)。
 * 铁律 #1: 不本地 timeout, 只透传 signal。
 */
async function findKeyframeAtOrBefore(
  sourcePath: string,
  targetSec: number,
  signal?: AbortSignal,
): Promise<number> {
  if (targetSec <= 0.001) return 0;
  return new Promise((resolve) => {
    // 只读到 targetSec+2s, 避免长视频扫全部 packet (关键帧间隔通常 <2s, 足够覆盖 <= targetSec 的那个)。
    const readEnd = (targetSec + 2).toFixed(3);
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-read_intervals", `%${readEnd}`,
      "-show_entries", "packet=pts_time,flags",
      "-of", "csv=p=0",
      sourcePath,
    ];
    const child = spawn("ffprobe", args, { windowsHide: true });
    if (signal) {
      const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* dead */ } };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.length > 512 * 1024) out = out.slice(-512 * 1024);
    });
    child.on("close", () => {
      // CSV 行形如 "1.500000,K__" — 首个字段 pts_time, 其后 flags; flags 含 "K" = keyframe。
      let best = -1;
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const comma = trimmed.indexOf(",");
        if (comma < 0) continue;
        const flags = trimmed.slice(comma + 1);
        if (!flags.includes("K")) continue;
        const pts = parseFloat(trimmed.slice(0, comma));
        if (!isFinite(pts)) continue;
        if (pts <= targetSec + 1e-4 && pts > best) best = pts;
      }
      resolve(best >= 0 ? best : targetSec);
    });
    child.on("error", () => resolve(targetSec));
  });
}

/**
 * UP-6 (2026-07-22 词表统一): 之前四处直接把内部文件名糊到用户脸上 —
 * "final.mp4 不存在，请先运行 compose" —— compose/final.mp4 是后端内部实现细节,
 * 用户只认产品词表: 「预览片」(粗剪, 免费, 不能导出) / 「成片」(可导出正式产物,
 * 没素材时降级为「占位样片」但仍可导出). 这里查一下 compose 目录下是否已有预览片,
 * 给出更准确的下一步引导; 统一 code="FinalNotReady" 让前端能识别、弹人话引导 +
 * 一键直达"合成成片"按钮, 不再是干巴巴一条 toast。
 */
async function describeFinalNotReady(slug: string, episodeId: string): Promise<string> {
  const versions = await listComposeVersions(slug, episodeId).catch(() => []);
  const hasPreview = versions.some((v) => v.mode === "rough");
  return hasPreview
    ? "你现在只有粗剪预览片，用于免费查看节奏，不能导出。要导出可交付的成片，请先点「合成成片」。"
    : "这一集还没有合成成片，请先点「合成成片」生成可导出的正式成片（也可以先点「粗剪预览」免费看看节奏）。";
}

async function writeZipArchive(
  zipPath: string,
  filesToInclude: Array<{ source: string; entryName: string }>,
): Promise<void> {
  // 2026-07-22 XT-T1: 走共享的版本无关 createZipArchive, 不再各自维护 require 工厂.
  await ensureDir(path.dirname(zipPath));
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = createZipArchive({ zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);

    for (const file of filesToInclude) {
      archive.file(file.source, { name: file.entryName });
    }
    archive.finalize().catch(reject);
  });
}

export async function exportEpisode(
  input: ExportEpisodeInput,
  deps: ExportEpisodeDeps,
): Promise<ExportUseCaseResult> {
  const v = validate(ExportSchema, input.body);
  if (!v.ok) return { kind: "validation", status: v.status, errors: v.errors };

  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };
  }

  const baseDir = episodeBase(input.slug, input.episodeId);
  const composeDir = path.join(baseDir, "compose");
  const originalFinalMp4 = path.join(composeDir, "final.mp4");
  const coverPng = path.join(baseDir, "cover.png");
  const metadataJson = path.join(baseDir, "metadata.json");

  // 2026-07-10 P1-6: 外挂字幕 sidecar 源. 裁剪片头片尾时会被替换成平移后的临时文件,
  // 保证包里的 .srt/.ass 与包里的视频严格对齐 (铁律 #4). 未裁剪时维持原文件, 行为不变.
  const originalSrtPath = path.join(composeDir, "subtitles", "final.srt");
  const originalAssPath = path.join(composeDir, "subtitles", "final.ass");
  let effectiveSrtPath = originalSrtPath;
  let effectiveAssPath = originalAssPath;
  // trim 产生的临时文件 (mp4 + 平移字幕) 统一收集, 各 return 分支前一并清理.
  const trimmedTempFiles: string[] = [];

  const outputsDir = path.join(DATA_ROOT, "..", "outputs", input.slug);
  await ensureDir(outputsDir);
  const zipPath = path.join(outputsDir, `${input.episodeId}.zip`);

  // 2026-05-26 整集片头片尾 trim — 用户在 FinalPreviewPlayer 拖把手选 [start, end] 后导出.
  // 2026-05-28 P0-16 修: trim 失败 throw / 返 400 而非 silent fallback 完整视频 (违反铁律 #5).
  // 用户选了 [10s, 60s], ffmpeg 挂了若 silent fallback 完整 0-300s, 用户拿到非预期文件.
  const trimStart = (v.data as { episode_trim_start_sec?: number }).episode_trim_start_sec ?? 0;
  const trimEndRaw = (v.data as { episode_trim_end_sec?: number }).episode_trim_end_sec;
  const needsTrim = trimStart > 0.05 || (trimEndRaw !== undefined && trimEndRaw > 0);
  let finalMp4 = originalFinalMp4;
  let trimmedPath: string | null = null;
  const extraWarnings: string[] = [];
  if (needsTrim && await pathExists(originalFinalMp4)) {
    const ts = Date.now();
    trimmedPath = path.join(composeDir, `final.trimmed_${ts}.mp4`);
    // X2-2 (A2-3): -c copy 裁片头是关键帧级 seek, 实际裁点吸附到 <= trimStart 的最近关键帧。
    // 探出该实际裁点 K, 同时用于视频 -ss 和外挂字幕平移 (同源) → 消除"字幕比画面早最多一个关键帧间隔"的漂移。
    // 探测失败退回 trimStart (原行为)。K<=trimStart 故视频输出与原来同一关键帧起点 (字节等价), 仅字幕平移量对齐。
    const actualTrimStart = trimStart > 0.05
      ? await findKeyframeAtOrBefore(originalFinalMp4, trimStart, deps.signal)
      : trimStart;
    if (trimStart > 0.05 && Math.abs(actualTrimStart - trimStart) > 0.001) {
      deps.progress.progress("export.trim_keyframe", {
        episode_id: input.episodeId,
        requested_trim_start_sec: Number(trimStart.toFixed(3)),
        actual_keyframe_start_sec: Number(actualTrimStart.toFixed(3)),
      });
    }
    const ok = await trimEpisodeMp4(originalFinalMp4, trimmedPath, actualTrimStart, trimEndRaw, deps.signal);
    if (ok && await pathExists(trimmedPath)) {
      finalMp4 = trimmedPath;
      trimmedTempFiles.push(trimmedPath);
      deps.progress.progress("export.trim", {
        episode_id: input.episodeId,
        trim_start_sec: trimStart,
        trim_end_sec: trimEndRaw ?? null,
        output: path.basename(trimmedPath),
      });

      // 2026-07-10 P1-6: 视频裁了片头片尾, 外挂字幕 sidecar 也必须跟着平移/裁剪, 否则
      // "没烧字幕、靠外挂 srt 投稿"的用户拿到的是错位交付物 (裁 6s 片头, 每条字幕晚 6s).
      // 生成平移后的临时 srt/ass, 让 zip / folder / library 三条路径都引用它 (多规格共用同一份).
      // 字幕平移失败不阻塞主视频导出 — 沿用原字幕并显式警告, 好过静默错位。
      try {
        if (await pathExists(originalSrtPath)) {
          const shiftedSrt = trimSrtToWindow(
            await fs.readFile(originalSrtPath, "utf-8"),
            actualTrimStart, // X2-2: 与视频实际关键帧裁点同源, 消除字幕/画面漂移
            trimEndRaw,
          );
          const trimmedSrt = path.join(composeDir, "subtitles", `final.trimmed_${ts}.srt`);
          await fs.writeFile(trimmedSrt, shiftedSrt, "utf-8");
          effectiveSrtPath = trimmedSrt;
          trimmedTempFiles.push(trimmedSrt);
        }
        if (await pathExists(originalAssPath)) {
          const shiftedAss = trimAssToWindow(
            await fs.readFile(originalAssPath, "utf-8"),
            actualTrimStart, // X2-2: 与视频实际关键帧裁点同源
            trimEndRaw,
          );
          const trimmedAss = path.join(composeDir, "subtitles", `final.trimmed_${ts}.ass`);
          await fs.writeFile(trimmedAss, shiftedAss, "utf-8");
          effectiveAssPath = trimmedAss;
          trimmedTempFiles.push(trimmedAss);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[export] 字幕平移失败, 沿用原始字幕: ${msg}`);
        extraWarnings.push("字幕时间轴平移失败, 导出包内字幕可能与裁剪后的视频不对齐, 请核对");
      }
    } else {
      console.warn("[export] episode_trim 失败 — throw 而非 silent fallback");
      if (trimmedPath) {
        await fs.unlink(trimmedPath).catch(() => {});
      }
      return {
        kind: "error",
        status: 400,
        body: {
          error: {
            code: "TrimFailed",
            message: `片头片尾裁剪失败 (起点 ${trimStart.toFixed(1)}s, 终点 ${trimEndRaw ?? "末尾"}). 请取消片头片尾设置后重试, 或检查 ffmpeg 日志.`,
          },
        },
      };
    }
  }

  const filesToInclude: Array<{ source: string; entryName: string }> = [];

  if (await pathExists(finalMp4)) {
    filesToInclude.push({ source: finalMp4, entryName: "final.mp4" });
  }
  if (v.data.include_cover && await pathExists(coverPng)) {
    filesToInclude.push({ source: coverPng, entryName: "cover.png" });
  }
  if (v.data.include_metadata && await pathExists(metadataJson)) {
    filesToInclude.push({ source: metadataJson, entryName: "metadata.json" });
    const metaContent = await fs.readFile(metadataJson, "utf-8");
    try {
      const metaObj = JSON.parse(metaContent);
      const txtPath = path.join(composeDir, "metadata.txt");
      await fs.writeFile(
        txtPath,
        `标题: ${metaObj.title || ""}\n简介: ${metaObj.summary || ""}\n标签: ${(metaObj.tags || []).join(", ")}`,
        "utf-8",
      );
      filesToInclude.push({ source: txtPath, entryName: "metadata.txt" });
    } catch {
      // metadata.json 损坏时跳过, 不影响主要导出产物 (final.mp4 / cover.png 等)
    }
  }

  const scriptMd = path.join(baseDir, "script.md");
  if (await pathExists(scriptMd)) {
    filesToInclude.push({ source: scriptMd, entryName: "script.md" });
  }

  // 2026-07-10 P1-6: 用 effectiveSrtPath — 裁剪时为平移后的临时 srt, 未裁剪时为原 final.srt.
  if (await pathExists(effectiveSrtPath)) {
    filesToInclude.push({ source: effectiveSrtPath, entryName: "subtitles.srt" });
  }

  if (filesToInclude.length === 0) {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "FinalNotReady", message: await describeFinalNotReady(input.slug, input.episodeId) } },
    };
  }

  const target = v.data.target;
  const requestedFormats: string[] = (v.data as { formats?: string[] }).formats || [];
  let multiFormatResults: Array<{
    format_id: string;
    output_path: string;
    width: number;
    height: number;
    fps: number;
    container: string;
    size_bytes: number;
    ok: boolean;
    error?: string;
  }> | undefined;

  if (requestedFormats.length > 0 && await pathExists(finalMp4)) {
    const formatsDir = path.join(outputsDir, "formats", input.episodeId);
    const resolved = resolveFormats(requestedFormats);
    if (resolved.length > 0) {
      // 2026-05-29 P0-6: 多规格串/并行导出时每完成一个 format 通过 SSE broker 推 export.format_progress,
      //   前端 useExport 订 /api/v2/events 收到后显 percent + 当前规格 + ETA (之前只显"导出中 12s").
      //   先推一条 completed=0 的起点, 让前端立刻显进度条 + 总规格数, 不空等到第一个 format 完成.
      deps.progress.progress("export.format_progress", {
        episode_id: input.episodeId,
        completed: 0,
        total: resolved.length,
        percent: 0,
        current_format_id: "",
        current_format_label: "准备导出",
      });
      const results = await exportMultiFormat(
        finalMp4,
        requestedFormats,
        formatsDir,
        input.episodeId,
        600_000,
        0,        // durationSec unknown here; use default timeout
        deps.signal, // T5: propagate client-disconnect signal
        (ev) => {
          deps.progress.progress("export.format_progress", {
            episode_id: input.episodeId,
            completed: ev.completed,
            total: ev.total,
            percent: Math.round((ev.completed / Math.max(ev.total, 1)) * 100),
            current_format_id: ev.justFinishedId,
            current_format_label: ev.justFinishedLabel,
          });
        },
      );
      multiFormatResults = results.map((r) => ({
        format_id: r.formatId,
        output_path: r.outputPath,
        width: r.width,
        height: r.height,
        fps: r.fps,
        container: r.container,
        size_bytes: r.sizeBytes,
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
      }));
      if (target !== "library" && target !== "folder") {
        for (const r of results) {
          if (r.ok) {
            const entryName = path.basename(r.outputPath);
            filesToInclude.push({ source: r.outputPath, entryName: `formats/${entryName}` });
          }
        }
      }
    }
  }

  // 2026-05-25: library/folder target 复制多规格文件 (用户原话: "没看到导出的视频").
  //   原 bug — 用户勾选了"竖版短视频/横版高清"等规格, 但 library/folder 分支只复制 final.mp4 一个,
  //   完全忽略 multiFormatResults. 用户打开文件夹只看到 1 个 mp4, 跟勾选不一致.
  //   修: 按 multi_format 结果复制所有 ok=true 的规格文件; 未勾任何规格时 fallback final.mp4.

  async function copyAllOutputs(destDir: string): Promise<{ files: string[]; totalBytes: number; lastPath: string; warnings: string[] }> {
    await ensureDir(destDir);
    const filesCopied: string[] = [];
    const warnings: string[] = [];
    let totalBytes = 0;
    let lastPath = "";

    // 验证复制后 dest 文件真存在 + 大小一致 — 防 OneDrive / 杀软 / 权限拦截后 silent
    async function copyAndVerify(src: string, dest: string, label: string): Promise<void> {
      const srcStat = await fs.stat(src);
      try {
        await fs.copyFile(src, dest);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[export] copyFile FAILED ${label}: ${msg}`);
        throw new Error(`复制失败 (${label}): ${msg}. 检查目标目录权限 / OneDrive 同步 / 杀毒软件拦截.`);
      }
      // verify
      if (!(await pathExists(dest))) {
        throw new Error(`复制后文件不存在 (${label}): ${dest}. 可能 OneDrive 把它 sync 到云端 + 本地删了, 或杀毒软件移走.`);
      }
      const destStat = await fs.stat(dest);
      if (destStat.size === 0 && srcStat.size > 0) {
        throw new Error(`复制后文件 0 字节 (${label}): ${dest} (源 ${srcStat.size}B). 可能写入被拦截.`);
      }
      if (destStat.size !== srcStat.size) {
        warnings.push(`${label} 大小不一致 (源 ${srcStat.size}B, 目标 ${destStat.size}B), 但文件已落地`);
      }
      totalBytes += destStat.size;
      filesCopied.push(path.basename(dest));
      lastPath = dest;
    }

    // 优先复制多规格生成结果 (用户主动勾选的规格)
    if (multiFormatResults && multiFormatResults.length > 0) {
      for (const r of multiFormatResults) {
        if (r.ok && await pathExists(r.output_path)) {
          const fileName = `${input.slug}_${input.episodeId}_${r.format_id}.${r.container}`;
          const destPath = path.join(destDir, fileName);
          await copyAndVerify(r.output_path, destPath, `format-${r.format_id}`);
        } else {
          warnings.push(`规格 ${r.format_id} 生成失败: ${r.error ?? "未知"}`);
        }
      }
    }

    // 没勾任何规格 (或多规格全失败) → fallback 复制 final.mp4 兜底
    if (filesCopied.length === 0) {
      const destName = `${input.slug}_${input.episodeId}.mp4`;
      const destPath = path.join(destDir, destName);
      await copyAndVerify(finalMp4, destPath, "final.mp4");
    }

    // 2026-05-25 — 用户原话: "字幕呢?" 之前 library/folder target 只复制 video,
    // 字幕/封面/元数据/剧本全丢. 用户没烧字幕到画面时, sidecar .srt 才是字幕载体 →
    // 不复制 = 用户彻底看不到字幕. 跟 zip target 对齐, 一并复制周边产物.
    // 2026-07-10 P1-6: srt/ass 走 effective 路径 — 裁剪片头片尾时为平移后临时文件, 与视频对齐.
    const sidecarFiles: Array<{ src: string; destName: string; label: string }> = [
      { src: effectiveSrtPath, destName: `${input.slug}_${input.episodeId}.srt`, label: "字幕 srt" },
      { src: effectiveAssPath, destName: `${input.slug}_${input.episodeId}.ass`, label: "字幕 ass" },
      { src: coverPng, destName: `${input.slug}_${input.episodeId}_cover.png`, label: "封面" },
      { src: metadataJson, destName: `${input.slug}_${input.episodeId}_metadata.json`, label: "元数据" },
      { src: path.join(baseDir, "script.md"), destName: `${input.slug}_${input.episodeId}_script.md`, label: "剧本" },
    ];
    for (const sc of sidecarFiles) {
      if (!(await pathExists(sc.src))) continue;
      try {
        await copyAndVerify(sc.src, path.join(destDir, sc.destName), sc.label);
      } catch (err) {
        // sidecar 失败不阻塞主视频导出, 只警告
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`${sc.label} 复制失败: ${msg}`);
      }
    }

    return { files: filesCopied, totalBytes, lastPath, warnings };
  }

  if (target === "library") {
    if (!(await pathExists(finalMp4))) {
      return {
        kind: "error",
        status: 400,
        body: { error: { code: "FinalNotReady", message: await describeFinalNotReady(input.slug, input.episodeId) } },
      };
    }
    const libraryDir = resolveLibraryVideoDir();
    const { files, totalBytes, lastPath, warnings } = await copyAllOutputs(libraryDir);

    await updateEpisode(input.slug, input.episodeId, { status: "exported" });

    // 2026-05-26 trim 临时文件 cleanup — fire-and-forget, 失败不阻塞 return
    // 2026-07-10 P1-6: 一并清理平移后的临时字幕 (srt/ass)
    for (const f of trimmedTempFiles) fs.unlink(f).catch(() => {});

    deps.progress.progress("export.done", {
      episode_id: input.episodeId,
      output: lastPath,
      size_bytes: totalBytes,
      target: "library",
    });

    return {
      kind: "json",
      body: {
        ok: true,
        episode_id: input.episodeId,
        output_path: lastPath,
        output_dir: libraryDir,
        size_bytes: totalBytes,
        target: "library",
        files,
        ...((warnings.length > 0 || extraWarnings.length > 0) ? { warnings: [...extraWarnings, ...warnings] } : {}),
        ...(multiFormatResults ? { multi_format_results: multiFormatResults } : {}),
      },
    };
  }

  if (target === "folder") {
    const folderPath = v.data.folder_path;
    if (!folderPath || typeof folderPath !== "string") {
      return {
        kind: "error",
        status: 400,
        body: { error: { code: "ValidationError", message: "target=folder 时必须提供 folder_path" } },
      };
    }
    if (folderPath.includes("..")) {
      return {
        kind: "error",
        status: 400,
        body: { error: { code: "ValidationError", message: "folder_path 不能包含路径遍历字符" } },
      };
    }
    // 2026-05-28 P1-46/47: 必须绝对路径 + 拒 UNC. 相对路径基于 server cwd, 用户搞不清最终落
    // 在哪 (dev / production cwd 不同). UNC (\\server\share / //server/share) 走 SMB, 无网络挂
    // 载会悬挂数小时, 不在本机工作台合理场景内.
    if (!path.isAbsolute(folderPath)) {
      return {
        kind: "error",
        status: 400,
        body: { error: { code: "ValidationError", message: "folder_path 必须是绝对路径 (如 D:\\Videos\\out)" } },
      };
    }
    if (folderPath.startsWith("\\\\") || folderPath.startsWith("//")) {
      return {
        kind: "error",
        status: 400,
        body: { error: { code: "ValidationError", message: "folder_path 不支持 UNC 网络路径, 请用本机绝对路径" } },
      };
    }
    if (!(await pathExists(finalMp4))) {
      return {
        kind: "error",
        status: 400,
        body: { error: { code: "FinalNotReady", message: await describeFinalNotReady(input.slug, input.episodeId) } },
      };
    }
    const { files, totalBytes, lastPath, warnings } = await copyAllOutputs(folderPath);

    await updateEpisode(input.slug, input.episodeId, { status: "exported" });

    // 2026-05-26 trim 临时文件 cleanup (含 2026-07-10 P1-6 平移字幕 srt/ass)
    for (const f of trimmedTempFiles) fs.unlink(f).catch(() => {});

    deps.progress.progress("export.done", {
      episode_id: input.episodeId,
      output: lastPath,
      size_bytes: totalBytes,
      target: "folder",
    });

    return {
      kind: "json",
      body: {
        ok: true,
        episode_id: input.episodeId,
        output_path: lastPath,
        output_dir: folderPath,
        size_bytes: totalBytes,
        target: "folder",
        files,
        ...((warnings.length > 0 || extraWarnings.length > 0) ? { warnings: [...extraWarnings, ...warnings] } : {}),
        ...(multiFormatResults ? { multi_format_results: multiFormatResults } : {}),
      },
    };
  }

  deps.progress.progress("export.packaging", {
    episode_id: input.episodeId,
    file_count: filesToInclude.length,
    output: zipPath,
  });

  await writeZipArchive(zipPath, filesToInclude);
  const stat = await fs.stat(zipPath).catch(() => null);
  const sizeBytes = stat?.size ?? 0;

  await updateEpisode(input.slug, input.episodeId, { status: "exported" });

  // 2026-05-26 trim 临时文件 cleanup — zip 写完后才删, 否则 archiver 还在读 (含 P1-6 平移字幕)
  for (const f of trimmedTempFiles) fs.unlink(f).catch(() => {});

  deps.progress.progress("export.done", {
    episode_id: input.episodeId,
    output: zipPath,
    size_bytes: sizeBytes,
    target: "zip",
  });

  return {
    kind: "json",
    body: {
      ok: true,
      episode_id: input.episodeId,
      output_path: zipPath,
      size_bytes: sizeBytes,
      target: "zip",
      files: filesToInclude.map(f => f.entryName),
      ...(multiFormatResults ? { multi_format_results: multiFormatResults } : {}),
      // 2026-05-27 — zip 路径也透传 trim 失败 warnings, 让 ExportPanel banner 能显示
      ...(extraWarnings.length > 0 ? { warnings: extraWarnings } : {}),
    },
  };
}

export async function getFinalMp4(slug: string, episodeId: string): Promise<ExportUseCaseResult> {
  const baseDir = episodeBase(slug, episodeId);
  const composeDir = path.join(baseDir, "compose");
  // X2-4 (A6/P3-1): 候选去重 — 原为 ["final.mp4","source.mp4","source.mp4"] 有重复 source.mp4,
  // 同一文件被列两次 (无功能后果但冗余/误导). 去重为 final.mp4 优先, 其次 source.mp4 兜底。
  const candidates = ["final.mp4", "source.mp4"];
  for (const candidate of candidates) {
    const fp = path.join(composeDir, candidate);
    if (await pathExists(fp)) return { kind: "file", path: fp };
  }
  return {
    kind: "error",
    status: 404,
    body: { error: { code: "FinalNotReady", message: await describeFinalNotReady(slug, episodeId) } },
  };
}

export async function listEpisodeComposeVersions(slug: string, episodeId: string): Promise<ExportUseCaseResult> {
  const episode = await readEpisode(slug, episodeId);
  if (!episode) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };
  }

  const versions = await listComposeVersions(slug, episodeId);
  return {
    kind: "json",
    body: {
      episode_id: episodeId,
      versions: versions.map(v => ({
        filename: v.filename,
        mode: v.mode,
        created_at: v.created_at,
        size_bytes: v.size_bytes,
        url: `/api/v2/series/${slug}/episodes/${episodeId}/compose-file/${v.filename}`,
      })),
    },
  };
}

export async function getComposeFile(slug: string, episodeId: string, filename: string): Promise<ExportUseCaseResult> {
  const baseDir = episodeBase(slug, episodeId);
  const composeDir = path.join(baseDir, "compose");
  const fp = path.join(composeDir, filename);

  const resolved = path.resolve(fp);
  if (!resolved.startsWith(path.resolve(composeDir))) {
    return {
      kind: "error",
      status: 403,
      body: { error: { code: "Forbidden", message: "路径非法" } },
    };
  }

  if (!(await pathExists(fp))) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: "指定的历史版本文件不存在，可能已被删除或还没生成" } },
    };
  }
  return { kind: "file", path: fp };
}

// 2026-05-25: 删除指定 compose 历史版本 (用户原话 "做完" — audit 续集 P0 #1).
// W11 D4 (2026-05-27) 升级软删: 走 _trash/ 目录(铁律 #6 "数据保留 > 直接删除"),
// 用户可以从 _trash 子目录手动恢复; 30 天后由 maintenance 命令真删 (后续 wave 补).
// 路径校验防穿越; 删 final.mp4 拒绝 (那是当前成片, 不该从历史版本删).
export async function deleteComposeFile(slug: string, episodeId: string, filename: string): Promise<ExportUseCaseResult> {
  if (filename === "final.mp4") {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "ValidationError", message: "当前成片不能从历史版本里删除；如需替换，请重新合成覆盖。" } },
    };
  }

  const baseDir = episodeBase(slug, episodeId);
  const composeDir = path.join(baseDir, "compose");
  const fp = path.join(composeDir, filename);

  const resolved = path.resolve(fp);
  if (!resolved.startsWith(path.resolve(composeDir))) {
    return {
      kind: "error",
      status: 403,
      body: { error: { code: "Forbidden", message: "路径非法" } },
    };
  }

  if (!(await pathExists(fp))) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: "指定的历史版本文件不存在，可能已被删除或还没生成" } },
    };
  }

  // W11 D4: 软删 — 把文件移到 _trash/ 子目录而非 fs.unlink. 用户后悔可手动从 _trash 拷回.
  const trashDir = path.join(composeDir, "_trash");
  try {
    await fs.mkdir(trashDir, { recursive: true });
  } catch { /* 已存在或父目录权限问题, rename 时再 fail */ }

  // 加时间戳避免重名冲突 (用户可能多次删同名文件)
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const trashedName = `${filename}.${ts}.deleted`;
  const trashedPath = path.join(trashDir, trashedName);

  try {
    await fs.rename(fp, trashedPath);
  } catch (err) {
    // 跨盘 rename 失败 → fallback copy+unlink
    try {
      await fs.copyFile(fp, trashedPath);
      await fs.unlink(fp);
    } catch (err2) {
      return {
        kind: "error",
        status: 500,
        body: { error: { code: "InternalError", message: `软删失败: ${err2 instanceof Error ? err2.message : String(err2)}` } },
      };
    }
  }

  return { kind: "json", body: { ok: true, deleted: filename, trashed_to: `_trash/${trashedName}` } };
}

export async function listEpisodeVersions(slug: string, episodeId: string): Promise<ExportUseCaseResult> {
  const episode = await readEpisode(slug, episodeId);
  if (!episode) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };
  }

  const fileVersions = await loadVersionFiles(slug, episodeId);
  const versions = fileVersions.length > 0
    ? fileVersions
    : (episode.versions || []);

  const result = versions.map(v => ({
    version: v.version,
    created_at: v.created_at,
    source: v.source,
    summary: v.summary,
    script_md_snippet: (v.script_md || "").slice(0, 300),
  }));

  return { kind: "json", body: { versions: result } };
}

export async function revertEpisodeVersion(slug: string, episodeId: string, body: unknown): Promise<ExportUseCaseResult> {
  const episode = await readEpisode(slug, episodeId);
  if (!episode) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };
  }

  const { to_version } = body as { to_version?: number };
  if (!to_version || typeof to_version !== "number") {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "ValidationError", message: "to_version 必须是数字" } },
    };
  }

  let targetVersion: EpisodeVersion | null = await readVersionFile(slug, episodeId, to_version);
  if (!targetVersion) {
    const versions = episode.versions || [];
    const found = versions.find(v => v.version === to_version);
    if (!found) {
      return {
        kind: "error",
        status: 404,
        body: { error: { code: "NotFound", message: `版本 v${to_version} 不存在` } },
      };
    }
    targetVersion = found;
  }

  const revertedScript = targetVersion.script_md;
  const baseDir = episodeBase(slug, episodeId);
  await ensureDir(baseDir);
  const scriptPath = path.join(baseDir, "script.md");
  await fs.writeFile(scriptPath, revertedScript, "utf8");

  const newVersion = await createVersion(
    slug, episodeId,
    revertedScript, "revert",
    `回滚到 v${to_version}`,
  );

  return {
    kind: "json",
    body: {
      ok: true,
      version: newVersion.version,
      script_md: revertedScript,
      message: `已回滚到 v${to_version}`,
    },
  };
}
