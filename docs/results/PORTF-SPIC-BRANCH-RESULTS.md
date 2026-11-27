# PF4, the SUB instruction, and the first SPIC reply

All 256 port values were applied at bus clock 4,738,396. The handler reads mask `0x10` from SRAM `0x475C`. After the AND instruction at word PC `0x0079C9`, 128 input values share each PF4 outcome. The full reset profiles used `0xE6` and `0xF6`. Both receive the eighth TWIE byte, write it to `0x41DD`, set the count to 8, and issue NACK and STOP. [PORTF sample tests](../../tests/portf-sample.test.mjs)

| Observation | PF4 low | PF4 high |
|---|---:|---:|
| Branch target (word PC) | `0x007A09` | `0x0079D3` |
| 16-bit counter at `0x30ED` | 0 | 1 |
| Return from timer interrupt (clock) | 4,738,462 | 4,738,500 |
| Eighth byte on TWIE (clock) | 4,739,254 | 4,739,254 |
| Firmware reads TWIE data (clock) | 4,739,326 | 4,739,325 |
| NACK and STOP (clock) | 4,739,661 | 4,739,660 |
| Stop before the first SPIC reply (clock) | 4,741,094 | 4,741,132 |
| Stop before the second SPIC reply (clock) | 4,741,172 | 4,741,210 |

Register SUB at word PC `0x00FCF9` subtracts `0xEC` from `0x65`. In one clock R14 becomes `0x79` and SREG becomes `0xA1`. The next SBC produces `0x49` in R15. Checks cover all 1,024 register encodings, all 65,536 operand pairs under two initial C/Z settings, and six independent GNU simulator observations. [SUB tests](../../tests/sub.test.mjs) · [GNU AVR comparison](../../verification/cpu/sub-gnu.mjs)

SPIC sends `0x00` in mode 3, MSB first, with a clock divider of 4. All 256 replies on each PF4 path reach the second transfer in 48 instructions and 78 clocks. Word PC `0x00FD24` reads `SPIC.DATA` at `0x08C3`. Word PC `0x00FD27` stores the first reply at SRAM `0x4870`. The next transfer sends `0x07`. [First-reply tests](../../tests/spic-first-rx.test.mjs)

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| First PORTF sample (PF4) | 544 | 6 | 2,895,908–2,895,932 | 4,741,004–4,741,042 | `0x00FCF9` |
| Register SUB | 546 | 6 | 2,895,965–2,895,989 | 4,741,094–4,741,132 | `0x00FD24` |
| SPIC reply 1 | 548 | 8 | 2,896,013–2,896,037 | 4,741,172–4,741,210 | `0x00FD24` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](TWIE-SIXTH-EIGHTH-READ-RESULTS.md) · [Next report](SPIC-SECOND-FOURTH-RESULTS.md)
