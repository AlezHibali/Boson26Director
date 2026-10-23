$ErrorActionPreference='Stop'
$sourceRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$baseRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$targetRoot=[IO.Path]::GetFullPath((Join-Path $baseRoot ('director-clean-'+[guid]::NewGuid().ToString())))
$checks=@()
$previousKey=$env:BOSON_API_KEY
$previousData=$env:BOSON_DATA_DIR
try {
  Set-Location -LiteralPath $sourceRoot
  $files=((& git ls-files --cached --others --exclude-standard -z) -join "`n").Split([char]0) | Where-Object {$_} | Sort-Object -Unique
  if(Test-Path -LiteralPath $targetRoot){throw 'Clean target already exists.'}
  New-Item -ItemType Directory -Path $targetRoot | Out-Null
  foreach($relative in $files){
    if($relative -match '^(?:\.data/|docs/evidence/private/|node_modules/|\.next/|\.env(?!\.example$))'){continue}
    $destination=[IO.Path]::GetFullPath((Join-Path $targetRoot $relative))
    if(-not $destination.StartsWith($targetRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe snapshot path.'}
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination $destination
  }
  Set-Location -LiteralPath $targetRoot
  $env:BOSON_API_KEY=''
  $env:BOSON_DATA_DIR=(Join-Path $targetRoot '.data')
  & git init --quiet
  if($LASTEXITCODE -ne 0){throw 'Cannot initialize clean snapshot.'}
  $commands=@(
    @{Name='npm ci';Args=@('ci')},
    @{Name='doctor';Args=@('run','doctor')},
    @{Name='typecheck';Args=@('run','typecheck')},
    @{Name='unit';Args=@('run','test:unit')},
    @{Name='build';Args=@('run','build')},
    @{Name='secrets';Args=@('run','check:secrets')}
  )
  foreach($command in $commands){
    $watch=[Diagnostics.Stopwatch]::StartNew()
    & npm.cmd @($command.Args)
    $ok=($LASTEXITCODE -eq 0)
    $checks+=@{phase=$command.Name;ok=$ok;durationMs=$watch.ElapsedMilliseconds}
    if(-not $ok){throw ('Clean install check failed: '+$command.Name)}
  }
} finally {
  Set-Location -LiteralPath $sourceRoot
  $env:BOSON_API_KEY=$previousKey
  $env:BOSON_DATA_DIR=$previousData
  $report=@{date=[DateTime]::UtcNow.ToString('o');mode='Fresh source snapshot, no .env.local, no private media, no copied node_modules';checks=$checks}
  $reportPath=Join-Path $sourceRoot 'docs/evidence/stage5-clean-install.json'
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($reportPath))|Out-Null
  [IO.File]::WriteAllText($reportPath,(($report|ConvertTo-Json -Depth 8).Replace([Environment]::NewLine,[string][char]10)+[char]10),[Text.UTF8Encoding]::new($false))
  $checkedTarget=[IO.Path]::GetFullPath($targetRoot)
  if(-not $checkedTarget.StartsWith($baseRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($checkedTarget) -notmatch '^director-clean-[0-9a-f-]{36}$'){throw 'Unexpected cleanup target.'}
  if(Test-Path -LiteralPath $checkedTarget){Remove-Item -LiteralPath $checkedTarget -Recurse -Force}
}
