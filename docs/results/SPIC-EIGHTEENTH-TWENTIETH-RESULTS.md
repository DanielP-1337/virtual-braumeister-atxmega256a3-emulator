# SPIC replies 18 through 20

Replies 18 and 19 each cause one SRAM write. After reply 20, the firmware returns from word PC `0x00FD56` to `0x008417`, then calls `0x008088` from `0x00841A`. This path makes 36 additional SRAM writes outside the receive buffer. Their addresses and values match across all current reply values within a pin history.

At the stop before reply 21 the four receive cells hold replies 17, 18, 19, and 20. Each reply is stored by word PC `0x00FD27` five clocks after the preceding stop. Transfer 21 sends `0x00`.

## SPI transfers

MOSI is the byte sent by the firmware. The counts run from the blocked read for the current reply to the following stop.

| Reply | MOSI | SRAM destination | Replaces reply | Next MOSI | Instructions | Clocks |
| ---: | --- | --- | ---: | --- | ---: | ---: |
| 18 | `0x07` | `0x4871` | 14 | `0x00` | 53 | 92 |
| 19 | `0x00` | `0x4872` | 15 | `0x33` | 48 | 78 |
| 20 | `0x33` | `0x4873` | 16 | `0x00` | 160 | 261 |

Each section used every MISO value from `0x00` through `0xFF` on each of the eight pin histories. That gives **2,048 executed cases per reply**. Each sweep starts at the saved firmware state for that history. Within a history, the current reply changes only the destination byte in SRAM at the next stop. Control flow, elapsed clocks, and the CPU and GPIO end states match across the 256 inputs. The final SPI state also matches.

## Stop clocks by pin history

| PF4 / PF5 / PF6 | Before reply 18 | Before reply 19 | Before reply 20 | Before reply 21 |
| --- | ---: | ---: | ---: | ---: |
| low / low / low | 4,803,532 | 4,803,624 | 4,803,702 | 4,803,963 |
| low / low / high | 4,803,570 | 4,803,662 | 4,803,740 | 4,804,001 |
| low / high / low | 4,803,570 | 4,803,662 | 4,803,740 | 4,804,001 |
| low / high / high | 4,803,608 | 4,803,700 | 4,803,778 | 4,804,039 |
| high / low / low | 4,803,570 | 4,803,662 | 4,803,740 | 4,804,001 |
| high / low / high | 4,803,608 | 4,803,700 | 4,803,778 | 4,804,039 |
| high / high / low | 4,803,608 | 4,803,700 | 4,803,778 | 4,804,039 |
| high / high / high | 4,803,646 | 4,803,738 | 4,803,816 | 4,804,077 |

The samples are PF4 at clock 4,738,396, PF5 at 4,770,657, and PF6 at 4,802,913. Every earlier high sample adds 38 clocks to the absolute SPI stop times shown here.

Two uninterrupted replays for low/low/low and high/high/high matched all six instruction sections, both terminal diagnostics, and the two final SRAM images. Eight representative input histories ran twice from reset at each step.

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| SPIC reply 18 | 550 | 11 | 2,927,506–2,927,578 | 4,803,624–4,803,738 | `0x00FD24` |
| SPIC reply 19 | 550 | 11 | 2,927,554–2,927,626 | 4,803,702–4,803,816 | `0x00FD24` |
| SPIC reply 20 | 550 | 11 | 2,927,714–2,927,786 | 4,803,963–4,804,077 | `0x00FD24` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](PORTF-PF5-PF6-SPIC17-RESULTS.md) · [Next report](SPIC-TWENTY-FIRST-TWENTY-THIRD-RESULTS.md)
