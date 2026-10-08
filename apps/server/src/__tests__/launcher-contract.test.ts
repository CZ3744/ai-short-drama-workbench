import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { execFileSync } from "node:child_process";

const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
function runPowerShell(body: string) {
  const source = `$ErrorActionPreference = 'Stop'\n. ${psLiteral(path.join(process.cwd(), "studio-common.ps1"))}\n${body}`;
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
    windowsHide: true, encoding: "utf8", timeout: 15000,
  }).trim();
}

describe("silent launcher contracts", () => {
  it("launches absolute project children with a strict Vite port and hidden windows", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { EventEmitter } from 'node:events';
      import { pathToFileURL } from 'node:url';
      import path from 'node:path';
      const calls = [];
      cp.spawn = (file, args, options) => { calls.push({file, args, options}); return new EventEmitter(); };
      syncBuiltinESMExports();
      await import(pathToFileURL(path.join(process.cwd(), 'scripts/dev.mjs')).href);
      console.log(JSON.stringify(calls));
    `], { cwd: process.cwd(), windowsHide: true, encoding: "utf8", timeout: 10000 });
    const calls = JSON.parse(output);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.file, process.execPath);
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.cwd, process.cwd());
      assert.equal(path.isAbsolute(call.args[0]), true);
    }
    assert.ok(calls[1].args.includes("--strictPort"));
  });

  it("does not treat another listener or another checkout as its own frontend", { skip: process.platform !== "win32" }, () => {
    const output = runPowerShell(String.raw`
      $root = 'C:\Projects\Studio'
      $ours = [pscustomobject]@{ CommandLine = 'node "C:\Projects\Studio\node_modules\vite\bin\vite.js"' }
      $other = [pscustomobject]@{ CommandLine = 'node "C:\Projects\Studio-other\node_modules\vite\bin\vite.js"' }
      $server = [pscustomobject]@{ CommandLine = 'node "C:\Projects\Studio\apps\server\src\index.ts"' }
      $entry = [pscustomobject]@{ CommandLine = 'node "C:\Projects\Studio\scripts\dev.mjs"' }
      $lookalike = [pscustomobject]@{ CommandLine = 'node "C:\Projects\Studio\scripts\dev.mjs-other"' }
      @{ ours = (Test-StudioWebProcess $ours $root); other = (Test-StudioWebProcess $other $root); server = (Test-StudioWebProcess $server $root); entry = (Test-StudioDevEntryProcess $entry $root); lookalike = (Test-StudioDevEntryProcess $lookalike $root) } | ConvertTo-Json -Compress
    `);
    assert.deepEqual(JSON.parse(output), { ours: true, other: false, server: false, entry: true, lookalike: false });
  });

  it("requires a served studio document as well as an owned Vite listener", { skip: process.platform !== "win32" }, () => {
    const root = process.cwd();
    const output = runPowerShell(String.raw`
      $script:owner = [pscustomobject]@{ CommandLine = ${psLiteral(`node "${path.join(root, "node_modules/vite/bin/vite.js")}"`)} }
      $script:html = '<html><meta name="application-name" content="video-generate"></html>'
      $script:requests = 0
      function Get-StudioPortOwner { param($Port); return $script:owner }
      function Invoke-WebRequest { param($Uri, [switch]$UseBasicParsing, $TimeoutSec, $ErrorAction); $script:requests++; return [pscustomobject]@{ StatusCode = 200; Content = $script:html } }
      $ready = Test-StudioWeb
      $script:html = '<html>Another app</html>'
      $wrongDocument = Test-StudioWeb
      $script:owner = [pscustomobject]@{ CommandLine = 'node C:\Other\node_modules\vite\bin\vite.js' }
      $foreign = Test-StudioWeb
      @{ ready = $ready; wrongDocument = $wrongDocument; foreign = $foreign; requests = $script:requests } | ConvertTo-Json -Compress
    `);
    assert.deepEqual(JSON.parse(output), { ready: true, wrongDocument: false, foreign: false, requests: 2 });
  });

  it("passes a path containing spaces and apostrophes literally to hidden Node", { skip: process.platform !== "win32" }, () => {
    const root = "C:\\Projects\\O'Brien\\My Studio";
    const output = runPowerShell(`
      function Test-Path { param($LiteralPath, $PathType); return $true }
      function Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)
        @{ file = $FilePath; args = $ArgumentList; cwd = $WorkingDirectory; window = $WindowStyle; stdout = $RedirectStandardOutput; stderr = $RedirectStandardError } | ConvertTo-Json -Compress
      }
      Start-StudioDevProcess -RepoRoot ${psLiteral(root)} -LogPath ${psLiteral(`${root}\\dev.log`)} -ErrorLogPath ${psLiteral(`${root}\\dev.stderr.log`)}
    `);
    const launch = JSON.parse(output);
    assert.match(launch.file, /node\.exe$/i);
    assert.equal(launch.args, `"${path.join(root, "scripts/dev.mjs")}"`);
    assert.equal(launch.cwd, root);
    assert.equal(launch.window, "Hidden");
    assert.notEqual(launch.stdout, launch.stderr);
  });
});
