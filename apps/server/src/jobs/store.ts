import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  ensureDir,
  jobDir,
  jobPath,
  jobSubdirs,
  outputsRoot,
  pathExists,
  readJson,
  resolveVideoFormat,
  safeFileName,
  writeJson,
  type CreateJobInput,
  type JobRecord,
  type JobStage,
} from "../../../../packages/core/src/index";

export async function initializeJob(input: CreateJobInput): Promise<{ record: JobRecord; sourcePath: string }> {
  const jobId = `job_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${crypto.randomUUID().slice(0, 12)}`;
  const root = jobDir(jobId);
  await ensureDir(root);
  await Promise.all(jobSubdirs.map((dir) => ensureDir(path.join(root, dir))));
  const ext = input.filename?.toLowerCase().endsWith(".txt") ? ".txt" : ".md";
  const sourcePath = jobPath(jobId, "input", `source${ext}`);
  await fs.writeFile(sourcePath, input.scriptText, "utf8");
  const now = new Date().toISOString();
  const record: JobRecord = {
    job_id: jobId,
    created_at: now,
    updated_at: now,
    stage: "created",
    progress: 0,
    status: "queued",
    style: input.style,
    visual_strategy: input.visualStrategy,
    video_style: input.videoStyle || "knowledge_card",
    generation_mode: input.generationMode || "review",
    aspect_ratio: resolveVideoFormat({ resolution: input.resolution, aspectRatio: input.aspectRatio }).aspectRatio,
    resolution: resolveVideoFormat({ resolution: input.resolution, aspectRatio: input.aspectRatio }).resolution,
    source_filename: safeFileName(input.filename || `source${ext}`),
    output_dir: root,
    fallback_count: 0,
    agents: {
      "Script Understanding Agent": "pending",
      "Scene Planner Agent": "pending",
      "Visual Director Agent": "pending",
      "Metadata Agent": "pending",
      "Revision Agent": "pending",
      "QA Agent": "pending"
    },
    approvals: {}
  };
  await saveJob(record);
  return { record, sourcePath };
}

export async function saveJob(record: JobRecord) {
  record.updated_at = new Date().toISOString();
  await writeJson(path.join(record.output_dir, "job.json"), record);
}

export async function readJob(jobId: string): Promise<JobRecord | null> {
  const file = path.join(jobDir(jobId), "job.json");
  if (!(await pathExists(file))) return null;
  return readJson<JobRecord>(file);
}

export async function listJobs(): Promise<JobRecord[]> {
  await ensureDir(outputsRoot);
  const entries = await fs.readdir(outputsRoot, { withFileTypes: true });
  // v0.2.4: parallelize per-job reads. With 50+ jobs on disk the serial loop
  // took seconds and the job history chip bar blocked the first paint.
  const jobs = (await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("job_"))
      .map((entry) => readJob(entry.name).catch((e) => { console.warn("[store] listJobs readJob failed:", (e as Error)?.message ?? e); return null; }))
  )).filter((j): j is JobRecord => j !== null);
  return jobs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function readJobLog(jobId: string) {
  const file = jobPath(jobId, "logs", "job.log");
  if (!(await pathExists(file))) return "";
  return fs.readFile(file, "utf8");
}

export async function readLlmLog(jobId: string) {
  const file = jobPath(jobId, "logs", "llm_calls.jsonl");
  if (!(await pathExists(file))) return "";
  return fs.readFile(file, "utf8");
}

export async function updateJobApproval(
  jobId: string,
  stage: string,
  action: "approve" | "reject" | "edit",
  edits?: Record<string, any>
) {
  const job = await readJob(jobId);
  if (!job) throw new Error("Job not found");

  if (action === "edit") {
    throw Object.assign(
      new Error("Edit approval is not implemented. Please edit scenes in storyboard workspace, then approve."),
      { status: 501 }
    );
  }

  if (!job.approvals) {
    job.approvals = {};
  }

  job.approvals[stage] = action === "approve" ? "approved" : "rejected";

  // 根据动作更新状态
  if (action === "approve") {
    // 继续下一个阶段
    const nextStage = getNextStage(stage);
    if (nextStage) {
      job.stage = nextStage;
      job.status = "running";
    }
  } else if (action === "reject") {
    // 返回上一个阶段或保持当前阶段
    job.status = "awaiting_approval";
  }

  await saveJob(job);
  return job;
}

export async function continueJob(jobId: string) {
  const job = await readJob(jobId);
  if (!job) throw new Error("Job not found");

  const nextStage = getNextStage(job.stage);
  if (nextStage) {
    job.stage = nextStage;
    job.status = "running";
    await saveJob(job);
  }

  return job;
}

function getNextStage(currentStage: string): JobStage | null {
  const stageOrder: JobStage[] = [
    "document_parsing",
    "awaiting_document_review",
    "script_understanding",
    "awaiting_script_review",
    "scene_planning",
    "awaiting_storyboard_review",
    "visual_direction",
    "awaiting_visual_review",
    "metadata",
    "assets",
    "subtitles",
    "audio",
    "render",
    "awaiting_render_confirm",
    "qa",
    "completed",
  ];

  const currentIndex = stageOrder.indexOf(currentStage as JobStage);
  if (currentIndex === -1 || currentIndex >= stageOrder.length - 1) return null;
  return stageOrder[currentIndex + 1];
}

/**
 * v0.2.4: On server startup, scan all existing jobs for orphaned
 * `scene.clip_generation_status === "generating"` entries whose writer
 * process died (crash, Ctrl-C, OOM). Flip those to "failed" so the user
 * can retry or fall back without restarting the server.
 *
 * Safety: only reset scenes that have been in "generating" for > 30 minutes
 * (generous upper bound for real-video tasks) to avoid racing with a
 * legitimately long-running task from a separate process.
 */
export async function reconcileOrphanedGeneratingScenes(): Promise<{ jobsScanned: number; scenesRecovered: number }> {
  const jobs = await listJobs();
  let scenesRecovered = 0;
  const ORPHAN_THRESHOLD_MS = 30 * 60 * 1000;
  const now = Date.now();
  for (const job of jobs) {
    try {
      const manifestPath = path.join(job.output_dir, "manifests", "scene_manifest.json");
      if (!(await pathExists(manifestPath))) continue;
      const manifest = await readJson<any>(manifestPath);
      if (!Array.isArray(manifest?.scenes)) continue;
      let dirty = false;
      for (const scene of manifest.scenes) {
        if (scene.clip_generation_status !== "generating") continue;
        const updatedAt = scene.updated_at ? Date.parse(scene.updated_at) : 0;
        if (!updatedAt || Number.isNaN(updatedAt)) {
          scene.clip_generation_status = "failed";
          dirty = true;
          scenesRecovered++;
          continue;
        }
        if (now - updatedAt >= ORPHAN_THRESHOLD_MS) {
          scene.clip_generation_status = "failed";
          dirty = true;
          scenesRecovered++;
        }
      }
      if (dirty) {
        manifest.updated_at = new Date().toISOString();
        await writeJson(manifestPath, manifest);
      }
    } catch {
      /* per-job reconciliation is best-effort */
    }
  }
  return { jobsScanned: jobs.length, scenesRecovered };
}
