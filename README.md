# Virtual Braumeister ATxmega256A3 Emulator

A headless JavaScript emulator for the ATxmega256A3 in the legacy Speidel Braumeister 20 L brewing controller. It executes AVR instructions from the reset vector, with a word-addressed program counter and byte-addressed flash and data memory. The long-term goal is a browser-based emulator.

## Run the tests

Use Node.js 24 and PowerShell 7. From the repository root, run the following commands. The 276 synthetic tests exercise the emulator using generated programs and test inputs. They run offline with Node's standard library.

```powershell
New-Item -ItemType Directory -Path private -Force | Out-Null
node --test "tests/*.test.mjs"
```

## Current state

The core supports an independently tested subset of AVRxm instructions, three-byte return addresses, deterministic tracing, and explicit stops on unsupported operations. The memory bus connects the CPU to GPIO, NVM and mapped EEPROM, SPI, TWI, interrupts, and clock-control models. Each peripheral implements only its documented, tested subset.

In a local BrewControl 1.1.27 run the emulator reached the application entry from reset after 46,682 instructions and 61,883 clocks. With unknown EEPROM contents, execution stops at the first unknown byte. With simulated erased EEPROM and uncharacterized oscillator startup times, it stops at the first readiness check. With the explicit oscillator timing profile, it reaches a write to `USARTF0.CTRLB` after 2,872,882 instructions and 4,706,325 clocks. A complete application boot and a browser UI are future work.

## Repository contents

| Path | Contents |
|---|---|
| `src/` | CPU, memory bus, peripherals, Intel HEX loader, and deterministic execution and discovery APIs |
| `tests/` | Independent instruction, timing, memory, peripheral, and runner tests |
| `verification/` | Synthetic AVR assembly and comparison tools for GNU AVR and Atmel Studio |
| `scripts/` | Headless Ghidra tooling, local execution runners, trace comparison, and EEPROM input handling |
| `docs/` | CPU core evaluation and independent Atmel Studio measurements |

## Local firmware runs

The MIT license covers the emulator, its tests, and the accompanying project tools. Third-party firmware remains subject to its own license. Supply your own local inputs for firmware experiments. Keep firmware, EEPROM images, Ghidra databases and exports, firmware-specific evidence, and generated traces outside version control. The `private/` folder is reserved for local evidence and scratch data.

For the reset-to-main check, provide the firmware image and your local Ghidra instruction export. The output directory must be a new direct child of `private/`.

```powershell
./scripts/Test-Poc001.ps1 -Firmware $firmwarePath -Evidence $instructionCsv -Output (Join-Path $PWD 'private/poc-001-validation')
```

Five discovery runners have revision-specific instruction checks. The checked-in templates store the flash word addresses for those checks. The following command uses your local 1.1.27 image to restore the scripts with their exact original SHA-256 digests. Existing matching scripts are left in place. Historical acceptance runs also use separately retained private baseline traces and reports.

```powershell
node scripts/restore-discovery.mjs $firmwarePath
```

For device timing and flag measurements, see the [CPU core evaluation](docs/CPU-CORE-EVALUATION.md), the [ADIW comparison](docs/ADIW-STUDIO7.md), and the [SREG timing comparison](docs/OUT-SREG-STUDIO7.md). Links in historical reports to private measurements refer to files held locally.

## License

[MIT License](LICENSE)
