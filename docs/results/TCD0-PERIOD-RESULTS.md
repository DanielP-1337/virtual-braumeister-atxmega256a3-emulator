# TCD0 period registers and the first channel C buffer write

BrewControl 1.1.27 programmed TCD0's active period to `0x0FFF` (4,095). TCC0 kept its period of `0x007D` (125). The next instruction attempted to write zero to the low byte of TCD0's channel C compare/capture buffer and stopped at word `0x007AF4`.

## Registers and isolation

| Timer | Data base | CPU TEMP | Active PERL | Active PERH | TEMP at the stop | Active PER at the stop |
| --- | --- | --- | --- | --- | --- | --- |
| TCC0 | `0x0800` | `0x080F` | `0x0826` | `0x0827` | `0x7D` | `0x007D` |
| TCD0 | `0x0900` | `0x090F` | `0x0926` | `0x0927` | `0xFF` | `0x0FFF` |

The non-U ATxmega256A3 device pack defines two TC0 instances at these bases. Each resets its CPU TEMP to zero and active PER to `0xFFFF`. A PERL write stages the low byte in that timer's TEMP. A PERH write commits the high byte together with the staged low byte. A PERL read returns the active low byte and latches the active high byte in TEMP for a subsequent PERH read. Multiple 16-bit register pairs on one timer share its CPU latch. The emulator gives each instance its own state and registers only D0's TEMP and active PER pair on the discovery bus. [A3 peripheral addresses, page 56](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=56) · [CPU access order, XMEGA A §3.11](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=13) · [Timer register definitions, §§14.12.11–15](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=170) · [Shared TC0 implementation](../../src/peripherals/tc0-counter.mjs)

## Firmware instructions

| Word PC | Instruction | Result under the timing profile |
| --- | --- | --- |
| `0x007AF2` | `STD Z+38,R18` | At clock 4,706,416, wrote `0xFF` to `0x0926`. D0 TEMP became `0xFF` and active PER still held `0xFFFF`. |
| `0x007AF3` | `STD Z+39,R19` | At clock 4,706,418, wrote `0x0F` to `0x0927`. D0 PER became `0x0FFF`. |
| `0x007AF4` | `STD Z+60,R1` | Attempted `0x00` at `0x093C`, the low byte of `TCD0.CCCBUF`. The write stopped with `UNHANDLED_MMIO`. |

Attempt 2,872,940 stopped with Z = `0x0900`, R1 = `0x00`, SP = `0x5FF3`, and SREG = `0x00`. The emulator recorded the rejected store as a diagnostic before retirement. Both committed writes matched the little-endian Ghidra instruction bytes and the firmware bus trace. TCC0 remained in normal mode with divider 256 and CNT = 0. Execution stopped before the channel C write completed or the firmware configured the D0 clock. Confidence is high for the register identities, values, and executed path under these scenario inputs.

## Three scenarios from reset

| EEPROM and oscillator inputs | Retired instructions | From main | Unique application word PCs | Emulator clocks | First controlled stop |
| --- | ---: | ---: | ---: | ---: | --- |
| Unknown EEPROM and startup timing | 46,741 | 59 | 59 | 61,988 | `UNKNOWN_EEPROM_DATA` at word `0x014E8C`, EEPROM offset `0x0000` |
| Simulated erased EEPROM and unknown timing | 2,872,372 | 2,825,690 | 578 | 4,705,639 | `OSC_STARTUP_TIMING_UNKNOWN` at word `0x007A52` |
| Simulated erased EEPROM and 12 / 640 reset-clock startup profile | 2,872,939 | 2,826,257 | 670 | 4,706,418 | `UNHANDLED_MMIO` at word `0x007AF4`, data byte `0x093C` |

Each scenario ran twice from the reset vector. The strict scenario retained zero known EEPROM bytes. The first two complete traces matched their previous SHA-256 digests. The third matched the preceding 2,872,937 retired instructions, then added two distinct application PCs in four emulator clocks. All three reproduced the original reset-to-main prefix of 46,682 instructions and 61,883 clocks, SHA-256 `35acd0fd70ed3ebd11a009bcfb756dc1b8b94bb120dbc4b351a36a948305f722`.

## Tests

All 355 previous tests and eight new timer tests passed. The new tests interleave reads and writes across the two timers, commit the high bytes in both orders, replace TEMP through direct access and through TCC0.CNTL, and reset either timer while the other holds a pending byte. They exercise all 65,536 D0 period values with a low byte staged on C0. Synthetic AVR instructions also verify bus accesses, clock counts, register-pair preservation, deterministic replay, and a rejected buffer write. The audit checked 51 prior test-file digests, 11 historical trace hashes, and 16 original firmware and Ghidra files. [Independent isolation tests](../../tests/tcd0-period.test.mjs)

The separate direct-I/O LDS timing probe still measures one clock against the documented two. The two newly retired firmware instructions both use STD. The reported totals use the historical timing profile. [Microchip LDS timing table](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-42EBE7FA-6359-4986-827E-28F00A3B2FAF.html)

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
