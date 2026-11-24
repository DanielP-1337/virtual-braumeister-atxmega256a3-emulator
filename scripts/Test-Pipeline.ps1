param([string]$OutputDirectory=(Join-Path (Split-Path $PSScriptRoot -Parent) 'private\synthetic-tests'))
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$case=Join-Path $OutputDirectory (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
$exports=Join-Path $case 'exports\synthetic.hex'
$firmware=Join-Path $case 'firmware'
New-Item -ItemType Directory -Force $exports,$firmware | Out-Null
Set-Content (Join-Path $firmware 'synthetic.hex') @(':04000000000008955F',':00000001FF')
Set-Content (Join-Path $exports 'metadata.csv') @('kind,name,value,detail','space,code,2,24','space,mem,1,16')
$valid=@('address,bytes,mnemonic,assembly,function','code:000000,0000,nop,nop,code:000000','code:000001,0895,ret,ret,code:000000')
Set-Content (Join-Path $exports 'instructions.csv') $valid
foreach($name in 'functions','calls','references','vector-candidates','decompiler-status','opcodes'){Set-Content (Join-Path $exports "$name.csv") @('entry,name','0,synthetic')}
Set-Content (Join-Path $case 'exports\synthetic.hex-xmega-register-references-test.csv') @('register_address,access,category','mem:0040,WRITE,CLOCK','code:000010,READ,DMA','mem:0bc2,UNKNOWN,SPI')
$validator=Join-Path $PSScriptRoot 'Test-Exports.ps1'
& $validator -RunDirectory $case -FirmwareDirectory $firmware | Out-Null
$mmio=@(Import-Csv (Join-Path $exports 'mmio-evidence.csv'))
if($mmio.Count -ne 1 -or $mmio[0].category -ne 'CLOCK'){throw 'MMIO filtering failed'}
$rejected=$false
Set-Content (Join-Path $firmware 'synthetic.hex') @(':04000000000008955E',':00000001FF')
try { & $validator -RunDirectory $case -FirmwareDirectory $firmware | Out-Null } catch {if($_ -notmatch 'checksum'){throw}; $rejected=$true}
if(!$rejected){throw 'Bad HEX checksum accepted'}
Set-Content (Join-Path $firmware 'synthetic.hex') @(':04000000000008955F',':00000001FF')
Set-Content (Join-Path $exports 'instructions.csv') ($valid -replace 'code:000001','code:000002')
$rejected=$false
try { & $validator -RunDirectory $case -FirmwareDirectory $firmware | Out-Null } catch {if($_ -notmatch 'outside HEX'){throw}; $rejected=$true}
if(!$rejected){throw 'Byte-addressed PC incorrectly accepted as word-addressed PC'}
Set-Content (Join-Path $exports 'instructions.csv') $valid
Set-Content (Join-Path $case 'TEST-PASS.txt') 'PASS: valid synthetic image; rejected bad checksum; rejected incorrect PC addressing; filtered code-space and unknown MMIO candidates.'
Write-Output "Synthetic tests PASS: $case"
