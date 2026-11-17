$ErrorActionPreference = 'Stop'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path -LiteralPath $ts)) { $ts = (Get-Command tailscale -ErrorAction Stop).Source }
$state = (& $ts status --json | ConvertFrom-Json)
if ($state.BackendState -ne 'Running') { throw '请先登录并连接 Tailscale。' }
$serve = (& $ts serve status --json | ConvertFrom-Json)
if ($serve.Web) {
  $serialized = $serve | ConvertTo-Json -Depth 20
  if ($serialized -notmatch '127\.0\.0\.1:3030|localhost:3030') { throw '这台电脑已有 Tailscale Serve 配置。为避免覆盖，请手动确认端口与路径后配置。' }
}
& $ts serve --bg --yes http://127.0.0.1:3030
if ($LASTEXITCODE -ne 0) { throw 'Tailscale Serve 尚未启用。请按照上方提示完成 HTTPS 设置后重新执行。' }
Write-Output "iPhone 地址: https://$($state.Self.DNSName.TrimEnd('.'))"
