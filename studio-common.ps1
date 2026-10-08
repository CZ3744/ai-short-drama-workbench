# AI 短剧工作台 — 启停脚本公用逻辑 (start-studio.ps1 / stop-studio.ps1 共用)
#
# 为什么单独抽一个文件: "后端端口上坐着的到底是不是我们自己" 这个判断,
# 启动器和停止器必须用同一套标准 —— 启动器靠它认出端口被外人占了要报警,
# 停止器靠它决定哪些进程碰都不能碰。两边各写一份, 迟早各说各话。

# 独立端口避免与其他本地服务冲突。启动器仍校验服务身份，不能仅凭端口开放判定成功。
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
# 端口开放不代表服务正确；必须同时验证进程归属与健康响应。
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
