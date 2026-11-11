import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpusSpur } from "../dist/aufnahme/ogg.js";
import { ABSCHNITT_BYTES, VerschluesselndesZiel, dateiSchreibziel, oeffnen, testSchluesselpaar } from "../dist/aufnahme/verschluesselung.js";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function speicherziel() {
  const teile: Buffer[] = [];
  return {
    teile,
    ziel: { write: (d: Buffer) => void teile.push(Buffer.from(d)), end: (f?: () => void) => f?.() },
    datei: () => Buffer.concat(teile),
  };
}

async function spurSchreiben(oeffentlich: Buffer, sessionId = "runde-1", attendeeId = "anw-1", abschnitt = 1024) {
  const z = speicherziel();
  const v = await VerschluesselndesZiel.anlegen(z.ziel, oeffentlich, sessionId, attendeeId, abschnitt);
  const spur = new OpusSpur(v, 3, 2, { TRACKNUMBER: "1" });
  for (let i = 0; i < 400; i++) spur.paket(Buffer.from([0x78, i & 0xff, (i * 7) & 0xff, 1, 2, 3, 4, 5]), i * 20);
  await spur.beenden();
  return z.datei();
}

describe("verschluesselung", () => {
  it("auf der Platte liegt während der Aufnahme nirgends ein Ogg-Kopf (K6), Datei nur für den Bot lesbar", async () => {
    const s = await testSchluesselpaar();
    const ordner = mkdtempSync(join(tmpdir(), "twse-"));
    const datei = join(ordner, "01-anw.twse");
    const v = await VerschluesselndesZiel.anlegen(dateiSchreibziel(datei), s.oeffentlich, "runde-1", "anw-1", 1024);
    const spur = new OpusSpur(v, 3, 2, { TRACKNUMBER: "1" });
    for (let i = 0; i < 300; i++) spur.paket(Buffer.from([0x78, i & 0xff, 9, 9, 9, 9]), i * 20);
    // Mitten in der Aufnahme: Datei auf der Platte prüfen.
    await new Promise((r) => setTimeout(r, 50));
    for (const name of readdirSync(ordner)) {
      const inhalt = readFileSync(join(ordner, name));
      assert.ok(!inhalt.includes(Buffer.from("OggS")), `Ogg-Kopf in ${name}`);
      assert.ok(!inhalt.includes(Buffer.from("OpusHead")));
    }
    await spur.beenden();
    const fertig = readFileSync(datei);
    assert.ok(!fertig.includes(Buffer.from("OggS")));
    assert.equal(statSync(datei).mode & 0o777, 0o600);
    const g = await oeffnen(fertig, s.privat, s.oeffentlich, { sessionId: "runde-1", attendeeId: "anw-1" });
    assert.equal(g.klartext.subarray(0, 4).toString("ascii"), "OggS");
  });
  it("schreibt keinen Klartext (kein Ogg-Kopf in der Datei) und der Server öffnet sie wieder", async () => {
    const s = await testSchluesselpaar();
    const datei = await spurSchreiben(s.oeffentlich);
    assert.equal(datei.subarray(0, 5).toString("ascii"), "TWSE1");
    assert.ok(!datei.includes(Buffer.from("OggS")), "Ogg-Kopf im Klartext");
    assert.ok(!datei.includes(Buffer.from("OpusHead")));
    const g = await oeffnen(datei, s.privat, s.oeffentlich, { sessionId: "runde-1", attendeeId: "anw-1" });
    assert.equal(g.sessionId, "runde-1");
    assert.equal(g.klartext.subarray(0, 4).toString("ascii"), "OggS");
    assert.ok(g.klartext.includes(Buffer.from("OpusHead")));
    assert.ok(g.abschnitte >= 2, `nur ${g.abschnitte} Abschnitte`);
  });
  it("lehnt veränderte, gekürzte, vertauschte und fremde Dateien ab", async () => {
    const s = await testSchluesselpaar();
    const fremd = await testSchluesselpaar();
    const datei = await spurSchreiben(s.oeffentlich);
    // verändert: ein Byte mitten im zweiten Abschnitt
    const kaputt = Buffer.from(datei);
    kaputt[kaputt.length - 40] ^= 0x01;
    await assert.rejects(oeffnen(kaputt, s.privat, s.oeffentlich), /verändert/);
    // gekürzt: letzter Abschnitt weg
    const kopfLaenge = 5 + 32 + 32 + 48 + 4 + 1 + "runde-1".length + 1 + "anw-1".length;
    const ersterAbschnitt = kopfLaenge + 4 + datei.readUInt32BE(kopfLaenge);
    await assert.rejects(oeffnen(datei.subarray(0, ersterAbschnitt), s.privat, s.oeffentlich), /verändert|gekürzt/);
    await assert.rejects(oeffnen(datei.subarray(0, datei.length - 7), s.privat, s.oeffentlich), /zu kurz|gekürzt/);
    // vertauscht: Abschnitt einer anderen Person in diese Datei kopiert
    const andere = await spurSchreiben(s.oeffentlich, "runde-1", "anw-2");
    const gemischt = Buffer.concat([datei.subarray(0, ersterAbschnitt), andere.subarray(ersterAbschnitt)]);
    await assert.rejects(oeffnen(gemischt, s.privat, s.oeffentlich), /verändert/);
    // fremder Schlüssel
    await assert.rejects(oeffnen(datei, fremd.privat, fremd.oeffentlich), /fremder Schlüssel/);
    // falsche Runde erwartet
    await assert.rejects(oeffnen(datei, s.privat, s.oeffentlich, { sessionId: "runde-2", attendeeId: "anw-1" }), /anderen Runde/);
    // unbrauchbare Kennungen beim Anlegen
    await assert.rejects(VerschluesselndesZiel.anlegen(speicherziel().ziel, s.oeffentlich, "../x", "a"), /unbrauchbar/);
  });
  it("hält die Abschnittsgröße ein und markiert den letzten Abschnitt auch bei 0 Bytes", async () => {
    const s = await testSchluesselpaar();
    const z = speicherziel();
    const v = await VerschluesselndesZiel.anlegen(z.ziel, s.oeffentlich, "r", "a", 1024);
    v.write(Buffer.alloc(2048, 7)); // genau zwei volle Abschnitte, Rest 0
    await new Promise<void>((ok) => v.end(ok));
    const g = await oeffnen(z.datei(), s.privat, s.oeffentlich);
    assert.equal(g.abschnitte, 3);
    assert.equal(g.klartext.length, 2048);
    assert.equal(ABSCHNITT_BYTES, 65_536);
  });
});

describe("testvektor", () => {
  it("der abgelegte Testvektor (werkzeuge/testvektor) lässt sich öffnen und stimmt mit der JSON überein", async () => {
    const { createHash } = await import("node:crypto");
    const basis = new URL("../werkzeuge/testvektor/", import.meta.url);
    const json = JSON.parse(readFileSync(new URL("testvektor.json", basis), "utf8")) as { privateKeyHex: string; publicKeyHex: string; keyId: string; sessionId: string; attendeeId: string; abschnitte: number; klartextSha256: string; dateiSha256: string };
    const datei = readFileSync(new URL("spur.twse", basis));
    assert.equal(createHash("sha256").update(datei).digest("hex"), json.dateiSha256);
    const g = await oeffnen(datei, Buffer.from(json.privateKeyHex, "hex"), Buffer.from(json.publicKeyHex, "hex"), { sessionId: json.sessionId, attendeeId: json.attendeeId });
    assert.equal(g.keyId.toString("hex"), json.keyId);
    assert.equal(g.abschnitte, json.abschnitte);
    assert.equal(createHash("sha256").update(g.klartext).digest("hex"), json.klartextSha256);
    assert.ok(g.klartext.equals(readFileSync(new URL("spur-klartext.opus", basis))));
  });
});
