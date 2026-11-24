param([Parameter(Mandatory)][string]$RunDirectory,[Parameter(Mandatory)][string]$FirmwareDirectory)
$ErrorActionPreference='Stop'
$results=@()
foreach($program in Get-ChildItem (Join-Path $RunDirectory 'exports') -Directory) {
 $hex=Join-Path $FirmwareDirectory $program.Name
 if(!(Test-Path -LiteralPath $hex)){throw "Missing HEX: $hex"}
 $memory=[Collections.Generic.Dictionary[long,byte]]::new()
 [long]$base=0; $eof=$false
 foreach($line in Get-Content -LiteralPath $hex) {
  if($eof){throw 'Data after EOF'}
  if($line -notmatch '^:([0-9A-Fa-f]{2})+$'){throw 'Invalid HEX syntax'}
  $bytes=[Collections.Generic.List[byte]]::new()
  for($n=1;$n -lt $line.Length;$n+=2){$bytes.Add([Convert]::ToByte($line.Substring($n,2),16))}
  if($bytes.Count -ne $bytes[0]+5){throw 'Invalid HEX length'}
  if((($bytes | Measure-Object -Sum).Sum % 256) -ne 0){throw 'Invalid HEX checksum'}
  $count=[int]$bytes[0]; $offset=256*[int]$bytes[1]+$bytes[2]; $type=$bytes[3]
  switch($type) {
   0 {for($n=0;$n -lt $count;$n++){[long]$addr=$base+$offset+$n; if($memory.ContainsKey($addr) -and $memory[$addr] -ne $bytes[$n+4]){throw 'Conflicting HEX overlap'}; $memory[$addr]=$bytes[$n+4]}}
   1 {if($count -ne 0){throw 'Invalid EOF'}; $eof=$true}
   2 {if($count -ne 2){throw 'Invalid segment record'}; $base=(256*[long]$bytes[4]+$bytes[5])*16}
   4 {if($count -ne 2){throw 'Invalid linear record'}; $base=(256*[long]$bytes[4]+$bytes[5])*65536}
   {$_ -in 3,5} {if($count -ne 4){throw 'Invalid start record'}}
   default {throw "Unsupported HEX record $type"}
  }
 }
 if(!$eof){throw 'Missing EOF'}
 # Decode JMP vector slots independently of Ghidra's symbols and disassembler.
 $vectors=@(for([long]$word=0;$word -le 0xf2;$word+=2) {
  [long]$address=2*$word
  if(!(0..3 | Where-Object {!$memory.ContainsKey($address+$_)})) {
   [int]$op=[int]$memory[$address]+256*[int]$memory[$address+1]
   $target=$null
   if(($op -band 0xfe0e) -eq 0x940c){$target=(($op -band 0x1f0) -shl 13) -bor (($op -band 1) -shl 16) -bor ([int]$memory[$address+2]+256*[int]$memory[$address+3])}
   [pscustomobject]@{slotWord=('0x{0:x6}' -f $word);slotByte=('0x{0:x6}' -f $address);opcode=('0x{0:x4}' -f $op);isJmp=($null -ne $target);targetWord=$(if($null -ne $target){'0x{0:x6}' -f $target}else{'UNKNOWN'});targetByte=$(if($null -ne $target){'0x{0:x6}' -f (2*$target)}else{'UNKNOWN'});note='Slot candidates through A3 USARTF0 TXC; reserved slots retained; reset/vector relocation unknown'}
  }
 })
 $vectors | Export-Csv (Join-Path $program.FullName 'vectors-hex.csv') -NoTypeInformation
 $metadata=Import-Csv (Join-Path $program.FullName 'metadata.csv')
 if(!($metadata | Where-Object {$_.kind -eq 'space' -and $_.name -eq 'code' -and $_.value -eq '2'})){throw 'Program code is not word addressed'}
 if(!($metadata | Where-Object {$_.kind -eq 'space' -and $_.name -eq 'mem' -and $_.value -eq '1'})){throw 'Data space is not byte addressed'}
 $instructions=@(Import-Csv (Join-Path $program.FullName 'instructions.csv'))
 $checked=0
 foreach($i in $instructions) {
  if($i.address -notmatch '^code:([0-9a-fA-F]+)$'){continue}
  [long]$byteAddress=2*[Convert]::ToInt64($Matches[1],16)
  for($n=0;$n -lt $i.bytes.Length;$n+=2){$addr=$byteAddress+$n/2; if(!$memory.ContainsKey($addr)){throw "Instruction outside HEX at $($i.address)"}; if($memory[$addr] -ne [Convert]::ToByte($i.bytes.Substring($n,2),16)){throw "Word/byte mismatch at $($i.address)"}}
  $checked++
 }
 if($checked -eq 0){throw 'No instructions checked'}
 foreach($file in 'functions.csv','calls.csv','references.csv','vector-candidates.csv','decompiler-status.csv','opcodes.csv'){if(@(Import-Csv (Join-Path $program.FullName $file)).Count -eq 0){throw "Empty export $file"}}
 $dot=[Collections.Generic.List[string]]::new(); $dot.Add('digraph calls {')
 foreach($edge in Import-Csv (Join-Path $program.FullName 'calls.csv')) {$dot.Add(('"{0}" -> "{1}" [label="{2}"];' -f $edge.caller,$edge.target,$edge.site))}
 $dot.Add('}'); $dot | Set-Content (Join-Path $program.FullName 'calls.dot')
 $registerCsv=Get-ChildItem (Join-Path $RunDirectory 'exports') -Filter ($program.Name+'-xmega-register-references-*.csv') | Select-Object -Last 1
 if(!$registerCsv -or @(Import-Csv $registerCsv.FullName).Count -eq 0){throw 'No register references exported'}
 # Generic XMEGA symbols can also occur in code space (for example an LPM
 # reference mislabeled DMA_CH2). Preserve the raw exporter, but exclude
 # non-data-space and non-read/write candidates from the MMIO evidence set.
 $mmio=@(Import-Csv $registerCsv.FullName | Where-Object {$_.register_address -match '^mem:' -and $_.access -in 'READ','WRITE','READ_WRITE'})
 $mmio | Export-Csv (Join-Path $program.FullName 'mmio-evidence.csv') -NoTypeInformation
 $mmio | Group-Object category,access | Select-Object Count,Name | Export-Csv (Join-Path $program.FullName 'register-summary.csv') -NoTypeInformation
 $results += [pscustomobject]@{program=$program.Name;hexBytes=$memory.Count;instructionsCompared=$checked;codeUnitBytes=2;dataUnitBytes=1;status='PASS'}
}
$results | ConvertTo-Json | Set-Content (Join-Path $RunDirectory 'validation.json')
$results | Format-Table
