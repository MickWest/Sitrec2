@echo off
REM Launcher for SitrecBridge MCP server (Windows).
REM Node.js is usually on PATH via the official installer. Distribution builds
REM contain mcp-server.mjs; the source tree contains mcp-server.js.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Error: node not found. Install Node.js 18+ from https://nodejs.org/ >&2
    exit /b 1
)

if exist "%~dp0mcp-server.mjs" (
    node "%~dp0mcp-server.mjs" %*
) else if exist "%~dp0mcp-server.js" (
    node "%~dp0mcp-server.js" %*
) else (
    echo Error: SitrecBridge server not found beside run.bat. >&2
    exit /b 1
)
