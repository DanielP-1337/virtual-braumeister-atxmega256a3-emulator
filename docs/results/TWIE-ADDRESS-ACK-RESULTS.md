# TWIE-Adress-ACK für `0xDE`

Im `0x5A/0x03`-Zusatzlauf erreicht BrewControl 1.1.27 das erste Datenbyte für die 7-Bit-Adresse `0x6F`. Bei Wort-PC `0x0132FB` versucht die Firmware, `0x00` nach `TWIE.MASTER.DATA` zu schreiben. Wie vorgegeben endet der Lauf hier vor Abschluss der Instruktion. Bis zu diesem Halt hat die Firmware 2.875.325 Instruktionen in 4.710.071 Emulator-Takten ausgeführt.

Der Lauf verwendet gelöschtes EEPROM, das bisherige Oszillatorprofil, die synthetischen Kalibrierbytes `0x5A/0x03` und PE2 auf High von Takt 4.707.005 bis zur Laufgrenze von 6.000.000. Die zusätzliche Eingabe `--synthetic-twie-address-ack 0xDE` gilt für die erste Adressphase nach Reset. Sie umfasst die Zieladresse und das Richtungsbit. Der zuvor geprüfte Lauf ohne dieses ACK dient als Kontrolle. [Ausgangsstand](PE2-HIGH-CONTINUED-RESULTS.md) · [Eingabemodell](../../scripts/twie-input.mjs) · [Tests zur Abgrenzung des ACK](../../tests/twie-address-ack.test.mjs)

## 1. Adresszugriff bei `0x0132B2`

`STD Z+6,R22` schreibt `0xDE` nach `TWIE.MASTER.ADDR` an Datenadresse `0x04A6`. Der Master beginnt den Transfer bei Takt 4.707.110. Mit `BAUD = 0x9B` dauert eine SCL-Periode im bestehenden Modell 320 Emulator-Takte. Nach neun Perioden, bei Takt 4.709.990, übernimmt der Master das freigegebene ACK und fordert den Schreibinterrupt auf niedriger Priorität an. Die CPU unterbricht vor Wort-PC `0x010379` und erreicht den TWIE-Vektor `0x00005C` bei Takt 4.709.992. [Taktmodell](../../src/peripherals/twie.mjs)

Die Firmware führt gegenüber dem vorherigen Halt 1.946 zusätzliche Instruktionen in 2.915 Takten aus. Der Interrupt-Eintritt zählt als eigenes Ereignis. Bei Wort-PC `0x013353` stoppt dieser Stand vor `LD R31,X` mit Opcode `0x91FC`. X zeigt auf SRAM `0x4194`.

## 2. `LD R31,X` bei `0x013353`

Der Kern unterstützt `LD Rd,X` für alle 32 Zielregister. Er liest an der ursprünglichen X-Adresse und schreibt das Byte nach Rd. Die Form ohne Postinkrement erlaubt auch XL und XH als Zielregister. Der AVRxm benötigt zwei Takte für SRAM und einen für I/O. Der Datenbus berücksichtigt die Wartezeit für eingeblendetes EEPROM. [Microchip, Opcode und Operanden](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-A1FCAFBB-57A3-41B7-8AD2-22AA69A9120B.html) · [SREG und Taktzahlen](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-0BE4054F-D7E4-4D6C-BF0A-3DAFBB39153C.html) · [CPU-Regressionstests](../../tests/ld-x.test.mjs)

Im Firmwarelauf liest R31 den Wert `0x04` aus SRAM `0x4194`. X steht nach dem Laden weiter auf `0x4194`, Z auf `0x04A0`. Bei `0x013355` und `0x0132DC` liest die Firmware jeweils `0x62` aus `TWIE.MASTER.STATUS`. Der Master besitzt den Bus, hält den Takt und meldet das gesetzte Schreibinterruptflag. Nach 32 weiteren Instruktionen und 48 Takten liegt das Datenbyte aus SRAM `0x4196` in R24.

## 3. Vereinbarter Halt bei `0x0132FB`

`STD Z+7,R24` (Opcode `0x8387`) zielt auf `TWIE.MASTER.DATA` an Datenadresse `0x04A7`. Der Teilnehmer müsste auf das erste Datenbyte `0x00` eigens mit ACK oder NACK antworten. Die gespeicherte Diagnose lautet `TWI_UNKNOWN_ACK`. Der CPU-Zähler steht vor der Instruktion bei 4.710.071. Das MMIO-Protokoll verzeichnet den versuchten Zugriff für dessen Busphase bei Takt 4.710.073 mit `completed: false`. Der Bus-Trace enthält START und das bestätigte Adressbyte.

## Regressionen und Reset-Szenarien

| Schritt | Regressionstests | Instruktionen im ACK-Lauf | Emulator-Takte | Nächster Wort-PC | Audit |
| --- | ---: | ---: | ---: | --- | --- |
| Adress-ACK für `0xDE` | 522/522 | 2.875.293 | 4.710.023 | `0x013353` | PASS |
| `LD R31,X` | 525/525 | 2.875.325 | 4.710.071 | `0x0132FB` | PASS |

Jeder der 14 Berichte enthält das Ergebnis zweier vollständiger Läufe ab Reset. CPU-Trace, Endzustand sowie Bus- und Interruptprotokoll stimmen für jedes Paar überein. Die sechs Profile ohne Adress-ACK reproduzieren die bisherigen Trace-Hashes.

| Szenario | Nach Adress-ACK | Nach Implementierung von LD |
| --- | --- | --- |
| EEPROM unbekannt | `0x014E8C` | `0x014E8C` |
| EEPROM gelöscht, Hochlauf unbekannt | `0x007A52` | `0x007A52` |
| EEPROM gelöscht, Oszillatorprofil | `0x007A74` | `0x007A74` |
| Oszillatorprofil und `0x5A` | `0x007A7D` | `0x007A7D` |
| Oszillatorprofil und `0x5A/0x03` | `0x013523` | `0x013523` |
| `0x5A/0x03` und PE2 High | `0x0132B2` | `0x0132B2` |
| `0x5A/0x03`, PE2 High und Adress-ACK für `0xDE` | `0x013353` | `0x0132FB` |

Je Schritt bestanden die vier Firmware-Vergleichstests, der synthetische Exporttest, elf historische Trace-Prüfungen und die Integritätsprüfung für 16 Originaldateien. Die separate `LDS`-Timingprobe ergab in beiden Stufen einen Emulator-Takt für einen direkten Peripherielesezugriff bei dokumentierten zwei Takten.

[Übersicht aller Stufen](README.md) · [Reset-Ergebnisse und Trace-Prüfsummen](reset-runs.json)
