param([string]$Output = '', [string]$Firmware = 'C:\dev\BraumeisterSoftwareUpdater-1.1.27-120918\BrewControl-1-1-27.hex')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (!$Output) { $Output = Join-Path $root ('private\poc-002a-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')) }
& node --test (Join-Path $root 'tests\discovery.test.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Discovery tests failed' }
& node (Join-Path $root 'scripts\discover-main.mjs') --firmware $Firmware --output $Output
if ($LASTEXITCODE -ne 2) { throw "Expected diagnostic stop (exit 2); inspect $Output" }
$result = Get-Content -LiteralPath (Join-Path $Output 'result.json') -Raw | ConvertFrom-Json
if ($result.status -ne 'CONTROLLED_STOP' -or !$result.startupCheckpoint.verified -or !$result.deterministicReplay) { throw 'Invalid discovery result' }
Write-Output "CONTROLLED_STOP: diagnostic captured in $Output. Application boot is not successful."
