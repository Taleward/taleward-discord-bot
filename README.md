# Taleward-Discord-Bot

Nimmt Online-Runden im Discord-Sprachkanal auf, eine Tonspur je Person, und bringt die Spuren zum Taleward-Server der Gruppe. Dort entsteht daraus ein Kapitel. Aufgenommen wird nur, wer selbst zugestimmt hat.

Freie Software (AGPL-3.0-only) wie die [App](https://github.com/Taleward/taleward-app) und der [Server](https://github.com/Taleward/taleward-server). Der Bot spricht mit Discord und mit **einem** Taleward-Server über dessen öffentliche Schnittstelle (`/bot/…`, ab Schnittstelle 0.4.34). Jede Gruppe mit eigenem Server betreibt ihren eigenen Bot; Anleitung in `docs/anleitung-start.md`.

## Befehle

Alles unter `/taleward`, Deutsch und Englisch (Discord wählt nach der Sprache der Person). SL = Spielleitung der verbundenen Kampagne.

| Befehl (deutsch) | Wer | Was er tut |
|---|---|---|
| `/taleward link` (`verbinden`) | SL | Verbindungslink (und auf Wunsch Drei-Wörter-Code) nur für sie; in der App Kampagne wählen; die Bindung prüft der Server über die Discord-Anmeldung |
| `/taleward unlink` (`trennen`) | SL | Verbindung lösen; bei mehreren Kampagnen Auswahlmenü |
| `/taleward ready` (`bereit`) | alle | Eigener Stand; fehlt etwas, kommt der Zustimmungslink (nur für die Person) |
| `/taleward join` (`beitreten`) | SL | Bot kommt in deinen Sprachkanal und spielt den Startton zur Probe; nimmt nichts auf |
| `/taleward leave` (`verlassen`) | SL | Bot geht; nicht während einer Aufnahme |
| `/taleward start` | SL, nur aus dem Sprachkanal | Startmotiv, je Person mit Zustimmung eine Tonspur; „Aufnahme läuft: Namen“ sichtbar im Textchat. Bei mehreren verbundenen Kampagnen Auswahlmenü (nur für die SL); Option `kampagne` als Abkürzung |
| `/taleward pause` / `resume` (`weiter`) | SL | Pausenton bzw. Weiter-Ton; die Lücke ist in allen Spuren Stille |
| `/taleward stop` (`stopp`) | SL | Endmotiv, Spuren schließen, Kanal verlassen, Hochladen zum Server |
| `/taleward discard` (`verwerfen`) | SL der Runde | Nach Bestätigung per Knopf: Aufnahme abbrechen, Spuren sofort löschen, nichts hochladen |
| `/taleward mark` (`merken`) [`notiz`] | alle Aufgenommenen | Stelle merken wie „Merken“ in der App, nur für die Person selbst (Schnittstelle 0.4.35) |
| `/taleward help` (`hilfe`) | alle | Ablauf in fünf Zeilen (nur für die Person sichtbar) |
| `/taleward status` | alle | Läuft eine Aufnahme, seit wann, wer, für welche Kampagne; sonst: welche Kampagnen der fragenden Person mit diesem Discord verbunden sind |

Freiwillige Helfer für den eigenen Discord-Server (nur, wenn `DISCORD_HEIM_GILDE` gesetzt ist): `/faq` (Antworten aus einer `faq.json`), `/taleward-status` (antwortet der Server, welche Fassungen sind freigegeben), `/feedback` (`/rueckmeldung`, Formular in einen privaten Kanal) und `/tester-knopf` (Rolle per Knopf). Die Adressen dafür stehen in `.env.example`.

## So läuft eine Aufnahme

Beim Start steht für alle „Aufnahme läuft: Namen“ im Textchat (Sprache der Kampagne); wer noch fehlt, steht in „Noch offen: …“ mit dem Knopf „Zustimmen“, der jedem nur seinen eigenen Link zeigt. Aufgenommen wird ausschließlich, wer laut Server bereit ist; für alle anderen bestellt der Bot keinen Empfang, ihre Pakete verwirft die Voice-Bibliothek vor der Entschlüsselung. Die Zustimmung wird alle 30 s neu abgefragt; ein Widerruf schließt die Spur, löscht die Datei und nimmt den Namen aus der Liste.

Wache (`src/aufnahme/wache.ts`): SL verlässt den Kanal → Pause mit Hinweis, zurück → weiter, nach 5 Minuten Ende; Kanal 5 Minuten leer → Ende; 6 Stunden → Ende; Verbindung weg → Ende. Kein frischer Zustimmungsstand vom Server (nicht erreichbar oder Bremse) für 60 Sekunden → Pause, 30 Minuten → Ende. Kampagnen-Einstellung „Aufnahme anhalten, wenn jemand ohne Zustimmung dazukommt“ (App, Kampagne verwalten → Discord): kommt während der Aufnahme eine Person ohne Zustimmung in den Kanal, hält der Bot an und schreibt es in den Kanal; weiter geht es, sobald alle im Kanal zugestimmt haben oder die Person weg ist, oder die SL setzt mit `weiter` fort (dann nicht noch einmal für dieselbe Person). Wer beim Start schon ohne Zustimmung da ist, steht in „Noch offen“ und löst keine Pause aus.

Nach dem Ende lädt `src/aufnahme/hochladen.ts` die Spuren in Teilen mit Prüfsumme zum Server (Zustimmung vorher frisch abgefragt), wiederholt bei Fehlern alle 5 Minuten bis 24 Stunden nach dem Beginn, löscht den Ordner nach bestätigtem Abschluss (oder nach der Frist) und macht aus der Nachricht „Runde ist angekommen“.

Dateien: eine Ogg/Opus-Spur je Person, `00-signal` mit allen Tönen des Bots (Holzklang, `werkzeuge/toene-erzeugen.py`) als Nullmarke, Lücken mit Stille gefüllt, alle Spuren laufen zueinander in Echtzeit. Mit Server liegen alle Spuren (auch die Signalspur) nur **verschlüsselt** auf der Platte (`.twse`, nur der Taleward-Server kann sie öffnen; Format in `docs/spuren-verschluesselt.md`); Dateinamen und Protokoll enthalten keine Namen und keine Discord-Kennungen. Befehle werden vor dem Server gebremst (je Person 10, je Discord-Server 30, insgesamt 300 je Minute; die SL einer laufenden Aufnahme nie).

Testmodus ohne Server (`AUFNAHME_LEITUNG`/`AUFNAHME_TEILNEHMER` statt Bot-Schlüssel): nur auf dem eigenen Discord, Klartext-`.opus` zum Anhören, kein Hochladen. Nur mit schriftlicher Zustimmung aller aufgenommenen Personen.

## Entwickeln

```
npm ci
npm test          # Tests ohne Discord
npm run typecheck
npm run build
```

Start lokal: `.env` nach `.env.example` anlegen, dann `npm run befehle` (einmalig) und `npm start`.

## Betrieb

Siehe `docs/anleitung-start.md` (Schritt für Schritt, etwa 30 Minuten). Kurz: Discord-Anwendung anlegen, Bot-Schlüssel in der Verwaltung des Taleward-Servers erzeugen, `.env` füllen, `docker compose up -d --build`, Befehle einmalig mit `docker compose run --rm discord-bot node dist/befehle-registrieren.js` registrieren.

## Regeln

- Geheimnisse nur in der `.env`, nie im Repo.
- Der Bot liest keine Nachrichten und schreibt keine Inhalte aus Taleward nach Discord.
- Fremde Daten (faq.json, GitHub, Formulare) werden streng geprüft und gesäubert, keine Erwähnungen.
- Abhängigkeiten mit festen Fassungen (`package-lock.json`). Sprachverbindung über `@discordjs/voice` mit `@snazzah/davey` (Ende-zu-Ende-Verschlüsselung von Discord) und der eingebauten AES-GCM-Verschlüsselung von Node.
- Spuren liegen im eigenen Datenträger `aufnahmen` (nur Nutzer 1000), mit Server nur verschlüsselt und nur bis zum bestätigten Hochladen.

Mitmachen: `CONTRIBUTING.md`. Sicherheitslücken bitte nicht als öffentliches Issue, sondern über die Sicherheitsmeldung des Repos.
