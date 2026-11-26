# BrewControl 1.1.27 reset results

With erased EEPROM, the oscillator timing profile, calibration bytes `0x5A/0x03`, PE2 held high and an explicit address ACK, the firmware reaches its first data write to TWIE target `0x6F`. Execution stops before word PC `0x0132FB`, after **2,875,325 instructions and 4,710,071 emulator clocks**. The outgoing byte is `0x00`. Its ACK or NACK is unknown. [Address ACK and first data byte](TWIE-ADDRESS-ACK-RESULTS.md)

The 36 milestones below start at the TCD0 period-register stop recorded in commit `2411e9e`. Each link opens the corresponding technical report. The test count covers the synthetic suite at that milestone. The execution totals and next word PC refer to the most advanced input profile available at that step.

| Milestone | Active profile | Tests passed | Instructions | Emulator clocks | Next word PC |
|---|---|---:|---:|---:|---|
| [TCD0 period](TCD0-PERIOD-RESULTS.md) | timed | 363 | 2,872,939 | 4,706,418 | `0x007AF4` |
| [TCD0 channel C compare buffer](TCD0-CCCBUF-RESULTS.md) | timed | 373 | 2,872,941 | 4,706,422 | `0x007AF6` |
| [TCD0 channel D compare buffer](TCD0-CCDBUF-RESULTS.md) | timed | 382 | 2,872,944 | 4,706,427 | `0x007AFB` |
| [TCD0 waveform and channel enables](TCD0-CTRLB-RESULTS.md) | timed | 393 | 2,872,948 | 4,706,432 | `0x007AFF` |
| [TCD1 period](TCD1-PERIOD-RESULTS.md) | timed | 402 | 2,872,950 | 4,706,436 | `0x007B01` |
| [TCD1 channel A compare buffer](TCD1-CCABUF-RESULTS.md) | timed | 412 | 2,872,952 | 4,706,440 | `0x007B03` |
| [TCD1 channel B compare buffer](TCD1-CCBBUF-RESULTS.md) | timed | 422 | 2,872,955 | 4,706,445 | `0x007B06` |
| [TCD1 waveform and channel enables](TCD1-CTRLB-RESULTS.md) | timed | 433 | 2,872,956 | 4,706,447 | `0x007B07` |
| [TCD1 clock start](TCD1-CTRLA-RESULTS.md) | timed | 444 | 2,872,964 | 4,706,459 | `0x00803B` |
| [DACB.CTRLB](DACB-CONTROL-RESULTS.md) | timed | 447 | 2,872,967 | 4,706,464 | `0x00803E` |
| [DACB.CTRLC](DACB-CONTROL-RESULTS.md) | timed | 450 | 2,872,969 | 4,706,467 | `0x008040` |
| [Register OR](DACB-CONTROL-RESULTS.md) | timed | 453 | 2,872,972 | 4,706,471 | `0x008043` |
| [DACB.CTRLA](DACB-CTRLA-NVM-CALIBRATION-RESULTS.md) | timed | 456 | 2,872,985 | 4,706,496 | `0x007A70` |
| [NVM calibration-row read](DACB-CTRLA-NVM-CALIBRATION-RESULTS.md) | timed | 460 | 2,872,988 | 4,706,500 | `0x007A74` |
| [First synthetic calibration byte](DACB-CTRLA-NVM-CALIBRATION-RESULTS.md) | synthetic | 463 | 2,872,990 | 4,706,505 | `0x007A77` |
| [ADCA.CALL](ADCA-CAL-RESULTS.md) | synthetic | 466 | 2,872,994 | 4,706,511 | `0x007A7D` |
| [Second synthetic calibration byte](ADCA-CAL-RESULTS.md) | paired | 469 | 2,873,000 | 4,706,523 | `0x007A87` |
| [ADCA.CTRLA](ADCA-CAL-RESULTS.md) | paired | 473 | 2,873,001 | 4,706,525 | `0x007A89` |
| [ADCA.CTRLB](ADCA-CONFIG-RESULTS.md) | paired | 476 | 2,873,006 | 4,706,532 | `0x007A90` |
| [ADCA.REFCTRL](ADCA-CONFIG-RESULTS.md) | paired | 478 | 2,873,007 | 4,706,534 | `0x007A92` |
| [ADCA.EVCTRL](ADCA-CONFIG-RESULTS.md) | paired | 481 | 2,873,009 | 4,706,537 | `0x007A95` |
| [ADCA.PRESCALER](ADCA-CHANNEL0-RESULTS.md) | paired | 483 | 2,873,011 | 4,706,540 | `0x007A98` |
| [ADCA.CH0.MUXCTRL](ADCA-CHANNEL0-RESULTS.md) | paired | 486 | 2,873,012 | 4,706,542 | `0x007A9A` |
| [ADCA.CH0.INTCTRL](ADCA-CHANNEL0-RESULTS.md) | paired | 489 | 2,873,014 | 4,706,545 | `0x007A9D` |
| [ADCA.CH0.INTFLAGS](ADCA-CH0-INIT-RESULTS.md) | paired | 491 | 2,873,015 | 4,706,547 | `0x007A9F` |
| [ADCA.CH0.CTRL](ADCA-CH0-INIT-RESULTS.md) | paired | 494 | 2,873,107 | 4,706,701 | `0x00FCCB` |
| [SPIE.CTRL](ADCA-CH0-INIT-RESULTS.md) | paired | 498 | 2,873,111 | 4,706,709 | `0x00FCCF` |
| [SPIE.INTCTRL](SPIE-INTCTRL-RESULTS.md) | paired | 501 | 2,873,270 | 4,707,003 | `0x007B26` |
| [PORTE.INT0MASK](SPIE-INTCTRL-RESULTS.md) | paired | 503 | 2,873,271 | 4,707,005 | `0x007B27` |
| [PORTE.INTCTRL](SPIE-INTCTRL-RESULTS.md) | paired | 507 | 2,873,283 | 4,707,025 | `0x013523` |
| [Bounded PE2 high interval](PE2-HIGH-RESULTS.md) | pe2 | 511 | 2,873,284 | 4,707,026 | `0x013524` |
| [Extended PE2 high interval](PE2-HIGH-CONTINUED-RESULTS.md) | pe2 | 511 | 2,873,317 | 4,707,071 | `0x013294` |
| [Register AND](PE2-HIGH-CONTINUED-RESULTS.md) | pe2 | 514 | 2,873,330 | 4,707,085 | `0x0132A1` |
| [ST Z+,R25](PE2-HIGH-CONTINUED-RESULTS.md) | pe2 | 519 | 2,873,347 | 4,707,108 | `0x0132B2` |
| [Initial TWIE address ACK](TWIE-ADDRESS-ACK-RESULTS.md) | ack | 522 | 2,875,293 | 4,710,023 | `0x013353` |
| [LD R31,X](TWIE-ADDRESS-ACK-RESULTS.md) | ack | 525 | 2,875,325 | 4,710,071 | `0x0132FB` |

## Final reset profiles

| Profile | Input | Instructions | Emulator clocks | First stop |
|---|---|---:|---:|---|
| strict | Unknown EEPROM | 46,741 | 61,988 | `0x014E8C` · `UNKNOWN_EEPROM_DATA` |
| erased | Erased EEPROM, uncharacterized oscillator startup | 2,872,372 | 4,705,639 | `0x007A52` · `OSC_STARTUP_TIMING_UNKNOWN` |
| timed | Erased EEPROM and the oscillator timing profile | 2,872,988 | 4,706,500 | `0x007A74` · `UNKNOWN_PRODUCTION_SIGNATURE_BYTE` |
| synthetic | Timed profile with ADCACAL0 = 0x5A | 2,872,994 | 4,706,511 | `0x007A7D` · `UNKNOWN_PRODUCTION_SIGNATURE_BYTE` |
| paired | Timed profile with ADCACAL0/1 = 0x5A/0x03 | 2,873,283 | 4,707,025 | `0x013523` · `PORTE_INT0_INPUT_HISTORY_UNKNOWN` |
| pe2 | Both calibration bytes and the specified PE2 high interval | 2,873,347 | 4,707,108 | `0x0132B2` · `TWI_UNKNOWN_ACK` |
| ack | Both calibration bytes, continuous PE2 high and an ACK for initial address byte 0xDE | 2,875,325 | 4,710,071 | `0x0132FB` · `TWI_UNKNOWN_ACK` |

The first PE2 interval covers cycles 4,707,005 through 4,707,025 inclusive. Later PE2 runs extend it through the 6,000,000-cycle execution limit. The `ack` profile also provides the target response to the initial write-address byte `0xDE`.

The 158 scenario reports each compare two runs from reset. Their complete trace hashes and final states matched. Each milestone also checked 11 historical traces and the integrity of 16 original files. The separate direct-peripheral `LDS` timing probe measured one emulator clock against two documented clocks. [All scenario results and trace hashes](reset-runs.json) · [Direct LDS probe](../../verification/cpu/lds-mmio-timing.mjs)

The synthetic suite runs offline with Node.js 24. Firmware runs use the operator’s local image and the retained historical reference files. [Test command](../../README.md#run-the-tests) · [Local firmware runs](../../README.md#local-firmware-runs)
