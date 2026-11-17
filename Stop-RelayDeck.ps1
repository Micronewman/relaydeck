$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot '.relaydeck\hub.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output '未找到后台服务记录。前台服务可用 Ctrl+C 停止。'; exit 0 }
$savedPid = [int](Get-Content -LiteralPath $pidFile)
$entry = Join-Path $PSScriptRoot 'src\main.js'
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid"
if ($process -and $process.CommandLine -like "*$entry*") {
  # Stop only descendants of this verified RelayDeck process, never unrelated Codex sessions.
  function Stop-RelayChild([int]$ParentId) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentId")
    foreach ($child in $children) { Stop-RelayChild -ParentId $child.ProcessId; Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue }
  }
  Stop-RelayChild -ParentId $savedPid
  Stop-Process -Id $savedPid -ErrorAction SilentlyContinue
  Write-Output 'RelayDeck 已停止。该服务中的未完成任务也已停止。'
} else { Write-Output '原服务已退出；没有停止其他进程。' }
Remove-Item -LiteralPath $pidFile
