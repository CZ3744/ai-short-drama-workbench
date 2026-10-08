# AI 短剧生成工作台 — 一键停止
#
# 2026-07-22 重写。旧版是"谁占着后端/前端端口就杀谁", 这有两个真问题:
#   1. 误杀。实测这台机器上后端端口(当时是 8787)被另一个程序 (codexpro) 占着, 旧版一点"停止"
#      就会把那个毫不相干的程序干掉 —— 用户根本不知道自己刚才杀了什么。
#   2. 杀不干净。真正的工作台进程 (npm / concurrently / tsx watch) 自己不占端口,
#      旧版一个都碰不到, 它们会一直挂在后台; 而且旧版还会照样弹"已停止", 说的是假话。
#
# 新版原则: 先认人, 再动手。
#   · 只杀命令行里带本仓库路径的进程, 以及它们的子孙进程 (真正的后端就藏在 tsx watch 底下)
#   · 认不出是自己人的, 一律不碰, 并且如实告诉用户"那个端口上还有谁, 我没动它"
#   · 报告说实话: 停了几个就说几个, 本来就没在跑就说没在跑

[CmdletBinding()]
param(
    # 桌面快捷方式走这个开关: 弹窗汇报结果。不带它就是安静模式 (给 start-studio.ps1 内部调用)。
    [switch]$Announce
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "studio-common.ps1")

$RepoRoot = $PSScriptRoot
$snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)

# ── 1. 先圈出"绝对不能碰"的进程: 本脚本自己这一条祖先链 ──────
# (不然在终端里跑这个脚本会把承载它的那个 shell 自己杀掉。)
$protected = New-Object System.Collections.Generic.HashSet[int]
$walk = $PID
for ($i = 0; $i -lt 32 -and $walk -gt 0; $i++) {
    if (-not $protected.Add([int]$walk)) { break }
    $node = $snapshot | Where-Object { $_.ProcessId -eq $walk } | Select-Object -First 1
    if (-not $node) { break }
    $walk = [int]$node.ParentProcessId
}

# ── 2. 认人: 只认"本仓库的开发服务器进程树的根" ───────────────
# 这里的门槛必须卡死。第一版写成"命令行里出现过本仓库路径就算自己人", 结果实测
# 把一个只是在命令里提了一嘴仓库路径的终端会话也杀了 —— 跟旧版按端口乱杀是同一种错:
# 提到 ≠ 是。所以现在要求两个条件同时成立:
#   1. 命令行里有本仓库路径
#   2. 而且它确实是开发服务器本体: 要么就是 `npm run dev`,
#      要么是本仓库 node_modules 里的 concurrently / vite / tsx 这三个跑服务的家伙
# 这样一来: 终端、编辑器、npx tsc 这类"路过"的进程一律不碰。
#
# 另外排除 .claude\worktrees\ 下面的 —— 那是 AI agent 的临时工作副本, 路径以本仓库开头,
# 但跑在里面的是别人的开发会话, 不能顺手杀掉。
$rootEscaped = [regex]::Escape($RepoRoot)
$seeds = @($snapshot | Where-Object {
    $_.CommandLine -and
    $_.CommandLine -match $rootEscaped -and
    $_.CommandLine -notmatch '\.claude[\\/]+worktrees' -and
    (
        $_.CommandLine -match 'npm(\.cmd)?\s+run\s+dev' -or
        $_.CommandLine -match 'node_modules.{0,40}(concurrently|vite|tsx)' -or
        (Test-StudioDevEntryProcess $_ $RepoRoot)
    ) -and
    -not $protected.Contains([int]$_.ProcessId)
})

# ── 3. 连坐子孙进程 ──────────────────────────────────────────
# 真正监听后端端口的那个 node 是 tsx watch 的子进程, 它自己的命令行里没有仓库路径,
# 只能顺着父子关系往下捞。esbuild 之类的小工具也在这一层。
$byParent = @{}
foreach ($p in $snapshot) {
    $key = [string]$p.ParentProcessId
    if (-not $byParent.ContainsKey($key)) { $byParent[$key] = New-Object System.Collections.ArrayList }
    [void]$byParent[$key].Add($p)
}

$seen   = New-Object System.Collections.Generic.HashSet[int]
$levels = @()
foreach ($s in $seeds) { [void]$seen.Add([int]$s.ProcessId) }
$current = $seeds
while ($current.Count -gt 0) {
    $levels += , @($current)
    $next = @()
    foreach ($proc in $current) {
        $kids = $byParent[[string]$proc.ProcessId]
        if (-not $kids) { continue }
        foreach ($k in $kids) {
            if ($protected.Contains([int]$k.ProcessId)) { continue }
            if ($seen.Add([int]$k.ProcessId)) { $next += $k }
        }
    }
    $current = $next
}

# ── 4. 动手: 从最深的子孙往上杀 ──────────────────────────────
# 先杀爹的话, tsx watch 这种看门狗有机会再拉一个儿子起来, 于是"停止"停了个寂寞。
$stopped = 0
for ($i = $levels.Count - 1; $i -ge 0; $i--) {
    foreach ($proc in $levels[$i]) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            $stopped++
        } catch { }
    }
}

# ── 5. 如实汇报 ─────────────────────────────────────────────
if ($stopped -gt 0) {
    $report = "工作台已停止。"
    Start-Sleep -Milliseconds 500
} else {
    $report = "工作台本来就没在运行, 这次什么都没动。"
}

# 端口上如果还坐着不是自己人的程序, 必须说出来 —— 用户点了"停止"却发现端口还占着,
# 不解释的话只会以为脚本又坏了。顺便证明我们没有乱杀。
$leftovers = @()
foreach ($port in @($StudioApiPort, $StudioWebPort)) {
    $owner = Get-StudioPortOwner -Port $port
    if ($owner) {
        $leftovers += "· 端口 $port 上还有「$(Get-StudioProcessLabel $owner)」—— 那不是工作台的进程, 已原样保留, 没有动它。"
    }
}
if ($leftovers.Count -gt 0) {
    $report += "`n`n另外:`n" + ($leftovers -join "`n")
}

Show-StudioMessage -Message $report -Popup:$Announce

# 退出码 0 = 脚本自己跑成功了。
# (旧版拿"杀了几个进程"当退出码, 于是正常停止反而返回非 0, 任何按惯例检查退出码的调用方
#  都会以为停止失败 —— 旧的 stop-studio.vbs 正是被这个坑出了"杀错人还报成功"的假消息。)
exit 0
