# TWIE read bytes 4 and 5

The same receive command accepts two more explicit zero bytes from target `0x6F`. Each iteration takes 1,976 instructions and 2,967 emulator clocks. At word PC `0x01332D` the handler compares the receive count with the requested length, 8, loaded from SRAM `0x4217`.

| Byte | RECVTRANS write | ACK for preceding byte | Byte arrives | Data register read | SRAM destination |
|---:|---:|---:|---:|---:|---|
| 4 | 4,724,505 | 4,724,825 | 4,727,385 | 4,727,456 | `0x41D9` |
| 5 | 4,727,472 | 4,727,792 | 4,730,352 | 4,730,423 | `0x41DA` |

At the end of byte 5, the count at `0x4219` is 5. The CPU stops before word PC `0x01334D` after 4,730,438 clocks. The next bus access would request byte 6 at clock 4,730,439. [Additional-byte input tests](../../tests/twie-additional-read.test.mjs)

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| TWIE read byte 4 | 541 | 13 | 2,886,916 | 4,727,471 | `0x01334D` |
| TWIE read byte 5 | 541 | 14 | 2,888,892 | 4,730,438 | `0x01334D` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](TWIE-THIRD-READ-RESULTS.md) · [Next report](TWIE-SIXTH-EIGHTH-READ-RESULTS.md)
