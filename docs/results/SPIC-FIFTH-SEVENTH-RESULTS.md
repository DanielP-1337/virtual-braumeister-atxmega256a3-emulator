# SPIC replies 5 through 7

Reply 5 wraps to the first receive cell. Each of replies 5 through 7 overwrites one cell without reading its old value. Reply 4 remains in `0x4873` at the stop before reply 8.

The seven-byte reset sequence `00 FF 00 FF A5 39 E1` leaves `A5 39 E1 FF` in the buffer. Its complement leaves `5A C6 1E 00`. CPU traces and complete SRAM images matched the corresponding individual test cases on both PF4 paths.

## SPI transfers

MOSI is the byte sent by the firmware. The counts run from the blocked read for the current reply to the following stop.

| Reply | MOSI | SRAM destination | Replaces reply | Next MOSI | Instructions | Clocks | Next stop, PF4 low | Next stop, PF4 high |
| ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| 5 | `0x00` | `0x4870` | 1 | `0x00` | 48 | 78 | 4,741,681 | 4,741,719 |
| 6 | `0x00` | `0x4871` | 2 | `0x00` | 53 | 92 | 4,741,773 | 4,741,811 |
| 7 | `0x00` | `0x4872` | 3 | `0x01` | 48 | 78 | 4,741,851 | 4,741,889 |

Each section used every MISO value from `0x00` through `0xFF` on each of the two PF4 paths. That gives **512 executed cases per reply**. Each sweep starts at the saved firmware state for that history. Within a history, the current reply changes only the destination byte in SRAM at the next stop. Control flow, elapsed clocks, and the CPU and GPIO end states match across the 256 inputs. The final SPI state also matches.

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| SPIC reply 5 | 550 | 7 | 2,896,322–2,896,346 | 4,741,681–4,741,719 | `0x00FD24` |
| SPIC reply 6 | 550 | 7 | 2,896,375–2,896,399 | 4,741,773–4,741,811 | `0x00FD24` |
| SPIC reply 7 | 550 | 7 | 2,896,423–2,896,447 | 4,741,851–4,741,889 | `0x00FD24` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](SPIC-SECOND-FOURTH-RESULTS.md) · [Next report](SPIC-EIGHTH-TENTH-RESULTS.md)
