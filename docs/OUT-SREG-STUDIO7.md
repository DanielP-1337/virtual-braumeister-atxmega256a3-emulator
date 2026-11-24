# Writing SREG on the ATxmega256A3

On November 24, 2026, Atmel Studio 7.0.2389 and the corrected JavaScript CPU agreed on all four interrupt-enable transitions. Writing SREG through its I/O address takes one extra clock whenever bit 7 changes. The previously observed value `0x8B` appeared in Studio's single-step display with interrupt masking enabled. The test program itself read back `0x0B`.

## Four measured writes

The device was **ATxmega256A3** with **Simulator** selected. A 98-byte synthetic program started at reset with no enabled peripheral interrupt sources. Every measurement below used the same instruction, `OUT 0x3F,R16` (word `0xBF0F`). Studio and the emulator executed the same program bytes. The data-space address of CPU.SREG is `0x003F`. The XMEGA A manual specifies the additional clock for an I/O write that changes I, on top of the single AVRxm clock for OUT. [XMEGA A manual, §3.14.9, p. 17](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=17) · [ATxmega A3 datasheet, peripheral address map](https://www.microchip.com/content/dam/mchp/documents/OTH/ProductDocuments/DataSheets/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=56) · [Microchip AVR instruction timing](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-BA59618D-4850-490B-B176-0BCC3D9438A1.html)

| Word PC before → after | OUT flash byte | SREG before → program readback (hex) | I before → after | Studio counter before → after (decimal) | Studio clocks | Emulator clocks |
|---|---|---|---|---|---:|---:|
| 0x0004 → 0x0005 | 0x0008 | A1 → 0B | 1 → 0 | 5 → 7 | 2 | 2 |
| 0x0010 → 0x0011 | 0x0020 | 53 → AC | 0 → 1 | 18 → 20 | 2 | 2 |
| 0x001C → 0x001D | 0x0038 | B6 → C9 | 1 → 1 | 31 → 32 | 1 | 1 |
| 0x0028 → 0x0029 | 0x0050 | 65 → 1A | 0 → 0 | 44 → 45 | 1 | 1 |

Cycle readings came from **Continue (F5)** to breakpoints at adjacent instruction addresses. The first two endpoints were collected in separate runs from reset. The other three pairs were measured within a run for each pair. At the first arrival at word `0x0030`, both simulators showed **52 clocks**. The JavaScript trace contained 36 completed instructions. The previous emulator reached the same word after 48 clocks. Two target writes and two setup writes changed I. [Studio observations](../private/studio7-out/studio-observations.json) · [Before correction](../private/studio7-out/before.json) · [Comparison with measured endpoints](../private/studio7-out/verified.json)

For a separate state check, IN sampled SREG before and immediately after each target OUT. The program saved the two samples and the source operand to SRAM. Running freely from reset produced `A1 0B 0B  53 AC AC  B6 C9 C9  65 1A 1A` at data bytes `0x2000–0x200B`. All 12 bytes matched the emulator. [Assembly](../verification/studio7-out/asm/out-sreg.S) · [Studio SRAM capture](../private/studio7-out/studio-free.txt)

## Why the single-step display showed 0x8B

Each trial began at word `0x0004`, clock 5, with SREG at `0xA1` and R16 at `0x0B`. Only the Studio setting **Tools → Options → Tools → Tool settings → Mask interrupts while stepping** varied. [Microchip guide showing this option](https://ww1.microchip.com/downloads/en/DeviceDoc/AVR128DA48-Curiosity-Nano-UG-DS50002971A.pdf#page=19)

| Setting | After one F11 | After a second F11 | SREG sampled by the program's IN |
|---|---|---|---|
| True | Word 0x0006, clock 7, displayed 0x8B | — | 0x0B |
| False | Word 0x0005, clock 7, displayed 0x0B | Word 0x0006, clock 8, displayed 0x0B | 0x0B |

With masking enabled, a single F11 advanced past both OUT and IN. That step cannot isolate the timing of OUT. The F5 measurements and the program's SRAM records independently establish the instruction timing and the value seen by the next instruction. The original Studio option was restored to True after the trials.

## Implementation and regressions

The data bus computes the wait from the previous and new I bits when a write reaches SREG. The CPU charges it to the instruction that completed the write. This covers OUT, STS and the supported indirect ST/STD forms. Three new synthetic test groups exercise these encodings, changes to unrelated flags, and fault paths. The Studio comparison directly measured OUT. The other store encodings were checked against the documented register behavior in the JavaScript tests. [Memory bus](../src/memory-bus.mjs) · [CPU](../src/xmega.mjs) · [Synthetic tests](../tests/sreg-io-wait.test.mjs)

- **133/133 tests passed**, including all 130 existing tests. [Test log](../private/studio7-out/regressions.tap)
- **ADIW** still matched the earlier Studio capture across 528 GPR/SREG bytes. The instrumented program took 648 instructions and 1,206 clocks in the corrected emulator. The earlier eight ADIW comparisons measured two clocks each. [ADIW replay](../private/studio7-out/adiw-regression.json) · [Original Studio comparison](ADIW-STUDIO7.md)
- **BrewControl 1.1.27** reached word `0x007B43` from reset after 46,682 instructions and 61,883 clocks. Two runs reproduced the original SHA-256 trace digest `35acd0fd70ed3ebd11a009bcfb756dc1b8b94bb120dbc4b351a36a948305f722`. [PoC 001 regression result](../private/studio7-out-poc001/result.json)
- **Strict application discovery** reproduced the archived full trace and the controlled stop after 46,741 instructions (59 in the application) and 61,988 clocks. At word `0x014E8C` (flash byte `0x029D18`), `LD R24,Z` (opcode `0x8180`) attempted to read data address `0x1000`. EEPROM offset `0x0000` has no supplied byte, so the instruction did not retire. SHA-256 of the full trace was `586c8a3cddec681d364fa0946b1a93c10e3a33f1e16279633f9c5c3cdd5b86b1`. [Strict run](../private/studio7-out-strict/result.json)

Replaying the older ADIW debugger export with the corrected CPU reproduced all eight two-clock instruction durations. Six absolute counter pairs matched. In cases 6 and 8 the older Studio counters were one clock ahead at both endpoints. That offset remains unexplained. The strict comparison of the older Autos export still flags seven cases for its stale register rows, as documented in the original report. The independent SRAM comparison above supplies the register values. [Replay of older Autos export](../private/studio7-out/adiw-counters.json)

## Reproduction

From the emulator workspace, run the commands below with Node.js and the AVR GNU toolchain. To repeat the Studio observations, open the synthetic ELF as a debugging object, select ATxmega256A3 and Simulator, reset, then use instruction breakpoints at the word PCs in the table. For the SRAM check, start a fresh run and set only the terminal breakpoint.

```powershell
& .\verification\studio7-out\scripts\Build-OutSreg.ps1 -OutputDirectory .\private\studio7-out-rebuild
$probe = '.\private\studio7-out'
node .\verification\studio7-out\scripts\compare-out.mjs .\private\studio7-out-rebuild\out-sreg.hex "$probe\studio-free.txt" "$probe\studio-observations.json"
node --test .\tests\sreg-io-wait.test.mjs
```

The subsequent ADIW replay matched the absolute F5 counters in both previously discrepant cases and reproduced a one-count advance at an unchanged breakpoint PC. [Fresh Studio measurements](ADIW-STUDIO7.md#absolute-cycle-counts-in-cases-6-and-8)

