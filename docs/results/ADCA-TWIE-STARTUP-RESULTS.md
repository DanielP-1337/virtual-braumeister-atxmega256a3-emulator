# First PA1 conversion and the TWIE write to address 0x57

Two complete runs from reset reached the TWIE write address `0x57` at word PC `0x0132B2` after **37,279,312 instructions and 53,702,806 emulator clocks**. Both produced the same full trace and SRAM image through the unresolved address response. The firmware entered its application at word PC `0x007B43` after 46,682 instructions and 61,883 clocks. [Reset and branch hashes](reset-runs.json)

The full runs used erased EEPROM, the `a3-wake-proxy` oscillator timing profile, calibration bytes `0x5A/0x03`, and PE2 held high over the observed interval. The first TWIE transaction to `0x6F` acknowledged the write address, offset, and read address and returned eight zero bytes. After the recorded initial replies, SPIC supplied zero starting at reply 30. The fixed low GPIO history and seven zero SPIE replies reproduce the path to the ADC. The example uses ADC clock phase 0 and a PA1 result of `0x000`. [SPIE and the preceding delay](SPIE-CPU-STARTUP-RESULTS.md)

## First ADC result

At word PC `0x010293`, the firmware writes `0x05` to `ADCA.CTRLA`. The ADC is enabled and settled. Channel 0 selects PA1, single-ended input, unity gain, unsigned 12-bit resolution, and the internal VCC/1.6 reference. With the peripheral clock divided by 256, the write occurs at emulator clock 53,699,670. The first sampling edge falls between 53,699,671 and 53,699,926. The conversion finishes seven ADC clocks later, between 53,701,463 and 53,701,718. [ADC conversion tests](../../tests/adca-conversion.test.mjs)

| Clock before the result read | Prescaler phases | Flag polls |
| ---: | ---: | ---: |
| 53,701,511 | 44 | 28 |
| 53,701,579 | 68 | 29 |
| 53,701,647 | 68 | 30 |
| 53,701,715 | 68 | 31 |
| 53,701,783 | 8 | 32 |

Leaving the clock phase open stops execution at the first ambiguous flag read, word PC `0x01029D`, clock 53,701,505. After completion, the firmware clears the flag at `0x0102A2` and reads the low and high result bytes at `0x0102A4` and `0x0102A6`. Reading the low byte latches the high byte in the shared TEMP register. Leaving the digitized input open stops execution at the low-byte read. The runner accepts an explicit test such as `--synthetic-adca-clock-phase 0 --synthetic-adca-ch0-results 0x000`. [Input parser](../../scripts/adca-input.mjs)

All 4,096 results ran on each of the five polling paths. These 20,480 CPU executions cover **1,048,576 phase/value combinations**. The firmware stores the value at SRAM `0x30A1/0x30A2` and copies it into 32 words starting at `0x30AA`. All combinations reach the same TWIE address. In 248 phases the address write is the next external input. In the other eight, TCC0 first samples PF6 at clock 53,703,005. All 64 port values consistent with PF0 driven low and PF3 driven high still reach `0x57`. [Polling classes and stop clocks](reset-runs.json)

## Address response

The wire address byte is `0xAE`. The table gives the next stop for each possible address response on the phase-0 example, with the next port sample set to `0x08`.

| Response to 0xAE | Next word PC | Emulator clocks | Next open response |
| --- | --- | ---: | --- |
| ACK | `0x0132FB` | 53,705,769 | ACK or NACK for the offset byte `0xF0` sent to `0x57` |
| NACK | `0x0132B2` | 53,706,193 | Response to a new write address byte `0xDE` for `0x6F` |

The driver requests eight bytes at offset `0xF0` from `0x57` and later requests eight bytes at offset `0x00` from `0x6F`. The tested ACK and NACK are alternatives. The physical device responses and the rest of the board boot remain open. A further 1,408 CPU executions cover the nearby pin samples and both address outcomes. [Conditional traces and next requests](reset-runs.json)

Each of the ADC start, flag polling, result read, and TWIE address steps passed **562 Node tests**, four Python comparison tests, the export test, 11 historical trace checks, and 16 original-file checks. The three standard controls ran twice per step. The independent direct-peripheral `LDS` probe still measures one emulator clock against two expected clocks. [Reset controls](README.md#reset-controls) · [LDS timing probe](../../verification/cpu/lds-mmio-timing.mjs)
