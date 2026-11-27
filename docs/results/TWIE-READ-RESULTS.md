# TWIE repeated START and read bytes 1 and 2

At word PC `0x013312`, the master writes `0xDF` to `TWIE.MASTER.ADDR` at clock 4,713,044. The target acknowledges the repeated read address at 4,715,924. Its first `0x00` arrives at 4,718,484 and triggers a read interrupt. The CPU reaches vector `0x00005C` at 4,718,486. At word PC `0x013324` the handler reads `TWIE.MASTER.DATA`, stores the byte at SRAM `0x41D6`, and increments the receive count at `0x4219`. A separate run with only the address ACK stops at `0x013312` with `TWI_UNKNOWN_DATA`. [Repeated-read tests](../../tests/twie-repeated-read.test.mjs)

At word PC `0x01334D`, the firmware writes `0x02` (RECVTRANS) to `TWIE.MASTER.CTRLC` at clock 4,718,571. The master acknowledges byte 1 at 4,718,891. Byte 2 arrives at 4,721,451, is read at 4,721,522, and reaches SRAM `0x41D7`. After 1,976 more instructions and 2,967 clocks, the CPU reaches the same PC to request byte 3 (index 2). [Second-byte tests](../../tests/twie-second-read.test.mjs)

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| TWIE read byte 1 | 532 | 10 | 2,880,988 | 4,718,570 | `0x01334D` |
| TWIE read byte 2 | 535 | 11 | 2,882,964 | 4,721,537 | `0x01334D` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](TWIE-FIRST-DATA-ACK-RESULTS.md) · [Next report](TWIE-THIRD-READ-RESULTS.md)
