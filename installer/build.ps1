# Builds installer\build\HostMyGame-Setup-<version>.exe.
# Needs Node.js/npm and Inno Setup 6. -Repo is the GitHub "owner/name" the installed panel checks for updates.
param([string]$Repo = $env:GITHUB_REPOSITORY)

$ErrorActionPreference = 'Stop'
$NodeVersion = '24.14.0'
$WinSWVersion = '2.12.0'

$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $PSScriptRoot 'build'
$cache = Join-Path $out 'cache'
$stage = Join-Path $out 'stage'
$app = Join-Path $stage 'app'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $app, (Join-Path $stage 'node'), $cache | Out-Null

function Get-Cached($url, $name) {
  $file = Join-Path $cache $name
  if (-not (Test-Path $file)) {
    Write-Host "Baixando $url"
    Invoke-WebRequest $url -OutFile "$file.part" -UseBasicParsing
    Move-Item "$file.part" $file
  }
  $file
}

Write-Host 'Copiando o painel...'
foreach ($item in 'src', 'public', 'package.json', 'package-lock.json', 'README.md') {
  Copy-Item (Join-Path $root $item) $app -Recurse
}
if ($Repo) {
  node -e "const fs=require('fs');const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,'utf8'));p.updateRepo=process.argv[2];fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')" (Join-Path $app 'package.json') $Repo
  if ($LASTEXITCODE) { throw 'Falha ao gravar updateRepo' }
} else {
  Write-Warning 'Sem -Repo: o painel instalado não vai procurar atualizações.'
}

Push-Location $app
try {
  npm ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE) { throw 'npm ci falhou' }
} finally { Pop-Location }

Copy-Item (Get-Cached "https://nodejs.org/dist/v$NodeVersion/win-x64/node.exe" "node-$NodeVersion.exe") (Join-Path $stage 'node\node.exe')
Copy-Item (Get-Cached "https://github.com/winsw/winsw/releases/download/v$WinSWVersion/WinSW-x64.exe" "WinSW-$WinSWVersion-x64.exe") (Join-Path $stage 'HostMyGameService.exe')
Copy-Item (Join-Path $PSScriptRoot 'HostMyGameService.xml'), (Join-Path $PSScriptRoot 'logo.ico') $stage

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { $iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source }
if (-not $iscc) { throw 'Inno Setup 6 não encontrado (https://jrsoftware.org/isdl.php)' }

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
& $iscc "/DAppVersion=$version" "/DStage=$stage" "/O$out" (Join-Path $PSScriptRoot 'HostMyGame.iss')
if ($LASTEXITCODE) { throw 'ISCC falhou' }
Write-Host "Pronto: $(Join-Path $out "HostMyGame-Setup-$version.exe")"
