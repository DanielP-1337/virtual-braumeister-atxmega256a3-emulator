# CPU core evaluation for PoC 001

Date: October 27, 2026. Scope: a local, deterministic reset-to-main milestone on ATxmega256A3. This evaluation does not equate instruction-family support with device/peripheral support.

## Decision

Use the small, specification-based JavaScript interpreter in `src/xmega.mjs` for this bounded milestone. Neither evaluated upstream core is an adequate unmodified ATxmega256A3 execution engine. The custom interpreter is an **explicitly incomplete AVRxm subset**, not a general avrxmega6 implementation. It executes individual opcodes with decoded operands and traps on unsupported operations. It contains no firmware addresses, startup-loop replacement, decompiler translation, or PC-to-main shortcut.

This decision is limited to PoC 001. Reassess adapting avr8js or extending this core before attempting application execution. The custom implementation and tests do not import either upstream CPU. The public avr8js package is an optional evaluation dependency only.

## Evidence and reproducible probes

Tested host: Windows 11, PowerShell 7, Node.js v24.19.0. The evaluation package is avr8js **0.21.0**, pinned by the local npm lockfile and its integrity hash. This is a version-specific result, not a claim about all future versions. The upstream main package file inspected online advertises 0.21.1; that is not the package executed here.

QEMU source was downloaded at commit `d73149283205645625bfa9fe029cfb68e4c4a9ae`. The source files and commit ID are retained in `private/core-evaluation/`. No `qemu-system-avr` executable was found on PATH or in the checked standard QEMU/MSYS2 locations, and no QEMU binary was built or run. QEMU findings below are source inspection, clearly separated from avr8js execution tests.

Run the public synthetic probes, without reading any proprietary input:

```powershell
npm.cmd ci --prefix C:\dev\Virtual-Braumeister-Emulator\private\core-evaluation --cache C:\dev\Virtual-Braumeister-Emulator\private\npm-cache --ignore-scripts --no-audit --no-fund
node C:\dev\Virtual-Braumeister-Emulator\scripts\probe-cores.mjs C:\dev\Virtual-Braumeister-Emulator\private\core-evaluation
```

`probe-results.json` records observations. The compatibility probes deliberately expose mismatches; a probe script exit code of zero does not mean either candidate passes XMEGA compatibility.

| Probe | avr8js 0.21.0 observation | ATxmega256A3 requirement | Result |
|---|---|---|---|
| OUT to I/O address 00 | Hook at data 0020 invoked | XMEGA I/O is at data 0000, separate from R0 | FAIL |
| ST X+ into SRAM | 2 cycles | AVRxm: 1 cycle | FAIL |
| RCALL from word 010020, then RET | Correct three-byte return address and restored PC | Preserve high return byte | PASS for state |
| Same RCALL timing | 4 cycles | AVRxm with three-byte return: 3 cycles | FAIL |
| ELPM Z+ at byte 03ffff, 264 KiB flash | RAMPZ wraps to 0 | Next byte 040000 requires RAMPZ=4 | FAIL |
| Opcode ffff | Advances PC without explicit error | Unsupported opcode must trap | FAIL |

The ELPM failure arises from modulo arithmetic using the whole-64-KiB-block count of a flash allocation containing a partial boot block. It is a boundary probe, not a claim that this startup crosses that boundary.

## Candidate comparison

| Requirement | QEMU at pinned commit | avr8js 0.21.0 |
|---|---|---|
| Actual avrxmega6 support | Documentation mentions xmega6, but inspected CPU type registration contains only avr5, avr51, avr6. No XMEGA6 CPU model registered there. DES translator is unimplemented. Not accepted as full avrxmega6 support. | No XMEGA profile. Classic AVR-oriented memory layout and ATmega timing. Not full avrxmega6 support. |
| Three-byte return addresses | avr6 sets the three-byte-PC feature; translator/helper implement stack support. Source evidence only. | Runtime RCALL/RET test passes, including high return byte. |
| Word PC, byte flash | Internal `pc_w`; debugger/external PC conversion uses bytes. Separate code/data spaces. | `cpu.pc` indexes program words; `progBytes` provides byte reads. |
| RAMPZ/EIND/LPM/ELPM | Translator implements extended addressing; not runtime-tested here. CPU-register/data-space mapping still follows classic AVR assumptions. | Instructions present. RAMPZ/EIND stored at classic data 005b/005c; XMEGA needs 003b/003c. ELPM boot-boundary probe fails. |
| Custom memory maps/MMIO | QEMU MemoryRegion/device APIs support extensions, but a new device/machine and CPU mapping corrections are needed. `gen_inb`/`gen_outb` add 32, and CPU registers are mapped into classic data locations. | Read/write hooks and configurable allocation help, but direct register-array/SP/SREG/stack accesses bypass a universal bus. Hooks alone do not supply an XMEGA memory map. |
| Deterministic stepping/tracing | GDB stepping and instruction instrumentation are available. `-d in_asm` logs translation, not necessarily every executed instruction. TCG instruction counts are not an AVRxm cycle-accurate timing model. | `avrInstruction` executes one instruction; explicit cycle counter. Useful deterministic API, but relevant cycle values differ from AVRxm. |
| Windows requirements | Supported MinGW/MSYS2 build environment with C compiler, Python, Meson/Ninja and libraries; plus a custom A3 machine. No working local runtime test completed. | Node.js package runs locally; package requires Node >=20.19.0. Tested with 24.19.0. |
| Browser/Wasm | Requires a separate port/build strategy and browser host integration; no verified supported turnkey AVR-to-Wasm path established here. | Native JavaScript/browser design. No Wasm compilation needed. |
| A3 peripherals | No verified ATxmega256A3 board model. Listed Arduino machines are ATmega-based. | Bundled ATmega peripherals cannot be assumed compatible with A3. |

The QEMU documentation/source discrepancy is material: listing an architecture in a documentation paragraph is weaker evidence than a registered model and execution tests. Do not select an ATmega2560 machine and label it ATxmega256A3.

## Custom implementation: completed and unimplemented

Completed: word-addressed PC, byte-addressed flash data, 264 KiB flash including boot, 16 KiB SRAM at 2000–5fff, a separate 4 KiB EEPROM backing store, separate 32-byte register file, CPU I/O addresses 003b–003f, three-byte return stack, explicit instruction traces, fail-fast MMIO hooks, strict HEX parsing and deterministic instruction/cycle limits. Unknown MMIO and disabled EEPROM mapping trap rather than returning invented status flags. No opcode fetch is permitted through a missing HEX byte; sparse data reads return erased ff.

Implemented instruction forms: NOP, LDI, EOR, IN, OUT, CPI, CPC, BRBC/BRBS, RJMP/RCALL, JMP/CALL, IJMP/ICALL, EIJMP/EICALL, RET, ST X/ST X+, LDS/STS, and implied/explicit/postincrement LPM/ELPM. Timing uses the AVRxm column, including ST X+=1, three-byte RCALL=3, CALL=4, RET=5, and ELPM=3. Tests exercise semantics with synthetic operands, not just firmware constants.

Not implemented: the rest of the ISA, interrupt delivery/RETI and PMIC, SPL interrupt-suppression timing, RAMPD/X/Y, NVM commands/self-programming/calibration, EEPROM mapping/write protocol, CCP, clocks, timers, GPIO behavior, USART, TWIE, SPIC or DACB. The EEPROM backing store is not a claim of an emulated NVM controller. SRAM poison values and erased EEPROM are deterministic test assumptions, not a captured physical power-on state. Reset uses PC=0 as required by this milestone; boot-reset fuses are not modeled. SP resets to SRAM top per the XMEGA manual, and the firmware's explicit SPL/SPH writes are separately required by acceptance.

The core modules have no Node-specific imports and are suitable for later browser module integration, but browser execution and Wasm integration were not tested. The current runner uses Node filesystem APIs for private trace files. There is no browser UI or virtual brewing hardware.

## Licensing and redistribution

avr8js is MIT-licensed; preserve its copyright and license text if redistributing it or a derivative. The evaluated package stays private and is not a runtime dependency. QEMU is distributed under GPL version 2, with file-specific licenses; inspected AVR sources carry LGPL-2.1-or-later notices. A future QEMU/Wasm distribution needs review of the actual linked build and corresponding-source obligations, not just the CPU file header. No upstream implementation source was copied into the custom interpreter. No new project-wide release license was chosen in this task, and no publication is authorized. Proprietary firmware, traces, SRAM snapshots and decompiler exports remain private.

## Primary references

- [Pinned QEMU CPU registration](https://github.com/qemu/qemu/blob/d73149283205645625bfa9fe029cfb68e4c4a9ae/target/avr/cpu.c), [translator](https://github.com/qemu/qemu/blob/d73149283205645625bfa9fe029cfb68e4c4a9ae/target/avr/translate.c), and [CPU memory definitions](https://github.com/qemu/qemu/blob/d73149283205645625bfa9fe029cfb68e4c4a9ae/target/avr/cpu.h).
- [QEMU AVR documentation](https://www.qemu.org/docs/master/system/target-avr.html), [Windows build requirements](https://www.qemu.org/docs/master/devel/build-environment.html), and [license](https://www.qemu.org/docs/master/about/license.html).
- [avr8js repository](https://github.com/wokwi/avr8js), [CPU structure](https://github.com/wokwi/avr8js/blob/main/src/cpu/cpu.ts), and [instruction implementation](https://github.com/wokwi/avr8js/blob/main/src/cpu/instruction.ts). Runtime evidence is pinned by the local 0.21.0 package lockfile rather than these moving main links.
- [Microchip instruction summary and AVRxm timing](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-BA59618D-4850-490B-B176-0BCC3D9438A1.html), [XMEGA A manual](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf), and [A3 device datasheet](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf).

## SimulAVR 1.1 as an optional cross-check

The 1.1 manual lists the ATmega2560 among the supported targets. Its limitations chapter explicitly excludes AVR XMEGA. For an instruction common to both architectures, a synthetic register-only program could compare arithmetic results and SREG on two independently implemented engines. The flag results for ADIW are one candidate. XMEGA cycle counts, the A3 memory map, CCP and NVM peripheral behavior still require device-specific references. This evaluation reviewed the manual only. [Supported devices](https://download-mirror.savannah.gnu.org/releases/simulavr/manual-1.1.0.pdf#page=17) · [Limitations](https://download-mirror.savannah.gnu.org/releases/simulavr/manual-1.1.0.pdf#page=51)

The instruction traces and VCD examples also illustrate how to compare simulated pin transitions with an expected waveform, for example when testing SPI clock polarity and phase. [Trace features](https://download-mirror.savannah.gnu.org/releases/simulavr/manual-1.1.0.pdf#page=9)

## Atmel Studio 7 AVR Simulator

The 7.0.934 device matrix lists simulator support for the ATxmega256A3 itself. Studio's disassembly, register view and cycle counter offer an independent reference for a synthetic program that crosses a word-PC boundary, adds an immediate or saves a three-byte return address. A comparison would need the selected device, Studio/device-pack versions, instruction stream and observed states from both engines. The evaluation used the Studio documentation. All runtime evidence in this milestone came from the JavaScript interpreter. Microchip lists issue 7611 for the documented simulator version. EEPROM programming and erasure initiated by XMEGA application code are unimplemented. This rules out using this version to establish the busy duration for 0x35 or 0x36. [AVR Simulator User Guide, section 2.2.3](https://ww1.microchip.com/downloads/en/devicedoc/avr-simulator-userguide-ds50003042a.pdf#page=15) [7.0.934 release notes, Table 6-35](https://www.microchip.com/content/dam/mchp/documents/OTH/ProductDocuments/DataSheets/as-installer-7.0.934-readme.pdf#page=78) · [Cycle Counter, Studio 7 User Guide pp. 67–68](https://www.microchip.com/content/dam/mchp/documents/atmel-start/Atmel-Studio-7-User-Guide.pdf#page=68) · [Microchip simulator limitations](https://onlinedocs.microchip.com/oxy/GUID-19BA5E18-FC0D-4489-9A99-3E3FFC279F4D-en-US-1/GUID-0FF41858-E8B2-4ED9-A242-5913E0AE9922.html)

A subsequent ATxmega256A3 run in Atmel Studio 7.0.2389 measured two cycles for each of eight ADIW cases. All 528 bytes of the independent register and SREG capture agreed with the JavaScript emulator. [Measurements and debug observations](ADIW-STUDIO7.md)

## avriss and AVR startup examples

The avriss author describes Intel HEX input, instruction tracing and common hooks for observing register and memory access. These are useful examples for testing a decoder. The stated target is classic AVR with a 16-bit program counter. BrewControl already executes at word PCs above 0xFFFF, including the strict stop at 0x014E8C. The register map also differs from the A3, and the author makes no hardware-accuracy claim for the cycle counts. The separate walkthrough of AVR-GCC startup illustrates checking initialized data and BSS against a disassembly, which the reset-to-main test already exercises. [Author's avriss README](https://github.com/dwelch67/avriss#readme) · [AVR startup walkthrough](https://stackoverflow.com/questions/17323757/going-through-avr-assembler-hello-world-code) · [PoC 001 results](POC-001-RESULTS.md)
