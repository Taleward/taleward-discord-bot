// Hochladen der Spuren zum Taleward-Server nach dem Ende einer Runde, in Teilen und wiederholbar.
//
// - Vor dem ersten Teil wird die Zustimmung frisch abgefragt (höchstens 60 s alt, Bedingung 20);
//   Spuren von Personen, die nicht mehr „ready“ sind, werden verworfen und dem Server gemeldet. Die
//   Discord-Kennungen dafür bleiben nur im Arbeitsspeicher; die Merkdatei auf der Platte enthält keine
//   (Bedingung 13). Nach einem Neustart prüft der Server die Zustimmung selbst (409 beim Anlegen).
// - Jeder Teil geht mit SHA-256; fehlende Teile werden nachgeliefert; Abschluss wird wiederholt.
// - Verwirft der Server beim Abschluss einzelne Spuren (400 track_invalid), fallen sie aus der Merkdatei und der
//   Abschluss läuft sofort mit den übrigen weiter; ist der Upload geschlossen (409 upload_closed), wird der Ordner
//   gelöscht und die Spielleitung bekommt den Hinweis, dass nichts angekommen ist.
// - Klappt es nicht, bleibt der Ordner mit einer Merkdatei liegen, der Bot versucht es alle 5 Minuten
//   weiter, bis 24 Stunden nach dem Beginn; danach wird der Ordner gelöscht (Bedingung 11).
// - Nach bestätigtem Abschluss wird der Ordner sofort gelöscht.
// - Im Testmodus (ohne Server) wird nichts hochgeladen; die Dateien bleiben bis zum Löschdatum.

import { open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Abschluss, Hinweisart } from "./aufnahme.js";
import type { Anbindung, Kontext } from "./anbindung.js";
import { DATEIENDUNG, MIME } from "./verschluesselung.js";

export const AUFBEWAHRUNG_MS = 24 * 3_600_000;
export const WIEDERHOLUNG_MS = 5 * 60_000;
const MERKDATEI = "hochladen.json";

export interface Merk {
  sessionId: string;
  kampagneId: string;
  sprache: string;
  beginn: number;
  /** Nur Dateiname und Kennung des Anwesenden beim Server; keine Discord-Kennungen auf der Platte. */
  spuren: { datei: string; attendeeId: string }[];
  uploadId?: string;
  dateien?: Record<string, string>; // datei → fileId
  teilgroesse?: number;
  versuche: number;
}

export interface Rueckmeldung {
  (ordner: string, art: Extract<Hinweisart, "angekommen" | "hochladen_fehlt">): Promise<void>;
}

export class Hochlader {
  private laeuft = new Set<string>();
  /** Discord-Kennungen je Ordner, nur im Arbeitsspeicher für die frische Abfrage vor dem ersten Teil. */
  private kennungen = new Map<string, Map<string, string>>();
  private zeitgeber: NodeJS.Timeout | undefined;

  constructor(
    private readonly anbindung: Anbindung,
    private readonly wurzel: string,
    private readonly melden: Rueckmeldung = async () => undefined,
    private readonly jetzt: () => number = Date.now,
  ) {}

  /** Nach dem Ende einer Runde: Merkdatei schreiben und sofort versuchen. */
  async nachEnde(abschluss: Abschluss): Promise<void> {
    if (!abschluss.sessionId || !this.anbindung.server) return; // Testmodus: nichts hochladen.
    const merk: Merk = {
      sessionId: abschluss.sessionId,
      kampagneId: abschluss.kontext.kampagneId,
      sprache: abschluss.kontext.sprache,
      beginn: abschluss.beginn,
      spuren: abschluss.spuren.map((s) => ({ datei: s.datei, attendeeId: s.attendeeId })),
      versuche: 0,
    };
    this.kennungen.set(abschluss.ordner, new Map(abschluss.spuren.map((s) => [s.attendeeId, s.discordId])));
    await writeFile(join(abschluss.ordner, MERKDATEI), JSON.stringify(merk), { mode: 0o600 });
    await this.versuchen(abschluss.ordner);
  }

  /** Beim Start des Bots: liegen gebliebene Runden weiter hochladen, zu alte löschen. Danach alle 5 Minuten. */
  async aufnehmen(): Promise<void> {
    await this.alleVersuchen();
    this.zeitgeber ??= setInterval(() => void this.alleVersuchen(), WIEDERHOLUNG_MS);
  }

  beenden(): void {
    if (this.zeitgeber) clearInterval(this.zeitgeber);
    this.zeitgeber = undefined;
  }

  private async alleVersuchen(): Promise<void> {
    let eintraege: string[] = [];
    try {
      eintraege = await readdir(this.wurzel);
    } catch {
      return;
    }
    for (const name of eintraege) {
      const ordner = join(this.wurzel, name);
      try {
        if (!(await stat(join(ordner, MERKDATEI))).isFile()) continue;
      } catch {
        continue;
      }
      await this.versuchen(ordner);
    }
  }

  async versuchen(ordner: string): Promise<void> {
    if (this.laeuft.has(ordner) || !this.anbindung.server) return;
    this.laeuft.add(ordner);
    try {
      const merk = JSON.parse(await readFile(join(ordner, MERKDATEI), "utf8")) as Merk;
      if (this.jetzt() - merk.beginn > AUFBEWAHRUNG_MS) {
        console.warn("hochladen: Frist von 24 h abgelaufen, Ordner wird gelöscht");
        await rm(ordner, { recursive: true, force: true });
        await this.melden(ordner, "hochladen_fehlt");
        return;
      }
      merk.versuche++;
      const ergebnis = await this.hochladen(ordner, merk);
      if (ergebnis === "fertig" || ergebnis === "verloren") {
        await rm(ordner, { recursive: true, force: true });
        this.kennungen.delete(ordner);
        await this.melden(ordner, ergebnis === "fertig" ? "angekommen" : "hochladen_fehlt");
      } else {
        await writeFile(join(ordner, MERKDATEI), JSON.stringify(merk), { mode: 0o600 });
      }
    } catch (fehler) {
      console.warn("hochladen:", fehler instanceof Error ? fehler.message : fehler);
    } finally {
      this.laeuft.delete(ordner);
    }
  }

  private async hochladen(ordner: string, merk: Merk): Promise<"fertig" | "spaeter" | "verloren"> {
    const server = this.anbindung.server;
    if (!server) return "spaeter";
    const kontext: Kontext = { kampagneId: merk.kampagneId, titel: "", sprache: merk.sprache === "de" ? "de" : "en", pauseOhneZustimmung: false, laufendeRunde: merk.sessionId };

    if (!merk.uploadId) {
      // Zustimmung frisch: Spuren ohne „ready“ verwerfen (Kennungen nur im Speicher; nach einem Neustart prüft der Server).
      const kennungen = this.kennungen.get(ordner);
      const behalten: Merk["spuren"] = [];
      if (kennungen) {
        const bereit = await this.anbindung.bereitschaft(kontext, [...kennungen.values()], merk.sessionId);
        for (const s of merk.spuren) {
          const discordId = kennungen.get(s.attendeeId);
          if (discordId && bereit.states.get(discordId)?.state === "ready") behalten.push(s);
          else {
            await rm(join(ordner, s.datei), { force: true });
            await this.anbindung.spurVerwerfen(merk.sessionId, s.attendeeId).catch(() => undefined);
          }
        }
      } else {
        behalten.push(...merk.spuren);
      }
      merk.spuren = behalten;
      if (behalten.length === 0) return "fertig"; // Nichts mehr hochzuladen; die Runde bleibt „ohne Aufnahme“.
      const dateien = [];
      for (const s of behalten) {
        const groesse = (await stat(join(ordner, s.datei))).size;
        dateien.push({ fileName: s.datei, sizeBytes: groesse, mimeType: s.datei.endsWith(DATEIENDUNG) ? MIME : "audio/ogg", trackAttendeeId: s.attendeeId });
      }
      const angelegt = await server.uploadAnlegen(merk.sessionId, dateien);
      merk.uploadId = angelegt.uploadId;
      merk.dateien = {};
      for (const f of angelegt.files) merk.dateien[f.fileName] = f.fileId;
      await this.teileSenden(ordner, merk, angelegt.chunkSizeBytes, undefined);
    } else {
      const fehlend = await server.fehlendeTeile(merk.uploadId);
      const groesse = await this.teilgroesse(merk);
      await this.teileSenden(ordner, merk, groesse, fehlend);
    }
    // Abschluss, bei verworfenen Spuren sofort noch einmal mit den übrigen (höchstens so oft, wie es Spuren gibt).
    for (let runde = 0; runde <= merk.spuren.length; runde++) {
      const a = await server.uploadAbschliessen(merk.uploadId);
      if (a.art === "fertig") return "fertig";
      if (a.art === "spaeter") return "spaeter";
      if (a.art === "geschlossen") return "verloren";
      const weg = new Set(a.attendeeIds);
      if (weg.size === 0) return "verloren"; // Server nennt keine Spur – nichts, was wir behalten könnten.
      for (const s of merk.spuren) if (weg.has(s.attendeeId)) await rm(join(ordner, s.datei), { force: true });
      merk.spuren = merk.spuren.filter((s) => !weg.has(s.attendeeId));
      if (merk.spuren.length === 0) return "verloren";
    }
    return "spaeter";
  }

  private teilgroesse(merk: Merk): Promise<number> {
    return Promise.resolve(merk.teilgroesse ?? 5 * 1024 * 1024);
  }

  private async teileSenden(ordner: string, merk: Merk, teilgroesse: number, nurFehlende: Map<string, number[]> | undefined): Promise<void> {
    const server = this.anbindung.server;
    if (!server || !merk.uploadId || !merk.dateien) return;
    merk.teilgroesse = teilgroesse;
    for (const s of merk.spuren) {
      const fileId = merk.dateien[s.datei];
      if (!fileId) continue;
      const pfad = join(ordner, s.datei);
      const groesse = (await stat(pfad)).size;
      const anzahl = Math.max(1, Math.ceil(groesse / teilgroesse));
      const indizes = nurFehlende ? (nurFehlende.get(fileId) ?? []) : Array.from({ length: anzahl }, (_, i) => i);
      if (indizes.length === 0) continue;
      const datei = await open(pfad, "r");
      try {
        for (const i of indizes) {
          const laenge = Math.min(teilgroesse, groesse - i * teilgroesse);
          if (laenge <= 0) continue;
          const puffer = Buffer.alloc(laenge);
          await datei.read(puffer, 0, laenge, i * teilgroesse);
          await server.teilHochladen(merk.uploadId, fileId, i, puffer);
        }
      } finally {
        await datei.close();
      }
    }
  }
}
