// Real local Python subprocess contracts; no provider calls or machine-specific paths.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function findPython(): string | undefined {
  const candidates = [process.env.VIDEO_GENERATE_TEST_PYTHON, process.env.PYTHON, process.env.PYTHON_PATH, "python", "python3"];
  for (const candidate of [...new Set(candidates.filter((value): value is string => Boolean(value)))]) {
    const result = spawnSync(candidate, ["-I", "-S", "-c", "import sys; print('video-generate-python-ok')"], {
      encoding: "utf8", windowsHide: true, timeout: 5000,
    });
    if (result.status === 0 && result.stdout.trim() === "video-generate-python-ok") return candidate;
  }
  return undefined;
}
const availablePython = findPython();
const PYTHON_EXE = availablePython ?? "python";
const pythonRequired = { skip: availablePython ? false : "No runnable Python on PATH; set VIDEO_GENERATE_TEST_PYTHON to an interpreter" };

describe("runPythonScript", () => {
  it("rejects python_path with disallowed basename", async () => {
    const { runPythonScript } = await import("../localExec");

    await assert.rejects(
      () => runPythonScript({
        python_path: "C:\\evil\\notepad.exe",
        script_path: "test.py",
        args: [],
      }),
      (err: Error) => {
        assert.ok(err.message.includes("Rejected python_path"));
        assert.ok(err.message.includes("notepad.exe"));
        return true;
      }
    );
  });

  it("rejects args containing null bytes", async () => {
    const { runPythonScript } = await import("../localExec");

    await assert.rejects(
      () => runPythonScript({
        python_path: PYTHON_EXE,
        script_path: "test.py",
        args: ["hello\0world"],
      }),
      (err: Error) => {
        assert.ok(err.message.includes("Rejected arg"));
        assert.ok(err.message.includes("null byte"));
        return true;
      }
    );
  });

  it("handles pre-aborted signal without spawning", async () => {
    const { runPythonScript } = await import("../localExec");

    const controller = new AbortController();
    controller.abort();

    const result = await runPythonScript({
      python_path: PYTHON_EXE,
      script_path: "test.py",
      args: [],
      signal: controller.signal,
    });

    assert.equal(result.exit_code, -1);
    assert.ok(result.stderr.includes("aborted"));
    assert.ok(result.duration_ms < 100);
  });

  it("allows shell metacharacters in args (shell:false makes them safe)", pythonRequired, async () => {
    const { runPythonScript } = await import("../localExec");

    const args = ["hello & del /f", "foo | bar", 'foo > output.txt', 'prompt with "quotes"'];
    const result = await runPythonScript({
      python_path: PYTHON_EXE,
      script_path: "-c",
      args: ["import sys, json; print(json.dumps(sys.argv[1:]))", ...args],
      timeout_ms: 10000,
    });

    assert.equal(result.exit_code, 0);
    assert.deepEqual(JSON.parse(result.stdout), args, "shell metacharacters must reach Python as literal arguments");
  });

  it("captures stdout, stderr, exit_code, and duration_ms", pythonRequired, async () => {
    const { runPythonScript } = await import("../localExec");

    const result = await runPythonScript({
      python_path: PYTHON_EXE,
      script_path: "-c",
      args: ["import sys; print('hello'); sys.exit(0)"],
      timeout_ms: 10000,
    });

    assert.equal(result.exit_code, 0);
    assert.ok(result.stdout.includes("hello"));
    assert.ok(typeof result.stderr === "string");
    assert.ok(typeof result.duration_ms === "number");
    assert.ok(result.duration_ms >= 0);
    assert.ok(result.duration_ms < 10000);
  });

  it("captures non-zero exit code", pythonRequired, async () => {
    const { runPythonScript } = await import("../localExec");

    const result = await runPythonScript({
      python_path: PYTHON_EXE,
      script_path: "-c",
      args: ["import sys; sys.exit(42)"],
      timeout_ms: 10000,
    });

    assert.equal(result.exit_code, 42);
  });

  it("captures stderr output", pythonRequired, async () => {
    const { runPythonScript } = await import("../localExec");

    const result = await runPythonScript({
      python_path: PYTHON_EXE,
      script_path: "-c",
      args: ["import sys; sys.stderr.write('error output\\n')"],
      timeout_ms: 10000,
    });

    assert.equal(result.exit_code, 0);
    assert.ok(result.stderr.includes("error output"));
  });

  it("on_stdout callback receives lines", pythonRequired, async () => {
    const { runPythonScript } = await import("../localExec");
    const lines: string[] = [];

    const result = await runPythonScript({
      python_path: PYTHON_EXE,
      script_path: "-c",
      args: ["print('line1'); print('line2')"],
      timeout_ms: 10000,
      on_stdout: (line) => lines.push(line.trim()), // trim \r from Windows Python
    });

    assert.equal(result.exit_code, 0);
    assert.ok(lines.includes("line1"), `Expected "line1" in ${JSON.stringify(lines)}`);
    assert.ok(lines.includes("line2"), `Expected "line2" in ${JSON.stringify(lines)}`);
  });

  it("timeout kills long-running process", pythonRequired, async () => {
    const { runPythonScript } = await import("../localExec");

    const result = await runPythonScript({
      python_path: PYTHON_EXE,
      script_path: "-c",
      args: ["import time; time.sleep(60)"],
      timeout_ms: 2000,
    });

    assert.equal(result.exit_code, -1);
    assert.ok(result.stderr.includes("timeout/abort") || result.stderr.includes("killed"));
    assert.ok(result.duration_ms < 10000);
  });
});
