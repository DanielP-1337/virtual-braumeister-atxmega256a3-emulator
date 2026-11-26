# TCD1 channel A compare buffer

BrewControl 1.1.27 completed both writes to TCD1.CCABUF in the run with simulated erased EEPROM and the explicit oscillator timing profile. The high-byte write set CCABV. The firmware stopped on its first write to TCD1.CCBBUFL while channel A was still pending. Independent tests verified the later transfer to active CCA using nonzero, distinct values.

## Register behavior

| ATxmega256A3 TC1 register | Data-byte address | Behavior in compare mode |
| --- | --- | --- |
| TEMP | `0x094F` | Shared CPU byte for this timer’s 16-bit register accesses. Reading a low byte latches the corresponding active or buffered high byte. |
| CCABUFL / CCABUFH | `0x0978 / 0x0979` | The low write stages TEMP. The high write commits the complete buffer word and sets CCABV, including when the new word is zero. |
| CCAL / CCAH | `0x0968 / 0x0969` | An unlocked UPDATE copies a valid buffer to CCA and clears CCABV. The last buffer value remains readable. Direct writes to CCA use TEMP. |
| CTRLGCLR / CTRLGSET | `0x094A / 0x094B` | Both aliases read the same flags. Writing bit 1 clears or sets CCABV through its respective alias. |
| CTRLFCLR / CTRLFSET | `0x0948 / 0x0949` | Bit 1 controls LUPD. Writing `0x04` to CTRLFSET issues UPDATE. Releasing LUPD permits transfer at the next UPDATE. |

**High confidence.** The A3 datasheet locates TCD1 at `0x0940`. The installed ATxmega256A3 TC1 register group confirms A and B are its two compare channels. CCA, CCABUF, CCABV, LUPD and TEMP reset to zero. The model recognizes the device-defined PERBV and CCBBV fields and stops on attempts to change either unimplemented flag. Clock selection, waveform generation and input capture for TCD1 remain open. [A3 peripheral map, p. 56](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf#page=56) · [CPU byte access, p. 13](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=13) · [Double buffering, p. 154](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=154) · [Control flags, pp. 167–168](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=168) · [Compare buffer reset values, p. 172](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=172)

## Instruction evidence

The Ghidra listing, fetched bytes and bus trace agree. Z held `0x0940`, R1 held `0x00`, SREG was `0x00`, and SP was `0x5FF3`. Each word PC corresponds to twice that address in flash bytes.

| Word PC | Instruction | Data byte | Outcome | Emulator clock |
| --- | --- | --- | --- | ---: |
| `0x007B01` | `STD Z+56,R1` | `0x0978` | CCABUFL stages zero. TCD1 TEMP changes from `0xFF` to `0x00`. CCABV remains clear. | 4,706,438 |
| `0x007B02` | `STD Z+57,R1` | `0x0979` | CCABUFH commits `0x0000`. CCABV is set. | 4,706,440 |
| `0x007B03` | `STD Z+58,R1` | `0x097A` | `UNHANDLED_MMIO` on CCBBUFL. Attempt 2,872,953 stopped before retirement. | 4,706,440 |

TCD0 counted from 6 to 10 during the two stores. It retained `PER = 0x0FFF`, `TEMP = 0x00`, and both C/D buffer-valid flags. TCD1 also retained `PER = 0x0FFF`. The set CCABV flag distinguishes a pending zero from a completed transfer even though CCA and CCABUF each read zero at the stop. The path establishes a compare-buffer write. Subsequent use of the channel and any external load remain unverified.

## Regression and reset runs

**412 of 412 tests passed**, covering all 402 previous tests and ten new channel A tests. The tests exercised all 65,536 words, both flag aliases, local TEMP sharing, locking, explicit UPDATE and precise failures. In a synthetic AVR program an UPDATE transferred `0x7E3C` to active CCA and cleared CCABV. A separate test drove the running TCD0 through BOTTOM. TCD0 transferred its own valid buffers while TCD1 A remained pending. No UPDATE event was injected into the firmware runs. [New tests](../../tests/tcd1-ccabuf.test.mjs)

| Inputs | Retired instructions | From main | Distinct application word PCs | Emulator clocks | First controlled stop |
| --- | ---: | ---: | ---: | ---: | --- |
| Unknown EEPROM and oscillator startup | 46,741 | 59 | 59 | 61,988 | `UNKNOWN_EEPROM_DATA`, word `0x014E8C`, EEPROM offset `0x0000` |
| Simulated erased EEPROM, unknown oscillator startup | 2,872,372 | 2,825,690 | 578 | 4,705,639 | `OSC_STARTUP_TIMING_UNKNOWN`, word `0x007A52` |
| Simulated erased EEPROM, 12 / 640 reset-clock oscillator timing profile | 2,872,952 | 2,826,270 | 683 | 4,706,440 | `UNHANDLED_MMIO`, word `0x007B03`, TCD1.CCBBUFL |

Each scenario ran twice from reset with deterministic replay. The strict run retained zero known EEPROM bytes. The first two full trace hashes matched the previous milestone. The timed run reproduced all 2,872,950 previously retired instructions, then retired two more. Its new trace SHA-256 is `bcbbd0b702625a61f49dca6a759cdc86213f53c56fd468cf49862cc8c6d4d5d5`. Both erased-EEPROM commands returned native exit code 2 for a controlled stop.

All three runs reproduced the PoC 001 checkpoint at 46,682 instructions and 61,883 emulator clocks, SHA-256 `35acd0fd70ed3ebd11a009bcfb756dc1b8b94bb120dbc4b351a36a948305f722`. The regression audit verified 56 prior test files, 11 historical trace hashes and 16 original firmware and Ghidra files. The separate direct-I/O `LDS` probe continues to measure one emulator clock against the documented two. Both new stores are `STD` instructions and each retired in two emulator clocks. [Microchip LDS timing](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-42EBE7FA-6359-4986-827E-28F00A3B2FAF.html)

## Next hardware requirement

The timed trace requires TCD1.CCBBUFL at `0x097A`. The device pack pairs it with CCBBUFH at `0x097B` and maps active CCB to `0x096A/0x096B`. Channel B has its own CCBBV flag (bit 2), shares TCD1 TEMP and the update lock with A, and requires independent staging and transfer tests. The firmware has reached the first B low-byte attempt. A complete application boot remains unverified.

[All milestones](README.md) · [Reset results and trace hashes](reset-runs.json)
