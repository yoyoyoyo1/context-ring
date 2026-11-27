@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "AGY_NODE=%APPDATA%\Antigravity\bin\agy-node.cmd"

echo ================================================================
echo   Context Ring — 卸载程序
echo ================================================================
echo.

if exist "%AGY_NODE%" (
  call "%AGY_NODE%" "%ROOT%scripts\install.mjs" uninstall %*
) else (
  node "%ROOT%scripts\install.mjs" uninstall %*
)

echo.
pause
