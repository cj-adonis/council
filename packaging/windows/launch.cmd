@echo off
cd /d "%~dp0"
set PORT=4317
set HOST=127.0.0.1
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4317/ -TimeoutSec 1 ^| Out-Null; Start-Process 'http://localhost:4317'; break } catch { Start-Sleep -Seconds 1 } }"
echo Council is running. Close this window to stop it.
node.exe server\dist\index.js
echo Council stopped. Press any key to close this window.
pause >nul
