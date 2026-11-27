# SPIC replies 21 through 23

Each of replies 21 through 23 is read two clocks after its preceding stop and stored after five clocks. That store is the only SRAM write in its section. At the last stop the receive cells hold replies 21, 22, 23, and 20.

Word PC `0x00FD1A` loads the next outgoing bytes `11 42 30` from SRAM `0x476C` through `0x476E`. Word PC `0x00FD1E` writes each to `SPIC.DATA`. After reply 22 the firmware also writes `0x08` to `PORTC.OUTSET` at word PC `0x00FD5A`.

## SPI transfers

MOSI is the byte sent by the firmware. The counts run from the blocked read for the current reply to the following stop.

| Reply | MOSI | SRAM destination | Replaces reply | Next MOSI | Instructions | Clocks |
| ---: | --- | --- | ---: | --- | ---: | ---: |
| 21 | `0x00` | `0x4870` | 17 | `0x11` | 48 | 78 |
| 22 | `0x11` | `0x4871` | 18 | `0x42` | 53 | 92 |
| 23 | `0x42` | `0x4872` | 19 | `0x30` | 48 | 78 |

Each section used every MISO value from `0x00` through `0xFF` on each of the eight pin histories. That gives **2,048 executed cases per reply**. Each sweep starts at the saved firmware state for that history. Within a history, the current reply changes only the destination byte in SRAM at the next stop. Control flow, elapsed clocks, and the CPU and GPIO end states match across the 256 inputs. The final SPI state also matches.

## Stop clocks by pin history

| PF4 / PF5 / PF6 | Before reply 21 | Before reply 22 | Before reply 23 | Before reply 24 |
| --- | ---: | ---: | ---: | ---: |
| low / low / low | 4,803,963 | 4,804,041 | 4,804,133 | 4,804,211 |
| low / low / high | 4,804,001 | 4,804,079 | 4,804,171 | 4,804,249 |
| low / high / low | 4,804,001 | 4,804,079 | 4,804,171 | 4,804,249 |
| low / high / high | 4,804,039 | 4,804,117 | 4,804,209 | 4,804,287 |
| high / low / low | 4,804,001 | 4,804,079 | 4,804,171 | 4,804,249 |
| high / low / high | 4,804,039 | 4,804,117 | 4,804,209 | 4,804,287 |
| high / high / low | 4,804,039 | 4,804,117 | 4,804,209 | 4,804,287 |
| high / high / high | 4,804,077 | 4,804,155 | 4,804,247 | 4,804,325 |

The samples are PF4 at clock 4,738,396, PF5 at 4,770,657, and PF6 at 4,802,913. Every earlier high sample adds 38 clocks to the absolute SPI stop times shown here.

Two uninterrupted replays for low/low/low and high/high/high matched all six instruction sections, both terminal diagnostics, and the two final SRAM images. Eight representative input histories ran twice from reset at each step.

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| SPIC reply 21 | 550 | 11 | 2,927,762–2,927,834 | 4,804,041–4,804,155 | `0x00FD24` |
| SPIC reply 22 | 550 | 11 | 2,927,815–2,927,887 | 4,804,133–4,804,247 | `0x00FD24` |
| SPIC reply 23 | 550 | 11 | 2,927,863–2,927,935 | 4,804,211–4,804,325 | `0x00FD24` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](SPIC-EIGHTEENTH-TWENTIETH-RESULTS.md) · [Next report](SPIC-TWENTY-FOURTH-TWENTY-SIXTH-RESULTS.md)
