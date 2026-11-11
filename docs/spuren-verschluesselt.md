# Verschlüsselte Spuren (TWSE1)

Der Bot legt Tonspuren mit angebundenem Taleward-Server nur verschlüsselt auf der Platte ab. Nur der Server der Gruppe kann sie öffnen; der Bot selbst kann es nach dem Schließen der Datei nicht mehr. Im Testmodus (ohne Server) bleiben die Spuren Klartext (`.opus`), damit man sie anhören kann.

Umsetzung: `src/aufnahme/verschluesselung.ts` (Schreiben, Referenz-Öffnen für Tests), Testvektor unter `werkzeuge/testvektor/`.

## Ablauf

1. Beim Anlegen der Runde (`POST /bot/campaigns/{c}/sessions`) gibt der Server seinen öffentlichen Spuren-Schlüssel mit (`trackKey`, siehe unten). Fehlt er, startet der Bot keine Aufnahme und meldet der Spielleitung, dass der Server aktualisiert werden muss.
2. Für jede Spur (auch die Signalspur `00-signal`) erzeugt der Bot einen frischen 256-Bit-Inhaltsschlüssel, verschlüsselt ihn per HPKE für den Server und verschlüsselt den Ogg/Opus-Strom abschnittsweise mit AES-256-GCM. Klartext und Inhaltsschlüssel liegen nur im Arbeitsspeicher (höchstens ein Abschnitt); nach dem Schließen wird der Schlüssel überschrieben.
3. Dateien heißen `NN-<attendeeKurz>.twse` (Rechte 0600), MIME beim Hochladen `application/vnd.taleward.spur-verschluesselt`.
4. Der Server entschlüsselt beim Abschluss des Uploads (`POST …/uploads/{u}/complete`). Stimmt etwas nicht (Kürzung, Vertauschung, fremder Schlüssel), lehnt er mit 400 ab; der Bot behandelt das wie jeden fehlgeschlagenen Abschluss (Wiederholung bis 24 h, dann Löschen).
5. Widerruf: Der Bot löscht die Datei und meldet `DELETE …/tracks/{attendeeId}` wie bisher.

## Dateiformat

Alle Zahlen Big-Endian.

| Teil | Größe | Inhalt |
|---|---|---|
| Kennung | 5 | `TWSE1` (ASCII) |
| keyId | 32 | SHA-256 des rohen öffentlichen X25519-Schlüssels des Servers |
| enc | 32 | HPKE-Kapsel (DHKEM X25519) |
| sealedKey | 48 | HPKE `Seal(pt = Inhaltsschlüssel 32 Bytes, aad = Kopf-AAD)` |
| chunkSize | 4 | Klartextgröße je Abschnitt, u32; der Bot nimmt 65536 |
| sessionId | 1 + n | Länge, dann ASCII |
| attendeeId | 1 + n | Länge, dann ASCII |
| Abschnitte | je 4 + n | u32 Länge des Chiffrats einschließlich Tag, dann `AES-256-GCM(Inhaltsschlüssel, Nonce, Klartext, aad = Abschnitt-AAD) ‖ Tag(16)` |

- Nonce (12 Bytes) = `00 00 00 00` ‖ u64 Abschnittsnummer ab 0.
- Kopf-AAD = `"TWSE1"` ‖ keyId ‖ sessionId ‖ attendeeId.
- Abschnitt-AAD = `"TWSE1"` ‖ sessionId ‖ attendeeId ‖ u64 Abschnittsnummer ‖ 1 Byte „letzter“ (0/1) ‖ u32 Klartextlänge.
- HPKE: Basismodus, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, `info = "taleward-spur-1"` (RFC 9180).
- Jeder Abschnitt außer dem letzten hat genau `chunkSize` Bytes Klartext. Der letzte trägt „letzter“ = 1 und darf 0 Bytes Klartext haben. Nach ihm kommt nichts mehr.

Prüfungen beim Öffnen (Server): Kennung, keyId gegen den eigenen Schlüssel, HPKE-Open des Inhaltsschlüssels mit Kopf-AAD, Abschnitte in Reihenfolge mit passender AAD, genau ein letzter Abschnitt am Ende, Klartextlänge wie in der AAD. Bei Erwartung aus dem Upload (sessionId, attendeeId) müssen die Werte im Kopf übereinstimmen.

## Testvektor

`werkzeuge/testvektor/`:

- `schluessel-privat.bin`, `schluessel-oeffentlich.bin`: rohes X25519-Paar (RFC-7748-Testschlüssel, nur für Tests)
- `spur.twse`: verschlüsselte Spur mit `chunkSize` 1024, 4 Abschnitte
- `spur-klartext.opus`: erwarteter Klartext
- `testvektor.json`: alle Werte und SHA-256-Summen

Neu erzeugen: `npm run build && node werkzeuge/testvektor-erzeugen.mjs` (die HPKE-Kapsel ist zufällig, deshalb ändert sich `spur.twse` bei jedem Lauf; `testvektor.json` wird mitgeschrieben).

## Vorschlag für die Schnittstelle (YAML 0.4.34)

1. Antwort von `POST /bot/campaigns/{campaignId}/sessions` erhält

   ```yaml
   trackKey:
     type: object
     required: [keyId, publicKey]
     properties:
       keyId: { type: string, pattern: '^[0-9a-f]{64}$', description: SHA-256 (hex) des rohen öffentlichen Schlüssels }
       publicKey: { type: string, description: Roher X25519-Schlüssel, 32 Bytes, Base64 }
   ```

   Der Bot prüft Länge und keyId und startet ohne `trackKey` keine Aufnahme.

2. `POST /sessions/{sessionId}/uploads` (source `discord`): `mimeType` darf `application/vnd.taleward.spur-verschluesselt` sein; `fileName` endet auf `.twse`. Der Server entschlüsselt beim `complete`; Fehler → `400 track_invalid` (Vorschlag für den Code).

3. Kein weiterer Pfad nötig: Der Schlüssel kommt mit der Runde, der Server erkennt seinen Schlüssel an der keyId und kann ihn so auch irgendwann wechseln, ohne dass alte, noch nicht hochgeladene Spuren ungültig werden (solange der alte private Schlüssel aufbewahrt wird).
