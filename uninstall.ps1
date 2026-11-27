param(
  [switch]$KeepSettings
)

$params = @{ Mode = 'Uninstall' }
if ($KeepSettings) {
  $params['KeepSettings'] = $true
}

& (Join-Path $PSScriptRoot 'install.ps1') @params
exit $LASTEXITCODE
