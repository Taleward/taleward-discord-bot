// Minimaler Ogg/Opus-Schreiber: eine Tonspur je Person, 48 kHz, 20-ms-Pakete.
// Discord liefert fertige Opus-Pakete; wir verpacken sie nur, ohne zu dekodieren.
// Lücken (Stille, Pausen) werden mit Opus-Stille-Paketen aufgefüllt, damit die Spur
// in Echtzeit läuft und alle Spuren zueinander passen.

import { createWriteStream, type WriteStream } from "node:fs";

export const PAKET_SAMPLES = 960; // 20 ms bei 48 kHz
export const STILLE = Buffer.from([0xf8, 0xff, 0xfe]); // Opus-Stille, wie Discord sie sendet

const CRC_TABELLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(daten: Buffer): number {
  let crc = 0;
  for (const b of daten) crc = ((crc << 8) >>> 0) ^ CRC_TABELLE[((crc >>> 24) ^ b) & 0xff]!;
  return crc >>> 0;
}

export function opusHead(kanaele: number, vorlauf = 3840): Buffer {
  const b = Buffer.alloc(19);
  b.write("OpusHead", 0, "ascii");
  b.writeUInt8(1, 8); // Fassung
  b.writeUInt8(kanaele, 9);
  b.writeUInt16LE(vorlauf, 10); // Pre-Skip
  b.writeUInt32LE(48000, 12);
  b.writeInt16LE(0, 16); // Verstärkung
  b.writeUInt8(0, 18); // Kanalabbildung 0 = mono/stereo
  return b;
}

export function opusTags(hersteller: string, tags: Record<string, string>): Buffer {
  const teile: Buffer[] = [Buffer.from("OpusTags", "ascii")];
  const h = Buffer.from(hersteller, "utf8");
  const l = Buffer.alloc(4);
  l.writeUInt32LE(h.length, 0);
  teile.push(l, h);
  const eintraege = Object.entries(tags);
  const n = Buffer.alloc(4);
  n.writeUInt32LE(eintraege.length, 0);
  teile.push(n);
  for (const [k, v] of eintraege) {
    const e = Buffer.from(`${k}=${v}`, "utf8");
    const el = Buffer.alloc(4);
    el.writeUInt32LE(e.length, 0);
    teile.push(el, e);
  }
  return Buffer.concat(teile);
}

/** Baut eine Ogg-Seite aus ganzen Paketen (jedes Paket < 255·255 Byte, was für Opus immer gilt). */
export function oggSeite(pakete: Buffer[], seriennummer: number, seitennummer: number, granule: bigint, kopfbits: number): Buffer {
  const segmente: number[] = [];
  for (const p of pakete) {
    let rest = p.length;
    while (rest >= 255) {
      segmente.push(255);
      rest -= 255;
    }
    segmente.push(rest);
  }
  if (segmente.length > 255) throw new Error("zu viele Segmente für eine Ogg-Seite");
  const kopf = Buffer.alloc(27 + segmente.length);
  kopf.write("OggS", 0, "ascii");
  kopf.writeUInt8(0, 4);
  kopf.writeUInt8(kopfbits, 5);
  kopf.writeBigInt64LE(granule, 6);
  kopf.writeUInt32LE(seriennummer >>> 0, 14);
  kopf.writeUInt32LE(seitennummer >>> 0, 18);
  kopf.writeUInt32LE(0, 22); // CRC, später
  kopf.writeUInt8(segmente.length, 26);
  for (let i = 0; i < segmente.length; i++) kopf.writeUInt8(segmente[i]!, 27 + i);
  const seite = Buffer.concat([kopf, ...pakete]);
  seite.writeUInt32LE(oggCrc(seite), 22);
  return seite;
}

export interface OggZiel {
  write(daten: Buffer): void;
  end(fertig?: () => void): void;
}

/**
 * Schreibt eine Opus-Spur. Die Zeit läuft nach der Wanduhr des Aufnahmebeginns:
 * `paket(opus, zeitMs)` legt das Paket an die Stelle zeitMs und füllt davor mit Stille auf.
 */
export class OpusSpur {
  private seitennummer = 0;
  private granule = 0n; // Samples (48 kHz), die bis zum Ende der letzten Seite abgeschlossen sind
  private offen: Buffer[] = [];
  private offenBytes = 0;
  private offenPakete = 0;
  private beendet = false;
  /** Zahl der bisher geschriebenen 20-ms-Pakete (inkl. Stille). */
  pakete = 0;
  /** Zahl der echten (nicht aufgefüllten) Pakete. */
  echtePakete = 0;

  constructor(
    private readonly ziel: OggZiel,
    private readonly seriennummer: number,
    kanaele: number,
    tags: Record<string, string>,
  ) {
    this.ziel.write(oggSeite([opusHead(kanaele)], seriennummer, this.seitennummer++, 0n, 0x02));
    this.ziel.write(oggSeite([opusTags("taleward-discord-bot", tags)], seriennummer, this.seitennummer++, 0n, 0));
  }

  /** Zielposition (in Paketen) für einen Zeitpunkt in Millisekunden seit Aufnahmebeginn. */
  static position(zeitMs: number): number {
    return Math.max(0, Math.round(zeitMs / 20));
  }

  /** Fügt ein Opus-Paket an, das zum Zeitpunkt zeitMs gehört. Zu späte Pakete werden direkt angehängt. */
  paket(opus: Buffer, zeitMs: number): void {
    if (this.beendet) return;
    const soll = OpusSpur.position(zeitMs);
    this.auffuellenBis(soll);
    this.anhaengen(opus);
    this.echtePakete++;
  }

  /** Füllt die Spur mit Stille bis zum Zeitpunkt zeitMs (z. B. am Ende oder bei Pausen). */
  stilleBis(zeitMs: number): void {
    if (this.beendet) return;
    this.auffuellenBis(OpusSpur.position(zeitMs));
  }

  private auffuellenBis(soll: number): void {
    while (this.pakete < soll) this.anhaengen(STILLE);
  }

  private anhaengen(opus: Buffer): void {
    this.offen.push(opus);
    this.offenBytes += opus.length;
    this.offenPakete++;
    this.pakete++;
    // Seiten von ~50 Paketen (1 s) oder wenn das Segment­verzeichnis voll wird.
    if (this.offenPakete >= 50 || this.offenBytes > 60000) this.seiteSchreiben(false);
  }

  private seiteSchreiben(letzte: boolean): void {
    if (this.offen.length === 0 && !letzte) return;
    this.granule += BigInt(this.offenPakete) * BigInt(PAKET_SAMPLES);
    this.ziel.write(oggSeite(this.offen, this.seriennummer, this.seitennummer++, this.granule, letzte ? 0x04 : 0));
    this.offen = [];
    this.offenBytes = 0;
    this.offenPakete = 0;
  }

  beenden(): Promise<void> {
    if (this.beendet) return Promise.resolve();
    this.beendet = true;
    this.seiteSchreiben(true);
    return new Promise((fertig) => this.ziel.end(fertig));
  }
}

export function dateiZiel(pfad: string): OggZiel & { strom: WriteStream } {
  const strom = createWriteStream(pfad, { mode: 0o600 });
  return {
    strom,
    write: (d) => void strom.write(d),
    end: (fertig) => strom.end(fertig),
  };
}
