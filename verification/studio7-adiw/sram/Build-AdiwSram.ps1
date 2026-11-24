[CmdletBinding()]
param(
    [string]$ToolDirectory = 'C:\Program Files (x86)\Arduino\hardware\tools\avr\bin',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'build')
)
$ErrorActionPreference = 'Stop'
$dest = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $dest -Force | Out-Null
$source = Join-Path $PSScriptRoot 'adiw-sram.S'
$elf = Join-Path $dest 'adiw-sram.elf'
$hex = Join-Path $dest 'adiw-sram.hex'
& (Join-Path $ToolDirectory 'avr-gcc.exe') '-mmcu=atxmega256a3' '-g' '-nostdlib' '-nostartfiles' '-Wl,-e,_start' $source '-o' $elf
if ($LASTEXITCODE -ne 0) { throw "avr-gcc exited $LASTEXITCODE" }
& (Join-Path $ToolDirectory 'avr-objcopy.exe') '-j' '.text' '-O' 'ihex' $elf $hex
if ($LASTEXITCODE -ne 0) { throw "avr-objcopy exited $LASTEXITCODE" }
$listing = & (Join-Path $ToolDirectory 'avr-objdump.exe') '-d' $elf
if ($LASTEXITCODE -ne 0) { throw "avr-objdump exited $LASTEXITCODE" }
$listing | Set-Content -LiteralPath (Join-Path $dest 'adiw-sram.lst') -Encoding ascii
$listing | Select-String -Pattern ' <(case\d+|finished)>:'
Get-FileHash -LiteralPath $hex -Algorithm SHA256
