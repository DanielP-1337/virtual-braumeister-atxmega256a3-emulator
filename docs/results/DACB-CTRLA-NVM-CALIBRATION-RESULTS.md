# DACB enable and the production signature row

The standard timed reset reaches the factory calibration read at word PC `0x007A74`. With the single authorized test byte `ADCACAL0 = 0x5A`, the firmware reaches its first write to `ADCA.CALL` at `0x007A77`.

## DACB.CTRLA

BrewControl 1.1.27 reads data byte `0x0320` at word PC `0x008043`. The register reads back its reset value of zero at emulator clock 4,706,472. The subsequent `ANDI` and `ORI` prepare `0x05`, and the store at `0x008046` enables DACB and channel 0 at clock 4,706,475. The non-U ATxmega256A3 device pack defines five writable bits, including `LPMODE` at bit 1. The device datasheet describes the low-power mode. The firmware leaves that bit clear. [Previous firmware stop](DACB-CONTROL-RESULTS.md) · [A3 datasheet, p. 43](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=43)

The firmware returns to its caller, enables the three PMIC interrupt levels and calls the ADC initialization routine. The first new stop is `STS 0x01CA,R24` at word PC `0x007A70`. R24 holds `0x02`. The timed reset has retired 13 additional instructions in 25 clocks, bringing the totals to 2,872,985 instructions and 4,706,496 clocks.

## NVM.CMD and the factory byte

At word `0x007A70` the firmware selects `READ_CALIB_ROW` by writing `0x02` to `NVM.CMD`. The XMEGA A manual specifies an `LPM` trigger with Z holding a byte offset. The command takes effect on the register write, and NVM.STATUS stays idle. The CPU continues to fetch instructions from flash. In the timed reset, the next two `LDI` instructions set Z to `0x0020`. [NVM command table, p. 359](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=359) · [Production signature access, p. 362](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=362)

The third blocker is the value of `ADCACAL0`. At word `0x007A74` (flash byte `0x00F4E8`), the firmware attempts `LPM R30,Z`. The ATxmega256A3 maps production-signature offset `0x20` to the low calibration byte for ADCA. The manufacturer determines this value during testing of the individual chip. The available 1.1.27 HEX contains 173,410 contiguous application flash bytes. The local firmware inputs and retained captures supply zero known production-signature bytes. The timed reset therefore stops before the load retires, with Z still `0x0020`. [Factory calibration, p. 38](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=38)

The synthetic CPU tests supply explicit bytes to verify selection, post-increment, a destination overlapping Z, returning to flash via command zero, and persistence of factory data across controller reset. The firmware reset scenarios retain their original inputs. An original byte at offset `0x20` is sufficient for this load. The static listing also identifies `ADCACAL1` at `0x21` as a later read. [Regression tests](../../tests/nvm-read-calib.test.mjs)

## Separate synthetic reset with ADCACAL0 = 0x5A

For the authorized additional run, the emulator receives one synthetic byte at production-signature offset `0x20`. At step 2,872,989, `LPM R30,Z` reads that byte and places `0x5A` in R30 at clock 4,706,503. The `STS` at `0x007A75` clears `NVM.CMD` two clocks later. The next instruction attempts to write R30 to data byte `0x020C`. This is the low byte of the 16-bit `ADCA.CAL` register, called `ADCA.CALL` in the manual. The emulator reports `UNHANDLED_MMIO` at word `0x007A77` before the store completes. The run has retired 2,872,990 instructions in 4,706,505 clocks. [Factory calibration and CALL, p. 38](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=38)

## Reset and regression reports

| Implemented step | Full Node.js suite | Unknown EEPROM | Erased EEPROM, unknown oscillator timing | Erased EEPROM, 12 / 640 reset-clock timing profile | Trace and integrity audit |
| --- | ---: | --- | --- | --- | --- |
| DACB.CTRLA | 456 / 456 | `0x014E8C` | `0x007A52` | `0x007A70` | PASS |
| NVM.CMD `READ_CALIB_ROW` | 460 / 460 | `0x014E8C` | `0x007A52` | `0x007A74` | PASS |
| ADCACAL0 input | 463 / 463 | `0x014E8C` | `0x007A52` | `0x007A74` | PASS |

With unknown EEPROM, all three steps reproduce `UNKNOWN_EEPROM_DATA` at word `0x014E8C` after 46,741 instructions and 61,988 clocks. With erased EEPROM and uncharacterized startup timing, all three reproduce `OSC_STARTUP_TIMING_UNKNOWN` at `0x007A52` after 2,872,372 instructions and 4,705,639 clocks. With the 12 / 640 oscillator model, both ordinary resets after adding `READ_CALIB_ROW` reach the unknown byte after 2,872,988 instructions and 4,706,500 clocks. Their full trace SHA-256 is `4f097b5c65e2ac7718667c0f6a7a3c446dd41432f2f968d2bcbc4bc866ae05d1`.

The full Node.js suites ran alongside four Python firmware-comparison tests, the synthetic export pipeline and historical checks at each step. All 11 historical trace hashes and 16 original input hashes were verified. The separate direct-I/O `LDS` timing probe measured one emulator clock against two documented clocks at each step.

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
