# AI 短剧工作台 — 启停脚本公用逻辑 (start-studio.ps1 / stop-studio.ps1 共用)
#
# 为什么单独抽一个文件: "后端端口上坐着的到底是不是我们自己" 这个判断,
# 启动器和停止器必须用同一套标准 —— 启动器靠它认出端口被外人占了要报警,
# 停止器靠它决定哪些进程碰都不能碰。两边各写一份, 迟早各说各话。

# 后端端口 2026-07-22 从 8787 改成 8788, 别改回去:
# 用户机器上的 codexpro (codexpro start --root C:/Projects/video-studio) 常驻 8787。两边撞港时
# Windows 不会报 EADDRINUSE, 而是让后来的照样"绑定成功", 请求却被先到的那个接走 ——
# 于是页面能开、后端日志也说 listening, 但每个接口都被 codexpro 回 401。
# 换个端口是让两个程序能同时开着的最省事办法。
$StudioApiPort = 8788
$StudioWebPort = 5173

# 把一个进程翻译成人能看懂的名字。
# node.exe 这种壳程序光看进程名等于没看, 得从命令行里把真正的包名/脚本名捞出来。
function Get-StudioProcessLabel {
    param($Process)
    if (-not $Process) { return "未知程序" }

    $label = [string]$Process.Name
    $cl    = [string]$Process.CommandLine
    if ($cl -match 'node_modules[\\/]([^\\/"]+)[\\/]') {
        $label = $Matches[1]
    } elseif ($cl -match '([^\\/"\s]+\.(?:js|mjs|cjs|ts|exe))(?:\s|"|$)') {
        $label = $Matches[1]
    }
    return "$label (PID $($Process.ProcessId))"
}

# 谁在监听这个端口? 返回进程对象, 没人监听返回 $null。
function Get-StudioPortOwner {
    param([int]$Port)
    $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($id in $owners) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        if ($proc) { return $proc }
    }
    return $null
}

# 后端到底是不是"我们的"后端。
# 光看端口通不通是不够的 —— 2026-07-22 的真实故障就是端口通, 但接电话的是别的程序,
# 所有接口一律返回 401, 页面能开却全线报错。所以必须验明正身: /healthz 得答出我们自己的 ok:true。
# 返回 ours / foreign / down 三态。
# (这里的 -TimeoutSec 是等本机子进程启动就绪的探针, 不是业务网络请求, 与"严禁本地主动 timeout"铁律无关。)
function Test-StudioBackend {
    param([int]$Port = $StudioApiPort)
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    } catch {
        # 有人应答但不是 200 (比如别的程序回 401) => 端口被外人占了
        $answered = $false
        try { if ($null -ne $_.Exception.Response) { $answered = $true } } catch { }
        if ($answered) { return "foreign" }
        return "down"
    }
    if ($resp.StatusCode -eq 200 -and $resp.Content -match '"ok"\s*:\s*true') { return "ours" }
    return "foreign"
}

# A port owned by another app is not a ready studio frontend.
function Test-StudioWebProcess {
    param($Process, [string]$RepoRoot = $PSScriptRoot)
    if (-not $Process -or -not $Process.CommandLine) { return $false }
    $repoPattern = [regex]::Escape($RepoRoot.TrimEnd('\', '/'))
    return [bool]($Process.CommandLine -match ($repoPattern + '[\\/]node_modules[\\/](?:\.bin[\\/]\.\.[\\/])?vite[\\/]'))
}

function Test-StudioDevEntryProcess {
    param($Process, [string]$RepoRoot = $PSScriptRoot)
    if (-not $Process -or -not $Process.CommandLine) { return $false }
    $repoPattern = [regex]::Escape($RepoRoot.TrimEnd('\', '/'))
    return [bool]($Process.CommandLine -match ($repoPattern + '[\\/]scripts[\\/]dev\.mjs(?:"|\s|$)'))
}

# Verify both ownership and the actual frontend document before opening a browser.
function Test-StudioWeb {
    param([int]$Port = $StudioWebPort)
    $owner = Get-StudioPortOwner -Port $Port
    if (-not $owner) {
        # Some Windows environments omit live listeners from the TCP inventory.
        # An HTTP 200 alone is still not ownership: resolve the local identity PID
        # back to the exact checkout's Vite command line before trusting its HTML.
        try {
            $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/__studio_identity" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($probe.StatusCode -ne 200) { return $false }
            $identity = $probe.Content | ConvertFrom-Json -ErrorAction Stop
            if ($identity.app -ne 'video-generate' -or $identity.service -ne 'web') { return $false }
            [long]$identityProcessId = 0
            if (-not [long]::TryParse([string]$identity.pid, [ref]$identityProcessId) -or $identityProcessId -le 0 -or $identityProcessId -gt [int]::MaxValue) { return $false }
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$identityProcessId" -ErrorAction Stop
        } catch { return $false }
    }
    if (-not (Test-StudioWebProcess $owner)) { return $false }
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return [bool]($resp.StatusCode -eq 200 -and $resp.Content.Contains('name="application-name" content="video-generate"'))
    } catch { return $false }
}

# Launch Node directly: no shell interpolation, including paths containing spaces or apostrophes.
function Start-StudioDevProcess {
    param([string]$RepoRoot, [string]$LogPath, [string]$ErrorLogPath)
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $entryPath = Join-Path $RepoRoot 'scripts\dev.mjs'
    if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw "启动文件缺失: $entryPath" }
    # Start-Process joins ArgumentList; retain quotes around the one Windows path argument.
    $entryArgument = '"' + $entryPath + '"'
    Start-Process -FilePath $nodePath -ArgumentList $entryArgument -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden -RedirectStandardOutput $LogPath -RedirectStandardError $ErrorLogPath -PassThru
}

# 说话。桌面快捷方式没有控制台窗口, 只能弹窗; 在终端里跑就直接打印。
function Show-StudioMessage {
    param(
        [string]$Message,
        [switch]$Popup,
        [ValidateSet("info", "error")][string]$Level = "info"
    )
    if ($Popup) {
        $icon = if ($Level -eq "error") { 16 } else { 64 }
        # 出错的弹窗等用户点掉(他必须读到); 报喜的弹窗 8 秒自动消失,
        # 免得在桌面上杵着等人点 —— 点"停止"就是想清净, 不该再收一个必须处理的对话框。
        $wait = if ($Level -eq "error") { 0 } else { 8 }
        try { (New-Object -ComObject WScript.Shell).Popup($Message, $wait, "AI 短剧工作台", $icon) | Out-Null } catch { }
    } else {
        $color = if ($Level -eq "error") { "Red" } else { "Cyan" }
        Write-Host ""
        Write-Host $Message -ForegroundColor $color
        Write-Host ""
    }
}
