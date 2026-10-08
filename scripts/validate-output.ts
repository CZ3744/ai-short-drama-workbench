import fs from "node:fs/promises";
import path from "node:path";
import { outputsRoot, pathExists, writeJson, type QaReport } from "../packages/core/src/index";
import { engineeringValidation, summarizeQaStatus } from "../apps/server/src/jobs/qa";

export async function validateJobOutput(jobId?: string) {
  const resolvedJobId = jobId ?? (await latestJobId());
  if (!resolvedJobId) throw new Error("No job found under outputs/");

  const validation = await engineeringValidation(resolvedJobId);
  const status = summarizeQaStatus(validation.checks);
  const reportPath = path.join(outputsRoot, resolvedJobId, "qa", "qa_report.json");
  let report: QaReport;
  if (await pathExists(reportPath)) {
    report = JSON.parse(await fs.readFile(reportPath, "utf8")) as QaReport;
    report.checks = validation.checks;
    report.ffprobe = validation.ffprobe;
    report.llm_mode = validation.llmMode;
    report.subtitle_mode = validation.subtitleMode;
    report.audio_mode = validation.audioMode;
    report.render_audio_source = validation.renderAudioSource;
    report.burned_subtitles = validation.burnedSubtitles;
    report.status = worstStatus(status, report.llm_review?.status as QaReport["status"] | undefined);
    report.summary = report.status === "pass" ? "Output passed automated validation." : "Output completed with warnings or failures. See checks.";
  } else {
    report = {
      job_id: resolvedJobId,
      created_at: new Date().toISOString(),
      status,
      summary: status === "pass" ? "Output passed automated validation." : "Output completed with warnings or failures. See checks.",
      checks: validation.checks,
      ffprobe: validation.ffprobe,
      llm_mode: validation.llmMode,
      subtitle_mode: validation.subtitleMode,
      audio_mode: validation.audioMode,
      render_audio_source: validation.renderAudioSource,
      burned_subtitles: validation.burnedSubtitles
    };
  }
  await writeJson(reportPath, report);
  const summary = {
    job_id: resolvedJobId,
    status: report.status,
    total_checks: report.checks.length,
    failed: report.checks.filter((check) => check.status === "fail").length,
    warnings: report.checks.filter((check) => check.status === "warning").length,
    llm_mode: report.llm_mode,
    subtitle_mode: report.subtitle_mode,
    audio_mode: report.audio_mode,
    render_audio_source: report.render_audio_source,
    burned_subtitles: report.burned_subtitles,
    ffprobe: report.ffprobe
  };
  return { report, summary };
}

async function latestJobId() {
  if (!(await pathExists(outputsRoot))) return null;
  const entries = await fs.readdir(outputsRoot, { withFileTypes: true });
  const jobs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("job_")).map((entry) => entry.name).sort().reverse();
  return jobs[0] ?? null;
}

function worstStatus(a: QaReport["status"], b?: QaReport["status"]): QaReport["status"] {
  if (a === "fail" || b === "fail") return "fail";
  if (a === "warning" || b === "warning") return "warning";
  return "pass";
}

if (process.argv[1]?.endsWith("validate-output.ts")) {
  validateJobOutput(process.argv[2])
    .then((result) => {
      console.log(JSON.stringify(result.summary, null, 2));
      if (result.summary.failed > 0) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
