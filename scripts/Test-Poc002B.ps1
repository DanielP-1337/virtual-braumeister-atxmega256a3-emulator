param([string]$Output = '', [string]$Firmware = 'C:\dev\BraumeisterSoftwareUpdater-1.1.27-120918\BrewControl-1-1-27.hex')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (!$Output) { $Output = Join-Path $root ('private\poc-002b-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')) }
& node --test (Join-Path $root 'tests\gpio.test.mjs')
if ($LASTEXITCODE -ne 0) { throw 'GPIO specification tests failed; firmware not attempted' }
& node (Join-Path $root 'scripts\discover-gpio.mjs') --firmware $Firmware --output $Output
if ($LASTEXITCODE -ne 2) { throw "Expected controlled diagnostic stop; inspect $Output" }
$r = Get-Content -LiteralPath (Join-Path $Output 'result.json') -Raw | ConvertFrom-Json
if ($r.status -ne 'CONTROLLED_STOP' -or !$r.startupCheckpoint.verified -or !$r.deterministicReplay -or !$r.firstApplicationInstructionCompleted) { throw 'GPIO discovery acceptance failed' }
Write-Output "CONTROLLED_STOP: first application STS completed through GPIO; next blocker recorded in $Output. Not a successful application boot."
