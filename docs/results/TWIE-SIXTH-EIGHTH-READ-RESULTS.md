# TWIE read bytes 6 through 8 and the first PORTF sample

The firmware requests bytes 6, 7, and 8 at word PC `0x01334D`. The first two requests fill their SRAM slots. A low-priority TCC0 overflow interrupts the wait for byte 8. The CPU reaches a PORTF input read before the byte is due on the bus.

| Byte | RECVTRANS write | ACK for preceding byte | Bus arrival | Data register read | SRAM at the stop |
|---:|---:|---:|---:|---:|---|
| 6 | 4,730,439 | 4,730,759 | 4,733,319 | 4,733,391 | `0x41DB = 0x00` |
| 7 | 4,733,407 | 4,733,727 | 4,736,287 | 4,736,358 | `0x41DC = 0x00` |
| 8 | 4,736,374 | 4,736,694 | Due at 4,739,254 | Pending | Seven bytes stored |

The timer interrupts word PC `0x01037A` at 4,738,304 clocks and reaches vector `0x00001C` at 4,738,306. The handler attempts to read `PORTF.IN` at data address `0x06A8` and word PC `0x0079C5`. The CPU stops at clock 4,738,395, one clock before the input sample. SRAM `0x475C` holds the mask `0x10` for PF4. PF0 and PF3 are low outputs. The other six pins have pull-ups and their external levels are unknown.

The replay with the timer and GPIO state restored matched all 20,850 trace entries from the first TWIE address access through the diagnostic, plus the final SRAM image. The transfer completed on both PF4 paths in the following milestone. [PF4 and the end of the TWIE transaction](PORTF-SPIC-BRANCH-RESULTS.md)

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| TWIE read byte 6 | 541 | 5 | 2,890,868 | 4,733,406 | `0x01334D` |
| TWIE read byte 7 | 541 | 5 | 2,892,844 | 4,736,373 | `0x01334D` |
| TWIE read byte 8 | 541 | 5 | 2,894,186 | 4,738,395 | `0x0079C5` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](TWIE-FOURTH-FIFTH-READ-RESULTS.md) · [Next report](PORTF-SPIC-BRANCH-RESULTS.md)
