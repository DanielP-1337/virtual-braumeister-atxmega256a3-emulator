[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$ToolDirectory = 'C:\Program Files (x86)\Arduino\hardware\tools\avr\bin'
)
$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path $PSScriptRoot) 'asm\out-sreg.S'
$build = New-Item -Path $OutputDirectory -ItemType Directory -Force
$elf = Join-Path $build.FullName 'out-sreg.elf'
$hex = Join-Path $build.FullName 'out-sreg.hex'
& (Join-Path $ToolDirectory 'avr-gcc.exe') -mmcu=atxmega256a3 -g -nostdlib -nostartfiles '-Wl,-e,_start' $source -o $elf
if ($LASTEXITCODE -ne 0) { throw 'AVR assembly failed.' }
& (Join-Path $ToolDirectory 'avr-objcopy.exe') -j .text -O ihex $elf $hex
if ($LASTEXITCODE -ne 0) { throw 'HEX export failed.' }
$listing = & (Join-Path $ToolDirectory 'avr-objdump.exe') -d $elf
if ($LASTEXITCODE -ne 0) { throw 'Disassembly failed.' }
$listing | Set-Content -LiteralPath (Join-Path $build.FullName 'out-sreg.lst') -Encoding ascii
Get-FileHash -LiteralPath $hex
