# DACB control registers and AVR OR

BrewControl 1.1.27 now completes the first three blockers observed after TCD1 clock start. The timed firmware run writes `0x08` to DACB.CTRLC and then stops on the attempted read of DACB.CTRLA at data byte `0x0320`. The timing run uses the existing 12 / 640 reset-clock oscillator profile with simulated erased EEPROM. [Starting milestone](TCD1-CTRLA-RESULTS.md)

## Firmware execution

| Step | Resolved blocker and word PC | Retired instructions | From main | Distinct application word PCs | Emulator clocks | First controlled stop in the timed run |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | DACB.CTRLB read at `0x00803B` | 2,872,967 | 2,826,285 | 698 | 4,706,464 | `UNHANDLED_MMIO` at `0x00803E`, DACB.CTRLC |
| 2 | DACB.CTRLC read at `0x00803E` | 2,872,969 | 2,826,287 | 700 | 4,706,467 | `UNSUPPORTED_OPCODE` at `0x008040`, `OR R20,R24` |
| 3 | Register `OR` at `0x008040` | 2,872,972 | 2,826,290 | 703 | 4,706,471 | `UNHANDLED_MMIO` at `0x008043`, DACB.CTRLA |

1. **DACB.CTRLB** at `0x0321` resets to zero. The model stores `CHSEL`, `CH1TRIG` and `CH0TRIG` with a writable mask of `0x63`. Writes with either reserved `CHSEL` encoding raise a diagnostic before updating the register. The firmware reads `0x00` at cycle 4,706,461, clears the channel selection bits with `ANDI`, then writes `0x00` at cycle 4,706,464. [XMEGA A manual, pp. 314–315](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=314)
2. **DACB.CTRLC** at `0x0322` resets to zero and stores `REFSEL` and `LEFTADJ` with a writable mask of `0x19`. The firmware reads `0x00` at cycle 4,706,466 and executes `ANDI`. The next fetched word is `0x2B48`, identified as `OR R20,R24` by the local Ghidra export. The synthetic register tests exercised readback, all eight field combinations and an indirect read-modify-write. [XMEGA A manual, p. 315](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=315) · [CTRLC test source](../../tests/dacb-ctrlc.test.mjs)
3. **AVRxm `OR`** uses one word and one clock. It writes the destination register, updates `Z`, `N` and `S`, clears `V` and preserves `I`, `T`, `H` and `C`. The firmware executes `OR R20,R24` at `0x008040` and `OR R20,R22` at `0x008041`. R20 goes from `0x00` to `0x00` to `0x08`, and SREG goes from `0x02` to `0x02` to `0x00`. The `STD` at `0x008042` commits `0x08` at cycle 4,706,471, selecting AVCC and right-aligned data. `LD R24,Z` at `0x008043` then attempts to read DACB.CTRLA. [AVR Instruction Set Manual, OR](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-1DD7CB28-593C-4786-850D-0234F21218BB.html) · [AVRxm cycle table](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-BA59618D-4850-490B-B176-0BCC3D9438A1.html) · [DAC reference table](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=315)

At the final stop TCD1 has received 23 DIV1 edges and both compare-buffer valid flags remain set. The DACB model covers digital control-register state. The trace confirms configuration writes and the attempted enable-register read.

## Regression and reset reports

Each milestone ran the complete Node.js suite, the four synthetic firmware-comparison tests, the synthetic export pipeline and the historical PoC checks. Each of the three reset scenarios ran twice from the original reset vector. The audits compare raw trace bytes and SHA-256 digests, match the appended instruction fetches to the Ghidra export and verify the original firmware and Ghidra files. The reset-to-main checkpoint reproduced 46,682 instructions and 61,883 emulator clocks.

| Step | Node.js suite | Unknown EEPROM and startup timing | Simulated erased EEPROM, unknown timing | Simulated erased EEPROM, timed profile | Verification |
| --- | --- | --- | --- | --- | --- |
| DACB.CTRLB | 447 / 447 | `0x014E8C` | `0x007A52` | `0x00803E` | PASS |
| DACB.CTRLC | 450 / 450 | `0x014E8C` | `0x007A52` | `0x008040` | PASS |
| AVR OR | 453 / 453 | `0x014E8C` | `0x007A52` | `0x008043` | PASS |

The strict traces match the TCD1 milestone byte for byte. They stop at `UNKNOWN_EEPROM_DATA` at word `0x014E8C` after 46,741 instructions and 61,988 clocks, with zero known EEPROM bytes. The simulated-erased traces with unknown oscillator timing also match byte for byte. They stop at `OSC_STARTUP_TIMING_UNKNOWN` at word `0x007A52` after 2,872,372 instructions and 4,705,639 clocks.

The separate direct-I/O `LDS` probe measured one emulator clock against the documented two at each milestone. The cycle totals above refer to the current emulator profile.

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
