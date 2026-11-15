// QR-Bild zu einer Adresse als PNG, ohne weitere Abhängigkeiten außer dem reinen QR-Kodierer.
// Der PNG-Schreiber ist bewusst klein: Graustufen, 1 Byte je Bildpunkt, deflate aus Node.

import { deflateSync } from "node:zlib";
import qrcode from "qrcode-generator";

const PNG_KOPF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTabelle: Uint32Array | undefined;
function crc32(daten: Buffer): number {
  if (!crcTabelle) {
    crcTabelle = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTabelle[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of daten) c = crcTabelle[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function abschnitt(typ: string, inhalt: Buffer): Buffer {
  const laenge = Buffer.alloc(4);
  laenge.writeUInt32BE(inhalt.length);
  const typUndInhalt = Buffer.concat([Buffer.from(typ, "ascii"), inhalt]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typUndInhalt));
  return Buffer.concat([laenge, typUndInhalt, crc]);
}

/** Graustufen-PNG aus einer Matrix (true = dunkel), jedes Modul `groesse` Bildpunkte, mit `rand` Modulen Rand. */
export function matrixAlsPng(dunkel: (x: number, y: number) => boolean, module: number, groesse: number, rand: number): Buffer {
  const breite = (module + 2 * rand) * groesse;
  const zeilen: Buffer[] = [];
  for (let y = 0; y < breite; y++) {
    const zeile = Buffer.alloc(1 + breite, 0xff);
    zeile[0] = 0; // Filter: keiner
    const my = Math.floor(y / groesse) - rand;
    if (my >= 0 && my < module) {
      for (let x = 0; x < breite; x++) {
        const mx = Math.floor(x / groesse) - rand;
        if (mx >= 0 && mx < module && dunkel(mx, my)) zeile[1 + x] = 0x1a;
      }
    }
    zeilen.push(zeile);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(breite, 0);
  ihdr.writeUInt32BE(breite, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 0; // Graustufen
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([PNG_KOPF, abschnitt("IHDR", ihdr), abschnitt("IDAT", deflateSync(Buffer.concat(zeilen))), abschnitt("IEND", Buffer.alloc(0))]);
}

/** QR-Code (Fehlerkorrektur M) für eine Adresse als PNG, etwa 300–400 px breit. Nur für https-Adressen gedacht. */
export function qrPng(text: string): Buffer {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const module = code.getModuleCount();
  const groesse = Math.max(4, Math.floor(360 / module));
  return matrixAlsPng((x, y) => code.isDark(y, x), module, groesse, 4);
}
