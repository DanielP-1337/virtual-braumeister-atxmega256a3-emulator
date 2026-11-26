# ADC clock selection and channel 0 configuration

The two-byte reset reaches `ADCA.CH0.INTFLAGS` at word PC `0x007A9D` after programming the ADC clock divider, input multiplexer and channel interrupt control. The firmware attempts to write `0x01` to data byte `0x0223` after 2,873,014 completed instructions and 4,706,545 emulator clocks.

The starting BrewControl 1.1.27 reset stops at word PC `0x007A95` before `STS 0x0204,R24`. R24 holds `0x06`. The ADC is enabled, calibrated to `0x035A` and configured for unsigned 12-bit results with event triggering and free running both off. The two-byte profile supplies exactly `ADCACAL0 = 0x5A` and `ADCACAL1 = 0x03` as synthetic production-signature inputs. PCs in this report count flash words. Register addresses count bytes. [Starting firmware report](ADCA-CONFIG-RESULTS.md)

## ADCA.PRESCALER

On the non-U ATxmega256A3, bits 2–0 of this register select the ADC clock divider relative to the peripheral clock. The reset selector is zero (divide by four). Selector six sets the divider to 256. The emulator retains the three selector bits and reports the divider in its ADC snapshots. Tests cover all eight divisors, all 256 write bytes, reset and the CPU write edge with the ADC enabled. [XMEGA A manual, Table 25-7](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=300) · [Register tests](../../tests/adca-prescaler.test.mjs)

The `STS` at `0x007A95` writes `0x06` to `0x0204` at emulator clock 4,706,539. The subsequent `LDI` loads `0x08` into R24. The run stops before the write to `ADCA.CH0.MUXCTRL` at `0x007A98`, after 2,873,011 retired instructions and 4,706,540 clocks. The ADC base `0x0200`, channel offset `0x20` and register offset `0x01` identify the target byte `0x0221`.

## ADCA.CH0.MUXCTRL

Bits 6–3 hold the positive input selector, and bits 1–0 hold the negative selector. Bits 7 and 2 are reserved. The non-U A3 has eight external inputs per ADC. The digital register accepts positive selectors 0–7 for configuration and diagnoses 8–15 as unavailable on this device. In internal-input mode the defined positive sources are temperature, bandgap, scaled VCC and DAC. The negative selector applies to differential measurements. The register tests exercise every write byte, including atomic rejection of unavailable selectors. [A3 input count, section 25.1](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=41) · [XMEGA A manual, section 25.17.2](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=305) · [Register tests](../../tests/adca-ch0-muxctrl.test.mjs)

The `STS` at `0x007A98` writes `0x08` at emulator clock 4,706,542. The positive selector is 1 and the negative selector is zero. This is the first completed channel 0 configuration write in the MMIO history. `ADCA.CH0.CTRL` at `0x0220` therefore still has its internal reset input mode. In that mode selector 1 identifies the bandgap. The firmware stops at the following `STS 0x0222,R1` at `0x007A9A` after 2,873,012 retired instructions. R1 holds zero. [Channel input modes and reset](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=304)

## ADCA.CH0.INTCTRL

The channel interrupt control register at `0x0222` implements bits 3–2 (`INTMODE`) and 1–0 (`INTLVL`). The reset mode is conversion complete and the reset priority is off. The other defined modes compare the result against the threshold. Mode 2 is reserved. Tests exercise every write byte, each of the four priority settings, the write completion edge and atomic handling of a reserved mode. [XMEGA A manual, section 25.17.3](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=307) · [Register tests](../../tests/adca-ch0-intctrl.test.mjs)

At `0x007A9A`, the firmware writes `0x00` at emulator clock 4,706,544, leaving the channel interrupt level off. `LDI` then loads `0x01` into R24. The first blocked instruction is `STS 0x0223,R24` at word PC `0x007A9D`, before the write to `ADCA.CH0.INTFLAGS` completes. Bit 0 is the channel flag with write-one-to-clear semantics. The run has retired 2,873,014 instructions in 4,706,545 emulator clocks. [XMEGA A manual, section 25.17.4](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=307)

## Reset and regression reports

Each of the five reset profiles starts from the original reset vector twice at every stage. The three standard CPU traces and the single-byte calibration trace are byte-identical to the corresponding starting traces. For the two-byte profile, the audit verifies the common instruction prefix, the additional instructions and MMIO writes, and the state at the first blocked access against the firmware disassembly and the A3 device definition.

| Register | Node.js tests | Unknown EEPROM | Erased EEPROM, unknown startup | Erased EEPROM, timed startup | Timed with 0x5A | Timed with 0x5A and 0x03 | Audit |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| ADCA.PRESCALER | 483 / 483 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x007A98` | PASS |
| ADCA.CH0.MUXCTRL | 486 / 486 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x007A9A` | PASS |
| ADCA.CH0.INTCTRL | 489 / 489 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x007A9D` | PASS |

The unknown-EEPROM reset stops at word PC `0x014E8C` (46,741 instructions, 61,988 emulator clocks). The erased-EEPROM run with unknown oscillator startup stops at `0x007A52` (2,872,372 instructions, 4,705,639 clocks). The timed run with unknown calibration stops at `0x007A74` (2,872,988 instructions, 4,706,500 clocks). Supplying only `ADCACAL0 = 0x5A` reaches `0x007A7D` (2,872,994 instructions, 4,706,511 clocks).

Each stage also passed four Python firmware-comparison tests, the synthetic export pipeline, all 11 historical trace checks and the integrity check for 16 original files. The separate direct-peripheral `LDS` timing probe measured one emulator clock against the documented two.

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
