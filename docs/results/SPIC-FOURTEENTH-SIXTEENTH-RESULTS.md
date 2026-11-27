# SPIC replies 14 through 16

After reply 16 the SPI routine returns from word PC `0x00FD56` to `0x00840D`. A TCC0 overflow interrupts the ensuing wait at clock 4,770,561. The CPU reaches vector `0x00001C` at 4,770,563. Its saved return PC is `0x008410` with PF4 low or `0x00840F` with PF4 high.

Both paths stop at 4,770,656 clocks before the second `PORTF.IN` read at word PC `0x0079C5`, one clock before its bus sample. The CPU has retired 2,910,955 or 2,910,960 instructions. SPIC is idle, its interrupt flag is clear, and its data register retains reply 16. The four receive cells hold replies 13 through 16. Each path has one interrupt entry in addition to the instruction counts in the table.

## SPI transfers

MOSI is the byte sent by the firmware. The counts run from the blocked read for the current reply to the following stop.

| Reply | MOSI | SRAM destination | Replaces reply | Next MOSI | Instructions | Clocks | Next stop, PF4 low | Next stop, PF4 high |
| ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| 14 | `0x10` | `0x4871` | 10 | `0x00` | 53 | 92 | 4,742,791 | 4,742,829 |
| 15 | `0x00` | `0x4872` | 11 | `0x00` | 48 | 78 | 4,742,869 | 4,742,907 |
| 16 | `0x00` | `0x4873` | 12 | PORTF read | 13,914 / 13,895 | 27,787 / 27,749 | 4,770,656 | 4,770,656 |

Each section used every MISO value from `0x00` through `0xFF` on each of the two PF4 paths. That gives **512 executed cases per reply**. Each sweep starts at the saved firmware state for that history. Within a history, the current reply changes only the destination byte in SRAM at the next stop. Control flow, elapsed clocks, and the CPU and GPIO end states match across the 256 inputs. At the PORTF stop, SPIC still holds the value of reply 16. The paired instruction and clock counts for reply 16 are in PF4 low/high order.

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| SPIC reply 14 | 550 | 7 | 2,896,993–2,897,017 | 4,742,791–4,742,829 | `0x00FD24` |
| SPIC reply 15 | 550 | 7 | 2,897,041–2,897,065 | 4,742,869–4,742,907 | `0x00FD24` |
| SPIC reply 16 | 550 | 7 | 2,910,955–2,910,960 | 4,770,656 | `0x0079C5` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](SPIC-ELEVENTH-THIRTEENTH-RESULTS.md) · [Next report](PORTF-PF5-PF6-SPIC17-RESULTS.md)
