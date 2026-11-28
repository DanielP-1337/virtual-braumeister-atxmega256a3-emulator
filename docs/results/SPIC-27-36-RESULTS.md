# SPIC replies 27 through 36

BrewControl 1.1.27 reads each reply from `SPIC.DATA` at word PC `0x00FD24` and stores it at `0x00FD27`. For replies 27 through 36, all 256 possible return bytes ran on each of the eight PF4/PF5/PF6 histories. That gives 2,048 cases per reply and **20,480 cases** across the ten steps. After reply 36, the firmware sends `0x00` in transfer 37 and returns to the same read. [Earlier replies](SPIC-TWENTY-FOURTH-TWENTY-SIXTH-RESULTS.md) · [Per-profile clocks, trace hashes, and inputs](reset-runs.json)

| Reply | MOSI | SRAM destination | Next MOSI | Clocks to next read | Emulator clocks before next read | Node tests passed |
| ---: | --- | --- | --- | ---: | ---: | ---: |
| 27 | `0x06` | `0x4872` | `0x00` | 78 | 4,804,720–4,804,834 | 550 |
| 28 | `0x00` | `0x4873` | `0x00` | 261 | 4,804,981–4,805,095 | 550 |
| 29 | `0x00` | `0x4870` | `0x28` | 78 | 4,805,059–4,805,173 | 550 |
| 30 | `0x28` | `0x4871` | `0x00` | 92 | 4,805,151–4,805,265 | 550 |
| 31 | `0x00` | `0x4872` | `0x06` | 78 | 4,805,229–4,805,343 | 550 |
| 32 | `0x06` | `0x4873` | `0x00` | 261 | 4,805,490–4,805,604 | 550 |
| 33 | `0x00` | `0x4870` | `0x01` | 78 | 4,805,568–4,805,682 | 550 |
| 34 | `0x01` | `0x4871` | `0x38` | 92 | 4,805,660–4,805,774 | 550 |
| 35 | `0x38` | `0x4872` | `0xEF` | 78 | 4,805,738–4,805,852 | 553 |
| 36 | `0xEF` | `0x4873` | `0x00` | 261 | 4,805,999–4,806,113 | 556 |

Within each starting history, only the receiving SRAM byte varies at the following stop. After reply 28, the firmware replaces the transmit buffer at `0x476B` with `00 28 00 06`. Each step also replayed the three standard reset scenarios and eight representative pin profiles twice. All four Python comparisons, the export test, 11 historical trace checks, and the 16 original-file checks passed at each step. [Reset controls](README.md#reset-controls)

## Subsequent PORTF samples

The firmware periodically interrupts the transfer loop to read `PORTF.IN` at word PC `0x0079C5`. The following sweeps execute each SPI input through the point where the CPU register states converge, then follow the shared control flow and check every access to the receive cells.

| SPIC reply range | Starting pin histories | Executed SPI cases | Next tested pin | Resulting histories |
| --- | ---: | ---: | --- | ---: |
| 30–88 | 8 | 120,832 | PF7 | 16 |
| 89–92 | 16 | 16,384 | PF4 | 32 |
| 93–100 | 32 | 65,536 | PF5 | 64 |

For replies 30 through 88, two complete resets on each of the eight histories confirmed 472 sections against the saved CPU states, SRAM hashes, and clocks. The PF7 read occurs at clock 4,835,169. All 64 histories after reply 100 also ran to the next port read with a fixed input sequence per history. Depending on the history, the last reply read before that interrupt was 266 through 269. The ranges in this table overlap the individual results above for replies 30 through 36. [Range results and reset hashes](reset-runs.json)

On two fixed GPIO histories, data-flow tracking continued through SPIC transfer 231,490 and the first write to SPIE. [SPIE and CPU startup results](SPIE-CPU-STARTUP-RESULTS.md) · [SPIC data-flow checker](../../verification/gpio/spic-register-dataflow.mjs)
