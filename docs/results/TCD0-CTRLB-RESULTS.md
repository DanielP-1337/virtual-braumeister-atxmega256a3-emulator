# TCD0 waveform control and single-slope buffer updates

BrewControl 1.1.27 completed the `TCD0.CTRLB` write at word PC `0x007AFB` in the erased-EEPROM run with explicit oscillator timing. It selected single-slope PWM on channels C and D, started the timer, and pointed Z at timer D1. The first unsupported operation is a write of `0xFF` to **TCD1.PERL** at data byte `0x0966`, word PC `0x007AFF`.

## Executed instructions

| Word PC | Instruction and effect | Completed emulator clocks |
| --- | --- | ---: |
| `0x007AFB` | `STD Z+1,R25` wrote `0xC3` to `TCD0.CTRLB` at `0x0901`. | 4,706,429 |
| `0x007AFC` | `ST Z,R24` wrote `0x01` to `TCD0.CTRLA` at `0x0900` and selected `clkPER/1`. | 4,706,430 |
| `0x007AFD` | `LDI R30,0x40` set the low byte of Z. | 4,706,431 |
| `0x007AFE` | `LDI R31,0x09` set the high byte. Z held the TCD1 base, `0x0940`. | 4,706,432 |
| `0x007AFF` | `STD Z+38,R18` attempted the TCD1.PERL write. The bus raised `UNHANDLED_MMIO` before retirement. | 4,706,432 |

The audit checked the Ghidra instruction encodings, flash fetch addresses, completed bus transactions, and full register state between instructions. At attempt 2,872,949, R18 held `0xFF`, SP was `0x5FF3`, and SREG was zero. The modeled TCD0 counted two clock edges with `PER = 0x0FFF`. Both compare buffers still held zero with their valid flags set. The run ended before the first PWM-period rollover. Confidence is high for the executed instructions and the register identities.

## Register semantics and synthetic evidence

The non-U ATxmega256A3 device pack places TCD0 at `0x0900` and CTRLB at offset `0x01`. It identifies TCD1 at `0x0940` as a TC1 instance with a two-byte PER register at offset `0x26`. [A3 peripheral map, page 56](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=56)

| CTRLB field | Reset | Written by `0xC3` | Modeled behavior |
| --- | --- | --- | --- |
| CCxEN, bits 7–4 | All clear | D and C set, B and A clear | Four independent enable bits. A PWM channel takes over its default output pad when the GPIO direction is output. |
| Reserved bit 3 | 0 | 0 | Reads zero and ignores writes. |
| WGMODE, bits 2–0 | 0, NORMAL | 3, single-slope PWM | In up-counting operation, PER defines TOP for both modes. NORMAL updates at TOP. Single-slope PWM updates at BOTTOM, on the wrap back to zero. |

The model applies an unlocked UPDATE to each valid compare buffer and clears the consumed flag. LUPD, software UPDATE, prescaler phase and the independent TCC0 normal-mode behavior are covered by tests. Reserved encodings and the unimplemented frequency and dual-slope modes reject the whole control write. [Waveform mode table 14-4](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=164) · [Buffering, §14.5](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=154) · [Waveform control implementation](../../src/peripherals/tc0-ctrlb.mjs)

The eleven new tests cover all 256 control-byte values, all seven internal dividers, counter wrap, timer isolation, and precise faults. A test with `PER = 3` and `clkPER/4` checks the update edge using distinct active and buffered values. At TOP on clock 44, C and D still held `0x1133` and `0x2244`, with both buffers valid. At BOTTOM on clock 48, C and D held `0x5577` and `0xAAEE`, with both flags clear. For mode changes and buffered high-byte commits on an UPDATE edge, the emulator processes the preceding mode and previously valid buffer first. A coincident CNT commit suppresses the hardware count. The tests specify these same-edge rules. Their timing on silicon remains unmeasured. [Tests](../../tests/tcd0-ctrlb.test.mjs)

At the firmware stop, PORTD.DIR held `0xFF` and PORTD.OUT held `0x80`. The default A3 routing assigns OC0C to PD2 and OC0D to PD3. GPIO diagnostics identify the timer as the source for these two outputs and mark the instantaneous waveform levels unresolved. GPIO input sampling still requires explicit samples. The firmware trace establishes register configuration and pin routing. Electrical loads, pin-level waveforms, and TCD0 interrupt delivery remain outside this milestone. [A3 pin functions, page 52](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=52)

## Three scenarios from reset

| EEPROM and oscillator inputs | Retired instructions | From main | Unique application word PCs | Emulator clocks | First controlled stop |
| --- | ---: | ---: | ---: | ---: | --- |
| Unknown EEPROM and startup timing | 46,741 | 59 | 59 | 61,988 | `UNKNOWN_EEPROM_DATA`, word `0x014E8C`, EEPROM offset `0x0000` |
| Simulated erased EEPROM and unknown startup timing | 2,872,372 | 2,825,690 | 578 | 4,705,639 | `OSC_STARTUP_TIMING_UNKNOWN`, word `0x007A52` |
| Simulated erased EEPROM and 12 / 640 reset-clock timing profile | 2,872,948 | 2,826,266 | 679 | 4,706,432 | `UNHANDLED_MMIO`, word `0x007AFF`, data byte `0x0966` |

Each scenario ran twice from the original reset vector. The strict run retained zero known EEPROM bytes. The first two full traces matched their previous SHA-256 digests. The timed run reproduced all 2,872,944 previously retired instructions and advanced four application PCs in five emulator clocks. Each run reproduced the reset-to-main trace of 46,682 instructions and 61,883 clocks, SHA-256 `35acd0fd70ed3ebd11a009bcfb756dc1b8b94bb120dbc4b351a36a948305f722`. Both erased-EEPROM runs returned native exit code 2 for a controlled stop.

**393 of 393 tests passed**, including all 382 previous tests. The audit verified 54 prior test files, 11 historical trace hashes, and 16 original firmware and Ghidra files. The isolated direct-I/O LDS timing probe still measures one clock against the documented two. The four newly retired instructions were STD, ST, LDI, and LDI. The cycle totals use the historical emulator timing model. [Microchip LDS timing](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-42EBE7FA-6359-4986-827E-28F00A3B2FAF.html)

## Next hardware requirement

Implement **TCD1.PERL/H** at `0x0966–0x0967` with the TC1 instance's own TEMP at `0x094F`. Test low-byte staging, high-byte commit and readback while TCD0 is running. The timed trace proves only the attempted low-byte store. Application boot remains incomplete. [Timer register map](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=173)

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
