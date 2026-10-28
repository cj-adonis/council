$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$stage = Join-Path $root 'packaging/windows/stage'
$compiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if (-not $compiler) { throw 'Install Inno Setup 6 and add ISCC.exe to PATH.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
if ([int]((& $node --version) -replace '^v(\d+)\..*', '$1') -lt 24) { throw 'Node 24 or newer is required.' }

Push-Location $root
try {
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage | Out-Null
    Copy-Item package.json, package-lock.json -Destination $stage
    New-Item -ItemType Directory -Path (Join-Path $stage 'server'), (Join-Path $stage 'client') | Out-Null
    Copy-Item server/package.json (Join-Path $stage 'server')
    Copy-Item client/package.json (Join-Path $stage 'client')
    Push-Location $stage
    try {
        npm.cmd ci --omit=dev
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
    } finally { Pop-Location }
    Copy-Item server/dist (Join-Path $stage 'server/dist') -Recurse
    Copy-Item client/dist (Join-Path $stage 'client/dist') -Recurse
    Copy-Item $node (Join-Path $stage 'node.exe')
    Copy-Item packaging/windows/launch.cmd $stage
    & $compiler.Source (Join-Path $PSScriptRoot 'council.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
} finally { Pop-Location }
