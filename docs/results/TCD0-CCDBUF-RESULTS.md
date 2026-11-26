# TCD0 channel D compare buffer

BrewControl 1.1.27 completed both stores to `TCD0.CCDBUF` in the erased-EEPROM run with the explicit oscillator timing profile. At the stop, channels C and D each held a pending zero and their valid flags were both set. The next instruction attempted to write `0xC3` to `TCD0.CTRLB` at data byte `0x0901`. It stopped at word PC `0x007AFB`.

## Firmware instructions

| Word PC | Instruction and effect | Retired emulator clocks |
| --- | --- | ---: |
| `0x007AF6` | `STS 0x093E,R1` staged zero in D0 TEMP through CCDBUFL. CCDBV stayed clear and CCCBV stayed set. | 4,706,424 |
| `0x007AF8` | `STS 0x093F,R1` committed `CCDBUF = 0x0000` and set CCDBV. The model recorded both valid bits set (combined mask `0x18`). | 4,706,426 |
| `0x007AFA` | `LDI R25,0xC3` loaded the value for the next store. | 4,706,427 |
| `0x007AFB` | `STD Z+1,R25` attempted to write `0xC3` to `0x0901`. The MMIO registry returned `UNHANDLED_MMIO` before retirement. | 4,706,427 |

The audit compared all four encodings with the local Ghidra listing, checked the flash fetches and calculated the complete CPU state after each retired instruction. At attempt 2,872,945, Z was `0x0900`, R1 was zero, SP was `0x5FF3`, and SREG was zero. The firmware had issued no UPDATE command and D0's clock was off. Both active compare registers still held their reset value. Confidence is high for the path, register identities, and pending state under these inputs.

## Register behavior and independent tests

| TCD0 register | Data bytes | Behavior tested |
| --- | --- | --- |
| TEMP | `0x090F` | One CPU byte latch shared by D0's period, active compare registers, and buffers. TCC0 has its own latch. |
| CCC and CCCBUF | `0x092C–0x092D`, `0x093C–0x093D` | Channel C keeps its pending word and flag independently of D. |
| CCD and CCDBUF | `0x092E–0x092F`, `0x093E–0x093F` | The low-byte write stages TEMP. The high-byte write commits the complete word. A buffer commit sets CCDBV, including a repeated or zero value. A low-byte read latches the high byte. |
| CTRLGCLR and CTRLGSET | `0x090A`, `0x090B` | Both aliases read the same valid bits. Bit 3 is CCCBV and bit 4 is CCDBV. Writes select which flags to clear or set. |
| CTRLFCLR and CTRLFSET | `0x0908`, `0x0909` | One LUPD bit (bit 1) locks both channels. An unlocked UPDATE copies each valid buffer to its own active word, clears the consumed flags, and retains the buffers. |

The non-U ATxmega256A3 device pack locates these registers on D0. The XMEGA A manual specifies the CPU byte order, the individual valid bits, and normal-mode UPDATE at TOP. A software UPDATE command also works with the counter stopped. [CPU byte access, §3.11](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=13) · [Double buffering, §14.5](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=154) · [Valid flags, §14.12.9](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=168) · [Forced UPDATE, AVR1306 §3.9.1](https://ww1.microchip.com/downloads/en/Appnotes/doc8045.pdf#page=9)

Nine synthetic tests exercise all 65,536 channel D words, all C/D flag-mask combinations, shared TEMP, reset, and precise faults. One test stages `0x5AA5` for C and `0x7BE1` for D with PER = 3 and `clkPER/4`. A locked TOP and a locked software command leave the old active words intact. At the next unlocked TOP, clock 28, the two distinct active values appear together and both flags clear. Separate tests verify software UPDATE with only C, only D, both, or neither valid. The inherited same-edge ordering processes TOP before a coincident high-byte write. Its ordering on silicon has not been measured. [Synthetic tests](../../tests/tcd0-ccdbuf.test.mjs) · [Shared compare implementation](../../src/peripherals/tc0-compare.mjs)

## Three scenarios from reset

| EEPROM and oscillator inputs | Retired instructions | From main | Unique application word PCs | Emulator clocks | First controlled stop |
| --- | ---: | ---: | ---: | ---: | --- |
| Unknown EEPROM and unknown startup timing | 46,741 | 59 | 59 | 61,988 | `UNKNOWN_EEPROM_DATA`, word `0x014E8C`, EEPROM offset `0x0000` |
| Simulated erased EEPROM and unknown startup timing | 2,872,372 | 2,825,690 | 578 | 4,705,639 | `OSC_STARTUP_TIMING_UNKNOWN`, word `0x007A52` |
| Simulated erased EEPROM and 12 / 640 reset-clock timing profile | 2,872,944 | 2,826,262 | 675 | 4,706,427 | `UNHANDLED_MMIO`, word `0x007AFB`, data byte `0x0901` |

All three scenarios replayed deterministically from the original reset vector. The strict run had zero known EEPROM bytes. The first two complete traces matched the previous milestone. The third reproduced all 2,872,941 previously retired instructions and added three different application PCs in five emulator clocks. All three reproduced the reset-to-main SHA-256 `35acd0fd70ed3ebd11a009bcfb756dc1b8b94bb120dbc4b351a36a948305f722` after 46,682 instructions and 61,883 clocks.

Additional runs in fresh Node processes reproduced both erased-EEPROM trace hashes and returned native exit code 2 for each controlled stop.

**382 of 382 tests passed** across the full suite, including all 373 previous tests. The audit checked 53 prior test files, 11 historical trace hashes, and 16 original firmware and Ghidra files. The separate direct-I/O LDS timing probe still measures one modeled clock against the documented two. The newly executed instructions were two STS and one LDI. Application boot remains incomplete. [Microchip LDS timing table](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-42EBE7FA-6359-4986-827E-28F00A3B2FAF.html)

## Next hardware requirement

Implement the attempted `TCD0.CTRLB` configuration. Its value `0xC3` requests CCDEN and CCCEN with WGMODE = 3 (single-slope PWM). The mode uses PER as TOP and transfers valid buffers at BOTTOM. The current run stopped before the control byte took effect. The trace provides no evidence about a connected device or a physical waveform. [Waveform mode table 14-4](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=164)

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
