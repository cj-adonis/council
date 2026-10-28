#define MyAppName "Council"
#define MyAppVersion "0.1.0"

[Setup]
AppId={{87EF6A05-6077-48E9-AADD-80769B4771F1}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\Council
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=CouncilSetup
Compression=lzma2
SolidCompression=yes
UninstallDisplayName=Council

[Files]
Source: "stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Council"; Filename: "{app}\launch.cmd"; WorkingDir: "{app}"

[Run]
Filename: "{app}\launch.cmd"; Description: "Launch Council"; Flags: postinstall skipifsilent nowait shellexec
