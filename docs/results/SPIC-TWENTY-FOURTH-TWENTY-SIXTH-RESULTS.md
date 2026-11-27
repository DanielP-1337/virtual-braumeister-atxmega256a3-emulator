# SPIC replies 24 through 26

The next open input is **SPIC reply 27**. The firmware sends `0x06` and stops at word PC `0x00FD24` while reading `SPIC.DATA` (data address `0x08C3`). Depending on the PF4/PF5/PF6 history, the stop falls between **4,804,642 and 4,804,756 emulator clocks**.

After reply 24 the firmware makes 36 additional SRAM writes. Four instructions at word PCs `0x008098`, `0x008099`, `0x00809B`, and `0x00809D` replace `00 11 42 30` with `00 02 06 00` in the transmit buffer at `0x476B–0x476E`. Transfers 25 through 27 load the first three bytes at word PC `0x00FD1A` and send them at `0x00FD1E`.

After reply 24, the firmware writes `0x10` to `PORTC.OUTSET`, then `0x08`, `0x10`, and `0x10` to `PORTC.OUTCLR`. After reply 25 it issues no GPIO write. After reply 26 it writes `0x08` to `PORTC.OUTSET`. No interrupt was taken in any of these three sections. The receive cells at `0x4870–0x4873` now hold replies **25, 26, 23, and 24**.

## SPI transfers

MOSI is the byte sent by the firmware. The counts run from the blocked read for the current reply to the following stop.

| Reply | MOSI | SRAM destination | Replaces reply | Next MOSI | Instructions | Clocks |
| ---: | --- | --- | ---: | --- | ---: | ---: |
| 24 | `0x30` | `0x4873` | 20 | `0x00` | 160 | 261 |
| 25 | `0x00` | `0x4870` | 21 | `0x02` | 48 | 78 |
| 26 | `0x02` | `0x4871` | 22 | `0x06` | 53 | 92 |

Each section used every MISO value from `0x00` through `0xFF` on each of the eight pin histories. That gives **2,048 executed cases per reply**. Each sweep starts at the saved firmware state for that history. Within a history, the current reply changes only the destination byte in SRAM at the next stop. Control flow, elapsed clocks, and the CPU and GPIO end states match across the 256 inputs. The final SPI state also matches.

## Stop clocks by pin history

| PF4 / PF5 / PF6 | Before reply 24 | Before reply 25 | Before reply 26 | Before reply 27 |
| --- | ---: | ---: | ---: | ---: |
| low / low / low | 4,804,211 | 4,804,472 | 4,804,550 | 4,804,642 |
| low / low / high | 4,804,249 | 4,804,510 | 4,804,588 | 4,804,680 |
| low / high / low | 4,804,249 | 4,804,510 | 4,804,588 | 4,804,680 |
| low / high / high | 4,804,287 | 4,804,548 | 4,804,626 | 4,804,718 |
| high / low / low | 4,804,249 | 4,804,510 | 4,804,588 | 4,804,680 |
| high / low / high | 4,804,287 | 4,804,548 | 4,804,626 | 4,804,718 |
| high / high / low | 4,804,287 | 4,804,548 | 4,804,626 | 4,804,718 |
| high / high / high | 4,804,325 | 4,804,586 | 4,804,664 | 4,804,756 |

The samples are PF4 at clock 4,738,396, PF5 at 4,770,657, and PF6 at 4,802,913. Every earlier high sample adds 38 clocks to the absolute SPI stop times shown here.

Two uninterrupted replays for low/low/low and high/high/high matched all six instruction sections, both terminal diagnostics, and the two final SRAM images. Eight representative input histories ran twice from reset at each step.

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| SPIC reply 24 | 550 | 11 | 2,928,023–2,928,095 | 4,804,472–4,804,586 | `0x00FD24` |
| SPIC reply 25 | 550 | 11 | 2,928,071–2,928,143 | 4,804,550–4,804,664 | `0x00FD24` |
| SPIC reply 26 | 550 | 11 | 2,928,124–2,928,196 | 4,804,642–4,804,756 | `0x00FD24` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](SPIC-TWENTY-FIRST-TWENTY-THIRD-RESULTS.md)
