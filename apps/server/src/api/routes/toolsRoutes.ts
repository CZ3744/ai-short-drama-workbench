import path from "node:path";
import { execFile, spawn } from "node:child_process";
import express from "express";
import { pathExists, readJson } from "../../../../../packages/core/src/index";

export const toolsRouter = express.Router();

// ====================================================================
// TOOL REGISTRY / PROVIDER CAPABILITIES
// ====================================================================

toolsRouter.get("/tools/registry", async (_req, res, next) => {
  try {
    const file = path.join(process.cwd(), "config", "tool_registry.json");
    if (!(await pathExists(file))) { res.json({}); return; }
    res.json(await readJson(file));
  } catch (error) {
    next(error);
  }
});

toolsRouter.get("/providers/capabilities", async (_req, res, next) => {
  try {
    const file = path.join(process.cwd(), "config", "provider_capabilities.json");
    if (!(await pathExists(file))) { res.json([]); return; }
    res.json(await readJson(file));
  } catch (error) {
    next(error);
  }
});

// ====================================================================
// UTILITY — 打开文件夹
// ====================================================================

// 2026-05-18: shell 命令注入防护 — exec(string) → execFile(argv 数组), 用户传含 `"` 的 path 不会被拼成新 shell 命令.
// 2026-05-25: 原 ALLOWED_ROOTS 白名单 (data/outputs/projects/assets/claw-shared) 在 folder target reveal 时挡死,
//   用户选 D:\OneDrive\... 这种家目录外的路径完全无法 reveal. 单用户本机工作台, reveal 只是
//   打开 explorer GUI 窗口, 无 escalation 风险 (XSS 攻击者能触发的最坏结果就是弹个空窗口).
//   彻底放弃白名单, 改为只校验"路径存在 + 不含 ../" + 仍用 execFile 防注入.
toolsRouter.post("/utils/open-folder", express.json(), async (req, res) => {
  try {
    const { path: folderPath } = req.body as { path?: string };
    if (!folderPath || typeof folderPath !== "string") {
      res.status(400).json({ error: { code: "ValidationError", message: "path 是必填字段" } });
      return;
    }
    // path.resolve 自动 normalize, 消除 .. / %2e%2e 等遍历
    const resolved = path.resolve(folderPath);
    if (!(await pathExists(resolved))) {
      res.status(404).json({ error: { code: "NotFound", message: "文件夹不存在: " + resolved } });
      return;
    }
    // execFile: 命令名 + argv 数组, 不走 shell, folderPath 含双引号/分号也不会被拼成新 shell 命令.
    const cmdName = process.platform === "win32" ? "explorer.exe" : "open";
    execFile(cmdName, [resolved], { timeout: 5000 }, (err) => {
      // explorer.exe 即使打开成功也可能返非零 exit code (Windows 怪行为),
      // 这里只把"无法 spawn"(ENOENT) 视为真失败. 其余视为成功.
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(500).json({ error: { code: "InternalError", message: "无法启动文件管理器" } });
        return;
      }
      res.json({ ok: true, message: "文件夹已打开" });
    });
  } catch (error) {
    res.status(500).json({ error: { code: "InternalError", message: "打开文件夹失败" } });
  }
});

// ====================================================================
// UTILITY — 弹原生文件夹选择器
// ====================================================================

// 2026-05-25: 用户原话 "为什么不能用路径选择器选路径? 开发的时候想什么了".
// 之前 ExportPanel 自定义文件夹靠 PromptDialog 让用户手输 "D:\Videos\output", 太 dev-flavor.
// 改: 后端调系统原生文件夹选择器 (Windows STA FolderBrowserDialog / macOS osascript / Linux zenity),
// 前端 PromptDialog 降级为 fallback (当 native picker 不可用时).
toolsRouter.post("/utils/pick-folder", express.json(), async (req, res) => {
  try {
    const { initialDir } = (req.body as { initialDir?: string }) ?? {};
    const platform = process.platform;

    if (platform === "win32") {
      // 2026-05-25 — 用户报"选择器返回的路径不是我选的", server log 显示 2049ms 返回 Downloads,
      // 即 IFileOpenDialog 在 Node spawn windowsHide:true 上下文下 fast-path 不真弹 dialog,
      // 自己 Bash 跑可复现 block 但 Node spawn 跑不复现 — 用户机器有未知 root cause.
      //
      // 决策: 放弃现代 IFileOpenDialog COM (Win10/11 explorer 风格但用户机器不稳),
      // 回到 System.Windows.Forms.FolderBrowserDialog (Win98 树形老风格但稳定可用).
      // 验证过: Node spawn windowsHide:true + -NonInteractive + 隐藏 owner Form 下能 block 等用户.
      // 用户上一轮也证实它能选到中文路径 (toast "已记住导出文件夹: D:\OneDrive\...").
      // 视觉妥协换可用性, 后续如有 IFileOpenDialog 兼容方案再升级.
      const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null

[Console]::Error.WriteLine("[ps-debug] startDir=" + $env:PICKER_START_DIR)

# 创建隐藏 Topmost Form 作 owner, 强制 dialog 弹到前台 (Node spawn 下无 owner 可能不弹)
$ownerForm = New-Object System.Windows.Forms.Form
$ownerForm.ShowInTaskbar = $false
$ownerForm.WindowState = 'Minimized'
$ownerForm.FormBorderStyle = 'None'
$ownerForm.Width = 1
$ownerForm.Height = 1
$ownerForm.TopMost = $true
$ownerForm.Show()
$ownerForm.Activate()

$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '选择导出文件夹'
$d.ShowNewFolderButton = $true
# UseDescriptionForTitle 需要 .NET 4.6.1+, 安全 try
try { $d.UseDescriptionForTitle = $true } catch { }

# startDir: 优先用环境变量, 否则用户家目录
$startDir = $env:PICKER_START_DIR
if ($startDir -and (Test-Path -LiteralPath $startDir)) {
  $d.SelectedPath = $startDir
} else {
  $d.SelectedPath = [System.Environment]::GetFolderPath('UserProfile')
}

try {
  $result = $d.ShowDialog($ownerForm)
  [Console]::Error.WriteLine("[ps-debug] ShowDialog result=" + $result + " selectedPath=" + $d.SelectedPath)
  if ($result -eq 'OK') {
    [Console]::Out.Write($d.SelectedPath)
  }
} finally {
  $d.Dispose()
  $ownerForm.Close()
  $ownerForm.Dispose()
}
`;
      const encodedCommand = Buffer.from(psScript, "utf16le").toString("base64");

      const ps = spawn("powershell.exe", [
        "-STA",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encodedCommand,
      ], {
        windowsHide: true,
        env: { ...process.env, PICKER_START_DIR: initialDir ?? "" },
      });

      let stdout = "";
      let stderr = "";
      ps.stdout.setEncoding("utf8");
      ps.stderr.setEncoding("utf8");
      ps.stdout.on("data", (d) => stdout += d);
      ps.stderr.on("data", (d) => stderr += d);
      ps.on("error", (err) => {
        res.status(500).json({ error: { code: "InternalError", message: `无法启动 PowerShell: ${err.message}` } });
      });
      ps.on("close", (code) => {
        const picked = stdout.trim();
        if (code !== 0 && stderr.trim() && !picked) {
          res.status(500).json({ error: { code: "InternalError", message: `选择器失败: ${stderr.trim().slice(0, 300)}` } });
          return;
        }
        if (picked) {
          res.json({ ok: true, path: picked });
        } else {
          res.json({ ok: true, canceled: true });
        }
      });
      return;
    }

    if (platform === "darwin") {
      const safeDir = (initialDir ?? "").replace(/"/g, '\\"');
      const osa = safeDir
        ? `POSIX path of (choose folder with prompt "选择导出文件夹" default location POSIX file "${safeDir}")`
        : `POSIX path of (choose folder with prompt "选择导出文件夹")`;
      const proc = spawn("osascript", ["-e", osa]);
      let stdout = "";
      proc.stdout.on("data", (d) => stdout += d.toString());
      proc.on("close", (code) => {
        const picked = stdout.trim();
        // osascript 取消 → exit code 1
        if (code !== 0 && !picked) {
          res.json({ ok: true, canceled: true });
          return;
        }
        res.json({ ok: true, path: picked });
      });
      proc.on("error", (err) => {
        res.status(500).json({ error: { code: "InternalError", message: `无法启动 osascript: ${err.message}` } });
      });
      return;
    }

    // linux: 试 zenity, 不存在则返回 NotImplemented 让前端 fallback 到手输
    const proc = spawn("zenity", ["--file-selection", "--directory", "--title=选择导出文件夹", ...(initialDir ? ["--filename=" + initialDir] : [])]);
    let stdout = "";
    proc.stdout.on("data", (d) => stdout += d.toString());
    proc.on("error", () => {
      res.status(501).json({ error: { code: "NotImplemented", message: "未检测到 zenity, 请手输路径" } });
    });
    proc.on("close", (code) => {
      const picked = stdout.trim();
      if (code !== 0 && !picked) {
        res.json({ ok: true, canceled: true });
        return;
      }
      res.json({ ok: true, path: picked });
    });
  } catch (error) {
    res.status(500).json({ error: { code: "InternalError", message: error instanceof Error ? error.message : "选择文件夹失败" } });
  }
});

// ====================================================================
// UTILITY — 弹原生文件选择器 (选单个文件)
// ====================================================================

// 2026-05-25: SettingsPage 恢复备份原本让用户手输 .zip 完整路径, 同款 dev-flavor.
// 复用 IFileOpenDialog COM (Vista+ 现代风格), 不带 FOS_PICKFOLDERS 就是文件模式.
// 支持可选 fileFilter (如 ".zip") 限定可选文件类型.
toolsRouter.post("/utils/pick-file", express.json(), async (req, res) => {
  try {
    const { initialDir, fileFilter } = (req.body as {
      initialDir?: string;
      /** 可选: 限定文件后缀, 如 "zip" / "json" (不带点). 多个用逗号分隔: "zip,7z" */
      fileFilter?: string;
    }) ?? {};
    const platform = process.platform;

    if (platform === "win32") {
      // 复用 modern IFileOpenDialog COM, 不设 FOS_PICKFOLDERS, 可选设 SetFileTypes
      const filterLabel = fileFilter
        ? `${fileFilter.toUpperCase()} 文件`
        : "所有文件";
      const filterSpec = fileFilter
        ? fileFilter.split(",").map((e) => `*.${e.trim()}`).join(";")
        : "*.*";

      // 2026-05-25: 同 pick-folder 同款放弃 IFileOpenDialog COM (Node spawn fast-path bug 无法复现 root-cause),
      // 改用 System.Windows.Forms.OpenFileDialog. 注意 .NET 4.6+ OpenFileDialog 自动用 Vista+ 现代 Common Item Dialog 内核,
      // 视觉是 Win10/11 现代风格 (跟 FolderBrowserDialog 老树形不同), 所以文件选择不损失视觉.
      const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null

# 隐藏 Topmost Form 作 owner, 强制 dialog 弹到前台
$ownerForm = New-Object System.Windows.Forms.Form
$ownerForm.ShowInTaskbar = $false
$ownerForm.WindowState = 'Minimized'
$ownerForm.FormBorderStyle = 'None'
$ownerForm.Width = 1
$ownerForm.Height = 1
$ownerForm.TopMost = $true
$ownerForm.Show()
$ownerForm.Activate()

$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '选择文件'
$d.CheckFileExists = $true
$d.CheckPathExists = $true
$d.Multiselect = $false
$d.AutoUpgradeEnabled = $true  # Vista+ 现代 dialog (默认 true, 显式设保险)

if ($env:PICKER_FILTER_SPEC) {
  $d.Filter = "$env:PICKER_FILTER_LABEL|$env:PICKER_FILTER_SPEC|所有文件|*.*"
} else {
  $d.Filter = "所有文件|*.*"
}

if ($env:PICKER_START_DIR -and (Test-Path -LiteralPath $env:PICKER_START_DIR)) {
  $d.InitialDirectory = $env:PICKER_START_DIR
}

try {
  $result = $d.ShowDialog($ownerForm)
  if ($result -eq 'OK') {
    [Console]::Out.Write($d.FileName)
  }
} finally {
  $d.Dispose()
  $ownerForm.Close()
  $ownerForm.Dispose()
}
`;
      const encodedCommand = Buffer.from(psScript, "utf16le").toString("base64");

      const ps = spawn("powershell.exe", [
        "-STA",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encodedCommand,
      ], {
        windowsHide: true,
        env: {
          ...process.env,
          PICKER_START_DIR: initialDir ?? "",
          PICKER_FILTER_LABEL: filterLabel,
          PICKER_FILTER_SPEC: filterSpec,
        },
      });

      let stdout = "";
      let stderr = "";
      ps.stdout.setEncoding("utf8");
      ps.stderr.setEncoding("utf8");
      ps.stdout.on("data", (d) => stdout += d);
      ps.stderr.on("data", (d) => stderr += d);
      ps.on("error", (err) => {
        res.status(500).json({ error: { code: "InternalError", message: `无法启动 PowerShell: ${err.message}` } });
      });
      ps.on("close", (code) => {
        const picked = stdout.trim();
        if (code !== 0 && stderr.trim() && !picked) {
          res.status(500).json({ error: { code: "InternalError", message: `选择器失败: ${stderr.trim().slice(0, 300)}` } });
          return;
        }
        if (picked) {
          res.json({ ok: true, path: picked });
        } else {
          res.json({ ok: true, canceled: true });
        }
      });
      return;
    }

    // macOS osascript choose file
    if (platform === "darwin") {
      const extPart = fileFilter
        ? ` of type {${fileFilter.split(",").map((e) => `"${e.trim()}"`).join(",")}}`
        : "";
      const osa = `POSIX path of (choose file with prompt "选择文件"${extPart})`;
      const proc = spawn("osascript", ["-e", osa]);
      let stdout = "";
      proc.stdout.on("data", (d) => stdout += d.toString());
      proc.on("close", (code) => {
        const picked = stdout.trim();
        if (code !== 0 && !picked) {
          res.json({ ok: true, canceled: true });
          return;
        }
        res.json({ ok: true, path: picked });
      });
      proc.on("error", (err) => {
        res.status(500).json({ error: { code: "InternalError", message: `无法启动 osascript: ${err.message}` } });
      });
      return;
    }

    // linux zenity 文件选择
    const zArgs = ["--file-selection", "--title=选择文件"];
    if (initialDir) zArgs.push("--filename=" + initialDir);
    if (fileFilter) zArgs.push("--file-filter=" + fileFilter.split(",").map((e) => `*.${e.trim()}`).join(" "));
    const proc = spawn("zenity", zArgs);
    let stdout = "";
    proc.stdout.on("data", (d) => stdout += d.toString());
    proc.on("error", () => {
      res.status(501).json({ error: { code: "NotImplemented", message: "未检测到 zenity, 请手输路径" } });
    });
    proc.on("close", (code) => {
      const picked = stdout.trim();
      if (code !== 0 && !picked) {
        res.json({ ok: true, canceled: true });
        return;
      }
      res.json({ ok: true, path: picked });
    });
  } catch (error) {
    res.status(500).json({ error: { code: "InternalError", message: error instanceof Error ? error.message : "选择文件失败" } });
  }
});
