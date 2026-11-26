# TCD1 active period on the ATxmega256A3

BrewControl 1.1.27 writes both bytes of `TCD1.PER` while TCD0 is counting. In the run with simulated erased EEPROM and the explicit oscillator timing profile, both stores retired. The next instruction attempted to write zero to `TCD1.CCABUFL` at data byte `0x0978` and stopped on unmapped MMIO. The full suite passed all **402 tests**, including the 393 previous tests.

## Register behavior and timer isolation

| ATxmega256A3 instance | Base | CPU TEMP | Active PERL / PERH | Reset TEMP / PER |
| --- | ---: | ---: | ---: | ---: |
| TCD0 (TC0) | `0x0900` | `0x090F` | `0x0926 / 0x0927` | `0x00 / 0xFFFF` |
| TCD1 (TC1) | `0x0940` | `0x094F` | `0x0966 / 0x0967` | `0x00 / 0xFFFF` |

**High confidence.** The A3 datasheet and the installed ATxmega256A3 device description identify separate timer instances. On a low-byte write, the addressed timer stages the value in its own TEMP. A high-byte write commits the high byte together with the staged low byte to the active period. Reading PERL returns the active low byte and latches the active high byte in TEMP. Reading PERH returns that latch. A high-first read immediately after reset therefore returns `0x00`. The CPU can also access TEMP directly. [A3 address map, p. 56](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=56) · [XMEGA A byte access, p. 13](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=13) · [Timer registers, pp. 170–171](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=170)

The nine new tests exercise all 65,536 period values, both commit orders, read latching, local resets, unmapped neighbors and conflicting registrations. Interleaved writes produced `TCD0.PER = 0x2491` and `TCD1.PER = 0x3672` with their respective TEMP bytes `0x91` and `0x72`. A second test performed TCD1 writes at TCD0 TOP and BOTTOM. TCD0’s counter, C/D buffer transfers, flags, TEMP and full register-access history matched a control run. Synthetic AVR loads and stores verified the instruction-level trace and deterministic replay. [Independent tests](../../tests/tcd1-period.test.mjs)

## Firmware evidence

Word PCs count 16-bit flash words. Flash and MMIO addresses below count bytes. Z held `0x0940` on all three attempts. The private Ghidra listing and the trace agree on the fetched bytes, opcodes, displacements and source registers. The last row is an emulator diagnostic for a failed store.

| Word PC | Instruction | Data byte / value | Result | Emulator clocks after retirement |
| ---: | --- | --- | --- | ---: |
| `0x007AFF` | `STD Z+38,R18` | `0x0966 / 0xFF` | TCD1 TEMP became `0xFF`. Active PER was still `0xFFFF`. | 4,706,434 |
| `0x007B00` | `STD Z+39,R19` | `0x0967 / 0x0F` | TCD1 committed `PER = 0x0FFF`. TEMP held `0xFF`. | 4,706,436 |
| `0x007B01` | `STD Z+56,R1` | `0x0978 / 0x00` | `UNHANDLED_MMIO` on TCD1.CCABUFL, attempt 2,872,951. | Did not retire |

TCD0 counted from 2 to 6 at `clkPER/1` during the two stores. Its active period was `0x0FFF`, its TEMP was `0x00`, and both C/D buffer-valid flags remained set. The CPU stopped with `SP = 0x5FF3` and `SREG = 0x00`. The 2,872,948 previously retired instructions matched their archived trace byte for byte. The two new instructions added four emulator clocks and two distinct application word PCs.

## Three scenarios from reset

| Input scenario | Retired instructions | From main | Distinct application word PCs | Emulator clocks | First controlled stop |
| --- | ---: | ---: | ---: | ---: | --- |
| Unknown EEPROM and oscillator startup | 46,741 | 59 | 59 | 61,988 | `UNKNOWN_EEPROM_DATA` at word `0x014E8C`, EEPROM offset `0x0000` |
| Simulated erased EEPROM, unknown oscillator startup | 2,872,372 | 2,825,690 | 578 | 4,705,639 | `OSC_STARTUP_TIMING_UNKNOWN` at word `0x007A52` |
| Simulated erased EEPROM, 12 / 640 reset-clock timing profile | 2,872,950 | 2,826,268 | 681 | 4,706,436 | `UNHANDLED_MMIO` at word `0x007B01`, TCD1.CCABUFL |

Each scenario ran twice from reset with deterministic replay. The strict run had zero known EEPROM bytes. The first two complete trace hashes matched the preceding milestone. All three reproduced the PoC 001 reset-to-main checkpoint at 46,682 instructions and 61,883 emulator clocks, SHA-256 `35acd0fd70ed3ebd11a009bcfb756dc1b8b94bb120dbc4b351a36a948305f722`. The timed trace SHA-256 is `c174cd560209fa5157837cc48dba3547124091b86452ba2b37e33d6f82aaa080`. The two erased-EEPROM discovery commands returned native exit code 2.

The regression audit verified 55 prior test files, 11 historical trace hashes and all 16 original firmware and Ghidra files. The separate direct-I/O `LDS` probe still measures one emulator clock against the documented two. Both newly retired instructions were `STD`. The clock totals above use the existing emulator timing model. [Microchip LDS timing](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-42EBE7FA-6359-4986-827E-28F00A3B2FAF.html)

## Next hardware requirement

**Verified with high confidence.** The next access requires the low byte of the TCD1 channel A compare/capture buffer. The device maps CCABUFL/H to `0x0978/0x0979` and active CCA to `0x0968/0x0969`. The next implementation should exercise low-byte staging in TCD1 TEMP. In compare mode, test that the high-byte commit sets CCABV (bit 1) and that an UPDATE transfers the pending value to CCA. The measured path ends on the first low-byte attempt. Later channel configuration, output use and complete application boot remain unverified. [Timer buffering, §14.5](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=154)

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
