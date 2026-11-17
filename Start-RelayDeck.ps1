param([switch]$Foreground)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) { throw '请先在项目目录执行 npm.cmd install' }
$data = Join-Path $PSScriptRoot '.relaydeck'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$entry = Join-Path $PSScriptRoot 'src\main.js'
if ($Foreground) { & $node $entry; exit $LASTEXITCODE }
$pidFile = Join-Path $data 'hub.pid'
if (Test-Path -LiteralPath $pidFile) {
  $savedPid = [int](Get-Content -LiteralPath $pidFile)
  $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid"
  if ($existing -and $existing.CommandLine -like "*$entry*") { Write-Output "RelayDeck 已在后台运行，进程 ID: $savedPid"; exit 0 }
}
$process = Start-Process -FilePath $node -ArgumentList @('"' + $entry + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'hub.log') -RedirectStandardError (Join-Path $data 'hub-error.log') -PassThru
$process.Id | Set-Content -LiteralPath $pidFile
Start-Sleep -Seconds 2
if ($process.HasExited) { Get-Content -LiteralPath (Join-Path $data 'hub-error.log'); throw '服务启动失败' }
Write-Output "RelayDeck 已在后台启动，进程 ID: $($process.Id)"
Write-Output '本机访问 http://localhost:3030；运行 npm run access 查看访问码。'
