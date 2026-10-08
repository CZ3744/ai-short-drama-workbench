/**
 * Smoke test for Phase Stable — validates core flows without real API keys.
 * Run: tsx scripts/smoke-phase-stable.ts
 * Requires: server running on port 8788 (npm run server)
 */

const BASE = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8788/api";
const FAKE_KEY = "sk-fake-test-key-1234567890abcdef";

interface TestResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: TestResult[] = [];

async function api(method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function pass(name: string, detail?: string) {
  results.push({ name, ok: true, detail });
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail?: string) {
  results.push({ name, ok: false, detail });
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- Tests ---

async function testHealth() {
  const { status, data } = await api("GET", "/health");
  if (status === 200 && data?.ok) pass("health check");
  else fail("health check", `status=${status}`);
}

async function testSecretsStatus() {
  const { status, data } = await api("GET", "/settings/secrets-status");
  if (status === 200 && data?.ikuncode && data?.mimo) {
    // Ensure no actual keys are leaked
    const json = JSON.stringify(data);
    if (json.includes(FAKE_KEY)) fail("secrets-status no leak", "fake key found in response");
    else pass("secrets-status no leak");
  } else fail("secrets-status", `status=${status}`);
}

async function testSaveAndClearSecret() {
  // Save a fake key using the correct API format
  const { status: saveStatus } = await api("POST", "/settings/save-secrets", {
    ikuncode: {
      api_key: FAKE_KEY,
      base_url: "https://fake.example.com/v1",
      model: "gpt-4o"
    }
  });
  if (saveStatus === 200) pass("save-secrets accepts fake key");
  else fail("save-secrets", `status=${saveStatus}`);

  // Verify secrets-status shows key_present
  const { data: statusData } = await api("GET", "/settings/secrets-status");
  if (statusData?.ikuncode?.key_present) pass("secrets-status shows key_present");
  else fail("secrets-status key_present");

  // Clear the key using the correct provider name
  const { status: clearStatus } = await api("POST", "/settings/clear-secret", { provider: "ikuncode" });
  if (clearStatus === 200) pass("clear-secret works");
  else fail("clear-secret", `status=${clearStatus}`);
}

async function testLocalSettingsReadable() {
  const { status, data } = await api("GET", "/settings");
  if (status === 200 && data?.settings) pass("local-settings readable");
  else fail("local-settings readable", `status=${status}`);
}

async function testCreateDemoJob(): Promise<string | null> {
  const { status, data } = await api("POST", "/jobs/demo");
  if (status === 202 && data?.job?.job_id) {
    pass("create demo job", `job_id=${data.job.job_id}`);
    return data.job.job_id;
  }
  fail("create demo job", `status=${status}`);
  return null;
}

async function waitForJob(jobId: string, maxWaitMs = 120000, targetStages?: string[]): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { data } = await api("GET", `/jobs/${jobId}`);
    const stage = data?.job?.stage;
    const status = data?.job?.status;
    if (targetStages) {
      if (targetStages.includes(stage) || targetStages.includes(status)) return true;
    } else {
      if (status === "completed" || status === "failed" || stage === "awaiting_storyboard_review" || stage === "awaiting_render_confirm") {
        return true;
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function waitForStoryboardManifest(jobId: string, maxWaitMs = 180000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { status, data } = await api("GET", `/jobs/${jobId}/manifest`);
    if (status === 200 && Array.isArray(data?.scenes) && data.scenes.length > 0) return true;

    const { data: jobData } = await api("GET", `/jobs/${jobId}`);
    if (jobData?.job?.status === "failed") return false;

    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function approveStage(jobId: string, stage: string) {
  const { status, data } = await api("POST", `/jobs/${jobId}/approve/${stage}`, { action: "approve" });
  if (status === 200 && data?.ok) pass(`approve ${stage}`);
  else fail(`approve ${stage}`, `status=${status}`);
}

async function testStoryboardGenerated(jobId: string) {
  const { status, data } = await api("GET", `/jobs/${jobId}/manifest`);
  if (status === 200 && Array.isArray(data?.scenes) && data.scenes.length > 0) {
    pass("storyboard generated", `${data.scenes.length} scenes`);
    return data.scenes;
  }
  fail("storyboard generated", `status=${status}`);
  return null;
}

async function testGenerateClip(jobId: string, sceneId: string) {
  const { status, data } = await api("POST", `/jobs/${jobId}/scenes/${sceneId}/generate-clip`, {
    provider: "local_mock_video",
    duration_sec: 6,
    auto_activate: true
  });
  if (status === 200 && data?.ok) pass("generate local_mock_video clip", `scene=${sceneId}`);
  else fail("generate local_mock_video clip", `status=${status} error=${data?.error}`);
}

async function testClipVersions(jobId: string, sceneId: string) {
  const { status, data } = await api("GET", `/jobs/${jobId}/scenes/${sceneId}/clip-versions`);
  if (status === 200 && Array.isArray(data?.clip_versions)) {
    pass("clip-versions endpoint", `count=${data.clip_versions.length}`);
    return data.clip_versions;
  }
  fail("clip-versions endpoint", `status=${status}`);
  return [];
}

async function testActivateDeactivateClip(jobId: string, sceneId: string, versionId: string) {
  // Deactivate
  const { status: deactStatus } = await api("POST", `/jobs/${jobId}/scenes/${sceneId}/clip-versions/${versionId}/deactivate`);
  if (deactStatus === 200) pass("deactivate clip");
  else fail("deactivate clip", `status=${deactStatus}`);

  // Activate
  const { status: actStatus } = await api("POST", `/jobs/${jobId}/scenes/${sceneId}/clip-versions/${versionId}/activate`);
  if (actStatus === 200) pass("activate clip");
  else fail("activate clip", `status=${actStatus}`);
}

async function testRetryClip(jobId: string, sceneId: string) {
  const { status, data } = await api("POST", `/jobs/${jobId}/scenes/${sceneId}/retry-clip`, {
    provider: "local_mock_video",
    duration_sec: 6
  });
  if (status === 200 && data?.ok) pass("retry clip");
  else fail("retry clip", `status=${status} error=${data?.error}`);
}

async function testGenerateImage(jobId: string, sceneId: string) {
  const { status, data } = await api("POST", `/jobs/${jobId}/scenes/${sceneId}/generate-image`, {
    provider: "local_card_image"
  });
  if (status === 200 && data?.ok) pass("generate local_card_image", `scene=${sceneId}`);
  else fail("generate local_card_image", `status=${status} error=${data?.error}`);
}

async function testImageVersions(jobId: string, sceneId: string) {
  const { status, data } = await api("GET", `/jobs/${jobId}/scenes/${sceneId}/image-versions`);
  if (status === 200 && Array.isArray(data?.image_versions)) {
    pass("image-versions endpoint", `count=${data.image_versions.length}`);
  } else fail("image-versions endpoint", `status=${status}`);
}

async function testImageProviders() {
  const { status, data } = await api("GET", "/image/providers");
  if (status === 200 && Array.isArray(data?.providers)) {
    const localCard = data.providers.find((p: any) => p.id === "local_card_image");
    if (localCard) pass("image providers list", `${data.providers.length} providers`);
    else fail("image providers list", "local_card_image not found");
  } else fail("image providers list", `status=${status}`);
}

async function testReorderScenes(jobId: string, scenes: any[]) {
  if (scenes.length < 2) { pass("reorder scenes (skipped, < 2 scenes)"); return; }
  const reversed = [...scenes].reverse().map(s => s.stable_scene_id);
  const { status, data } = await api("POST", `/jobs/${jobId}/scenes/reorder`, { scene_order: reversed });
  if (status === 200 && data?.ok) pass("reorder scenes");
  else fail("reorder scenes", `status=${status}`);
}

async function testSegmentManifest(jobId: string) {
  const { status, data } = await api("GET", `/jobs/${jobId}/download/segment-manifest`);
  if (status === 200) pass("segment_manifest.json exists");
  else fail("segment_manifest.json", `status=${status}`);
}

async function testClipManifest(jobId: string) {
  const { status, data } = await api("GET", `/jobs/${jobId}/clip-manifest`);
  if (status === 200 && data?.clips) pass("clip_manifest.json", `clips=${data.clips.length}`);
  else fail("clip_manifest.json", `status=${status}`);
}

async function testQaReport(jobId: string) {
  const { status, data } = await api("GET", `/jobs/${jobId}/qa`);
  if (status === 200) {
    const hasEngineering = !!data?.engineering_qa;
    const hasContent = !!data?.content_qa;
    const hasPublish = !!data?.publish_qa;
    if (hasEngineering && hasContent && hasPublish) pass("qa_report three-layer QA");
    else fail("qa_report three-layer QA", `eng=${hasEngineering} content=${hasContent} publish=${hasPublish}`);
  } else fail("qa_report", `status=${status}`);
}

async function testRenderFinal(jobId: string) {
  const { status, data } = await api("POST", `/jobs/${jobId}/render`);
  if (status === 200) pass("render final.mp4");
  else fail("render final.mp4", `status=${status} error=${data?.error}`);
}

async function testFinalMp4(jobId: string) {
  const { status } = await api("GET", `/jobs/${jobId}/download/final`);
  if (status === 200) pass("final.mp4 downloadable");
  else fail("final.mp4 downloadable", `status=${status}`);
}

async function testReviewPackageNoKey(jobId: string) {
  const { status, data } = await api("GET", `/jobs/${jobId}/download/review-package`);
  if (status === 200) {
    const json = JSON.stringify(data);
    if (json.includes(FAKE_KEY)) fail("review package no key leak", "fake key found");
    else pass("review package no key leak");
  } else fail("review package", `status=${status}`);
}

async function testExportPackageNoKey(jobId: string) {
  const { status, data } = await api("GET", `/jobs/${jobId}/download/export-package`);
  if (status === 200) {
    const json = JSON.stringify(data);
    if (json.includes(FAKE_KEY)) fail("export package no key leak", "fake key found");
    else pass("export package no key leak");
  } else fail("export package", `status=${status}`);
}

async function testLlmCallsRedacted(jobId: string) {
  const { status, data } = await api("GET", `/jobs/${jobId}/download/llm-calls-redacted`);
  if (status === 200) {
    const json = JSON.stringify(data);
    if (json.includes(FAKE_KEY)) fail("llm-calls-redacted no leak", "fake key found");
    else pass("llm-calls-redacted no leak");
  } else fail("llm-calls-redacted", `status=${status}`);
}

async function testDeprecatedEndpoints() {
  // Old /settings/api-key/clear should still work
  const { status } = await api("POST", "/settings/api-key/clear");
  if (status === 200) pass("deprecated /settings/api-key/clear still works");
  else fail("deprecated /settings/api-key/clear", `status=${status}`);
}

// --- Main ---

async function main() {
  console.log("=== Smoke Test: Phase Stable ===\n");

  // 1. Health
  await testHealth();

  // 2. Settings & Secrets
  await testSecretsStatus();
  await testLocalSettingsReadable();
  await testSaveAndClearSecret();
  await testDeprecatedEndpoints();

  // 3. Image providers
  await testImageProviders();

  // 4. Create demo job
  const jobId = await testCreateDemoJob();
  if (!jobId) {
    console.error("\nCannot continue without a job. Aborting.");
    printSummary();
    process.exit(1);
  }

  // Wait for job to reach storyboard review stage
  console.log("  ... waiting for storyboard ...");
  const reachedStoryboard = await waitForStoryboardManifest(jobId, 180000);
  if (!reachedStoryboard) {
    console.error("\nJob did not produce storyboard manifest in time.");
  }

  // 5. Storyboard
  const scenes = await testStoryboardGenerated(jobId);

  // Approve storyboard to let job continue to assets/render/qa
  if (scenes) {
    // Check if job is waiting for approval (review mode)
    const { data: preApproveJob } = await api("GET", `/jobs/${jobId}`);
    if (preApproveJob?.job?.stage === "awaiting_storyboard_review") {
      await approveStage(jobId, "awaiting_storyboard_review");
      console.log("  ... waiting for job to complete ...");
      // v0.2.4: bump to 360s. Windows ffmpeg muxing + 2-3 scenes of edge_tts
      // + subtitle burn-in can take 3-4 minutes on a cold cache, which
      // previously timed out at 180s and failed the 'job completed' check.
      const completed = await waitForJob(jobId, 360000, ["completed", "failed"]);
      if (!completed) {
        console.error("\nJob did not complete in time after approval.");
      }
    } else if (preApproveJob?.job?.status !== "completed" && preApproveJob?.job?.status !== "failed") {
      console.log("  ... waiting for auto job to complete ...");
      const completed = await waitForJob(jobId, 360000, ["completed", "failed"]);
      if (!completed) {
        console.error("\nJob did not complete in time after storyboard.");
      }
    }
    // Verify job completed
    const { data: jobData } = await api("GET", `/jobs/${jobId}`);
    if (jobData?.job?.status === "completed") pass("job completed");
    else fail("job completed", `status=${jobData?.job?.status}, stage=${jobData?.job?.stage}`);
  }

  // 6. Generate clip on first scene
  if (scenes && scenes.length > 0) {
    const sceneId = scenes[0].stable_scene_id;
    await testGenerateClip(jobId, sceneId);

    // 7. Clip versions
    const clipVersions = await testClipVersions(jobId, sceneId);
    if (clipVersions.length > 0) {
      await testActivateDeactivateClip(jobId, sceneId, clipVersions[0].version_id);
    }

    // 8. Retry clip
    await testRetryClip(jobId, sceneId);

    // 9. Generate image
    await testGenerateImage(jobId, sceneId);
    await testImageVersions(jobId, sceneId);

    // 10. Reorder
    await testReorderScenes(jobId, scenes);
  }

  // 11. Manifests
  await testSegmentManifest(jobId);
  await testClipManifest(jobId);

  // 12. Render
  await testRenderFinal(jobId);

  // 13. QA report
  await testQaReport(jobId);

  // 14. Final mp4
  await testFinalMp4(jobId);

  // 15. Security: packages don't leak keys
  await testReviewPackageNoKey(jobId);
  await testExportPackageNoKey(jobId);
  await testLlmCallsRedacted(jobId);

  printSummary();
}

function printSummary() {
  console.log("\n=== Summary ===");
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`  Total: ${results.length}  Passed: ${passed}  Failed: ${failed}`);

  if (failed > 0) {
    console.log("\n  Failed tests:");
    for (const r of results.filter(r => !r.ok)) {
      console.log(`    - ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
    }
    process.exit(1);
  } else {
    console.log("\n  All tests passed!");
    process.exit(0);
  }
}

main().catch((error) => {
  console.error("Smoke test crashed:", error);
  process.exit(1);
});
