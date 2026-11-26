# TCD1 clock start and the first DACB register read

BrewControl 1.1.27 started TCD1 at word `0x007B07` in the erased-EEPROM run with modeled oscillator startup. TCD1 reached count 11 before the first attempted read of DACB.CTRLB stopped execution at word `0x00803B`. Both compare buffers were still pending. The synthetic tests observed both transfers at BOTTOM.

## Clock and buffer behavior

The non-U ATxmega256A3 maps TCD1.CTRLA to data byte `0x0940`. It resets to `0x00` (OFF). Writing `0x01` selects `clkPER/1`. Values 2 through 7 select the common prescaler taps `/2`, `/4`, `/8`, `/64`, `/256`, and `/1024`. Selectors 8 through 15 require an event-system clock source and raise an explicit diagnostic in the emulator. **Confidence is high** for the address, reset value and selector definitions. [A3 peripheral map, p. 56](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=56) · [XMEGA A manual, Table 14-3](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=163)

The emulator counts through the MMIO write-completion edge using the old selection. The first subsequent peripheral edge increments CNT when DIV1 is selected. TCD0 and TCD1 share a prescaler phase and keep independent counters, periods and compare buffers. Clock edges are accounted for before a timed register access and at the final retired CPU cycle. This ordering and the common phase at cycle zero are deterministic emulator conventions. The start-edge evidence comes from deterministic synthetic tests. [Clock implementation](../../src/peripherals/timer-clock.mjs) · [TCD1 register bank](../../src/peripherals/tcd1-period.mjs)

In single-slope PWM with `CTRLB = 0x33`, TOP equals PER and UPDATE occurs on the next edge, when CNT returns to zero. The synthetic tests loaded different words into each channel so a missing or swapped transfer would be visible. [XMEGA A waveform modes, Table 14-4](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=164) · [Compare buffering](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=154) · [Independent clock tests](../../tests/tcd1-ctrla.test.mjs)

| Peripheral edges after `CTRLA = 1`, `PER = 3` | CNT | Active CCA | Active CCB | CCABV / CCBBV |
| ---: | ---: | ---: | ---: | --- |
| 0 | 0 | `0x3041` | `0x5062` | set / set |
| 1 | 1 | `0x3041` | `0x5062` | set / set |
| 3 | 3 (TOP) | `0x3041` | `0x5062` | set / set |
| 4 | 0 (BOTTOM) | `0x1273` | `0x2484` | clear / clear |

A second synthetic test used the firmware's period of `0x0FFF` and buffered two zero words. Both valid flags stayed set through edge 4,095 and cleared together on edge 4,096. Other cases cover all internal clock selections, stopping and restarting, the update lock, a new buffer commit on the BOTTOM edge, independent TCD0 state, and failed accesses. The initial AVR instruction fixture expected two clocks for `ST Z,Rr`. The device instruction table specifies one. The corrected fixture checks a one-clock store and the exact four following count edges. [A3 instruction timing, p. 59](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=59)

## Three reset runs

All **444 of 444 tests passed**, including the 433 previous tests and 11 new tests. Each scenario ran twice from the original reset vector with identical trace hashes, terminal states and timer events.

| Inputs | Retired instructions | From main | Distinct application word PCs | Emulator clocks | First controlled stop |
| --- | ---: | ---: | ---: | ---: | --- |
| Unknown EEPROM and oscillator startup | 46,741 | 59 | 59 | 61,988 | `UNKNOWN_EEPROM_DATA` at word `0x014E8C`, EEPROM offset `0x0000` |
| Simulated erased EEPROM, unknown oscillator startup | 2,872,372 | 2,825,690 | 578 | 4,705,639 | `OSC_STARTUP_TIMING_UNKNOWN` at word `0x007A52` |
| Simulated erased EEPROM, 12 / 640 reset-clock oscillator profile | 2,872,964 | 2,826,282 | 695 | 4,706,459 | `UNHANDLED_MMIO` at word `0x00803B`, DACB.CTRLB |

The strict run retained zero known EEPROM bytes. Its full trace and the uncharacterized-oscillator trace matched the previous milestone byte for byte. In the timing-profile run, the first 2,872,956 retired instructions matched the previous milestone. Eight further instructions retired in twelve emulator clocks. Its trace SHA-256 is `4c0580f286b8f6db327e19c1a02478084c92a315168cedc8e925e6a9731403ce`. Both erased-EEPROM runners returned exit code 2 for a controlled stop.

Every run reproduced the PoC 001 startup checkpoint at 46,682 instructions and 61,883 clocks with SHA-256 `35acd0fd70ed3ebd11a009bcfb756dc1b8b94bb120dbc4b351a36a948305f722`. The audit checked the 59 prior test files, 11 historical trace hashes and all 16 original firmware and Ghidra files. The separate direct-I/O `LDS` probe continues to measure one clock against the documented two. Totals above are emulator clocks for this profile.

## Executed path and next blocker

| Word PC | Observed operation |
| --- | --- |
| `0x007B07` | `ST Z,R24` (`0x8380`) completed the write of `0x01` to `0x0940` at cycle 4,706,448. CNT was zero at completion. |
| `0x007B08` | `RCALL` entered word `0x007AC1`. The caller prepared `R25:R24 = 0x0320`. |
| `0x007AC5` | `RCALL` entered word `0x00803A`. `MOVW` copied the DACB base into Z. |
| `0x00803B` | `LDD R24,Z+1` (`0x8181`) attempted to read data byte `0x0321`. Attempt 2,872,965 stopped before retirement. |

At the stop, SP was `0x5FED`, SREG was `0x00`, and Z held `0x0320`. TCD0 had advanced from 17 to 29. TCD1 had received eleven DIV1 edges and remained below its TOP of 4,095, with `CCABV = CCBBV = 1`. The verifier matched each newly fetched instruction to the Ghidra listing, checked both three-byte return addresses in SRAM and confirmed that R24 retained its value on the failed read.

The next required register is **DACB.CTRLB** at `0x0321`. The non-U device has a DACB instance at `0x0320`. Its control register B is at offset 1 and contains `CHSEL`, `CH1TRIG` and `CH0TRIG`. The manual gives a reset value of `0x00`. This milestone establishes an attempted read with high confidence. DAC conversions, external loads and a complete application boot remain unverified. [DACB.CTRLB specification, pp. 314–315](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=314)

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
