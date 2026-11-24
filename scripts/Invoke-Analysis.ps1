param(
 [string]$GhidraHome='C:\dev\ghidra_12.2_PUBLIC',
 [string]$SourceProject='C:\dev\Virtual-Braumeister.gpr',
 [string]$FirmwareDirectory='C:\dev\BraumeisterSoftwareUpdater-1.1.27-120918',
 [switch]$IncludeOtherFirmware
)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$run=Join-Path $root ('private\runs\'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $run | Out-Null
$projectBase=[IO.Path]::ChangeExtension($SourceProject,$null).TrimEnd('.')
$sourceFiles=@(Get-Item -LiteralPath $SourceProject)+@(Get-ChildItem -LiteralPath ($projectBase+'.rep') -Recurse -File | Where-Object {$_.Name -notmatch '^tmp.*\.ps$'})+@(Get-ChildItem -LiteralPath $FirmwareDirectory -Filter *.hex -File)
function Manifest { @($sourceFiles | Sort-Object FullName | ForEach-Object { [pscustomobject]@{path=$_.FullName;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash} }) }
$before=Manifest
$before | ConvertTo-Json | Set-Content (Join-Path $run 'source-before.json')
$snapshot=Join-Path $run 'snapshot'
New-Item -ItemType Directory -Path $snapshot | Out-Null
Copy-Item -LiteralPath $SourceProject -Destination $snapshot
foreach($file in $sourceFiles | Where-Object {$_.FullName.StartsWith($projectBase+'.rep\')}) { $target=Join-Path $snapshot ($file.FullName.Substring((Split-Path $SourceProject -Parent).Length+1)); New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null; Copy-Item -LiteralPath $file.FullName -Destination $target }
# Detect an inconsistent copy or concurrent source changes before launching Ghidra.
foreach($entry in $before | Where-Object {$_.path.StartsWith($projectBase+'.rep\') -or $_.path -eq $SourceProject}) {
 $copy=Join-Path $snapshot ($entry.path.Substring((Split-Path $SourceProject -Parent).Length+1))
 if((Get-FileHash -LiteralPath $copy).Hash -ne $entry.sha256){throw "Snapshot differs: $copy"}
}
$exports=Join-Path $run 'exports'
New-Item -ItemType Directory -Path $exports | Out-Null
$projectName=[IO.Path]::GetFileNameWithoutExtension($SourceProject)
try {
 & (Join-Path $GhidraHome 'support\analyzeHeadless.bat') $snapshot $projectName -process '*' -recursive -readOnly -analysisTimeoutPerFile 300 -scriptPath $PSScriptRoot -postScript ExportFirmware.java $exports -postScript Export_XmegaRegisterReferences.java $exports -log (Join-Path $run 'headless.log') -scriptlog (Join-Path $run 'scripts.log')
 if($LASTEXITCODE -ne 0){throw "Headless exited $LASTEXITCODE"}
 if($IncludeOtherFirmware) {
  & (Join-Path $GhidraHome 'support\analyzeHeadless.bat') $snapshot FirmwareVariants -import (Join-Path $FirmwareDirectory 'BrewControl-1-1-26.hex') (Join-Path $FirmwareDirectory 'WiFiUpdater.hex') -processor 'avr8:LE:24:xmega' -cspec gcc -readOnly -analysisTimeoutPerFile 300 -scriptPath $PSScriptRoot -postScript ExportFirmware.java $exports -postScript Export_XmegaRegisterReferences.java $exports -log (Join-Path $run 'variants.log') -scriptlog (Join-Path $run 'variant-scripts.log')
  if($LASTEXITCODE -ne 0){throw "Variant headless exited $LASTEXITCODE"}
  foreach($name in 'BrewControl-1-1-26.hex','WiFiUpdater.hex'){if(!(Test-Path (Join-Path $exports "$name\EXPORT-COMPLETE.txt"))){throw "Missing variant export $name"}}
 }
 if(@(Get-ChildItem $exports -Recurse -Filter EXPORT-COMPLETE.txt).Count -eq 0){throw 'Missing export completion marker'}
 & (Join-Path $PSScriptRoot 'Test-Exports.ps1') -RunDirectory $run -FirmwareDirectory $FirmwareDirectory
} finally {
 $after=Manifest
 $after | ConvertTo-Json | Set-Content (Join-Path $run 'source-after.json')
 if(($before | ConvertTo-Json -Compress) -ne ($after | ConvertTo-Json -Compress)){throw 'SOURCE INTEGRITY FAILURE: source data changed during run'}
}
Set-Content (Join-Path $run 'PIPELINE-PASS.txt') 'Export validation passed; all original firmware/project/database SHA-256 hashes unchanged.'
Write-Output "PIPELINE PASS: $run"


