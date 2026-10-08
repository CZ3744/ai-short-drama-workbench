import fs from "node:fs/promises";
import path from "node:path";
import { samplesRoot } from "../packages/core/src/index";
import { runJob } from "../apps/server/src/jobs/runner";
import { initializeJob } from "../apps/server/src/jobs/store";
import { validateJobOutput } from "./validate-output";

async function main() {
  const samplePath = path.join(samplesRoot, "sample_report.md");
  const scriptText = await fs.readFile(samplePath, "utf8");
  const { record, sourcePath } = await initializeJob({
    scriptText,
    filename: "sample_report.md",
    style: "Claude/iOS 质感卡片风",
    visualStrategy: "自动",
    // v0.2.4 E2E: fully automatic — no human approval gate, runs to final.mp4
    generationMode: "auto"
  });
  console.log(`Created sample job: ${record.job_id}`);
  await runJob(record.job_id, sourcePath);
  const result = await validateJobOutput(record.job_id);
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`Output: ${record.output_dir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
