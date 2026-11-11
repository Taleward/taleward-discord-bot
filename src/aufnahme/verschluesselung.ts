// Spuren verschlüsselt ablegen (S65): Nur der Taleward-Server der Gruppe kann sie öffnen.
//
// Dateiformat „Taleward-Spur, verschlüsselt“, Fassung 1 (TWSE1):
//
//   Kopf
//     5 Bytes   Kennung "TWSE1"
//     32 Bytes  keyId      = SHA-256 des rohen öffentlichen X25519-Schlüssels des Servers
//     32 Bytes  enc        = HPKE-Kapsel (DHKEM X25519)
//     48 Bytes  sealedKey  = HPKE Seal(pt = 32-Byte-Inhaltsschlüssel, aad = Kopf-AAD)
//     4 Bytes   chunkSize  = Klartextgröße je Abschnitt (u32 BE), hier 65536
//     1 Byte    Länge von sessionId, dann sessionId (ASCII)
//     1 Byte    Länge von attendeeId, dann attendeeId (ASCII)
//   Abschnitte, nacheinander
//     4 Bytes   n = Länge des Chiffrats einschließlich Tag (u32 BE)
//     n Bytes   AES-256-GCM(Inhaltsschlüssel, Nonce, Klartext, aad = Abschnitt-AAD) || Tag (16 Bytes)
//
//   Nonce           = 4 Bytes 0x00 || u64 BE Abschnittsnummer (ab 0)
//   Abschnitt-AAD   = "TWSE1" || sessionId || attendeeId || u64 BE Abschnittsnummer || 1 Byte letzter (0/1) || u32 BE Klartextlänge
//   Kopf-AAD        = "TWSE1" || keyId || sessionId || attendeeId
//   HPKE            = Basismodus, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, info = "taleward-spur-1"
//
//   Der letzte Abschnitt trägt letzter = 1 (auch mit 0 Bytes Klartext); danach kommt nichts mehr. So fallen Kürzen,
//   Vertauschen (sessionId, attendeeId, Nummer in der AAD) und fremde Schlüssel (keyId, HPKE) beim Öffnen auf.
//
// Der Ogg-Schreiber schreibt in dieses Ziel; Klartext liegt nur im Arbeitsspeicher (höchstens ein Abschnitt), der
// Inhaltsschlüssel ebenso und wird nach dem Schließen verworfen. Keine eigene Krypto außer dem Zusammensetzen:
// HPKE aus @hpke/core und @hpke/dhkem-x25519 (feste Fassungen), AES-GCM aus Node.

import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { OggZiel } from "./ogg.js";

export const KENNUNG = Buffer.from("TWSE1", "ascii");
export const INFO = Buffer.from("taleward-spur-1", "utf8");
export const ABSCHNITT_BYTES = 65_536;
export const DATEIENDUNG = ".twse";
export const MIME = "application/vnd.taleward.spur-verschluesselt";

const KENNUNG_RE = /^[A-Za-z0-9_-]{1,64}$/;

function suite(): CipherSuite {
  return new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
}

export function keyIdVon(oeffentlich: Buffer): Buffer {
  return createHash("sha256").update(oeffentlich).digest();
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

function kennungBytes(wert: string, name: string): Buffer {
  if (!KENNUNG_RE.test(wert)) throw new Error(`${name} unbrauchbar`);
  return Buffer.from(wert, "ascii");
}

export function abschnittAad(sessionId: Buffer, attendeeId: Buffer, index: number, letzter: boolean, klartextLaenge: number): Buffer {
  return Buffer.concat([KENNUNG, sessionId, attendeeId, u64(index), Buffer.from([letzter ? 1 : 0]), u32(klartextLaenge)]);
}

export function kopfAad(keyId: Buffer, sessionId: Buffer, attendeeId: Buffer): Buffer {
  return Buffer.concat([KENNUNG, keyId, sessionId, attendeeId]);
}

function nonce(index: number): Buffer {
  return Buffer.concat([Buffer.alloc(4), u64(index)]);
}

export interface Schreibziel {
  write(daten: Buffer): void;
  end(fertig?: () => void): void;
}

/** Verschlüsselt alles, was der Ogg-Schreiber liefert, abschnittsweise in das darunterliegende Ziel. */
export class VerschluesselndesZiel implements OggZiel {
  private puffer: Buffer[] = [];
  private pufferBytes = 0;
  private index = 0;
  private beendet = false;

  private constructor(
    private readonly ziel: Schreibziel,
    private readonly inhaltsschluessel: Buffer,
    private readonly sessionId: Buffer,
    private readonly attendeeId: Buffer,
    private readonly abschnittBytes: number,
  ) {}

  /**
   * Legt den Kopf an. `serverOeffentlich` ist der rohe öffentliche X25519-Schlüssel des Servers (32 Bytes).
   */
  static async anlegen(ziel: Schreibziel, serverOeffentlich: Buffer, sessionId: string, attendeeId: string, abschnittBytes = ABSCHNITT_BYTES): Promise<VerschluesselndesZiel> {
    if (serverOeffentlich.length !== 32) throw new Error("öffentlicher Schlüssel des Servers unbrauchbar");
    const s = kennungBytes(sessionId, "sessionId");
    const a = kennungBytes(attendeeId, "attendeeId");
    const keyId = keyIdVon(serverOeffentlich);
    const inhaltsschluessel = randomBytes(32);

    const cs = suite();
    const empfaenger = await cs.kem.deserializePublicKey(new Uint8Array(serverOeffentlich).buffer as ArrayBuffer);
    const sender = await cs.createSenderContext({ recipientPublicKey: empfaenger, info: new Uint8Array(INFO).buffer as ArrayBuffer });
    const sealed = Buffer.from(await sender.seal(new Uint8Array(inhaltsschluessel).buffer as ArrayBuffer, new Uint8Array(kopfAad(keyId, s, a)).buffer as ArrayBuffer));
    const enc = Buffer.from(sender.enc);
    if (enc.length !== 32 || sealed.length !== 48) throw new Error("HPKE lieferte unerwartete Längen");

    ziel.write(Buffer.concat([KENNUNG, keyId, enc, sealed, u32(abschnittBytes), Buffer.from([s.length]), s, Buffer.from([a.length]), a]));
    return new VerschluesselndesZiel(ziel, inhaltsschluessel, s, a, abschnittBytes);
  }

  write(daten: Buffer): void {
    if (this.beendet) return;
    this.puffer.push(daten);
    this.pufferBytes += daten.length;
    while (this.pufferBytes >= this.abschnittBytes) {
      const ganz = Buffer.concat(this.puffer);
      this.abschnittSchreiben(ganz.subarray(0, this.abschnittBytes), false);
      const rest = ganz.subarray(this.abschnittBytes);
      this.puffer = rest.length ? [Buffer.from(rest)] : [];
      this.pufferBytes = rest.length;
    }
  }

  private abschnittSchreiben(klartext: Buffer, letzter: boolean): void {
    const chiffre = createCipheriv("aes-256-gcm", this.inhaltsschluessel, nonce(this.index));
    chiffre.setAAD(abschnittAad(this.sessionId, this.attendeeId, this.index, letzter, klartext.length));
    const daten = Buffer.concat([chiffre.update(klartext), chiffre.final(), chiffre.getAuthTag()]);
    this.ziel.write(Buffer.concat([u32(daten.length), daten]));
    this.index++;
  }

  end(fertig?: () => void): void {
    if (this.beendet) return;
    this.beendet = true;
    this.abschnittSchreiben(Buffer.concat(this.puffer), true);
    this.puffer = [];
    this.pufferBytes = 0;
    this.inhaltsschluessel.fill(0);
    this.ziel.end(fertig);
  }
}

export function dateiSchreibziel(pfad: string): Schreibziel {
  const strom = createWriteStream(pfad, { mode: 0o600 });
  return { write: (d) => void strom.write(d), end: (fertig) => strom.end(fertig) };
}

export interface Geoeffnet {
  keyId: Buffer;
  sessionId: string;
  attendeeId: string;
  klartext: Buffer;
  abschnitte: number;
}

/**
 * Öffnet eine TWSE1-Datei mit dem privaten Schlüssel des Servers (roher X25519-Schlüssel, 32 Bytes).
 * Referenz für den Server und für die Tests; der Bot selbst braucht das nicht.
 */
export async function oeffnen(datei: Buffer, serverPrivat: Buffer, serverOeffentlich: Buffer, erwartet?: { sessionId: string; attendeeId: string }): Promise<Geoeffnet> {
  let p = 0;
  const lesen = (n: number): Buffer => {
    if (p + n > datei.length) throw new Error("Datei zu kurz");
    const b = datei.subarray(p, p + n);
    p += n;
    return b;
  };
  if (!lesen(5).equals(KENNUNG)) throw new Error("keine TWSE1-Datei");
  const keyId = Buffer.from(lesen(32));
  if (!keyId.equals(keyIdVon(serverOeffentlich))) throw new Error("fremder Schlüssel");
  const enc = Buffer.from(lesen(32));
  const sealed = Buffer.from(lesen(48));
  const abschnittBytes = lesen(4).readUInt32BE(0);
  if (abschnittBytes === 0 || abschnittBytes > 16 * 1024 * 1024) throw new Error("Abschnittsgröße unbrauchbar");
  const sLen = lesen(1)[0]!;
  const s = Buffer.from(lesen(sLen));
  const aLen = lesen(1)[0]!;
  const a = Buffer.from(lesen(aLen));
  const sessionId = s.toString("ascii");
  const attendeeId = a.toString("ascii");
  if (!KENNUNG_RE.test(sessionId) || !KENNUNG_RE.test(attendeeId)) throw new Error("Kennungen unbrauchbar");
  if (erwartet && (erwartet.sessionId !== sessionId || erwartet.attendeeId !== attendeeId)) throw new Error("Datei gehört zu einer anderen Runde oder Person");

  const cs = suite();
  const privat = await cs.kem.deserializePrivateKey(new Uint8Array(serverPrivat).buffer as ArrayBuffer);
  const empfaenger = await cs.createRecipientContext({
    recipientKey: privat,
    enc: new Uint8Array(enc).buffer as ArrayBuffer,
    info: new Uint8Array(INFO).buffer as ArrayBuffer,
  });
  const inhaltsschluessel = Buffer.from(await empfaenger.open(new Uint8Array(sealed).buffer as ArrayBuffer, new Uint8Array(kopfAad(keyId, s, a)).buffer as ArrayBuffer));

  const teile: Buffer[] = [];
  let index = 0;
  let letzterGesehen = false;
  while (p < datei.length) {
    if (letzterGesehen) throw new Error("Daten nach dem letzten Abschnitt");
    const n = lesen(4).readUInt32BE(0);
    if (n < 16) throw new Error("Abschnitt zu kurz");
    const daten = lesen(n);
    const chiffrat = daten.subarray(0, n - 16);
    const tag = daten.subarray(n - 16);
    const klartextLaenge = chiffrat.length;
    if (klartextLaenge > abschnittBytes) throw new Error("Abschnitt zu groß");
    // Letzter Abschnitt: kürzer als die Abschnittsgröße oder das Dateiende ist erreicht. Beides muss zur AAD passen.
    const letzter = p >= datei.length;
    const entschl = createDecipheriv("aes-256-gcm", inhaltsschluessel, nonce(index));
    entschl.setAAD(abschnittAad(s, a, index, letzter, klartextLaenge));
    entschl.setAuthTag(tag);
    let klartext: Buffer;
    try {
      klartext = Buffer.concat([entschl.update(chiffrat), entschl.final()]);
    } catch {
      throw new Error(`Abschnitt ${index} verändert oder vertauscht`);
    }
    if (!letzter && klartextLaenge !== abschnittBytes) throw new Error(`Abschnitt ${index} hat die falsche Länge`);
    teile.push(klartext);
    if (letzter) letzterGesehen = true;
    index++;
  }
  if (!letzterGesehen) throw new Error("Datei gekürzt: letzter Abschnitt fehlt");
  inhaltsschluessel.fill(0);
  return { keyId, sessionId, attendeeId, klartext: Buffer.concat(teile), abschnitte: index };
}

/** Testhilfe: ein frisches Schlüsselpaar des Servers als rohe Bytes. */
export async function testSchluesselpaar(): Promise<{ privat: Buffer; oeffentlich: Buffer }> {
  const cs = suite();
  const kp = await cs.kem.generateKeyPair();
  return {
    privat: Buffer.from(await cs.kem.serializePrivateKey(kp.privateKey)),
    oeffentlich: Buffer.from(await cs.kem.serializePublicKey(kp.publicKey)),
  };
}
