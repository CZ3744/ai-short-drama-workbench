import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { handleStudioWebIdentity } from "../../../../scripts/studio-web-identity";

const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
function runPowerShell(body: string) {
  const source = `$ErrorActionPreference = 'Stop'\n. ${psLiteral(path.join(process.cwd(), "studio-common.ps1"))}\n${body}`;
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
    windowsHide: true, encoding: "utf8", timeout: 15000,
  }).trim();
}

describe("silent launcher contracts", () => {
  it("serves a local identity with only the app, service and process ID", async () => {
    const server = createServer((req, res) => handleStudioWebIdentity(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/__studio_identity`;
    try {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { app: "video-generate", service: "web", pid: process.pid });
      assert.equal((await fetch(url, { method: "POST" })).status, 405);
      assert.equal((await fetch(`${url}-other`)).status, 404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

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

  it("uses a verified local identity only when the listener inventory is unavailable", { skip: process.platform !== "win32" }, () => {
    const output = runPowerShell(String.raw`
      $script:owner = $null
      $script:process = [pscustomobject]@{ ProcessId = 54321; CommandLine = ${psLiteral(`node "${path.join(process.cwd(), "node_modules/vite/bin/vite.js")}"`)} }
      $script:identity = '{"app":"video-generate","service":"web","pid":54321}'
      $script:html = '<meta name="application-name" content="video-generate">'
      $script:filters = @()
      $script:requests = 0
      function Get-StudioPortOwner { param($Port); return $script:owner }
      function Get-CimInstance { param($ClassName, $Filter, $ErrorAction); $script:filters += $Filter; return $script:process }
      function Invoke-WebRequest {
        param($Uri, [switch]$UseBasicParsing, $TimeoutSec, $ErrorAction)
        $script:requests++
        $content = if ($Uri.EndsWith('/__studio_identity')) { $script:identity } else { $script:html }
        return [pscustomobject]@{ StatusCode = 200; Content = $content }
      }
      $ready = Test-StudioWeb
      $script:html = '<html>Wrong app</html>'
      $wrongDocument = Test-StudioWeb
      $script:html = '<meta name="application-name" content="video-generate">'
      $script:process = [pscustomobject]@{ CommandLine = 'node C:\Other\node_modules\vite\bin\vite.js' }
      $foreignProcess = Test-StudioWeb
      $script:process = $null
      $missingProcess = Test-StudioWeb
      $script:identity = '{"app":"other-app","service":"web","pid":54321}'
      $wrongApp = Test-StudioWeb
      $script:identity = '{"app":"video-generate","service":"api","pid":54321}'
      $wrongService = Test-StudioWeb
      $script:identity = '{"app":"video-generate","service":"web","pid":"54321 OR 1=1"}'
      $badPid = Test-StudioWeb
      $script:identity = '{"app":"video-generate","service":"web","pid":0}'
      $zeroPid = Test-StudioWeb
      $script:identity = 'not-json'
      $badJson = Test-StudioWeb
      $script:owner = [pscustomobject]@{ CommandLine = 'node C:\Other\node_modules\vite\bin\vite.js' }
      $beforeForeign = $script:requests
      $foreignListener = Test-StudioWeb
      @{ ready = $ready; wrongDocument = $wrongDocument; foreignProcess = $foreignProcess; missingProcess = $missingProcess; wrongApp = $wrongApp; wrongService = $wrongService; badPid = $badPid; zeroPid = $zeroPid; badJson = $badJson; foreignListener = $foreignListener; foreignRequests = ($script:requests - $beforeForeign); filters = $script:filters } | ConvertTo-Json -Compress
    `);
    assert.deepEqual(JSON.parse(output), {
      ready: true, wrongDocument: false, foreignProcess: false, missingProcess: false,
      wrongApp: false, wrongService: false, badPid: false, zeroPid: false, badJson: false,
      foreignListener: false, foreignRequests: 0,
      filters: Array(4).fill("ProcessId=54321"),
    });
  });
});
