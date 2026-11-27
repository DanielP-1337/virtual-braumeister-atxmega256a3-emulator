# SPIC replies 2 through 4

Replies 2 through 4 fill the remaining three cells in the receive buffer. Each step reads `SPIC.DATA` at word PC `0x00FD24` and writes the reply at `0x00FD27`. The next access after reply 4 is another read of the same SPI data register.

Two complementary four-byte sequences, `00 FF 00 FF` and `FF 00 FF 00`, were replayed from reset on both PF4 paths. The fifth transfer starts at clock 4,741,569 or 4,741,607 and completes 32 clocks later. The stop before reply 5 occurs after 2,896,274 or 2,896,298 retired instructions.

## SPI transfers

MOSI is the byte sent by the firmware. The counts run from the blocked read for the current reply to the following stop.

| Reply | MOSI | SRAM destination | Replaces reply | Next MOSI | Instructions | Clocks | Next stop, PF4 low | Next stop, PF4 high |
| ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | `0x07` | `0x4871` | First use | `0x00` | 53 | 92 | 4,741,264 | 4,741,302 |
| 3 | `0x00` | `0x4872` | First use | `0x21` | 48 | 78 | 4,741,342 | 4,741,380 |
| 4 | `0x21` | `0x4873` | First use | `0x00` | 160 | 261 | 4,741,603 | 4,741,641 |

Each section used every MISO value from `0x00` through `0xFF` on each of the two PF4 paths. That gives **512 executed cases per reply**. Each sweep starts at the saved firmware state for that history. Within a history, the current reply changes only the destination byte in SRAM at the next stop. Control flow, elapsed clocks, and the CPU and GPIO end states match across the 256 inputs. The final SPI state also matches.

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| SPIC reply 2 | 550 | 7 | 2,896,066–2,896,090 | 4,741,264–4,741,302 | `0x00FD24` |
| SPIC reply 3 | 550 | 7 | 2,896,114–2,896,138 | 4,741,342–4,741,380 | `0x00FD24` |
| SPIC reply 4 | 550 | 7 | 2,896,274–2,896,298 | 4,741,603–4,741,641 | `0x00FD24` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](PORTF-SPIC-BRANCH-RESULTS.md) · [Next report](SPIC-FIFTH-SEVENTH-RESULTS.md)
