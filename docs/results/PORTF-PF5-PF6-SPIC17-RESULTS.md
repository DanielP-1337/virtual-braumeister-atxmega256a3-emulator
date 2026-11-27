# PF5, PF6, and SPIC reply 17

The second PORTF sample occurs at clock 4,770,657. On each of the two earlier PF4 paths, two saved SPI histories were checked against all 256 raw inputs. The firmware uses mask `0x20` (PF5). Both PF5 branches write `0x40` to `0x475C` for the next poll. The timer interrupt returns at 4,770,723 clocks with PF5 low or 4,770,761 with PF5 high. All paths reach the next input boundary at 4,802,912 clocks.

At clock 4,802,913 the third input is masked with `0x40` (PF6). Four PF4/PF5 histories were checked against 256 values apiece. For either sample, 64 byte values agree with the two low outputs (`value & 0x09 == 0`). Of those, 32 select each branch. Each sample applies only at its specified bus clock.

All eight pin histories reach transfer 17 with MOSI `0x00`. All 256 replies per history overwrite reply 13 at `0x4870`. The next transfer sends `0x07`. The next blocked read follows 48 instructions and 78 clocks later. The other three receive cells retain replies 14 through 16.

## Stop clocks by pin history

| PF4 / PF5 / PF6 | PF6 interrupt return | Before reply 17 | Before reply 18 |
| --- | ---: | ---: | ---: |
| low / low / low | 4,802,979 | 4,803,454 | 4,803,532 |
| low / low / high | 4,803,017 | 4,803,492 | 4,803,570 |
| low / high / low | 4,802,979 | 4,803,492 | 4,803,570 |
| low / high / high | 4,803,017 | 4,803,530 | 4,803,608 |
| high / low / low | 4,802,979 | 4,803,492 | 4,803,570 |
| high / low / high | 4,803,017 | 4,803,530 | 4,803,608 |
| high / high / low | 4,802,979 | 4,803,530 | 4,803,608 |
| high / high / high | 4,803,017 | 4,803,568 | 4,803,646 |

The samples are PF4 at clock 4,738,396, PF5 at 4,770,657, and PF6 at 4,802,913. Every earlier high sample adds 38 clocks to the absolute SPI stop times shown here.

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| Second PORTF sample (PF5) | 550 | 9 | 2,927,103–2,927,113 | 4,802,912 | `0x0079C5` |
| Third PORTF sample (PF6) | 550 | 11 | 2,927,405–2,927,477 | 4,803,454–4,803,568 | `0x00FD24` |
| SPIC reply 17 | 550 | 11 | 2,927,453–2,927,525 | 4,803,532–4,803,646 | `0x00FD24` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](SPIC-FOURTEENTH-SIXTEENTH-RESULTS.md) · [Next report](SPIC-EIGHTEENTH-TWENTIETH-RESULTS.md)
