# SPIE, CPU shifts, and the delay before the first ADC conversion

On both the low and high GPIO profiles, BrewControl sends `0x04` to `SPIE.DATA` at word PC `0x00FD1E` after **231,490 SPIC transfers**. There are 130 SPIC transfers before a loop of 320 calls with 723 transfers each. From reply 30 onward, SPIC return values can vary independently on either fixed GPIO history. The operand trace follows those bytes through registers, SRAM, and interrupt stack saves until each value is overwritten or the firmware switches to SPIE. [SPIC input histories](SPIC-27-36-RESULTS.md) · [Data-flow checker and counterexamples](../../verification/gpio/check-spic-register-dataflow.mjs)

| First SPIE transfer | Low-profile clock | High-profile clock |
| --- | ---: | ---: |
| Before write to DATA | 27,294,665 | 27,323,984 |
| Before first STATUS read, transfer in progress | 27,294,672 | 27,323,991 |
| Transfer completes | 27,294,699 | 27,324,018 |
| Before DATA read with the reply open | 27,294,701 | 27,324,020 |

SPIE uses mode 0 with the peripheral clock divided by four. STATUS changes from `0x00` to `0x80` when the 32-clock transfer completes. The DATA and STATUS steps each passed 550 Node tests and the three standard double resets. Both profiles ran twice from power-on for each step. The native register check covers all 16 register mapping masks, 32 collisions, all 256 replies, and input exhaustion. Run `node verification/gpio/check-spie-native-registers.mjs` to repeat it with synthetic input. [Register check](../../verification/gpio/check-spie-native-registers.mjs)

## Seven replies and the first value-dependent branch

The firmware sends `04 90 00 00 00 FF FF`. The first six replies produce the same subsequent control flow for every possible input byte on each tested history. For the seventh reply, the firmware reads SRAM `0x4A8C` at word PC `0x008C45`. Values `0x14` and `0x41` each take a distinct path and are stored at `0x27E4`. The other 254 values take a third path. All three paths next transmit `0x00` on SPIC. [Per-step checks](reset-runs.json)

| Reply | Executed value cases across both GPIO profiles | Node tests passed |
| ---: | ---: | ---: |
| 1 | 512 | 550 |
| 2 | 1,024 | 553 |
| 3 | 1,024 | 556 |
| 4–7, each | 1,024 | 562 |

Every reply had a fresh regression run and three double reset controls. Replies 2 through 7 each varied the current byte on two explicit prefixes, first with preceding zero bytes and then with preceding `0xFF` bytes. The exact emulator clocks depend on the GPIO history and the seventh reply. [Reset and regression results](reset-runs.json)

## Instructions, GPIO, and the 24-bit loop

BrewControl executes `ASR R23` at word PC `0x0088DC`, then `ROR R22` at `0x0088DD`. Each instruction takes one emulator clock. The tests cover all 32 register encodings and all 65,536 combinations of an input byte and incoming SREG. Eight firmware cases covered two GPIO profiles and four values for SPIE reply 7. The ASR and ROR steps passed 553 and 556 Node tests, respectively. [ASR tests](../../tests/asr.test.mjs) · [ROR tests](../../tests/ror.test.mjs)

At the next PORTF read, the interrupt tests PF4 on the low profile and PF5 on the high profile. Across the eight starting states, 2,048 raw port-byte cases yielded 512 inputs consistent with the driven outputs and 16 continuations. The following delay was traced on the fixed low profile with seven zero SPIE replies. It ran 4,799,999 iterations and serviced 747 TCC0 interrupts between clocks 29,578,628 and 53,699,642. Two complete resets reached the ADC start at word PC `0x010293` after **37,277,264 instructions and 53,699,668 emulator clocks**. This profile completed 246,632 SPIC transfers. The firmware then needs the first PA1 conversion. [ADC and TWIE results](ADCA-TWIE-STARTUP-RESULTS.md)
