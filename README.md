# Virtual Braumeister ATxmega256A3 Emulator

A headless JavaScript emulator for the ATxmega256A3 in the legacy Speidel Braumeister 20 L brewing controller. It executes AVR instructions from the reset vector, with a word-addressed program counter and byte-addressed flash and data memory. The long-term goal is a browser-based emulator.

## Run the tests

Use Node.js 24 and PowerShell 7. From the repository root, run the following commands. The 550 synthetic tests exercise the emulator using generated programs and test inputs. They run offline with Node's standard library.

```powershell
New-Item -ItemType Directory -Path private -Force | Out-Null
node --test "tests/*.test.mjs"
```

## Current state

BrewControl 1.1.27 stops before **SPIC reply 27** with the tested inputs. The firmware sends `0x06` and stops before reading `SPIC.DATA` at word PC `0x00FD24`, after **4,804,642 to 4,804,756 emulator clocks** across all eight pin histories. [SPI replies 24 through 26](docs/results/SPIC-TWENTY-FOURTH-TWENTY-SIXTH-RESULTS.md)

The core supports an independently tested subset of AVRxm instructions, three-byte return addresses, deterministic tracing, and explicit stops on unsupported operations. The memory bus connects the CPU to GPIO, NVM and mapped EEPROM, SPI, TWI, interrupts, clock control, the USARTF0 control and baud-selector registers, and the TCC0 counter and active period register with their shared temporary byte, clock selection, normal-mode control, and overflow interrupt delivery. TCD0 has its own period and CPU temporary byte. Its channel C and D compare buffers have independent valid flags. A shared lock controls software and automatic updates. The automatic transfer occurs at TOP in normal mode and at BOTTOM in single-slope PWM. GPIO reports the timer as the source for enabled output pins and leaves the instantaneous waveform levels unresolved. DACB models the digital control state of CTRLA, CTRLB and CTRLC. The NVM controller supports LPM reads from explicitly supplied production-signature bytes. Each peripheral implements only its documented, tested subset.

In a local BrewControl 1.1.27 run the emulator reached the application entry from reset after 46,682 instructions and 61,883 clocks. With unknown EEPROM contents, execution stops at the first unknown byte. With simulated erased EEPROM and uncharacterized oscillator startup times, it stops at the first readiness check. With the explicit oscillator timing profile, it selects asynchronous 8N2 and a medium receive-complete interrupt level, programs both baud registers, and enables reception. It then clears the 16-bit TCC0 counter and selects the peripheral clock divided by 256. It selects normal counting with all four channel enables clear and programs the timer period to 125. It enables low-level overflow interrupts and programs the separate TCD0 period to 4,095. The firmware writes both compare buffers, selects single-slope PWM on channels C and D, and starts TCD0 on the undivided peripheral clock.

With TCD0 counting, the firmware stages the low byte and commits the separate TCD1 period of 4,095 on the high-byte write. The firmware then commits zero to the separate TCD1 channel A and B compare buffers. It selects single-slope PWM on TCD1 channels A and B. It starts TCD1 on the undivided peripheral clock. The firmware selects single-channel operation in DACB.CTRLB, then uses two OR instructions to prepare the DACB.CTRLC value for AVCC and right-aligned data. It writes that value, enables DACB channel 0, enables the three PMIC interrupt levels and selects the production signature row via NVM.CMD. With the factory calibration byte unknown, the timed reset stops before the LPM at word 0x007A74 after 2,872,988 instructions and 4,706,500 emulator clocks.

With the explicit synthetic input `--synthetic-adcacal0 0x5A`, the store to ADCA.CALL stages the low byte in ADCA.TEMP. The subsequent LPM at word 0x007A7D stops on the unknown ADCACAL1 byte after 2,872,994 instructions and 4,706,511 emulator clocks. With the additional input `--synthetic-adcacal1 0x03`, the firmware writes ADCA.CALH and commits the test calibration `0x035A`. The firmware enables ADCA, selects unsigned 12-bit results and the internal VCC/1.6 reference, enables the bandgap and leaves ADC event triggers disabled. It sets the ADC clock to the peripheral clock divided by 256, writes positive input selector 1 to channel 0 and leaves the channel interrupt level off. The firmware clears the channel flag and selects single-ended input PA1 without starting a conversion. It configures PE4 as an output and enables SPIE in master mode.

The firmware disables the SPIE interrupt, initializes the TWIE master and SPIC, and selects PE2 for low-priority port E interrupt 0. After SEI and the following CALL, the paired profile stops before word 0x013523 because the PE2 edge history is unknown. It has retired 2,873,283 instructions in 4,707,025 emulator clocks. With the additional input `--synthetic-pe2-high 4707005:4707025`, PUSH R28 completes at word 0x013523. The next arbitration boundary is word 0x013524 at emulator clock 4,707,026, one clock past the high interval.

With PE2 held high through the run, the firmware executes `AND R18,R18` and `ST Z+,R25`. At word `0x0132B2` it attempts to write `0xDE` to `TWIE.MASTER.ADDR`. The address response from the 7-bit target `0x6F` is unknown. At this boundary the emulator has retired 2,873,347 instructions in 4,707,108 clocks. With `--synthetic-twie-address-ack 0xDE`, the master receives the initial write-address ACK and requests its interrupt. The handler executes `LD R31,X` and attempts to write its first data byte, `0x00`. The run stops before that write at word `0x0132FB` with the data-byte response unknown, after 2,875,325 instructions and 4,710,071 clocks.

With the write-data and read-address ACKs supplied, TWIE target `0x6F` returns eight zero bytes. A TCC0 interrupt samples PF4 while the eighth byte is pending. Both PF4 paths store it at SRAM `0x41DD` and finish the transaction with NACK and STOP. After SPIC reply 16, the overflow handler samples PF5 and PF6. Across those three samples the firmware uses masks `0x10`, `0x20`, and `0x40`. [TWIE receive timing](docs/results/TWIE-SIXTH-EIGHTH-READ-RESULTS.md) · [PF5 and PF6 samples](docs/results/PORTF-PF5-PF6-SPIC17-RESULTS.md)

The firmware stores successive SPIC replies in the four SRAM cells at `0x4870` through `0x4873`. All 256 values were executed for each of replies 1 through 16 on both PF4 paths, and for replies 17 through 26 on all eight PF4/PF5/PF6 histories. After reply 24 the firmware writes `00 02 06 00` to the transmit buffer starting at `0x476B`. The separate direct-peripheral LDS timing probe still measures one clock where two are expected. A complete application boot and a browser UI are future work. [Reset profiles and verified milestones](docs/results/README.md) · [Direct LDS timing probe](verification/cpu/lds-mmio-timing.mjs)

## Repository contents

| Path | Contents |
|---|---|
| `src/` | CPU, memory bus, peripherals, Intel HEX loader, and deterministic execution and discovery APIs |
| `tests/` | Independent instruction, timing, memory, peripheral, and runner tests |
| `verification/` | Synthetic AVR assembly and comparison tools for GNU AVR and Atmel Studio |
| `scripts/` | Headless Ghidra tooling, local execution runners, trace comparison, and EEPROM input handling |
| `docs/` | Firmware milestone reports, reset results, CPU core evaluation, and independent Atmel Studio measurements |

## Local firmware runs

The MIT license covers the emulator, its tests, and the accompanying project tools. Third-party firmware remains subject to its own license. Supply your own local inputs for firmware experiments. Keep firmware, EEPROM images, Ghidra databases and exports, firmware-specific evidence, and generated traces outside version control. The `private/` folder is reserved for local evidence and scratch data.

For the reset-to-main check, provide the firmware image and your local Ghidra instruction export. The output directory must be a new direct child of `private/`.

```powershell
./scripts/Test-Poc001.ps1 -Firmware $firmwarePath -Evidence $instructionCsv -Output (Join-Path $PWD 'private/poc-001-validation')
```

Five discovery runners have revision-specific instruction checks. The checked-in templates store the flash word addresses for those checks. The following command uses your local 1.1.27 image to restore the scripts and verifies their recorded SHA-256 digests. Existing matching scripts are left in place. If you have an earlier generated EEPROM runner, move it into the private directory before restoring the new version. Historical acceptance runs also use separately retained private baseline traces and reports.

```powershell
node scripts/restore-discovery.mjs $firmwarePath
```

For device timing and flag measurements, see the [CPU core evaluation](docs/CPU-CORE-EVALUATION.md), the [ADIW comparison](docs/ADIW-STUDIO7.md), and the [SREG timing comparison](docs/OUT-SREG-STUDIO7.md). Links in historical reports to private measurements refer to files held locally.

## License

[MIT License](LICENSE)
