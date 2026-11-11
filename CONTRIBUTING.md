# Mitmachen

Schön, dass du am Taleward-Discord-Bot mitarbeiten willst. Fehler, Ideen und Fragen gern als
[Issue](https://github.com/Taleward/taleward-discord-bot/issues); Code als Pull Request.

## Bevor du loslegst

- **Umgebung und Tests:** `npm ci`, `npm test` – fertig. Die Tests brauchen kein Discord und keinen Server.
- **Regeln, die nicht verhandelbar sind:** Aufgenommen wird nur, wer selbst zugestimmt hat (keine Zustimmung durch
  die Spielleitung); der Bot liest keine Nachrichten; mit Server liegen Spuren nur verschlüsselt auf der Platte und
  nur bis zum bestätigten Hochladen; keine Namen oder Discord-Kennungen in Dateien oder Protokollen. Änderungen daran
  lehnen wir ab.
- **Größere Vorhaben** bitte vorher in einem Issue beschreiben, besonders wenn sie die Schnittstelle zum Server
  betreffen (die gehört dem Server-Repo, `contract/session-chronik-api.yaml`).

## Pull Requests

- Alle Tests laufen durch (`npm test`, `npm run typecheck`). Neue Funktionen bringen eigene Tests mit.
- Neue Texte für Nutzende gibt es auf Deutsch und Englisch (`src/texte/texte.ts`), ohne Technikwörter.
- Abhängigkeiten nur mit fester Fassung und Prüfsumme (`package-lock.json`), `npm ci --ignore-scripts` muss gehen.
- Ein Thema pro Pull Request, mit kurzer Beschreibung, was sich für Betreiber oder Nutzende ändert.

## Sicherheitslücken

Bitte nicht als öffentliches Issue melden, sondern über
[GitHub Security Advisories](https://github.com/Taleward/taleward-discord-bot/security/advisories/new).

## Lizenz

Mit einem Beitrag stimmst du zu, dass er unter der [AGPL-3.0](LICENSE) veröffentlicht wird.
