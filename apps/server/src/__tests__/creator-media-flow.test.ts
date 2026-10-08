/** Real HTTP/storage/FFmpeg acceptance with generated fixtures, never paid providers. */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import express from "express";
import sharp from "sharp";
import { v2Router } from "../api/v2/index";
import { getRegistry } from "../api/v2/orchestration/_shared/registry";
import { writeLocalSettings } from "../../../../packages/core/src/localSettings";

const ffmpegAvailable = ["ffmpeg", "ffprobe"].every(bin => spawnSync(bin, ["-version"], { windowsHide: true, timeout: 5000, stdio: "ignore" }).status === 0);
const work = path.join(process.cwd(), ".tmp", "creator-media-flow");
let server: http.Server;
let base = "";
let slug = "";
let epId = "";
let shotId = "";
const voices: Array<{ text: string; voice_id: string }> = [];

function media(bin: string, args: string[]): Buffer {
  const result = spawnSync(bin, args, { windowsHide: true, timeout: 20000, maxBuffer: 5 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString().slice(-2000) || result.error?.message);
  return result.stdout;
}
function probe(file: string) {
  return JSON.parse(media("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).toString());
}
async function request(route: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${base}${route}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const payload = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}
async function compose(body: Record<string, unknown>) {
  const queued = await request(`/series/${slug}/episodes/${epId}/compose`, body);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const { task } = await request(`/tasks/${queued.task_id}`);
    if (task.status === "done") return task.result;
    assert.notEqual(task.status, "failed", task.error);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail("Local fixture composition did not finish within 30 seconds");
}

describe("creator media workflow", { skip: ffmpegAvailable ? false : "FFmpeg/ffprobe are required for actual media acceptance" }, () => {
  before(async () => {
    assert.equal(process.env.NODE_ENV, "test");
    assert.equal(path.resolve(process.env.VIDEO_GENERATE_TEST_FIXTURE ?? ""), process.cwd());
    await fs.mkdir(work, { recursive: true });
    // Prevent optional speech alignment from discovering/downloading a host model.
    await writeLocalSettings({ PYTHON_WHISPER_EXE: path.join(work, "missing-python"), WHISPER_CPP_PATH: path.join(work, "missing-whisper"), WHISPER_CPP_MODEL_PATH: path.join(work, "missing-model") });
    media("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-c:a", "libmp3lame", path.join(work, "tone.mp3")]);
    const tone = await fs.readFile(path.join(work, "tone.mp3"));
    getRegistry().register("tts", "fixture_local_tone", () => ({
      id: "fixture_local_tone",
      async synthesize(input) { voices.push(input); return { audio: { buffer: tone, mime: "audio/mpeg", duration_sec: 0.3 } }; },
      async healthCheck() { return { ok: true }; },
    }));
    const app = express(); app.use(express.json({ limit: "10mb" })); app.use("/api/v2", v2Router);
    app.use(((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: { message: error.message } })) as express.ErrorRequestHandler);
    await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/v2`;
  });
  after(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("returns an explicit timing estimate when optional speech alignment tools are unavailable", async () => {
    const { alignSubtitlesForAudio } = await import("../../../../packages/render/src/subtitleAligner");
    const result = await alignSubtitlesForAudio(path.join(work, "tone.mp3"), "Offline spoken text", { whisperProvider: "python_faster_whisper" });
    assert.equal(result.method, "fallback_estimate");
    assert.ok(result.segments.length > 0);
    assert.ok(result.warnings.some(warning => /Python|Whisper/.test(warning)));
  });

  it("saves a script, imports local artwork and two videos, and preserves an explicit candidate choice", async () => {
    const created = await request("/series", { title: "离线完整流程", defaults: { aspect_ratio: "16:9", tts_provider_id: "fixture_local_tone" } });
    slug = created.series.slug;
    epId = (await request(`/series/${slug}/episodes`, { title: "纯测试素材" })).episode.id;
    const script = "# 离线示例\n\n纸船慢慢驶过蓝色河面。";
    await request(`/series/${slug}/episodes/${epId}`, { script_md: script }, "PATCH");
    assert.equal((await request(`/series/${slug}/episodes/${epId}`)).episode.script_md, script);
    shotId = (await request(`/series/${slug}/episodes/${epId}/shots`, { title: "纸船", action: "纸船慢慢驶过蓝色河面", dialogue: "Hello fixture", duration_sec: 1 })).shot.id;
    const localImage = await request("/images/generate", { provider_id: "local_card_image", prompt: "Local offline artwork fixture", width: 512, height: 512, count: 1 });
    const image = await request(`/shots/${shotId}/firstframe/import-image`, { slug, epId, image_base64: localImage.images[0].data_url, mime: "image/png", as_anchor: "first" });
    const candidates: string[] = [];
    for (const color of ["red", "blue"]) {
      const file = path.join(work, `${color}.mp4`);
      media("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${color}:size=320x180:duration=1:r=24`, "-f", "lavfi", "-i", "sine=frequency=880:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
      const imported = await request(`/shots/${shotId}/video/import-local`, { slug, epId, video_base64: (await fs.readFile(file)).toString("base64"), mime: "video/mp4", duration_sec: 1 });
      assert.equal(imported.auto_picked, color === "red");
      candidates.push(imported.generation_id);
    }
    await request(`/series/${slug}/episodes/${epId}/shots/${shotId}/stage/video/candidate/${candidates[1]}`, { action: "select" }, "PATCH");
    const { shot } = await request(`/series/${slug}/episodes/${epId}/shots/${shotId}`);
    assert.equal(shot.picked_video_generation_id, candidates[1]);
    assert.equal(shot.picked_first_frame_generation_id, image.generation_id);
    assert.equal(shot.status, "approved");
  });

  it("composes the selected video with reviewed narration/subtitles and downloads a fully decodable MP4", async () => {
    const result = await compose({ mode: "full", audio_mode: "tts", tts_provider: "fixture_local_tone", tts_voice: "reviewed-fixture-voice", tts_script_override: { [shotId]: "Reviewed narration" }, burn_subtitles: true, subtitle_style: "custom", custom_style: { font_family: "Arial", font_size: 64, color: "#ffffff", position: "top" }, aspect_ratio: "16:9" });
    assert.equal(result.mode, "full"); assert.equal(result.subtitles_burned, true); assert.equal(result.tts_status, "ok");
    assert.equal(result.mock_shots, undefined); assert.equal(result.failed_shots, undefined);
    assert.deepEqual(voices.at(-1) && { text: voices.at(-1)!.text, voice_id: voices.at(-1)!.voice_id }, { text: "Reviewed narration", voice_id: "reviewed-fixture-voice" });
    const download = await fetch(`${base}/series/${slug}/episodes/${epId}/final.mp4`);
    assert.equal(download.status, 200); assert.match(download.headers.get("content-type") ?? "", /video\/mp4/);
    const output = path.join(work, "downloaded.mp4"); await fs.writeFile(output, Buffer.from(await download.arrayBuffer()));
    const info = probe(output); assert.ok(info.streams.some((s: { codec_type: string }) => s.codec_type === "video")); assert.ok(info.streams.some((s: { codec_type: string }) => s.codec_type === "audio"));
    assert.ok(Number(info.format.duration) >= 0.95);
    media("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
    // Pixel evidence: choose the blue candidate, never silently revert to the first red import.
    const rgb = media("ffmpeg", ["-v", "error", "-i", output, "-vf", "crop=20:20:0:100,scale=1:1", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    assert.ok(rgb[2] > rgb[0] + 100, `selected video lost: RGB ${[...rgb]}`);
    const exported = await request(`/series/${slug}/episodes/${epId}/export`, { target: "zip", include_subtitles: true });
    assert.ok(exported.files.some((name: string) => name.endsWith(".mp4"))); assert.ok(exported.size_bytes > 1000);
    assert.equal((await fs.readFile(exported.output_path)).subarray(0, 2).toString(), "PK");
    const history = await request(`/series/${slug}/episodes/${epId}/compose-versions`);
    assert.deepEqual(history.versions.map((version: { filename: string }) => version.filename).sort(), ["final.mp4", "final_v1.mp4"], "actual source/mixing intermediates must not appear as downloadable history");
  });

  it("keeps shot changes scoped to the episode after switching editing context", async () => {
    const otherEp = (await request(`/series/${slug}/episodes`, { title: "另一集" })).episode.id;
    const otherShot = (await request(`/series/${slug}/episodes/${otherEp}/shots`, { title: "另一镜", action: "Separate episode" })).shot;
    const stale = await fetch(`${base}/shots/${shotId}/video/import-local`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, epId: otherEp, video_base64: (await fs.readFile(path.join(work, "red.mp4"))).toString("base64") }),
    });
    assert.equal(stale.status, 404, "a stale shot id must never import media into a different episode");
    assert.equal((await request(`/series/${slug}/episodes/${otherEp}/shots/${otherShot.id}`)).shot.generations.length, 0);
    assert.equal((await request(`/series/${slug}/episodes/${epId}/shots/${shotId}`)).shot.generations.filter((g: { type: string }) => g.type === "video").length, 2);
  });

  it("rough composition respects disabled subtitle burning and retains shot duration after short narration", async () => {
    const result = await compose({ mode: "rough", audio_mode: "tts", tts_provider: "fixture_local_tone", burn_subtitles: false, aspect_ratio: "16:9" });
    assert.equal(result.subtitles_burned, false);
    const output = path.join(process.cwd(), "data", "series", slug, result.final_video_path);
    const info = probe(output);
    assert.ok(Number(info.format.duration) >= 0.95, `one-second shot truncated to ${info.format.duration} seconds by short audio`);
    media("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
    const history = await request(`/series/${slug}/episodes/${epId}/compose-versions`);
    const roughHistory = history.versions.filter((version: { mode: string }) => version.mode === "rough");
    assert.deepEqual(roughHistory.map((version: { filename: string }) => version.filename), [path.basename(output)], "rough source and individual shot segments must stay out of history");
  });

  it("preserves original video audio without making an extra narration call", async () => {
    const callsBefore = voices.length;
    const result = await compose({ mode: "full", audio_mode: "original", tts_provider: "fixture_local_tone", burn_subtitles: false, aspect_ratio: "16:9" });
    assert.equal(result.subtitles_burned, false);
    assert.equal(voices.length, callsBefore);
    const output = path.join(process.cwd(), "data", "series", slug, result.final_video_path);
    assert.ok(probe(output).streams.some((stream: { codec_type: string }) => stream.codec_type === "audio"));
    const pcm = media("ffmpeg", ["-v", "error", "-ss", "0.6", "-i", output, "-t", "0.2", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]);
    let squared = 0;
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) squared += pcm.readInt16LE(offset) ** 2;
    assert.ok(Math.sqrt(squared / (pcm.length / 2)) > 100, "original video audio was dropped or replaced with silence");
  });

  it("actually burns the requested custom color and top position in a rough render", async () => {
    const black = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#000000" } }).png().toBuffer();
    await request(`/shots/${shotId}/firstframe/import-image`, { slug, epId, image_base64: black.toString("base64"), mime: "image/png", as_anchor: "first" });
    const result = await compose({ mode: "rough", audio_mode: "tts", tts_provider: "fixture_local_tone", tts_script_override: { [shotId]: "MMMMMMMM" }, burn_subtitles: true, subtitle_style: "custom", custom_style: { font_family: "Arial", font_size: 120, color: "#00ff00", stroke_width: 0, bg_opacity: 0, position: "top" }, aspect_ratio: "16:9" });
    assert.equal(result.subtitles_burned, true);
    const output = path.join(process.cwd(), "data", "series", slug, result.final_video_path);
    const rgb = media("ffmpeg", ["-v", "error", "-ss", "0.1", "-i", output, "-vf", "scale=320:180", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    let topGreen = 0; let bottomGreen = 0;
    for (let offset = 0; offset + 2 < rgb.length; offset += 3) {
      if (rgb[offset + 1] > 70 && rgb[offset + 1] > rgb[offset] + 40 && rgb[offset + 1] > rgb[offset + 2] + 40) {
        if (offset / 3 < 320 * 90) topGreen++; else bottomGreen++;
      }
    }
    assert.ok(topGreen > 10, `custom green top subtitle missing: ${topGreen} pixels`);
    assert.equal(bottomGreen, 0, "custom top subtitle must not silently use the bottom preset");
  });

  it("reports missing selected footage explicitly without marking the episode composed", async () => {
    const { shot } = await request(`/series/${slug}/episodes/${epId}/shots/${shotId}`);
    const selected = shot.generations.find((g: { generation_id: string }) => g.generation_id === shot.picked_video_generation_id);
    const { getVaultEntry, getVaultAbsolutePath } = await import("../../../../packages/library/src/assetVault");
    const vault = await getVaultEntry(selected.vault_id); assert.ok(vault);
    for (const file of [path.join(process.cwd(), "data", "series", slug, selected.path), getVaultAbsolutePath(vault)]) {
      assert.ok(path.resolve(file).startsWith(process.cwd() + path.sep), "only fixture media may be removed");
      await fs.rename(file, `${file}.missing-fixture`);
    }
    await request(`/series/${slug}/episodes/${epId}`, { status: "scripted" }, "PATCH");
    const result = await compose({ mode: "full", audio_mode: "original", burn_subtitles: false, aspect_ratio: "16:9" });
    assert.equal(result.failed_shots[0].code, "asset-file-missing");
    assert.equal(result.failed_shots[0].shot_id, shotId);
    assert.ok(result.failed_shots_reason);
    assert.equal((await request(`/series/${slug}/episodes/${epId}`)).episode.status, "scripted");
  });
});
