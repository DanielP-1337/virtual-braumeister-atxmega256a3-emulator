# TCD1 channel B compare buffer

With simulated erased EEPROM and the explicit oscillator timing profile, BrewControl 1.1.27 committed `TCD1.CCBBUF = 0x0000`. Channel A already had a pending word. Both valid flags were set when the next hardware access stopped at word PC `0x007B06`. The instruction attempted to write `0x33` to `TCD1.CTRLB` at data byte `0x0941`.

## Independent compare channels

| Resource | Channel A | Channel B |
| --- | --- | --- |
| Active register, low / high data byte | CCA at `0x0968 / 0x0969` | CCB at `0x096A / 0x096B` |
| Buffer, low / high data byte | CCABUF at `0x0978 / 0x0979` | CCBBUF at `0x097A / 0x097B` |
| Valid flag in CTRLGCLR / CTRLGSET (`0x094A / 0x094B`) | CCABV, bit 1 (`0x02`) | CCBBV, bit 2 (`0x04`) |

The non-U ATxmega256A3 device pack identifies TCD1 as a TC1 instance at `0x0940`. The two channels share TCD1’s CPU TEMP at `0x094F` and the update lock LUPD. A low-byte write stages TEMP. The high-byte write commits the staged byte and the supplied high byte to the addressed buffer, setting that channel’s valid flag even for a zero word. On an unlocked compare-mode UPDATE, each valid buffer transfers to its own active register and its flag clears. An invalid buffer leaves the corresponding active register intact. The model accepts software UPDATE via `0x04` in CTRLFSET (`0x0949`). **Confidence is high** for the register addresses and these compare-mode semantics. [A3 address map, p. 56](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=56) · [CPU byte accesses, p. 13](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=13) · [Compare buffering, p. 154](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=154) · [Control aliases, pp. 167–168](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=168)

The ten new synthetic tests covered all 65,536 B buffer values, all four A/B validity combinations, either write order, interleaved TEMP accesses, lock and unlock, TC1 reset, and MMIO registration collisions. In an AVR instruction test, the first UPDATE transferred `0x82A7` into CCB while CCA held `0x193E`. Revalidating A and issuing a second UPDATE transferred `0x15C3` into CCA while CCB held `0x82A7`. Another test reached BOTTOM on TCD0 with both TCD1 buffers still pending. [Independent tests](../../tests/tcd1-ccbbuf.test.mjs)

## Firmware execution

Z held `0x0940` and R1 held zero throughout this extension. The verifier checked the instruction bytes against the local Ghidra listing, the complete CPU state before and after retirement, and the separate peripheral-access log. Word PCs below count 16-bit words. Flash and data addresses count bytes.

| Word PC | Instruction | Outcome | Cumulative emulator clocks |
| --- | --- | --- | ---: |
| `0x007B03` | `STD Z+58,R1` | Wrote `0x00` to CCBBUFL. CCABV was set and CCBBV was clear. | 4,706,442 |
| `0x007B04` | `STD Z+59,R1` | Wrote `0x00` to CCBBUFH. Both buffers were now valid. | 4,706,444 |
| `0x007B05` | `LDI R25,0x33` | R25 changed from `0xC3` to `0x33`. | 4,706,445 |
| `0x007B06` | `STD Z+1,R25` | `UNHANDLED_MMIO` writing `0x33` to TCD1.CTRLB. Attempt 2,872,956 stopped before retirement. | 4,706,445 |

Both active TCD1 compare words were zero at the stop. The set CCABV and CCBBV flags show that the committed values were still pending. The observed firmware path contains no TCD1 UPDATE transfer. TCD0 advanced from count 10 to 15 at `clkPER/1` and retained its pending C/D flags. Both timers held `PER = 0x0FFF`. The CPU stopped with `SP = 0x5FF3` and `SREG = 0x00`.

## Regression and three reset runs

**422 of 422 tests passed**, including all 412 previous tests. Each firmware scenario ran twice from the original reset vector with deterministic replay.

| Inputs | Retired instructions | From main | Distinct application word PCs | Emulator clocks | First controlled stop |
| --- | ---: | ---: | ---: | ---: | --- |
| Unknown EEPROM and oscillator startup | 46,741 | 59 | 59 | 61,988 | `UNKNOWN_EEPROM_DATA`, word `0x014E8C`, EEPROM offset `0x0000` |
| Simulated erased EEPROM, unknown oscillator startup | 2,872,372 | 2,825,690 | 578 | 4,705,639 | `OSC_STARTUP_TIMING_UNKNOWN`, word `0x007A52` |
| Simulated erased EEPROM, 12 / 640 reset-clock oscillator profile | 2,872,955 | 2,826,273 | 686 | 4,706,445 | `UNHANDLED_MMIO`, word `0x007B06`, TCD1.CTRLB |

The strict run retained zero known EEPROM bytes. The first two complete trace hashes matched the previous milestone. In the timed run the bytes for all 2,872,952 previously retired instructions matched the archived trace, and three further instructions retired in five emulator clocks. The timed trace SHA-256 is `0fa36f61440563e9f9c26005a005f9abf14787090da1eba004d34188da7aa83f`. Both erased-EEPROM commands returned native exit code 2. All three runs reproduced PoC 001 at 46,682 instructions and 61,883 emulator clocks, SHA-256 `35acd0fd70ed3ebd11a009bcfb756dc1b8b94bb120dbc4b351a36a948305f722`.

The audit checked 57 prior test files, 11 historical trace hashes, and the hashes of all 16 original firmware and Ghidra files. A separate direct-I/O `LDS` probe still measures one emulator clock against the documented two. The new instructions were two `STD` stores and one `LDI`. [Microchip LDS timing](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-42EBE7FA-6359-4986-827E-28F00A3B2FAF.html)

## Next hardware requirement

**Verified attempted configuration.** `0x33` encodes CCAEN (`0x10`), CCBEN (`0x20`), and WGMODE `0x03` for single-slope PWM with PER as TOP and UPDATE at BOTTOM. The emulator stopped before applying the control write. The next milestone is TCD1.CTRLB, including channel-enable readback and single-slope update timing. TCD1 waveform output, connected devices, and complete application boot remain unverified. [Waveform table 14-4, p. 164](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=164)

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
