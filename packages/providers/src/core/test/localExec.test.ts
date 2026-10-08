// P25: Tests for runPythonScript — mock child_process

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Use real python if available; tests that need a real spawn use this.
const PYTHON_EXE = "C:\\Users\\example\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";

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

  it("allows shell metacharacters in args (shell:false makes them safe)", async () => {
    const { runPythonScript } = await import("../localExec");

    // Real python will fail on the nonexistent script, but the metachar args
    // should pass validation. shell:false prevents any injection.
    const result = await runPythonScript({
      python_path: PYTHON_EXE,
      script_path: "nonexistent_script.py",
      args: ["hello & del /f", "foo | bar", 'foo > output.txt', 'prompt with "quotes"'],
      timeout_ms: 10000,
    });

    // python will fail (script not found), but NOT a validation error
    assert.notEqual(result.exit_code, 0);
    assert.ok(!result.stderr.includes("null byte"), "Should not get validation error for metachars");
  });

  it("captures stdout, stderr, exit_code, and duration_ms", async () => {
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

  it("captures non-zero exit code", async () => {
    const { runPythonScript } = await import("../localExec");

    const result = await runPythonScript({
      python_path: PYTHON_EXE,
      script_path: "-c",
      args: ["import sys; sys.exit(42)"],
      timeout_ms: 10000,
    });

    assert.equal(result.exit_code, 42);
  });

  it("captures stderr output", async () => {
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

  it("on_stdout callback receives lines", async () => {
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

  it("timeout kills long-running process", async () => {
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
