param(
    [string]$Firmware = 'C:\dev\BraumeisterSoftwareUpdater-1.1.27-120918\BrewControl-1-1-27.hex',
    [string]$Evidence = '',
    [string]$Output = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (!$Evidence) { $Evidence = Join-Path $root 'private\runs\20261027-073058-193\exports\BrewControl-1-1-27.hex\instructions.csv' }
if (!$Output) { $Output = Join-Path $root ('private\poc-001-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')) }
& node --test (Join-Path $root 'tests\cpu.test.mjs') (Join-Path $root 'tests\runner.test.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Synthetic instruction/runner tests failed; boot not attempted.' }
& node (Join-Path $root 'scripts\boot-poc.mjs') --firmware $Firmware --evidence $Evidence --output $Output
if ($LASTEXITCODE -ne 0) { throw "Boot acceptance failed. See $Output\result.json" }
Write-Output "PASS: synthetic tests and reset-to-main acceptance. Evidence: $Output"
