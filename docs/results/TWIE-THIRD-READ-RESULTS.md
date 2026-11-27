# TWIE read byte 3

The second RECVTRANS command at word PC `0x01334D` writes `0x02` to `TWIE.MASTER.CTRLC` at clock 4,721,538. The master acknowledges the preceding byte at 4,721,858. The third `0x00` arrives at 4,724,418, and the CPU reaches the TWIE interrupt vector at 4,724,420.

The handler reads `TWIE.MASTER.DATA` at word PC `0x013324` and clock 4,724,489. It stores the byte at SRAM `0x41D8` and sets `0x4219` to 3. At 4,724,504 clocks it reaches the command for byte 4 (index 3). The bus access at 4,724,505 records `TWI_UNKNOWN_DATA`. [Third-byte tests](../../tests/twie-third-read.test.mjs)

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| TWIE read byte 3 | 538 | 12 | 2,884,940 | 4,724,504 | `0x01334D` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](TWIE-READ-RESULTS.md) · [Next report](TWIE-FOURTH-FIFTH-READ-RESULTS.md)
