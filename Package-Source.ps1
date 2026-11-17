$ErrorActionPreference = 'Stop'
$destination = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$names = @('src', 'public', 'scripts', 'test', 'docs', 'package.json', 'package-lock.json', 'README.md', '.gitignore', '.gitattributes', 'Start-RelayDeck.ps1', 'Stop-RelayDeck.ps1', 'Enable-Tailscale.ps1', 'Package-Source.ps1')
$sources = $names | ForEach-Object { Join-Path $PSScriptRoot $_ }
$archive = Join-Path $destination 'relaydeck-source.zip'
Compress-Archive -LiteralPath $sources -DestinationPath $archive -Force
Write-Output "Source package: $archive"
