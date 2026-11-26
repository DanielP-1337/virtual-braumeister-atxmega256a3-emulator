# PE2 im begrenzten High-Fenster

Der Lauf endet bei Wort-PC `0x013524` nach **2.873.284 abgeschlossenen Instruktionen und 4.707.026 Emulator-Takten**. Gegenüber dem Zweibyteprofil kommt genau eine ausgeführte Instruktion hinzu, `PUSH R28` bei `0x013523`.

Der Zusatzlauf für BrewControl 1.1.27 verwendet gelöschtes EEPROM, das bisherige Oszillatorprofil und die synthetischen Kalibrierbytes `ADCACAL0 = 0x5A` und `ADCACAL1 = 0x03`. Die zusätzliche Vorgabe setzt PE2 von Emulator-Takt 4.707.005 bis einschließlich 4.707.025 durchgehend auf High. Der vereinbarte Endpunkt ist die erste Interruptentscheidung nach diesem Fenster, bei Takt 4.707.026. Flash-Adressen sind Wortadressen, SRAM- und Registeradressen sind Byteadressen. [Ausgangsbericht](SPIE-INTCTRL-RESULTS.md)

## Befund an der Fenstergrenze

Bei Takt 4.707.005 wählt die Firmware PE2 als einzige Quelle für Portinterrupt 0. Zunächst reagiert der Eingang auf beide Flanken. Bei Takt 4.707.013 schaltet die Firmware auf fallende Flanken um. Im gesamten freigegebenen Fenster liegt keine passende Flanke vor. Der Interruptcontroller lässt daher nach `SEI` und dem folgenden `CALL` den Befehlsabruf bei `0x013523` zu. Die lokale Gegenprobe reproduziert die 13 vorangehenden Firmware-Instruktionen ab dem Masken-Schreibzugriff samt CPU-Zuständen und SRAM. [Eingangserkennung des XMEGA A, Abschnitt 13.6](https://ww1.microchip.com/downloads/en/DeviceDoc/doc8077.pdf#page=137)

| Wort-PC | Emulator-Takt | Beobachtung |
| --- | ---: | --- |
| `0x013523` | 4.707.025 → 4.707.026 | `PUSH R28` (Opcode `0x93CF`) schreibt `0x04` nach SRAM `0x5FEF`. Der Stackpointer wechselt von `0x5FEF` auf `0x5FEE`. |
| `0x013524` | 4.707.026 | Vor dem nächsten Befehlsabruf benötigt der PMIC die PE2-Historie für das Intervall (4.707.025, 4.707.026]. Der Lauf hält mit `PORTE_INT0_INPUT_HISTORY_UNKNOWN`. |

Die Maske bleibt `0x04` und die Priorität von `PORTE.INT0` bleibt niedrig. Die letzte Diagnose enthält null Buszugriffe und die Anzahl der Interrupt-Eintritte bleibt null. Das Protokoll unterscheidet eine mögliche Flanke nach Ende des Fensters von einem gesetzten Interruptflag.

## Reset- und Regressionsergebnisse

Jedes Szenario lief zweimal vom Resetvektor. Alle sechs Paare lieferten identische CPU-Traces und Endzustände. Die drei Standardprofile, das Einzelbyteprofil und das Zweibyteprofil ohne PE2-Eingabe reproduzieren ihre zuvor gespeicherten Trace-Hashes.

| Profil | Abgeschlossene Instruktionen | Emulator-Takte | Halt bei Wort-PC | Bericht |
| --- | ---: | ---: | --- | --- |
| EEPROM unbekannt | 46.741 | 61.988 | `0x014E8C` | `0x014E8C` |
| EEPROM gelöscht, Oszillatorhochlauf unbekannt | 2.872.372 | 4.705.639 | `0x007A52` | `0x007A52` |
| EEPROM gelöscht, Oszillatorprofil | 2.872.988 | 4.706.500 | `0x007A74` | `0x007A74` |
| Oszillatorprofil und `0x5A` | 2.872.994 | 4.706.511 | `0x007A7D` | `0x007A7D` |
| Oszillatorprofil und `0x5A/0x03` | 2.873.283 | 4.707.025 | `0x013523` | `0x013523` |
| `0x5A/0x03` und PE2 im High-Fenster | 2.873.284 | 4.707.026 | `0x013524` | `0x013524` |

Alle 511 Node.js-Regressionstests bestanden, darunter 4 neue Tests für das Zeitfenster. Hinzu kamen vier bestandene Firmware-Vergleichstests, die synthetische Exportprüfung, elf historische Trace-Prüfungen und die Integritätsprüfung für 16 Originaldateien.

Die separate Zeitmessung für direkte Peripheriezugriffe mit `LDS` ergab erneut einen Emulator-Takt bei dokumentierten zwei Takten. Der hier hinzugekommene `PUSH` benötigt einen Takt.

Zur erneuten Prüfung der gespeicherten Ergebnisse dient `node verification/adca/check-stages.mjs pe2-high-window`.

[Übersicht aller Stufen](README.md) · [Reset-Ergebnisse und Trace-Prüfsummen](reset-runs.json)
