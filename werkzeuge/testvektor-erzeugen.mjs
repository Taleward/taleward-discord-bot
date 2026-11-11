// Erzeugt den gemeinsamen Testvektor für das Dateiformat TWSE1 (verschlüsselte Spuren, S65).
// Aufruf nach `npm run build`: node werkzeuge/testvektor-erzeugen.mjs
// Schreibt nach werkzeuge/testvektor/: Test-Schlüsselpaar (nur für Tests!), eine verschlüsselte
// Spur mit 1024-Byte-Abschnitten, ihren Klartext (Ogg/Opus) und eine JSON mit allen Werten.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { OpusSpur } from "../dist/aufnahme/ogg.js";
import { VerschluesselndesZiel, oeffnen } from "../dist/aufnahme/verschluesselung.js";

const ordner = new URL("./testvektor/", import.meta.url);
mkdirSync(ordner, { recursive: true });

// Festes Schlüsselpaar, damit der Vektor reproduzierbar bleibt (X25519, roh, 32 Bytes). Nur für Tests.
const privat = Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex"); // RFC 7748 Alice
const { createPrivateKey, createPublicKey } = await import("node:crypto");
const der = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), privat]);
const oeffentlich = Buffer.from(createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" })).subarray(-32);
const keyId = createHash("sha256").update(oeffentlich).digest("hex");

const sessionId = "ses_testvektor_0001";
const attendeeId = "att_testvektor_0001";
const teile = [];
const ziel = { write: (d) => void teile.push(Buffer.from(d)), end: (f) => f?.() };
const v = await VerschluesselndesZiel.anlegen(ziel, oeffentlich, sessionId, attendeeId, 1024);
const spur = new OpusSpur(v, 3, 2, { TRACKNUMBER: "1" });
for (let i = 0; i < 400; i++) spur.paket(Buffer.from([0x78, i & 0xff, (i * 7) & 0xff, 1, 2, 3, 4, 5]), i * 20);
await spur.beenden();
const datei = Buffer.concat(teile);
const g = await oeffnen(datei, privat, oeffentlich, { sessionId, attendeeId });

writeFileSync(new URL("schluessel-privat.bin", ordner), privat);
writeFileSync(new URL("schluessel-oeffentlich.bin", ordner), oeffentlich);
writeFileSync(new URL("spur.twse", ordner), datei);
writeFileSync(new URL("spur-klartext.opus", ordner), g.klartext);
writeFileSync(
  new URL("testvektor.json", ordner),
  JSON.stringify(
    {
      hinweis: "Testschlüssel, niemals produktiv verwenden. Format: siehe docs/spuren-verschluesselt.md",
      kem: "DHKEM(X25519, HKDF-SHA256)", kdf: "HKDF-SHA256", aead: "AES-256-GCM", hpkeModus: "base", info: "taleward-spur-1",
      privateKeyHex: privat.toString("hex"), publicKeyHex: oeffentlich.toString("hex"), publicKeyBase64: oeffentlich.toString("base64"), keyId,
      sessionId, attendeeId, chunkSize: 1024, abschnitte: g.abschnitte,
      klartextBytes: g.klartext.length, klartextSha256: createHash("sha256").update(g.klartext).digest("hex"),
      dateiBytes: datei.length, dateiSha256: createHash("sha256").update(datei).digest("hex"),
    },
    null,
    2,
  ),
);
console.log(`Testvektor geschrieben: ${g.abschnitte} Abschnitte, ${datei.length} Bytes, keyId ${keyId}`);
