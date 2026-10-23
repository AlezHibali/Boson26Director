param([ValidateSet('dev','demo')][string]$Mode='dev',[ValidateRange(1024,65535)][int]$Port=3000)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node 24+ first.' }
if ([int]((node -p 'process.versions.node').Split('.')[0]) -lt 24) { throw 'Node 24+ required.' }
if (-not (Test-Path -LiteralPath 'node_modules')) { & npm.cmd ci; if($LASTEXITCODE -ne 0){throw 'npm ci failed.'} }
if (-not (Test-Path -LiteralPath '.env.local')) { Copy-Item -LiteralPath '.env.example' -Destination '.env.local' }
& npm.cmd run doctor
if($LASTEXITCODE -ne 0){throw 'Preflight failed.'}
if($Mode -eq 'demo'){
  & npm.cmd run build
  if($LASTEXITCODE -ne 0){throw 'Production build failed.'}
  & npm.cmd run start -- --port $Port
}else{
  & npm.cmd run dev -- --port $Port
}
if($LASTEXITCODE -ne 0){throw 'Local server stopped with an error.'}
