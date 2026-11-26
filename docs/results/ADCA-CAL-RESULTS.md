# ADCA calibration and enable in the synthetic firmware reset

With the approved synthetic bytes `ADCACAL0 = 0x5A` and `ADCACAL1 = 0x03`, BrewControl 1.1.27 commits `0x035A`, enables ADCA and reaches `ADCA.CTRLB` at word PC `0x007A89`.

The starting trace reads the synthetic production-signature byte `ADCACAL0 = 0x5A` and stops before the store to `ADCA.CALL` at word PC `0x007A77`. All program counters below are word addresses. Peripheral addresses and production-signature offsets are byte addresses. [Starting milestone](DACB-CTRLA-NVM-CALIBRATION-RESULTS.md)

## ADCA.CALL

The ATxmega256A3 defines a two-byte `ADCA.CAL` at `0x020C` and an ADC temporary register at `0x0207`. The low byte supplies bits 7–0 and the low nibble of the high byte supplies bits 11–8. The peripheral resets its active calibration and temporary register to zero. A low-byte write stages the byte in TEMP. The high-byte write transfers the pair to the active calibration. A low-byte read latches the active high byte for the subsequent high-byte read. The synthetic tests cover all 4,096 calibration words, direct TEMP access, reset and the CPU bus completion edges. [XMEGA A manual, 16-bit access](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=13) · [ADC register definitions](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=301) · [Register tests](../../tests/adca-cal.test.mjs)

The store at `0x007A77` stages `0x5A` at emulator clock 4,706,507. The firmware selects `READ_CALIB_ROW` again and sets Z to `0x0021`. At `0x007A7D`, `LPM R30,Z` needs `ADCACAL1`, a separate factory byte. The one-byte profile stops there after 2,872,994 instructions and 4,706,511 clocks. At that point TEMP contains `0x5A`, active CAL is zero and `NVM.CMD` holds `0x02`. The project inputs supply no device capture for offset `0x21`. [Factory calibration bytes, pp. 38–39](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=39)

## ADCACAL1 input

The additional timed profile supplies exactly two synthetic factory bytes. `ADCACAL0` at offset `0x20` is `0x5A`, and `ADCACAL1` at offset `0x21` is `0x03`. The discovery runner records both byte addresses and values in the result. The single-byte profile supplies only offset `0x20`. Each missing offset remains unknown. [Input implementation](../../scripts/production-signature-input.mjs) · [Input tests](../../tests/production-signature-adcacal1.test.mjs)

In the two-byte run, `LPM R30,Z` at `0x007A7D` reads `0x03` at emulator clock 4,706,514. The firmware clears `NVM.CMD`, then writes `0x03` to `ADCA.CALH` at `0x007A80`. This commits `0x035A` at clock 4,706,518. Two GPIO stores write `0x02` to `PORTA.DIRCLR` and `0x00` to `PORTA.PIN1CTRL`. The next stop is `STS 0x0200,R25` at `0x007A87`, with R25 holding `0x01`. The run has retired 2,873,000 instructions in 4,706,523 clocks.

## ADCA.CTRLA

The firmware writes `0x01` to `ADCA.CTRLA` at byte address `0x0200`. This sets ENABLE. The DMA selection and all four conversion-start bits are zero. The emulator records the control write at clock 4,706,525 with `CAL = 0x035A` and `TEMP = 0x5A`. The register tests cover reset, ENABLE and DMASEL readback, and explicit diagnostics for writes that request a channel start or a pipeline flush. [XMEGA A manual, ADC.CTRLA](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=296) · [Register tests](../../tests/adca-ctrla.test.mjs)

The next instruction, `STS 0x0201,R1` at word PC `0x007A89`, attempts to write `0x00` to `ADCA.CTRLB`. It stops before the write completes. The two-byte run retires 2,873,001 instructions in 4,706,525 emulator clocks.

## Regression and reset reports

| Step | Node.js suite | Unknown EEPROM | Erased EEPROM, unknown startup | Erased EEPROM, timed startup | Timed with 0x5A | Timed with 0x5A and 0x03 | Trace and integrity audit |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| ADCA.CALL | 466 / 466 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | — | PASS |
| ADCACAL1 input | 469 / 469 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x007A87` | PASS |
| ADCA.CTRLA | 473 / 473 | `0x014E8C` | `0x007A52` | `0x007A74` | `0x007A7D` | `0x007A89` | PASS |

The strict reset stops on the first unknown EEPROM byte at `0x014E8C` after 46,741 instructions and 61,988 clocks. With erased EEPROM and uncharacterized oscillator startup, the readiness check stops at `0x007A52` after 2,872,372 instructions and 4,705,639 clocks. With the established 12 / 640 startup profile and unknown factory bytes, the first `ADCACAL0` read stops at `0x007A74` after 2,872,988 instructions and 4,706,500 clocks. The verifier compares these complete traces to the preceding reports.

The regression checks also cover four Python firmware-comparison tests, the synthetic export pipeline, 11 historical trace hashes and 16 original input files. Each reset scenario runs twice from the original reset vector. The separate direct-I/O `LDS` timing probe measures one emulator clock against two documented clocks.

The three standard reset commands and the single-byte command use the established local inputs. To reproduce the starting stop at `0x007A77`, add `--adca-cal unmapped` to the single-byte run and choose a fresh output directory. To reproduce the two-byte stop at `0x007A87`, add `--adca-ctrla unmapped` to the two-byte command below. Run `node verification/adca/check-stages.mjs` with `adca-cal`, `adcacal1` or `adca-ctrla` to check the corresponding reports. [Reset commands](../../README.md#local-firmware-runs)

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
