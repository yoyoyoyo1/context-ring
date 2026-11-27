@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "AGY_NODE=%APPDATA%\Antigravity\bin\agy-node.cmd"

echo ================================================================
echo   Context Ring — Antigravity 无侵入多形态上下文监控安装程序
echo ================================================================
echo.

if exist "%AGY_NODE%" (
  call "%AGY_NODE%" "%ROOT%scripts\install.mjs" install %*
) else (
  node "%ROOT%scripts\install.mjs" install %*
)

echo.
pause
