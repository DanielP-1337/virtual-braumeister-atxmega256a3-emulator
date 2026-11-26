# TCD1 waveform control and the first clock-select write

BrewControl 1.1.27 completed the write of `0x33` to TCD1.CTRLB at word `0x007B06` in the erased-EEPROM run with the explicit oscillator profile. This selected single-slope PWM on channels A and B. The next instruction, at word `0x007B07`, attempted to start TCD1 with the undivided peripheral clock. It stopped on the unmapped TCD1.CTRLA register.

## Register and UPDATE behavior

The installed non-U ATxmega256A3 device pack maps TCD1 to `0x0940` and CTRLB to offset `0x01`. CTRLB resets to `0x00`. The write `0x33` sets CCAEN (bit 4), CCBEN (bit 5), and WGMODE `011`. In single-slope PWM the counter counts up through PER, then wraps to zero on the following input edge. This transition to BOTTOM generates UPDATE. Normal mode generates UPDATE at TOP. The output-enable bits govern pin routing. Each channel’s buffer-valid flag and the shared LUPD lock govern automatic buffer transfers. **Confidence is high** for these device capabilities and register semantics. [A3 peripheral map, p. 56](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=56) · [XMEGA A waveform table 14-4, p. 164](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=164) · [Compare buffering, p. 154](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=154)

Independent tests fed input edges to the TCD1 counter with `PER = 3`. The active compare words remained distinct from their pending replacements through TOP. Both valid flags cleared at BOTTOM. [Synthetic tests](../../tests/tcd1-ctrlb.test.mjs)

| Edges since mode selection | CNT | Active CCA | Active CCB | CCABV / CCBBV |
| ---: | ---: | ---: | ---: | --- |
| 0 | 0 | `0x1731` | `0x2862` | set / set |
| 3 | 3 (TOP) | `0x1731` | `0x2862` | set / set |
| 4 | 0 (BOTTOM) | `0x31A7` | `0x42B8` | clear / clear |

The eleven tests exercised all 256 register bytes, all enable and validity combinations, LUPD, forced UPDATE, mode changes, and a staged low byte across BOTTOM. An independent one-edge-at-a-time calculation checked batched counts, including zero and maximum periods and a period change below the current count. The firmware runner supplied no synthetic TCD1 clock edges. Frequency and dual-slope modes have explicit unsupported-mode diagnostics. [Independent tests](../../tests/tcd1-ctrlb.test.mjs) · [Waveform model](../../src/peripherals/timer-waveform.mjs)

## Firmware evidence

The private Ghidra instruction listing agrees with the fetched bytes and register operands. The verifier checked the before/after CPU state, the MMIO inventory, and the separate peripheral event. PCs count 16-bit flash words. The flash and data addresses below count bytes.

| Word PC | Instruction | Data byte | Result |
| --- | --- | --- | --- |
| `0x007B06` | `STD Z+1,R25` | `0x0941` | Retired at emulator clock 4,706,447. CTRLB changed from `0x00` to `0x33`. |
| `0x007B07` | `ST Z,R24` | `0x0940` | Attempt 2,872,957 requested `TCD1.CTRLA = 0x01`. `UNHANDLED_MMIO` stopped the instruction before retirement. |

Z held `0x0940`, R25 held `0x33`, R24 held `0x01`, SP was `0x5FF3`, and SREG was `0x00`. TCD0 advanced from 15 to 17 during the completed store. TCD1 remained at zero with `PER = 0x0FFF` and both buffered zeros still valid. Selecting the waveform at zero produced no count edge or transfer.

The non-U A3 pin table assigns OC1A to PD4 and OC1B to PD5. PORTD.DIR was `0xFF`, so the run reports the TCD1 waveform generator as the output source for both pins. The instantaneous pin levels and external loads remain unresolved. TCD0 retained ownership of PD2 and PD3. [A3 port D functions, p. 52](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=52)

## Regression and reset runs

**433 of 433 tests passed**, including all 422 previous tests. Each firmware scenario ran twice from the original reset vector and reproduced its trace and peripheral events.

| Inputs | Retired instructions | From main | Distinct application word PCs | Emulator clocks | First controlled stop |
| --- | ---: | ---: | ---: | ---: | --- |
| Unknown EEPROM and oscillator startup | 46,741 | 59 | 59 | 61,988 | `UNKNOWN_EEPROM_DATA` at word `0x014E8C`, EEPROM offset `0x0000` |
| Simulated erased EEPROM, unknown oscillator startup | 2,872,372 | 2,825,690 | 578 | 4,705,639 | `OSC_STARTUP_TIMING_UNKNOWN` at word `0x007A52` |
| Simulated erased EEPROM, 12 / 640 reset-clock oscillator profile | 2,872,956 | 2,826,274 | 687 | 4,706,447 | `UNHANDLED_MMIO` at word `0x007B07`, TCD1.CTRLA |

The strict run retained zero known EEPROM bytes. The first two full trace hashes matched their previous runs. The timed run matched all 2,872,955 previously retired instructions before advancing one instruction and two emulator clocks. Its trace SHA-256 is `8c02f126fc9af250730b9d6218994628b06aa7b4dbd63616a9b64dea0fa1e8d1`. The two erased-EEPROM discovery commands returned native exit code 2.

The audit verified the 58 prior test files, 11 historical trace hashes and 16 original firmware and Ghidra files. Every run reproduced PoC 001 at 46,682 instructions and 61,883 emulator clocks, SHA-256 `35acd0fd70ed3ebd11a009bcfb756dc1b8b94bb120dbc4b351a36a948305f722`. The separate direct-I/O LDS probe still measures one emulator clock against the documented two. The newly retired instruction was STD. [Microchip LDS timing](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-42EBE7FA-6359-4986-827E-28F00A3B2FAF.html)

## Next hardware requirement

Implement TCD1.CTRLA at `0x0940` and connect its reset-off clock selector to the counter. The verified attempted value `CLKSEL = 1` requests `clkPER/1`. Exercise the enable edge, counting on subsequent peripheral edges, stopping, prescaling, and the first BOTTOM transfer of both pending words. A complete application boot remains unverified. [XMEGA A clock selection, p. 163](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=163)

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
