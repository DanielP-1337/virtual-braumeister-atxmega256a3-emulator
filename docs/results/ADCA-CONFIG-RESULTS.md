# ADCA configuration in the two-byte firmware reset

With the two synthetic calibration bytes, BrewControl configures ADCA for unsigned 12-bit results, selects the VCC/1.6 reference and leaves ADC event triggering disabled. The next stop is the attempted `0x06` write to `ADCA.PRESCALER` at word PC `0x007A95`, after 2,873,009 instructions and 4,706,537 emulator clocks.

The reference run for BrewControl 1.1.27 reached the write to `ADCA.CTRLB` at word PC `0x007A89` with `ADCA.CAL = 0x035A` and `ADCA.CTRLA = 0x01`. The two supplied production-signature bytes are synthetic. The low byte at offset `0x20` is `0x5A` and the high byte at offset `0x21` is `0x03`. All instruction addresses below are word addresses. Register and SRAM addresses are byte addresses. [Starting report](ADCA-CAL-RESULTS.md)

## ADCA.CTRLB

The non-U ATxmega256A3 places this register at `0x0201`. Zero selects unsigned 12-bit results, right adjusted, with free running disabled. The register resets to zero. The emulator retains the resolution and sign fields and masks the reserved bits. A reserved resolution or a request to run the enabled ADC continuously raises a diagnostic before the write completes. The tests cover all 256 input bytes and both orders of enabling the ADC and selecting free running. [XMEGA A manual, section 25.16.2](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=297) · [Register tests](../../tests/adca-ctrlb.test.mjs)

The `STS` at `0x007A89` writes zero at emulator clock 4,706,527. The following `LDS` reads `0xFF` from SRAM byte `0x30F5`, which also contains `0xFF` in the preceding reset's saved SRAM. Comparing with `0xAA` leaves Z clear. The branch falls through and `LDI` sets R24 to `0x12`. This step adds five retired instructions and seven clocks. The run stops after 2,873,006 instructions and 4,706,532 emulator clocks at `0x007A90`, attempting to write `0x12` to `ADCA.REFCTRL` at `0x0202`.

## ADCA.REFCTRL

The A3 reference register resets to zero and implements bits 5, 4, 1 and 0. The firmware value `0x12` selects the internal VCC/1.6 reference (`REFSEL = 1`), enables the bandgap for ADC measurements and leaves the temperature reference disabled. The model records the selector and enable bits. The tests cover all four reference sources, independently setting each enable, reserved-bit readback and the CPU store edge. [XMEGA A manual, section 25.16.3](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=298) · [Register tests](../../tests/adca-refctrl.test.mjs)

The `STS` at `0x007A90` writes `0x12` at emulator clock 4,706,534. The firmware stops at the next instruction, `STS 0x0203,R1` at word PC `0x007A92`, after 2,873,007 retired instructions. R1 holds zero. The new stop is the write to `ADCA.EVCTRL`.

## ADCA.EVCTRL

The event control register at `0x0203` resets to zero. Bits 7–6 select the ADC channel sweep, bits 5–3 select the event input group and bits 2–0 select the event action. At the firmware value `0x00`, the sweep selects ADC channel 0, the input group covers event lines 0–3 and `EVACT = NONE` leaves event triggering disabled. Register tests cover every defined combination and verify that the reserved action code 7 stops the write before changing the CPU or ADC state. [XMEGA A manual, section 25.16.4, Tables 25-4 to 25-6](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=299) · [Register tests](../../tests/adca-evctrl.test.mjs)

The event register write completes at emulator clock 4,706,536. The next `LDI` loads `0x06` into R24. At word PC `0x007A95`, `STS 0x0204,R24` encounters the first unmapped register, `ADCA.PRESCALER`. The CPU has completed 2,873,009 instructions in 4,706,537 clocks. The ADC state at that point is `CAL = 0x035A`, `CTRLA = 0x01`, `CTRLB = 0x00`, `REFCTRL = 0x12` and `EVCTRL = 0x00`.

## Reset and regression reports

Each stage runs the complete Node.js suite, four Python firmware-comparison tests and the synthetic export pipeline. The integrity check covers 11 historical instruction traces and 16 original input files. Each reset profile starts from the firmware reset vector twice. The audit compares the complete CPU traces for the four earlier stops and checks the additional instructions in the two-byte run against the firmware disassembly.

| Register | Node.js tests | Unknown EEPROM | Erased EEPROM, unknown startup | Erased EEPROM, timed startup | Timed with 0x5A | Timed with 0x5A and 0x03 | Audit |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| ADCA.CTRLB | 476 / 476 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x007A90` | PASS |
| ADCA.REFCTRL | 478 / 478 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x007A92` | PASS |
| ADCA.EVCTRL | 481 / 481 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x007A95` | PASS |

The unknown-EEPROM reset stops at `0x014E8C` after 46,741 instructions and 61,988 emulator clocks. Erased EEPROM with uncharacterized oscillator startup stops at `0x007A52` after 2,872,372 instructions and 4,705,639 clocks. The timed run without calibration inputs stops on `ADCACAL0` at `0x007A74` after 2,872,988 instructions and 4,706,500 clocks. With only `ADCACAL0 = 0x5A`, the stop is the `ADCACAL1` read at `0x007A7D` after 2,872,994 instructions and 4,706,511 clocks.

The separate timing probe for a direct peripheral `LDS` reports one emulator clock against the documented two. The `LDS` at `0x007A8B` reads SRAM and takes two clocks in the recorded firmware run.

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
