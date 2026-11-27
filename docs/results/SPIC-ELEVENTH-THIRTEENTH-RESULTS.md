# SPIC replies 11 through 13

Replies 11 and 12 overwrite the last two cells. Reply 13 replaces reply 9 at `0x4870`. The buffer then holds replies 13, 10, 11, and 12. The next transfer sends `0x10` and completes 32 clocks after it starts.

The two reset sequences leave `49 27 D2 87` and `B6 D8 2D 78` in SRAM. The stop before reply 14 occurs after 2,896,940 instructions with PF4 low and 2,896,964 with PF4 high. Continuous replays from an earlier stop also matched all three trace sections and the final SRAM on both selected paths.

## SPI transfers

MOSI is the byte sent by the firmware. The counts run from the blocked read for the current reply to the following stop.

| Reply | MOSI | SRAM destination | Replaces reply | Next MOSI | Instructions | Clocks | Next stop, PF4 low | Next stop, PF4 high |
| ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| 11 | `0x00` | `0x4872` | 7 | `0x23` | 48 | 78 | 4,742,360 | 4,742,398 |
| 12 | `0x23` | `0x4873` | 8 | `0x00` | 160 | 261 | 4,742,621 | 4,742,659 |
| 13 | `0x00` | `0x4870` | 9 | `0x10` | 48 | 78 | 4,742,699 | 4,742,737 |

Each section used every MISO value from `0x00` through `0xFF` on each of the two PF4 paths. That gives **512 executed cases per reply**. Each sweep starts at the saved firmware state for that history. Within a history, the current reply changes only the destination byte in SRAM at the next stop. Control flow, elapsed clocks, and the CPU and GPIO end states match across the 256 inputs. The final SPI state also matches.

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| SPIC reply 11 | 550 | 7 | 2,896,732–2,896,756 | 4,742,360–4,742,398 | `0x00FD24` |
| SPIC reply 12 | 550 | 7 | 2,896,892–2,896,916 | 4,742,621–4,742,659 | `0x00FD24` |
| SPIC reply 13 | 550 | 7 | 2,896,940–2,896,964 | 4,742,699–4,742,737 | `0x00FD24` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](SPIC-EIGHTH-TENTH-RESULTS.md) · [Next report](SPIC-FOURTEENTH-SIXTEENTH-RESULTS.md)
