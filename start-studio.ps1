# AI 短剧生成工作台 — 一键启动
#
# 2026-07-22 重写。修的是这个真实故障:
#   旧版只探前端端口 5173, 探到就固定 sleep 9 秒, 然后不管三七二十一打开浏览器。
#   而后端端口(当时是 8787)被另一个程序 (实测是 codexpro) 占着的时候:
#     · 页面能打开, 看着一切正常
#     · 但页面上每一个操作都被那个程序接走, 一律返回 401
#     · 用户看到的就是"点了没反应 / 到处报错", 而且没有任何一句话告诉他为什么
#   新版三条改动:
#     1. 开浏览器之前先验明后端正身 (/healthz 必须答出我们自己的 ok:true), 不是我们就当场说清是谁
#     2. 不再瞎等 9 秒, 而是一直等到前后端真的都能用了才开页面; 等不到就老实说等不到
#     3. 只起来一半的残留先清干净再重启, 不会叠第二份上去

[CmdletBinding()]
param(
    # 桌面快捷方式走这个开关: 没有控制台窗口, 用弹窗说话。
    [switch]$Quiet,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "studio-common.ps1")

$RepoRoot        = $PSScriptRoot
$WebUrl          = "http://127.0.0.1:$StudioWebPort"
$LogPath         = Join-Path $RepoRoot "dev.log"
$ErrorLogPath    = Join-Path $RepoRoot "dev.stderr.log"
$ReadyTimeoutSec = 120

function Say {
    param([string]$Message, [ValidateSet("info", "error")][string]$Level = "info")
    if ($Quiet -and $Level -eq 'info') { return }
    Show-StudioMessage -Message $Message -Level $Level -Popup:$Quiet
}

# 端口被外人占了 —— 这是这次故障的正主, 单独一个函数保证启动前/启动中两次检查说的是同一句话。
function Stop-BecausePortTaken {
    param([string]$When)
    $owner = Get-StudioPortOwner -Port $StudioApiPort
    $who   = if ($owner) { Get-StudioProcessLabel $owner } else { "另一个程序" }
    Say @"
工作台没能启动 —— 后端要用的 $StudioApiPort 端口${When}被别的程序占着。

占用它的是: $who

这种情况下就算把页面打开也是坏的: 页面上每一步操作都会被那个程序接走并报错。
所以这次没有打开页面。

怎么办: 先把上面这个程序关掉, 然后重新双击"AI 短剧生成工作台"。
"@ "error"
}

# ── 0. 环境自检 ──────────────────────────────────────────────
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Say "工作台没能启动 —— 这台电脑上找不到 Node.js。`n`n请先安装 Node.js, 再重新双击桌面上的「AI 短剧生成工作台」。" "error"
    exit 2
}

# ── 1. 后端端口体检 (启动前) ─────────────────────────────────
$backend = Test-StudioBackend
if ($backend -eq "foreign") {
    Stop-BecausePortTaken -When ""
    exit 3
}

$webOwner = Get-StudioPortOwner -Port $StudioWebPort
if ($webOwner -and -not (Test-StudioWebProcess $webOwner)) {
    Say "工作台没能启动 —— 前端端口 $StudioWebPort 已被 $(Get-StudioProcessLabel $webOwner) 占用。`n`n请关闭占用该端口的程序后重试。现有程序已原样保留。" "error"
    exit 3
}

# ── 2. 已经在跑就别启第二份, 直接开页面 ──────────────────────
if ($backend -eq "ours" -and (Test-StudioWeb)) {
    Say "工作台已经在运行, 直接打开页面。"
    if (-not $NoBrowser) { Start-Process $WebUrl }
    exit 0
}

# ── 3. 只起来一半的残留先清干净 ──────────────────────────────
# (上次没退干净的常见后果: 一半端口占着, 新起的那半跟它打架, 表现成"时好时坏"。)
if ($backend -eq "ours" -or (Test-StudioWeb)) {
    Say "发现上次没退干净的残留, 正在清理后重新启动…"
    & (Join-Path $RepoRoot "stop-studio.ps1") | Out-Null
    Start-Sleep -Seconds 2
}

# ── 4. 启动 ─────────────────────────────────────────────────
Say "正在启动工作台, 请稍候… (启动日志: $LogPath)"
try {
    Start-StudioDevProcess -RepoRoot $RepoRoot -LogPath $LogPath -ErrorLogPath $ErrorLogPath | Out-Null
} catch {
    Say "工作台没能启动：$($_.Exception.Message)" "error"
    exit 4
}

# ── 5. 等到"真的能用了"再开浏览器 ────────────────────────────
# 旧版这里是 WScript.Sleep 9000 —— 机器慢一点就开出一个白页, 机器快也照样等满 9 秒。
# 现在改成一秒一探, 前后端双双就绪立刻开, 最多等 $ReadyTimeoutSec 秒。
# (等本地子进程就绪的循环, 属于铁律 1 的"本地 spawn 子进程"例外; 而且超时不杀进程, 只是如实报告。)
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
$ready    = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $backend = Test-StudioBackend
    if ($backend -eq "foreign") {
        Stop-BecausePortTaken -When "在启动过程中"
        exit 3
    }
    if ($backend -eq "ours" -and (Test-StudioWeb)) { $ready = $true; break }
}

if (-not $ready) {
    $tail = ""
    foreach ($path in @($LogPath, $ErrorLogPath)) {
        if (Test-Path -LiteralPath $path) {
            $tail += "`n`n启动日志最后几行:`n" + ((Get-Content -LiteralPath $path -Tail 8 -ErrorAction SilentlyContinue) -join "`n")
        }
    }
    Say "工作台等了 $ReadyTimeoutSec 秒还没准备好, 这次没有打开页面。`n`n它可能还在后台继续启动, 过一会儿再双击一次试试。$tail" "error"
    exit 4
}

Say "工作台已就绪, 正在打开页面: $WebUrl"
if (-not $NoBrowser) { Start-Process $WebUrl }
exit 0
