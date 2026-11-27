# TWIE acknowledgment of the first data byte

The first data-byte ACK moves the firmware from word PC `0x0132FB` to `0x013312`. The TWIE master owns the bus when it attempts a repeated START with read address byte `0xDF` for the same 7-bit target, `0x6F`.

At clock 4,710,073, the firmware writes `0x00` to `TWIE.MASTER.DATA` at data address `0x04A7`. Nine SCL periods of 320 emulator clocks place the target's ACK at 4,712,953. The CPU accepts the write interrupt at 4,712,954 and reaches vector `0x00005C` at 4,712,956. The handler reads status `0x62` twice.

The CPU stops after 2,877,303 instructions and 4,713,042 clocks, 1,978 instructions and 2,971 clocks beyond the previous stop. The attempted write of `0xDF` to `TWIE.MASTER.ADDR` is recorded at bus clock 4,713,044. Its diagnostic is `TWI_UNKNOWN_ACK`. The targeted input is `--synthetic-twie-first-data-ack 0x00`. [Data ACK regression tests](../../tests/twie-first-data-ack.test.mjs)

## Reset and regression results

| Milestone | Synthetic tests passed | Reset profiles checked twice | Instructions at stop | Emulator clocks | Next word PC |
| --- | ---: | ---: | ---: | ---: | --- |
| TWIE first data acknowledgment | 528 | 8 | 2,877,303 | 4,713,042 | `0x013312` |

Each step reproduced the three reset controls and passed four firmware comparison tests, the synthetic export test, the 11 historical trace checks, and the integrity checks for 16 original files. [Reset controls and timing note](README.md#reset-controls) · [Reset results and SHA-256 hashes](reset-runs.json)

[Previous report](TWIE-ADDRESS-ACK-RESULTS.md) · [Next report](TWIE-READ-RESULTS.md)
