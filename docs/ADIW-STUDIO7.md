# ADIW on the ATxmega256A3

Atmel Studio 7.0.2389 and the JavaScript emulator agreed on all eight synthetic `ADIW` cases for the ATxmega256A3. Each instruction advanced the PC by one word and took **two cycles** in both engines. A separate run from reset recorded all 32 general-purpose registers and the complete SREG before and after each addition. **All 528 bytes matched**. The first Studio register export and a separate observation of single-stepping over an SREG write are preserved below. [Measured SRAM comparison](../private/poc-002r-adiw/sram-comparison.json)

## Target and fixture

Studio ran the AVR8 simulator on Windows 11. The saved debug project selects `ATxmega256A3`, expected signature `0x1E9842`, and tool `Simulator`. The installed XMEGAA device pack is `1.1.68`. Its device description assigns the A3 model key to a shared model file named `libatxmega256a3u.dll` (version `7.0.0.97`). The project target and the pack mapping establish the A3 selection. All measurements used synthetic assembly. [Studio project](../private/poc-002r-adiw/ObjProject1/ObjProject1/ObjProject1.objproj) · [Microchip device packs](https://packs.download.microchip.com/)

The fixture starts at reset, initializes R0–R31, loads each operand and incoming SREG, and executes one `ADIW` followed by a labeled `NOP`. The generated HEX has SHA-256 `6e74ddc4bf4da30abeef346e57c107ce2005bee592c3503b909a26e34a1310c4`. GNU objdump reports flash byte addresses. The Studio Autos PC and the JavaScript PC below count 16-bit words. [Assembly](../verification/studio7-adiw/asm/adiw-studio.S) · [Private disassembly](../private/poc-002r-adiw/fixture/adiw-studio.lst)

## Instruction measurements

Cases 1–3 and 4–8 were collected in separate runs from reset. Case 7 was also replayed from reset with the setup running through the SREG write. The Studio disassembly address box accepted flash **byte** addresses during this measurement. Entering `0x0068` selected the instruction displayed at word PC `0x0034`. The address box only navigates the view.

PC, opcodes, pairs, and SREG are hexadecimal. Counters and immediates are decimal. The pair column gives the JavaScript register measurement. The SREG column gives the observed byte in **both** simulators for the run to each ADIW breakpoint. The independent Studio reads came from data address `0x003F` in Memory 4. Absolute counter readings differ across the two environments and the offset varies between cases. The instruction duration is the difference between the readings on the same row within one simulator. [Studio Autos export](../private/poc-002r-adiw/studio-autos.txt) · [Studio SREG observations](../private/poc-002r-adiw/studio-sreg.tsv) · [JavaScript observations](../private/poc-002r-adiw/emulator.json)

| Case | Word PC before → after | First flash byte | Opcode | Pair, K | JS pair before → after | SREG before → after | Studio cycles | JS cycles |
|---|---|---|---|---|---|---|---|---|
| 1 | 0034 → 0035 | 0068 | 9600 | R25:R24, 0 | 0000 → 0000 | FF → E2 | 53 → 55 | 52 → 54 |
| 2 | 003A → 003B | 0074 | 9611 | R27:R26, 1 | 00FF → 0100 | 7F → 60 | 61 → 63 | 59 → 61 |
| 3 | 0040 → 0041 | 0080 | 9621 | R29:R28, 1 | 7FFF → 8000 | F3 → EC | 69 → 71 | 66 → 68 |
| 4 | 0046 → 0047 | 008C | 9631 | R31:R30, 1 | FFFF → 0000 | 3C → 23 | 77 → 79 | 73 → 75 |
| 5 | 004C → 004D | 0098 | 96CF | R25:R24, 63 | 7FC1 → 8000 | DF → CC | 85 → 87 | 80 → 82 |
| 6 | 0052 → 0053 | 00A4 | 9690 | R27:R26, 32 | FFFF → 001F | AF → A1 | 93 → 95 | 87 → 89 |
| 7 | 0058 → 0059 | 00B0 | 9620 | R29:R28, 0 | 8000 → 8000 | 0B → 14 | 100 → 102 | 94 → 96 |
| 8 | 005E → 005F | 00BC | 9670 | R31:R30, 16 | FFFE → 000E | 5F → 41 | 108 → 110 | 101 → 103 |

Microchip specifies a six-bit immediate and the four destination pairs used here. `ADIW` updates S, V, N, Z and C. It preserves I, T and H. The AVRxm timing is two cycles. The cases exercise zero, sign change, signed overflow, unsigned wrap, carry between bytes, and preserved incoming flags. [Instruction definition](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-7A5798EA-3F95-4081-8525-4759B1BFD8A0.html) · [Flag definitions and timing](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-279C6223-582F-4696-A8CC-761B6989850C.html)

### Case 7 and the preceding OUT

In a second Studio execution path, single-stepping `OUT 0x3F,R16` at word `0x0057` (opcode `BF0F`, flash byte `0x00AE`) advanced the cycle counter from 99 to 100. R16 contained `0x0B`, and the Memory 4 reading for SREG changed from `0xA1` to `0x8B`. The following `ADIW R28,0` then changed SREG from `0x8B` to `0x94` in two cycles. Running directly to the ADIW breakpoint reproduced `0x0B → 0x14`. Bit 7 (I) accounts for the difference in both readings, and ADIW preserved that incoming bit on both paths. The reason for the different I-bit observation after OUT remains open. [Stepped-setup SREG capture](../private/poc-002r-adiw/studio-sreg-stepped.tsv) · [Stepped-setup comparison](../private/poc-002r-adiw/autos-comparison-stepped.json) · [Run-to-breakpoint SREG capture](../private/poc-002r-adiw/studio-sreg.tsv)

Starting the JavaScript emulator from reset and reading state on both sides of each instruction yielded `0xA1 → 0x0B` across OUT (cycles 93 → 94), followed by `0x0B → 0x14` across ADIW (94 → 96). R16 remained `0x0B` and R29:R28 remained `0x8000` throughout.

### Register evidence from Autos

The original comparator matched case 1 completely and reported GPR differences in cases 2–8. The exported CPU group includes stale off-screen rows. At case 2, the live system-register X changed from `0x00FF` to `0x0100` across ADIW. In the same two frames the separate R27 and R26 rows both times reported `0xAB` and `0xAA`. These values cannot describe the same X register at the same instant. The PC, cycle counter and X/Y/Z rows refreshed. The contradiction prevents a conclusion about preservation of all 32 GPRs from this export. The comparator retains every original value and the seven failed cases. [Raw Studio frames](../private/poc-002r-adiw/studio-autos.txt) · [Original strict comparison](../private/poc-002r-adiw/autos-comparison.json)

## Reproduction and regressions

1. From the emulator workspace, build the synthetic assembly into a new private directory using `verification\studio7-adiw\scripts\Build-AdiwStudio.ps1 -Output .\private\adiw-studio-build`. Verify the HEX hash above. Open the generated ELF in Studio using **File → Open → Open Object File for Debugging**. Select **ATxmega256A3** and **Simulator**, and save the debug project under the private directory.
2. Select **Start Debugging and Break**. Open **Disassembly**, **Processor Status**, **Autos**, and **Memory 4**. In Memory 4 select data address `0x003F`. Set breakpoints at the eight ADIW labels. Run to each label, record word PC, cycle counter, register rows and the independently visible SREG byte, then single-step in Disassembly and repeat at the labeled NOP. For the alternate case 7 path, also break and step at word `0x0057`. [Studio simulator debugging](https://onlinedocs.microchip.com/oxy/GUID-ECD8A826-B1DA-44FC-BE0B-5A53418A47BD-en-US-12/GUID-C73F1111-250E-4106-B5E5-85A512B75E8B.html) · [Disassembly view](https://onlinedocs.microchip.com/oxy/GUID-ECD8A826-B1DA-44FC-BE0B-5A53418A47BD-en-US-12/GUID-BEFC7814-CC09-49EC-98D7-31941D00237A.html)
3. Save Autos rows and a two-column SREG TSV (`pcWord`, `sreg`). The following PowerShell commands replay the saved first-fixture comparison. The comparator returns exit code 1 for the recorded GPR mismatch and exit code 2 for an invalid capture.

```powershell
$p = '.\private\poc-002r-adiw'
$s = '.\verification\studio7-adiw\scripts'
$hex = "$p\fixture\adiw-studio.hex"
node "$s\parse-studio.mjs" "$p\studio-autos.txt" "$p\studio-sreg.tsv" $hex 7.0.2389 |
    Set-Content -Encoding utf8 "$p\studio-replay.json"
if ($LASTEXITCODE -ne 0) { throw 'Invalid Studio input' }
node "$s\compare-adiw.mjs" $hex "$p\studio-replay.json"
```

The existing project regression suite passed **130 of 130** tests. The focused ADIW suite passed all five groups, including an independent byte-wise oracle over all 4,194,304 input-word and immediate combinations. Run `node --test tests/adiw.test.mjs` from the emulator workspace to repeat the focused suite. [Regression log](../private/poc-002r-adiw/regressions.tap) · [ADIW test log](../private/poc-002r-adiw/adiw.tap)

## Independent SRAM register capture

The second fixture contains the same eight ADIW opcodes and operands. It uses absolute stores to copy R0–R31 into internal SRAM, reads SREG with `IN`, then restores the temporary R16 from its saved byte. All capture instructions preserve the flags. Each of the 16 records contains 32 GPR bytes followed by SREG. The eight pairs of records occupy data byte addresses `0x2000–0x220F`. [Assembly](../verification/studio7-adiw/sram/adiw-sram.S) · [GNU disassembly](../private/poc-002r-adiw/sram-fixture/adiw-sram.lst)

The Studio simulator ran the instrumented ELF from reset until its terminal self-loop. **Break All** showed word PC `0x04A8` at that loop (flash byte `0x0950`). Two overlapping views of Studio's data memory at `0x2000,data` and `0x2160,data` supplied the bytes in address order. Their overlap agreed. The independent JavaScript run checked the saved bytes against the actual CPU state on either side of each ADIW. It first reached the self-loop after 648 instructions and 1,200 cycles. Studio had already executed the self-loop when paused, so only the original timing fixture supplies the Studio instruction durations. [Studio project](../private/poc-002r-adiw/SramProbe/SramProbe.objproj) · [Studio SRAM bytes](../private/poc-002r-adiw/studio-sram.txt)

The SRAM comparison returned `RAM_MATCH` with zero differences across 512 GPR bytes and 16 SREG bytes. The SHA-256 of the 528 binary data bytes is `0f4b2e6ee15a582cad76e088d14918966eee3eba502c8dc4507b3d626fcb78ff` on both sides. The HEX SHA-256 is `17c81735e5cf3c6b3a31a6269a745ebb6bde0e17690d75a1eea2ea24d9dac26c`. This run also produced `0x0B → 0x14` in case 7. [Machine-readable result](../private/poc-002r-adiw/sram-comparison.json)

From the emulator project root, reproduce the byte comparison or build a fresh ELF for another Studio run.

```powershell
$fixture = '.\private\poc-002r-adiw'
$check = '.\verification\studio7-adiw\sram'
node "$check\compare-sram.mjs" "$fixture\sram-fixture\adiw-sram.hex" "$fixture\studio-sram.txt"
& "$check\Build-AdiwSram.ps1" -OutputDirectory '.\private\adiw-sram-rebuild'
```

The measurements cover the four legal destination pairs and five immediates. Real-device timing and the source of the differing absolute cycle counters remain open. The focused exhaustive JavaScript tests provide the broader arithmetic coverage. [Microchip simulator guide](https://onlinedocs.microchip.com/oxy/GUID-ECD8A826-B1DA-44FC-BE0B-5A53418A47BD-en-US-12/GUID-C73F1111-250E-4106-B5E5-85A512B75E8B.html)

## Follow-up on the SREG observation

A separate four-case OUT probe reproduced the step-mode display of 0x8B. With Studio interrupt masking disabled during stepping, the display and the next IN both showed 0x0B. Breakpoint measurements also confirmed one additional clock for writes to SREG that change I. The corrected emulator matched the original 528-byte ADIW capture. The cycle totals above describe the emulator version used for the original experiment. [OUT timing and Studio step-mode measurements](OUT-SREG-STUDIO7.md)

## Absolute cycle counts in cases 6 and 8

A fresh Atmel Studio 7.0.2389 ATxmega256A3 Simulator run on November 24, 2026 reproduced both absolute counter pairs predicted by the corrected emulator. The same synthetic ELF ran from word zero with the existing device selection. The archived HEX SHA-256 is `6e74ddc4bf4da30abeef346e57c107ce2005bee592c3503b909a26e34a1310c4`. In the reference run, F5 continued to each disassembly breakpoint. Word PCs and register pairs are hexadecimal below. Cycle counts are decimal.

| Checkpoint | Word PC | Studio, F5 only | Emulator | Studio, one F11 at word 0051 |
|---|---|---:|---:|---:|
| Before the OUT preparing case 6 | 0051 | 91 | 91 | 91 |
| Before ADIW X,32 | 0052 | 92 | 92 | 92, then 93 at the same PC |
| After ADIW X,32 | 0053 | 94 | 94 | 95 |
| Before ADIW Z,16 | 005E | 107 | 107 | 108 |
| After ADIW Z,16 | 005F | 109 | 109 | 110 |
| First arrival at the terminal loop | 0060 | 110 | 110 | 111 |

The expected absolute counts can also be calculated from the assembly. Every instruction before word `0x0060` occupies one word and takes one base clock. Add one clock per earlier ADIW and one per earlier OUT that changes SREG.I. At word `0x0052` that gives 82 + 5 + 5 = 92. At word `0x005E` it gives 94 + 7 + 6 = 107. The F5 run reached all 12 recorded checkpoints at their expected counts. [Assembly](../verification/studio7-adiw/asm/adiw-studio.S) · [F5 observations](../private/studio7-adiw-replay/continue.json) · [F5 comparison](../private/studio7-adiw-replay/continue-comparison.json)

### How Studio can add one count at a breakpoint

A second run used the same breakpoints and changed one action. At word `0x0051` (`OUT 0x3F,R16`), F11 landed on the existing ADIW breakpoint at word `0x0052`, count 92. F5 stopped **again at word `0x0052`**, now at count 93. Both stops showed X = `0xFFFF`. The next F5 reached word `0x0053` at count 95 with X = `0x001F`. ADIW had advanced one word, changed X once and taken two clocks between the last two stops. The extra count persisted through case 8 and the terminal loop. An independent reset reproduced the three critical PC, counter and X readings. The last three frames of the raw Autos export are from that repeat. The first two frames are copies of the same exploratory measurement at word `0x0058`. [Direct Studio register export](../private/studio7-adiw-replay/studio-autos-raw.txt) · [Single-step observations](../private/studio7-adiw-replay/single-step.json) · [Absolute differences](../private/studio7-adiw-replay/single-step-comparison.json)

The one-step run reproduces the older numerical discrepancy in cases 6 and 8. The archival capture combines multiple runs and omits the debugger command sequence between observations. It cannot establish that the same sequence occurred originally. The debugger-specific count is excluded from the CPU model. The full test suite passed **133/133**. Replaying the independent SRAM comparison matched all **528 register and SREG bytes** against the original Studio capture. [Regression log](../private/studio7-adiw-replay/all-tests.tap) · [SRAM replay](../private/studio7-adiw-replay/adiw-sram.json)

To reproduce the comparison from the emulator workspace, use the archived fixture and the two independent captures. The second command returns exit code 1 because the Studio single-step sequence contains measured differences from architectural cycle counts.

```powershell
$fixture = '.\private\poc-002r-adiw\fixture\adiw-studio.hex'
$probe = '.\verification\studio7-adiw\scripts\compare-breakpoints.mjs'
$run = '.\private\studio7-adiw-replay'
node $probe $fixture "$run\continue.json"
node $probe $fixture "$run\single-step.json"
```

