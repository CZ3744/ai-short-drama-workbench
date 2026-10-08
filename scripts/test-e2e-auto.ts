#!/usr/bin/env tsx
/**
 * End-to-end "document → final.mp4" smoke test (no real video API).
 *
 * Runs the same sample workflow as scripts/run-sample.ts but asserts:
 *   - final.mp4 exists and is non-empty
 *   - qa_report has 0 failed checks
 *   - audio_mode is real_tts (edge_tts works)
 *   - burned_subtitles is true
 *   - ffprobe confirms h264 + aac and non-zero duration
 *
 * Adds the end-to-end chain to test:pre-v02 so any regression in
 * LLM orchestration, TTS, subtitle burn-in or ffmpeg mux fails CI
 * within ~60 seconds (vs. silently shipping a broken headline feature).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

// W7 (2026-05-16): legacy runner 不再 silent fallback 到 local_card_image / local_mock_video。
// 这个 smoke 显式声明要跑 mock pipeline,所以在 import runner 之前把 env 配齐;
// 没设 env 而走 mock 路径就是当年 silent fallback 红线 #1 的化身,必须显式。
process.env.IMAGE_PROVIDER = process.env.IMAGE_PROVIDER || "local_card_image";
process.env.VIDEO_PROVIDER = process.env.VIDEO_PROVIDER || "local_mock_video";
// X7-1 (A7-1, P0 2026-07-22): 强制 MOCK_LLM=true —— 与上面 VIDEO/IMAGE_PROVIDER 兜底并排。
// A7 实测: 本机 config/local-settings.json 里 MOCK_LLM="false" 且 IKUNCODE_API_KEY 真实配置,
// 而 getConfigValue 优先级 process.env > local-settings.json。之前脚本只兜底 provider、漏了 LLM,
// 原样 `npm run test:e2e-smoke` 会用 generationMode:"auto"(无审核 gate)对真实 IkunCode relay 发 5 次
// 付费 LLM 调用(script understanding/scene planner/visual director/metadata/QA)。这里显式覆盖堵死。
// 逃生舱: 显式 `MOCK_LLM=false npm run test:e2e-smoke` 仍可跑真实 LLM(等价 --real-llm), 但会打醒目警告。
process.env.MOCK_LLM = process.env.MOCK_LLM || "true";
if (process.env.MOCK_LLM !== "true" && process.env.MOCK_LLM !== "1") {
  console.warn(
    "\n⚠️  [e2e-auto] MOCK_LLM 被显式设为非 mock —— 本次 smoke 将调用真实(可能付费)LLM provider。" +
    "\n    如非本意, 请去掉 MOCK_LLM 环境变量 (默认强制 mock)。\n"
  );
}

import { runJob } from "../apps/server/src/jobs/runner";
import { initializeJob } from "../apps/server/src/jobs/store";
import { validateJobOutput } from "./validate-output";

const SAMPLE_REPORT = `# 智能客服机器人调研报告

## 背景
2025 年起，客服机器人在电商、政务、金融领域渗透率持续上升。根据中国信通院数据，超过 68% 的头部电商企业已部署智能客服，月均处理咨询 2.3 亿次。

## 技术路线
主流方案从意图识别走向端到端 LLM。2024 年 10 月后，多轮上下文推理成为标准能力。国内厂商以 MiniMax、智谱、月之暗面为主。

## 落地难点
长尾问答准确率仍不足 80%；个性化推荐受限于用户画像完整度；真人接入成本随咨询量线性增加。

## 未来方向
结合多模态理解（语音、图像）与 Agent 自治能力，客服机器人将逐步演进为用户侧智能助理。
`;

interface Check { name: string; passed: boolean; detail?: string; }

async function main() {
  const checks: Check[] = [];
  const startTs = Date.now();

  console.log("[e2e-auto] initializing job (auto mode, mock LLM)…");
  const { record, sourcePath } = await initializeJob({
    scriptText: SAMPLE_REPORT,
    filename: "e2e_sample.md",
    style: "Claude/iOS 质感卡片风",
    visualStrategy: "自动",
    generationMode: "auto"
  });

  console.log(`[e2e-auto] job_id=${record.job_id} source=${sourcePath}`);
  console.log("[e2e-auto] running full pipeline…");
  await runJob(record.job_id, sourcePath);

  const { summary } = await validateJobOutput(record.job_id);
  const jobRoot = record.output_dir;

  checks.push({
    name: "qa failed === 0",
    passed: summary.failed === 0,
    detail: `failed=${summary.failed}, warnings=${summary.warnings}, total=${summary.total_checks}`
  });

  const finalPath = path.join(jobRoot, "final", "final.mp4");
  let finalBytes = 0;
  try { finalBytes = (await fs.stat(finalPath)).size; } catch { /* missing */ }
  checks.push({
    name: "final/final.mp4 present (> 100 KB)",
    passed: finalBytes > 100 * 1024,
    detail: `${finalBytes} bytes`
  });

  checks.push({
    name: "audio_mode === real_tts (edge_tts works)",
    passed: summary.audio_mode === "real_tts",
    detail: `audio_mode=${summary.audio_mode}`
  });

  checks.push({
    name: "burned_subtitles === true",
    passed: Boolean(summary.burned_subtitles),
    detail: `burned=${summary.burned_subtitles}`
  });

  const probe = summary.ffprobe as any;
  checks.push({
    name: "ffprobe: h264 + aac + duration > 30s",
    passed:
      probe?.video_codec === "h264" &&
      probe?.audio_codec === "aac" &&
      typeof probe?.duration_sec === "number" &&
      probe.duration_sec > 30,
    detail: probe ? `${probe.video_codec}/${probe.audio_codec} ${probe.duration_sec?.toFixed?.(1)}s` : "no ffprobe data"
  });

  // Assertion 6 — confirm no real video provider was used (zero cost)
  const manifestPath = path.join(jobRoot, "manifests", "scene_manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  const realClipCount = (manifest.scenes || []).reduce((acc: number, s: any) => {
    const versions = s.clip_versions || [];
    return acc + versions.filter((v: any) => v.provider === "minimax_hailuo" || v.provider === "aliyun_wan_t2v").length;
  }, 0);
  checks.push({
    name: "no real video provider used (zero cost)",
    passed: realClipCount === 0,
    detail: `real_clip_versions=${realClipCount}`
  });

  const durationS = ((Date.now() - startTs) / 1000).toFixed(1);
  const failed = checks.filter(c => !c.passed);
  console.log(`\n========== E2E AUTO RESULT (${durationS}s) ==========`);
  for (const c of checks) {
    const mark = c.passed ? "✓" : "✗";
    console.log(`  ${mark} ${c.name}${c.detail ? " — " + c.detail : ""}`);
  }
  console.log("=====================================================");
  console.log(`Total: ${checks.length}  Passed: ${checks.length - failed.length}  Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.error("\nE2E auto smoke FAILED.");
    process.exit(1);
  }
  console.log("E2E auto smoke PASSED. final.mp4 produced end-to-end without any real video API.");
}

main().catch((err) => {
  console.error("[e2e-auto] fatal:", err);
  process.exit(1);
});
