# Fortgesetzter PE2-High-Lauf

Nach 2.873.347 ausgeführten Instruktionen und 4.707.108 Emulator-Takten erreicht BrewControl 1.1.27 bei Wort-PC `0x0132B2` erstmals das Adressregister des TWIE-Masters. Die Firmware adressiert `0x6F` zum Schreiben. Die Antwort des externen Teilnehmers ist offen.

Der Zusatzlauf verwendet gelöschtes EEPROM, das bisherige Oszillatorprofil und die synthetischen Kalibrierbytes `0x5A/0x03`. PE2 liegt ab Emulator-Takt 4.707.005 für den gesamten Zusatzlauf auf High. Das Eingabefenster reicht bis zur Ausführungsgrenze von 6.000.000 Takten. Alle Programmadressen sind Wort-PCs. [Vorheriger Halt bei `0x013524`](PE2-HIGH-RESULTS.md)

## 1. Interruptentscheidung vor `0x013524`

Am alten Endpunkt, Takt 4.707.026, hält das fortgesetzte High den Eingang PE2 auch während der vorausgehenden Stackoperation stabil. Für Portinterrupt 0 liegt keine fallende Flanke vor. Die Firmware führt `PUSH R29` bei `0x013524` aus und ruft über `0x010365` die TWIE-Treiberroutine bei `0x013281` auf. Die Gegenprobe beginnt am gespeicherten Zustand vor dem Schreiben der Interruptmaske und gleicht den bisherigen Pfad bis einschließlich `PUSH R28` mit dem alten Trace ab.

Nach 33 weiteren Instruktionen und 45 Emulator-Takten stoppt der bisherige Kern bei `0x013294` am Opcode `0x2322` (`AND R18,R18`). R18 enthält `0x01` und SREG enthält `0xA0`. Bis zu dieser Stelle ist der TWIE-Master im Leerlauf.

## 2. `AND R18,R18` bei `0x013294`

Der Kern führt die Registerform `AND Rd,Rr` für alle 1.024 Registerpaare aus. Bei gleichen Operanden lautet der Assembleralias `TST`. Das Ergebnis bestimmt Z, N und S. V wird gelöscht, I, T, H und C bleiben erhalten. Die Instruktion benötigt einen AVRxm-Takt. Der GNU-Assembler bestätigt alle 1.024 Codierungen. In fünf synthetischen Fällen stimmen Registerwerte und Flags im GNU-Simulator und im Emulator überein. [Microchip, AND](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-7E52E7AC-C561-4586-BB19-A4808C282813.html) · [Flags und Taktzahl](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-FFD08331-9D26-4BBC-B586-BBE5BEEC7F29.html) · [Gezielte Tests](../../tests/and.test.mjs)

Im Firmwarelauf bleiben R18 bei `0x01` und SREG bei `0xA0`. Da Z gelöscht ist, setzt die Firmware hinter dem bedingten Sprung bei `0x013296` fort. Sie liest den Wert `0x00` aus SRAM `0x421C` nach R25. Nach 13 weiteren Instruktionen und 14 Takten ist `ST Z+,R25` bei Wort `0x0132A1` der erste offene Befehl. Z zeigt zu diesem Zeitpunkt auf `0x4196`.

## 3. `ST Z+,R25` bei `0x0132A1`

Der Opcode `0x9391` schreibt das Byte `0x00` aus R25 an die bisherige SRAM-Adresse `0x4196`. Nach dem erfolgreichen Zugriff steht Z auf `0x4197`. Der Befehl verbraucht einen Emulator-Takt. SREG steht danach auf `0x80` und RAMPZ auf `0x02`. Die fünf neuen Tests prüfen alle 30 definierten Quellregister und alle Bytewerte, die beiden undefinierten Überlappungen mit Z, I/O-Wartezeiten sowie Fehler und Wiederholung eines Schreibzugriffs. Der GNU-Assembler bestätigt alle 32 Codierungen. Drei Ausführungsfälle stimmen mit dem GNU-Simulator überein. [Microchip, ST mit Z](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-6329F59C-6462-4958-B5A5-709E9518A3CA.html) · [AVRxm-Taktzahl](https://onlinedocs.microchip.com/oxy/GUID-0B644D8F-67E7-49E6-82C9-1B2B9ABE6A0D-en-US-23/GUID-00B40469-CD95-4A1F-9447-2E094BBD4EF1.html) · [Gezielte Tests](../../tests/st-z-postincrement.test.mjs)

Für den SRAM-Zugriff auf dem ATxmega256A3 genügt der 16-Bit-Zeiger Z. Das XMEGA-A-Handbuch beschreibt die Erweiterung von Datenadressen durch RAMPZ für Geräte mit mehr als 64 KiB Datenraum. [Microchip, Abschnitt 3.14.5](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=15)

Ein bestehender Regressionstest prüft jetzt den erfolgreichen Speicherzugriff und die Zeigererhöhung auch für `ST Z+,R0` (`0x9201`). Er prüft weiterhin die sechs benachbarten, bisher unimplementierten Codierungen. Die frühere Erwartung ist mit ihrer damaligen Prüfsumme archiviert. [Aktueller Test](../../tests/ldd-std.test.mjs)

Nach weiteren 17 Instruktionen und 23 Emulator-Takten versucht `STD Z+6,R22` (`0x8366`) bei `0x0132B2`, das Adressbyte `0xDE` nach `TWIE.MASTER.ADDR` an Datenadresse `0x04A6` zu schreiben. Das entspricht der 7-Bit-Adresse `0x6F` mit Schreibbit 0. Das Modell hält mit `TWI_UNKNOWN_ACK` vor Abschluss des Registerzugriffs. Das TWIE-Protokoll enthält drei abgeschlossene Initialisierungszugriffe und diesen ersten offenen Adressversuch. Der Master steht im Leerlauf. Für die Übertragung liegt weder ein bestätigtes ACK noch ein NACK vor.

## Regressionen und Reset-Berichte

| Abgearbeiteter Blocker | Node.js-Tests | Instruktionen im Zusatzlauf | Emulator-Takte | Nächster Wort-PC | Audit |
| --- | ---: | ---: | ---: | --- | --- |
| PE2 ab ursprünglicher Fenstergrenze | 511/511 | 2.873.317 | 4.707.071 | `0x013294` | PASS |
| AND R18,R18 | 514/514 | 2.873.330 | 4.707.085 | `0x0132A1` | PASS |
| ST Z+,R25 | 519/519 | 2.873.347 | 4.707.108 | `0x0132B2` | PASS |

Jeder der 18 Szenarioberichte beruht auf zwei Läufen ab Reset mit identischem vollständigem CPU-Trace und Endzustand. Die drei Standardprofile sowie die zwei Kalibrierungsprofile ohne vorgegebenen PE2-Pegel reproduzieren in jeder Stufe die zuvor verifizierten Trace-Hashes.

| Eingaben | Nach PE2-Fortsetzung | Nach AND | Nach ST Z+ |
| --- | --- | --- | --- |
| EEPROM unbekannt | `0x014E8C` | `0x014E8C` | `0x014E8C` |
| EEPROM gelöscht, Hochlauf unbekannt | `0x007A52` | `0x007A52` | `0x007A52` |
| EEPROM gelöscht, Oszillatorprofil | `0x007A74` | `0x007A74` | `0x007A74` |
| Oszillatorprofil und `0x5A` | `0x007A7D` | `0x007A7D` | `0x007A7D` |
| Oszillatorprofil und `0x5A/0x03` | `0x013523` | `0x013523` | `0x013523` |
| `0x5A/0x03` und PE2 durchgehend High | `0x013294` | `0x0132A1` | `0x0132B2` |

In jeder Stufe bestanden auch die vier Firmware-Vergleichstests, die synthetische Exportprüfung, elf historische Trace-Prüfungen und die Integritätsprüfung für 16 Originaldateien.

Die separate Messung eines direkten Peripheriezugriffs mit `LDS` ergab in jeder Stufe einen Emulator-Takt bei dokumentierten zwei Takten. Alle Laufzeiten in diesem Bericht sind Emulator-Takte.

[Übersicht aller Stufen](README.md) · [Reset-Ergebnisse und Trace-Prüfsummen](reset-runs.json)
