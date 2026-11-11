# Eigenen Taleward-Discord-Bot betreiben

Jede Gruppe mit eigenem Taleward-Server betreibt ihren eigenen Bot. Der Bot gehört zu genau einem Taleward-Server; wer den Bot betreibt, ist dafür auch verantwortlich (Datenschutz, siehe Abschnitt 6).

Du brauchst:

- einen Taleward-Server ab Fassung 0.4.162 (Schnittstelle 0.4.35) mit öffentlicher https-Adresse und Verwaltungszugang,
- einen Ort, an dem der Bot läuft: eine Linux-Maschine mit Docker (Docker Engine mit Compose-Plugin), zum Beispiel der Server, auf dem Taleward läuft, oder ein kleiner Mietserver (1 GB Arbeitsspeicher reicht, etwa 1 GB Platz je laufender Aufnahme),
- ein Discord-Konto mit Zweifaktor-Anmeldung und Verwaltungsrechten auf dem Discord-Server eurer Gruppe.

Dauer etwa 30 Minuten.

## 1. Discord-Anwendung anlegen

1. https://discord.com/developers/applications öffnen → **New Application** → Name, zum Beispiel „Taleward“ oder der Name eurer Gruppe → anlegen.
2. Reiter **General Information**: **Application ID** kopieren. Das ist `DISCORD_ANWENDUNG_ID`.
3. Reiter **Bot**:
   - **Reset Token** → bestätigen → Schlüssel sofort kopieren. Das ist `DISCORD_TOKEN`; er wird nur einmal angezeigt und ist geheim.
   - **Public Bot** ausschalten, damit nur du den Bot einladen kannst.
   - **Privileged Gateway Intents**: alle drei Schalter aus lassen (Presence, Server Members, Message Content). Der Bot braucht sie nicht.
4. Reiter **Installation**: **User Install** aus, **Guild Install** an; **Install Link** auf **None** (eingeladen wird mit dem Link aus Schritt 4).

## 2. Bot-Schlüssel beim Taleward-Server erzeugen

1. Verwaltung des Servers → **Discord-Bot** → Schalter einschalten → **Schlüssel erzeugen** → Schlüssel sofort kopieren (wird nur einmal angezeigt). Das ist `TALEWARD_BOT_SCHLUESSEL`, geheim.
2. Auf derselben Seite **Schlüssel für die Spuren** anlegen, falls noch nicht geschehen. Damit verschlüsselt der Bot jede Spur so, dass nur dieser Server sie öffnen kann.

## 3. Bot einrichten und starten

Auf der Maschine, auf der der Bot laufen soll, Zeile für Zeile:

```
sudo mkdir -p /opt/taleward-discord-bot && cd /opt/taleward-discord-bot
sudo git clone https://github.com/Taleward/taleward-discord-bot.git .
sudo cp .env.example .env
sudo nano .env
```

In `nano` eintragen (jeweils direkt hinter das Gleichheitszeichen, ohne Anführungszeichen):

- `DISCORD_TOKEN=` und `DISCORD_ANWENDUNG_ID=` aus Schritt 1,
- `TALEWARD_SERVER_URL=` die öffentliche Adresse eures Servers, zum Beispiel `https://taleward.beispiel.de` (ohne Schrägstrich am Ende),
- `TALEWARD_BOT_SCHLUESSEL=` aus Schritt 2.

Die Zeilen zu `DISCORD_HEIM_GILDE`, `DISCORD_TESTER_ROLLE` und `DISCORD_RUECKMELDUNG_KANAL` leer lassen (das sind freiwillige Helfer, siehe Abschnitt 7). Speichern mit Strg+O, Enter, beenden mit Strg+X. Dann:

```
sudo chmod 600 .env
sudo docker compose build
sudo docker compose run --rm discord-bot node dist/befehle-registrieren.js
sudo docker compose up -d
sudo docker compose logs --tail 5
```

Die dritte Zeile meldet „/taleward auf allen Discord-Servern“. Die letzte Zeile sollte „Angemeldet als … Aufnahme mit Taleward-Server.“ zeigen. Die Befehle erscheinen in Discord binnen einer Stunde (Strg+R in Discord hilft).

## 4. Bot auf den Discord-Server der Gruppe einladen

Setze deine Anwendungs-ID in diesen Link ein und öffne ihn im Browser:

```
https://discord.com/oauth2/authorize?client_id=DEINE_ANWENDUNGS_ID&scope=bot%20applications.commands&permissions=3165184
```

Die Zahl steht für genau diese Rechte: Kanäle ansehen, Nachrichten senden, Links einbetten, Verbinden, Sprechen. Den Discord-Server wählen und bestätigen. Mehr Rechte braucht der Bot nicht; „Nachrichten senden“ muss er im Textchat des Sprachkanals haben, sonst bricht er den Start ab (die Liste „Aufnahme läuft“ ist Pflicht).

## 5. Ausprobieren

1. In der App als Spielleitung: Kampagne verwalten → **Mit Discord verbinden**. Oder in Discord `/taleward verbinden` → Link öffnen → Kampagne wählen.
2. In den Sprachkanal gehen, im Textchat `/taleward beitreten`: Der Bot kommt und spielt den Startton, nimmt aber nichts auf.
3. `/taleward start`: Startton, „Aufnahme läuft: …“ und „Noch offen: …“ mit dem Knopf „Zustimmen“. Wer noch nicht zugestimmt hat, drückt den Knopf und bekommt seinen Link.
4. Kurz sprechen, `/taleward pause`, `/taleward weiter`, dann `/taleward stopp`. Die Spuren gehen zum Server, die Nachricht wird zu „Runde ist angekommen“, die Runde liegt in der App.

Meldet der Bot beim Start „kann verschlüsselte Spuren noch nicht annehmen“, ist der Taleward-Server zu alt und muss aktualisiert werden.

## 6. Datenschutz und Nutzungsbedingungen

Wer den Bot betreibt, ist Verantwortlicher für die Aufnahme in Discord. Der Taleward-Server bringt Vorlagen mit: Verwaltung → **Discord-Bot** → **Datenschutz und Nutzungsbedingungen des Bots**. Dort die Angaben in eckigen Klammern ausfüllen (Aufsicht, Hoster des Bots, Standort, Sicherungen) und veröffentlichen; die Seiten erscheinen dann unter `https://<euer Server>/discord-bot/datenschutz` und `…/discord-bot/nutzungsbedingungen`. Die Vorlagen beschreiben genau, was dieser Bot tut; ändert ihr den Bot, zieht die Texte nach.

## 7. Freiwillige Helfer für den eigenen Discord

Mit `DISCORD_HEIM_GILDE` (Server-ID eures Discord; Entwicklermodus in Discord einschalten, Rechtsklick auf den Servernamen → Server-ID kopieren), `DISCORD_TESTER_ROLLE` (Rollen-ID) und `DISCORD_RUECKMELDUNG_KANAL` (Kanal-ID eines privaten Kanals) registriert der Bot auf diesem Discord zusätzlich `/faq`, `/taleward-status`, `/feedback` und `/tester-knopf`. Die Adressen für `/faq` und den Tester-Hinweis stehen in `.env.example` (`TALEWARD_FAQ_URL` usw.) und zeigen auf taleward.org; eigene Adressen eintragen oder die Helfer weglassen. Für den Tester-Knopf braucht die Bot-Rolle „Rollen verwalten“ und muss in der Rollenliste über der Tester-Rolle stehen.

## Später

- **Aktualisieren:** `cd /opt/taleward-discord-bot && sudo git pull && sudo docker compose up -d --build`. Haben sich Befehle geändert, zusätzlich noch einmal die Zeile mit `befehle-registrieren.js`. Nicht während einer laufenden Aufnahme.
- **Rückweg**, wenn nach einem Update etwas nicht geht: `git log --oneline -5` zeigt die letzten Stände; `sudo git checkout <sieben Zeichen des vorherigen Standes> && sudo docker compose up -d --build` stellt ihn wieder her (Spuren im Volume und die `.env` bleiben unberührt). Zurück auf den neuesten Stand: `sudo git checkout main && sudo git pull`.
- **Anhalten:** `sudo docker compose down`.
- **Discord-Schlüssel neu setzen** (falls er je bekannt wird): Schritt 1.3 wiederholen, Wert in `.env` ersetzen, `sudo docker compose up -d`. Bot-Schlüssel des Servers: in der Verwaltung widerrufen und neu erzeugen.
- **Spuren auf der Platte:** liegen nur verschlüsselt und nur bis zum bestätigten Hochladen (spätestens 24 Stunden) im Docker-Volume `aufnahmen`. Macht euer Hoster Sicherungen der Maschine, können verschlüsselte Spuren darin liegen; das gehört in eure Datenschutzerklärung (Abschnitt 6).
- **Testmodus ohne Server** (`AUFNAHME_LEITUNG`/`AUFNAHME_TEILNEHMER` statt Bot-Schlüssel, dazu `DISCORD_HEIM_GILDE`): Klartext-Spuren zum Anhören, nur mit schriftlicher Zustimmung aller Beteiligten; Dateien mit `sudo docker cp taleward-discord-bot:/aufnahmen ./aufnahmen-kopie` herausholen und nach der Auswertung löschen.
