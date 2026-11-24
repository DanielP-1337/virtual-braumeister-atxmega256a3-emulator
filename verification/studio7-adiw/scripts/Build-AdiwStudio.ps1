param(
    [Parameter(Mandatory)][string]$Output,
    [string]$ToolDirectory = "${env:ProgramFiles(x86)}\Arduino\hardware\tools\avr\bin"
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$outputPath = [IO.Path]::GetFullPath($Output)
$source = Join-Path $root 'asm\adiw-studio.S'
$gcc = Join-Path $ToolDirectory 'avr-gcc.exe'
$objcopy = Join-Path $ToolDirectory 'avr-objcopy.exe'
$objdump = Join-Path $ToolDirectory 'avr-objdump.exe'
foreach ($file in $source, $gcc, $objcopy, $objdump) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing build dependency: $file" }
}
if (Test-Path -LiteralPath $outputPath) { throw "Choose a new output directory: $outputPath" }
$null = New-Item -ItemType Directory -Path $outputPath
$elf = Join-Path $outputPath 'adiw-studio.elf'
$hex = Join-Path $outputPath 'adiw-studio.hex'
& $gcc '-mmcu=atxmega256a3' '-g' '-nostdlib' '-nostartfiles' '-Wl,-e,_start' $source '-o' $elf
if ($LASTEXITCODE -ne 0) { throw 'AVR GCC assembly or linking failed' }
& $objcopy '-j' '.text' '-O' 'ihex' $elf $hex
if ($LASTEXITCODE -ne 0) { throw 'AVR objcopy failed' }
& $objdump '-d' $elf | Set-Content -Encoding ascii -LiteralPath (Join-Path $outputPath 'adiw-studio.lst')
if ($LASTEXITCODE -ne 0) { throw 'AVR objdump failed' }
Get-FileHash -LiteralPath $elf, $hex
