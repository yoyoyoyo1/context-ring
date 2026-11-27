param(
  [ValidateSet('Install', 'Uninstall', 'Status')]
  [string]$Mode = 'Install',
  [switch]$KeepSettings
)

$ErrorActionPreference = 'Stop'
$agyNode = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Antigravity\bin\agy-node.cmd'
$runtime = $null

if (Test-Path -LiteralPath $agyNode) {
  $runtime = $agyNode
} else {
  $nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $runtime = $nodeCmd.Source
  }
}

if (-not $runtime) {
  throw '未找到 Node.js 运行时，请先安装 Node.js 20+ 或启动一次 Antigravity 桌面客户端。'
}

$action = $Mode.ToLowerInvariant()
$scriptArgs = @((Join-Path $PSScriptRoot 'scripts\install.mjs'), $action)
if ($KeepSettings) {
  $scriptArgs += '--keep-settings'
}

& $runtime @scriptArgs
exit $LASTEXITCODE
