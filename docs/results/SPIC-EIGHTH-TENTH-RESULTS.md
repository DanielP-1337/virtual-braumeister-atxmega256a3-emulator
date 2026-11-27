# SPIC replies 8 through 10

Reply 8 overwrites reply 4, then the firmware wraps to `0x4870` for reply 9. At the next open input, the four buffer cells hold replies 9, 10, 7, and 8 in address order.

The complementary reset runs leave `B4 27 E1 6C` and `4B D8 1E 93` in the buffer. The six earlier case reports for replies 2 through 7 were also reproduced byte for byte.

## SPI transfers

MOSI is the byte sent by the firmware. The counts run from the blocked read for the current reply to the following stop.

| Reply | MOSI | SRAM destination | Replaces reply | Next MOSI | Instructions | Clocks | Next stop, PF4 low | Next stop, PF4 high |
| ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| 8 | `0x01` | `0x4873` | 4 | `0x00` | 160 | 261 | 4,742,112 | 4,742,150 |
| 9 | `0x00` | `0x4870` | 5 | `0x07` | 48 | 78 | 4,742,190 | 4,742,228 |
| 10 | `0x07` | `0x4871` | 6 | `0x00` | 53 | 92 | 4,742,282 | 4,742,320 |

Each section used every MISO value from `0x00` through `0xFF` on each of the two PF4 paths. That gives **512 executed cases per reply**. Each sweep starts at the saved firmware state for that history. Within a history, the current reply changes only the destination byte in SRAM at the next stop. Control flow, elapsed clocks, and the CPU and GPIO end states match across the 256 inputs. The final SPI state also matches.

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| SPIC reply 8 | 550 | 7 | 2,896,583–2,896,607 | 4,742,112–4,742,150 | `0x00FD24` |
| SPIC reply 9 | 550 | 7 | 2,896,631–2,896,655 | 4,742,190–4,742,228 | `0x00FD24` |
| SPIC reply 10 | 550 | 7 | 2,896,684–2,896,708 | 4,742,282–4,742,320 | `0x00FD24` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](SPIC-FIFTH-SEVENTH-RESULTS.md) · [Next report](SPIC-ELEVENTH-THIRTEENTH-RESULTS.md)
