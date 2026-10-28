# Windows installer

On Windows, install Node.js 24 or newer and Inno Setup 6, and make sure `ISCC.exe` is on PATH. From the repository root run:

```powershell
powershell -ExecutionPolicy Bypass -File packaging/windows/build.ps1
```

Share `packaging/windows/output/CouncilSetup.exe`. The installer bundles Node and production dependencies. Recipients still need Git and at least one supported AI CLI installed and signed in; Council's setup screen provides guidance. Launch Council from the Start menu and leave its console window open while using it. User data remains in `~/.council` after uninstalling.

Test the installer on a clean Windows machine before distributing it. Unsigned installers can trigger Windows security warnings.
