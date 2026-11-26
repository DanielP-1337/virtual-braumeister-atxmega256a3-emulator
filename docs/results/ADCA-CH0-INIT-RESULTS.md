# ADC channel 0 and SPIE initialization in the two-byte reset

The firmware now clears the ADC channel flag, selects PA1 and enables SPIE master mode. The next stop is the write of `0x00` to `SPIE.INTCTRL` at word PC `0x00FCCF`, after 2,873,111 completed instructions and 4,706,709 emulator clocks.

The BrewControl 1.1.27 run starts at the original reset vector with erased EEPROM, the existing oscillator startup profile and two synthetic production-signature bytes. Offset `0x20` supplies `0x5A` and offset `0x21` supplies `0x03`. The resulting ADC calibration word is `0x035A`. Instruction addresses below count flash words. Peripheral and SRAM addresses count bytes. [Starting milestone](ADCA-CHANNEL0-RESULTS.md)

## ADCA.CH0.INTFLAGS

At word PC `0x007A9D`, `STS 0x0223,R24` writes `0x01` to the channel interrupt flag. Writing a one to bit 0 clears `CHIF`. A zero preserves it, and a read returns its current value. The register tests check every possible write byte with the flag initially clear and initially set. A CPU test verifies the on-bus byte and the flag after the store at its two-clock completion edge. [XMEGA A manual, section 25.17.4](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=307) · [Register and CPU tests](../../tests/adca-ch0-intflags.test.mjs)

In the paired reset the flag was already clear. The store retires at emulator clock 4,706,547. The very next instruction, `STS 0x0220,R24` at `0x007A9F`, stops on `ADCA.CH0.CTRL` with R24 still equal to one. The run has completed 2,873,015 instructions.

## ADCA.CH0.CTRL

The channel configuration byte `0x01` selects single-ended acquisition. The existing `MUXCTRL = 0x08` then selects ADC input 1 on PA1. The gain field is zero and the START bit is clear. The emulator retains the input-mode and gain fields. A write requesting an actual conversion produces a diagnostic before the instruction retires. The register tests cover all 256 write bytes, including atomic handling of START. [XMEGA A manual, sections 25.17.1–2](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=304) · [Register and CPU tests](../../tests/adca-ch0-ctrl.test.mjs)

The store at `0x007A9F` completes at emulator clock 4,706,549. The firmware returns to `0x007B0A`, calls `0x0089FD`, then calls `0x00FC8E`. It stores the SPI base `0x0AC0`, Port E base `0x0680` and SS mask `0x10` in the SRAM structure at `0x497C`. Eleven Port E writes include setting PE4 as an output and setting its output latch high. After 92 additional instructions and 154 clocks the reset stops at `0x00FCCB`, with 2,873,107 instructions completed and 4,706,701 clocks elapsed. The disassembly identifies opcode `0x92CC` as `ST X,R12`. X points to `SPIE.CTRL` and R12 holds `0x50`. [A3 SPIE pin assignments, Table 30-5](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=52)

## SPIE.CTRL

The preceding stage's diagnostic records `UNKNOWN` in its mnemonic field. Its raw instruction, effective address and source byte identify the first SPIE store independently.

The port E SPI uses its own register state at base `0x0AC0`. It shares the existing master-selection logic with SPIC and observes PE4 for SS. The firmware's `0x50` enables master mode with MSB first, mode 0 and a clock divider of four. Software starts a byte transfer by writing DATA. Setting CTRL with PE4 configured as an output requires no external pin sample. The register tests cover all 256 control values, separation from SPIC and the master-mode response to an unknown, high or low input on PE4. The diagnostic decoder now identifies the source register, X address and attempted byte of an indirect store. [XMEGA A manual, master operation](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=226) · [Control register](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=228) · [SPIE and CPU tests](../../tests/spie-ctrl.test.mjs)

The master control write at `0x00FCCB` completes in one emulator clock at 4,706,702. The firmware then loads the SPI base from SRAM into X and adds one. The next instruction, `ST X,R10` at `0x00FCCF`, attempts to write `0x00` to `SPIE.INTCTRL` at data byte `0x0AC1`. The run stops before that write retires, after 2,873,111 instructions and 4,706,709 emulator clocks. The SPIE log contains one control write and zero transfer events.

## Regressions and resets

Each stage ran the complete Node.js suite, four firmware-comparison tests, the synthetic export pipeline, 11 historical trace checks and integrity checks on 16 original files. Each reset profile was executed twice from the original vector. The audit compares the two replays, the shared raw trace prefix and the new instruction bytes against the firmware listing. For the longer initialization path it also reconstructs SRAM, call frames and Port E latch changes from the preceding stage.

| Register | Node.js | Unknown EEPROM | Erased, unknown startup | Erased, timed startup | Timed with 0x5A | Timed with 0x5A / 0x03 | Verification |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| ADCA.CH0.INTFLAGS | 491 / 491 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x007A9F` | PASS |
| ADCA.CH0.CTRL | 494 / 494 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x00FCCB` | PASS |
| SPIE.CTRL | 498 / 498 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x00FCCF` | PASS |

The three standard profiles reproduce their previous full CPU trace hashes at every stage. The unknown-EEPROM stop is `0x014E8C` (46,741 retired instructions, 61,988 emulator clocks). With erased EEPROM and uncharacterized oscillator timing the stop is `0x007A52` (2,872,372 / 4,705,639). With the timed oscillator profile and unknown factory calibration it is `0x007A74` (2,872,988 / 4,706,500). Supplying only `0x5A` reproduces the stop on the missing second calibration byte at `0x007A7D` (2,872,994 / 4,706,511).

The separate direct-peripheral `LDS` probe reproduced the known timing difference at each stage. It measured one emulator clock against the documented two. All clock counts above are emulator clocks.

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
