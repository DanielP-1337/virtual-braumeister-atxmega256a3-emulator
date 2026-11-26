# SPIE interrupt control and the following firmware stops

After the three register accesses were implemented, the paired reset reaches word `0x013523` with 2,873,283 retired instructions and 4,707,025 emulator clocks. At this boundary the CPU must arbitrate a possible port E interrupt. Its outcome depends on the edge history of PE2.

All runs use the original BrewControl 1.1.27 firmware. The two-byte profile uses erased EEPROM, the existing oscillator startup profile, and synthetic production-signature bytes `ADCACAL0 = 0x5A` and `ADCACAL1 = 0x03`. Flash PCs are word addresses. Peripheral and SRAM addresses are byte addresses. The starting run stops at `0x00FCCF` with 2,873,111 retired instructions and 4,706,709 emulator clocks. [Starting firmware report](ADCA-CH0-INIT-RESULTS.md)

## SPIE.INTCTRL

At word `0x00FCCF`, `ST X,R10` writes zero to `0x0AC1`. The low two bits select off, low, medium or high interrupt priority. The register resets to zero. The emulator checks reserved writes and retains all four defined levels. When the SPI interrupt flag is set, an enabled level can request A3 vector number 57 at word `0x0072`. Vector entry clears IF. A write collision has a separate flag. The firmware's zero leaves the SPIE interrupt disabled. [XMEGA A manual, sections 20.7.2–3](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=229) · [SPIE and PMIC tests](../../tests/spie-intctrl.test.mjs)

The store retires at emulator clock 4,706,710. The firmware finishes the SPIE pin setup, writes `0x78`, `0x9B` and `0x01` to the TWIE master control, baud and status registers, then writes `0x5C` and `0x00` to SPIC control and interrupt control. The driver reuses the same store at `0x00FCCF` with X now pointing into SPIC. The audit checks the distinct effective addresses, CPU fetches, intervening calls, GPIO updates and SRAM reads and writes. After 159 more instructions and 294 clocks, `STD Z+10,R28` at `0x007B26` attempts to write `0x04` to `0x068A`.

## PORTE.INT0MASK

The store at `0x007B26` selects PE2 as the sole source for port E interrupt 0. All eight mask bits are writable. The register resets to zero. At emulator clock 4,707,005 the trace records `0x04` at data address `0x068A`. The port direction, output and input sample registers retain their previous values. The next instruction at `0x007B27` attempts to read data address `0x0689` with `LDD R24,Z+9`. [XMEGA A manual, sections 13.13.10 and 13.13.11](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=142)

## PORTE.INTCTRL

At word `0x007B27`, the firmware reads the reset value `0x00` from `0x0689`. It sets bit 0 with `ORI` and writes `0x01` back at word `0x007B29`. Interrupt 0 now has low priority and interrupt 1 is disabled. The two two-bit level fields and the zero-valued high nibble match the non-U A3 register map. The separate port interrupt log records both accesses and the earlier mask write. [Register and interrupt tests](../../tests/porte-intctrl.test.mjs) · [Port control register](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=142)

The mask takes effect at clock 4,707,005. At `0x007B2B`, clock 4,707,013, the firmware changes PE2 input sensing from both edges to the falling edge. PE2 is an input. The firmware enables the three PMIC levels, executes `SEI` and completes the following `CALL`. Before the first fetch at the call target `0x013523`, the PMIC can accept a low-priority interrupt. The stored reset profile provides no PE2 signal history from activation of the mask, so the state of the INT0 flag is undetermined. The possible vector is word `0x000056`. Interrupt entries remain zero and the call frame is intact. The final diagnostic contains zero bus accesses. [Interrupt flag latching](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=126) · [Pin sense settings](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=144)

The last stage advances 12 instructions and 20 clocks. The paired reset stops after 2,873,283 retired instructions and 4,707,025 emulator clocks with `PORTE_INT0_INPUT_HISTORY_UNKNOWN`.

## Regressions and resets

Each stage ran the complete Node.js suite, four firmware-comparison tests, the synthetic export pipeline, 11 historical trace checks and integrity checks on 16 original files. Each reset profile was executed twice from the original vector. The audit compares the two replays, the shared raw trace prefix and the new instruction bytes against the firmware listing. For the longer initialization path it also reconstructs SRAM, call frames and GPIO latch changes from the preceding stage.

| Register | Node.js | Unknown EEPROM | Erased, unknown startup | Erased, timed startup | Timed with 0x5A | Timed with 0x5A / 0x03 | Verification |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| SPIE.INTCTRL | 501 / 501 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x007B26` | PASS |
| PORTE.INT0MASK | 503 / 503 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x007B27` | PASS |
| PORTE.INTCTRL | 507 / 507 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x013523` | PASS |

The three standard profiles reproduce their previous full CPU trace hashes at every stage. The unknown-EEPROM stop is `0x014E8C` (46,741 retired instructions, 61,988 emulator clocks). With erased EEPROM and uncharacterized oscillator timing the stop is `0x007A52` (2,872,372 / 4,705,639). With the timed oscillator profile and unknown factory calibration it is `0x007A74` (2,872,988 / 4,706,500). Supplying only `0x5A` reproduces the stop on the missing second calibration byte at `0x007A7D` (2,872,994 / 4,706,511).

The separate direct-peripheral `LDS` probe measured one emulator clock for the documented two at each stage. The reads of PORTE.INTCTRL and PMIC.CTRL in this firmware segment use `LDD` and each retires in two emulator clocks.

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
