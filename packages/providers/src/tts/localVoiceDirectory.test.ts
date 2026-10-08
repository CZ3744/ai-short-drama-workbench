import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { OpenClawLocalTtsProvider } from "./openclawLocalTtsProvider";
import type { PresetOption } from "../../../core/src/presetSchema";

test("local voice packs belong to the configured installation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-voices-"));
  try {
    const pack = path.join(root, "voices", "narrator");
    await fs.mkdir(pack, { recursive: true });
    for (const file of ["gpt.ckpt", "sovits.pth", "ref.wav"]) await fs.writeFile(path.join(pack, file), "fixture");
    const provider = new OpenClawLocalTtsProvider({ id: "test", executor: { engine: "gpt_sovits", voices_dir: path.join(root, "voices") } } as unknown as PresetOption, null);
    assert.equal((await provider.listVoices())[0]?.id, "narrator");
    const unconfigured = new OpenClawLocalTtsProvider({ id: "test", executor: { engine: "gpt_sovits" } } as unknown as PresetOption, null);
    assert.deepEqual(await unconfigured.listVoices(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
