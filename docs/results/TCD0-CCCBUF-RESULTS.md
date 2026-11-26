# TCD0 channel C compare buffer

BrewControl 1.1.27 wrote both bytes of `TCD0.CCCBUF` in the erased-EEPROM run with explicit oscillator timing. The high-byte store set the channel C buffer-valid flag even though the buffered word was zero. At the next instruction the emulator stopped on the low byte of the **channel D** buffer. Channel C still had a pending word at the stop.

## Register behavior and independent tests

| TCD0 data address | Register | Behavior in the model |
| --- | --- | --- |
| `0x090F` | TEMP | One CPU latch shared by the 16-bit registers on D0. C0 has its own latch. |
| `0x093C`, `0x093D` | CCCBUFL, CCCBUFH | A low-byte write stages its value in TEMP. A high-byte write commits both bytes to CCCBUF and sets CCCBV. A low-byte read latches the buffered high byte for a subsequent high-byte read. |
| `0x092C`, `0x092D` | CCCL, CCCH | Active compare word. An unlocked UPDATE copies the complete valid buffer here and clears CCCBV. The buffer retains its value. |
| `0x090A`, `0x090B` | CTRLGCLR, CTRLGSET | Both read the same valid state. Writing bit 3 (`0x08`) clears or sets CCCBV through the respective alias. |
| `0x0908`, `0x0909` | CTRLFCLR, CTRLFSET | Bit 1 controls the update lock, LUPD. Writing the UPDATE command (`0x04`) to CTRLFSET requests a transfer. |
| `0x0900` | CTRLA | D0 resets with its clock off. The supported internal prescaler selections drive its own counter. In normal up-counting mode the automatic UPDATE occurs when CNT reaches PER (TOP). |

The ATxmega256A3 device pack identifies the D0 instance at `0x0900`. CCC, CCCBUF, CCCBV, and LUPD reset to zero. The XMEGA A manual specifies the CPU's low/high byte sequence, the valid flag and the UPDATE point for normal mode. The model covers compare operation in this mode. Capture, PWM, external event clocks, and compare interrupts remain open. [ATxmega256A3 peripheral map](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=56) · [CPU access to 16-bit registers, §3.11](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=13) · [Double buffering, §14.5](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=154) · [Waveform modes, table 14-4](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=164) · [Control register definitions, §§14.12.8–9](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=167)

Ten synthetic tests cover all 65,536 buffer words, low/high readback, replacement of a pending word, the set/clear flag aliases, and isolation of the two timers. One test starts with active `0x1133`, pending `0xAA55`, PER = 3 and a divide-by-four clock. At emulator clock 59, CNT = 2, CCC = `0x1133`, and CCCBV = 1. At clock 60, CNT = 3, CCC = `0xAA55`, and CCCBV = 0. A separate synthetic AVR program requests a software UPDATE with the timer stopped and reads back `0x47B2` through both active register bytes. The lock test holds a pending word across both kinds of UPDATE. [Independent tests](../../tests/tcd0-cccbuf.test.mjs) · [Force update, AVR1306 §3.9.1](https://ww1.microchip.com/downloads/en/Appnotes/doc8045.pdf#page=9)

For a high-byte bus write on the exact TOP edge, the emulator transfers the previously valid word first, then commits the newly written word for the next UPDATE. A dedicated test fixes this deterministic ordering. It is a modeling convention. Its behavior on physical silicon has not been measured here. [Timer counter](../../src/peripherals/tc0-counter.mjs) · [Buffer implementation](../../src/peripherals/tc0-compare-c.mjs)

## Observed firmware instructions

| Word PC | Instruction and MMIO result | Emulator clocks completed |
| --- | --- | ---: |
| `0x007AF4` | `STD Z+60,R1` wrote zero at `0x093C`. TEMP changed from `0xFF` to `0x00`. CCCBV remained clear. | 4,706,420 |
| `0x007AF5` | `STD Z+61,R1` wrote zero at `0x093D`. CCCBUF became `0x0000` and CCCBV became 1. | 4,706,422 |
| `0x007AF6` | `STS 0x093E,R1` attempted to write zero to TCD0.CCDBUFL. The MMIO handler was absent. | 4,706,422 |

Attempt 2,872,942 ended with `UNHANDLED_MMIO` before the STS retired. R1 = `0x00`, Z = `0x0900`, SP = `0x5FF3`, and SREG = `0x00`. The executed prefix contains two new application PCs and four additional emulator clocks. The D0 clock was off throughout the run and the firmware issued no UPDATE command. At the stop CCC was still its reset value, with CCCBV = 1. The nonzero transfers above were observed in the synthetic tests. Confidence is high for the register identities and the original firmware path under the stated inputs. The trace establishes no physical use of either output pin.

## Three scenarios from reset

| EEPROM and oscillator inputs | Retired instructions | From main | Unique application word PCs | Emulator clocks | First controlled stop |
| --- | ---: | ---: | ---: | ---: | --- |
| Unknown EEPROM and startup timing | 46,741 | 59 | 59 | 61,988 | `UNKNOWN_EEPROM_DATA`, word `0x014E8C`, EEPROM offset `0x0000` |
| Simulated erased EEPROM and unknown startup timing | 2,872,372 | 2,825,690 | 578 | 4,705,639 | `OSC_STARTUP_TIMING_UNKNOWN`, word `0x007A52` |
| Simulated erased EEPROM and 12 / 640 reset-clock timing profile | 2,872,941 | 2,826,259 | 672 | 4,706,422 | `UNHANDLED_MMIO`, word `0x007AF6`, data byte `0x093E` |

All three scenarios began at the original reset vector and were replayed deterministically. The strict run retained zero known EEPROM bytes. The first two full traces matched the previous SHA-256 digests. The timed run reproduced all 2,872,939 previously retired instructions byte for byte. Each reset-to-main trace reproduced 46,682 retired instructions, 61,883 clocks, and SHA-256 `35acd0fd70ed3ebd11a009bcfb756dc1b8b94bb120dbc4b351a36a948305f722`. Application boot remains incomplete.

All **373 tests passed**, including all 363 previous tests and ten new tests. The audit also checked the hashes of 52 previous test files, 11 historical firmware traces, and 16 original HEX and Ghidra files. The separate existing direct-I/O LDS timing probe still reports one modeled clock against the documented two. The reported totals use the historical clock model. Both newly retired firmware instructions use STD. [Microchip LDS timing](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-42EBE7FA-6359-4986-827E-28F00A3B2FAF.html)

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
