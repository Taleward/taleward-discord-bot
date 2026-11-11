import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ServerAnbindung } from "../dist/aufnahme/anbindung.js";
import { Hochlader } from "../dist/aufnahme/hochladen.js";
import { ServerFehler, TalewardServer, spurenSchluesselParsen } from "../dist/server/client.js";
import { createHash } from "node:crypto";
import { testSchluesselpaar } from "../dist/aufnahme/verschluesselung.js";

type Aufruf = { methode: string; pfad: string; kopf: Record<string, string>; koerper: unknown };

/** Nachgebildeter Server: antwortet nach Pfad, merkt sich alle Aufrufe. */
function nachbau(antworten: (a: Aufruf) => { status: number; body?: unknown }) {
  const aufrufe: Aufruf[] = [];
  const holen = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const kopf = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let koerper: unknown;
    if (typeof init?.body === "string") koerper = JSON.parse(init.body);
    else if (init?.body instanceof Uint8Array) koerper = Buffer.from(init.body);
    const a = { methode: init?.method ?? "GET", pfad: u.replace("https://srv/api/v1", ""), kopf, koerper };
    aufrufe.push(a);
    const r = antworten(a);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { aufrufe, holen };
}

describe("server-client", () => {
  it("schickt den Bot-Schlüssel im Kopf und liest die Bereitschaft streng", async () => {
    const n = nachbau((a) => {
      if (a.pfad === "/bot/campaigns/k1/readiness") return { status: 200, body: { states: { "111111111111111111": { state: "ready", attendeeId: "a1" }, "222222222222222222": { state: "quatsch" } }, sessionState: "recording" } };
      return { status: 404, body: { code: "not_found", message: "nein" } };
    });
    const s = new TalewardServer("https://srv", "geheim-geheim-geheim-geheim", n.holen);
    const b = await s.bereitschaft("k1", ["111111111111111111", "222222222222222222", "abc"], "s1");
    assert.equal(n.aufrufe[0]?.kopf["x-taleward-bot"], "geheim-geheim-geheim-geheim");
    assert.deepEqual(n.aufrufe[0]?.koerper, { discordUserIds: ["111111111111111111", "222222222222222222"], sessionId: "s1" });
    assert.equal(b.states.get("111111111111111111")?.state, "ready");
    assert.equal(b.states.get("111111111111111111")?.attendeeId, "a1");
    assert.equal(b.states.get("222222222222222222")?.state, "link_required");
    assert.equal(b.sessionState, "recording");
    await assert.rejects(s.kampagnen("1", "2"), (f: unknown) => f instanceof ServerFehler && f.status === 404 && f.code === "not_found");
  });
  it("nimmt nur saubere Kampagnen und Links an", async () => {
    const n = nachbau((a) => {
      if (a.pfad.startsWith("/bot/guilds/")) return { status: 200, body: { campaigns: [{ campaignId: "k1", title: "Die leisen Wasser", language: "de", pauseOnUnconsented: true, liveSessionId: null }, { campaignId: "../x", title: "böse" }, { title: "ohne id" }] } };
      if (a.pfad === "/bot/links") return { status: 201, body: { url: "http://unsicher", code: "a-b-c", expiresAt: "2026-11-07T12:00:00Z" } };
      return { status: 500 };
    });
    const s = new TalewardServer("https://srv", "geheim-geheim-geheim-geheim", n.holen);
    const k = await s.kampagnen("1", "2");
    assert.deepEqual(k.map((x) => x.campaignId), ["k1"]);
    assert.equal(k[0]?.pauseOnUnconsented, true);
    await assert.rejects(s.linkAnfordern("1", "2", "Gilde"), /unbrauchbar/);
  });
  it("liest den Spuren-Schlüssel der Runde nur, wenn keyId und Länge stimmen (S65)", async () => {
    const paar = await testSchluesselpaar();
    const keyId = createHash("sha256").update(paar.oeffentlich).digest("hex");
    const gut = spurenSchluesselParsen({ keyId, publicKey: paar.oeffentlich.toString("base64") });
    assert.ok(gut && gut.oeffentlich.equals(paar.oeffentlich) && gut.keyId === keyId);
    assert.equal(spurenSchluesselParsen({ keyId: "00".repeat(32), publicKey: paar.oeffentlich.toString("base64") }), undefined);
    assert.equal(spurenSchluesselParsen({ keyId, publicKey: Buffer.alloc(31).toString("base64") }), undefined);
    assert.equal(spurenSchluesselParsen(undefined), undefined);
    const n = nachbau((a) => (a.pfad.endsWith("/sessions") ? { status: 201, body: { sessionId: "s1", number: 3, trackKey: { keyId, publicKey: paar.oeffentlich.toString("base64") } } } : { status: 500 }));
    const an = new ServerAnbindung(new TalewardServer("https://srv", "geheim-geheim-geheim-geheim", n.holen));
    const r = await an.rundeAnlegen({ kampagneId: "k1", titel: "", sprache: "de", pauseOhneZustimmung: false, laufendeRunde: null }, "1", "2", new Date());
    assert.equal(r.sessionId, "s1");
    assert.equal(r.spurenSchluessel?.keyId, keyId);
  });
  it("Server-Anbindung: 409 beim Anwesenden heißt keine Spur, kein Fehler", async () => {
    const n = nachbau((a) => (a.pfad.endsWith("/attendees") ? { status: 409, body: { code: "consent_missing", message: "x" } } : { status: 500 }));
    const an = new ServerAnbindung(new TalewardServer("https://srv", "geheim-geheim-geheim-geheim", n.holen));
    assert.equal(await an.anwesend("s1", "111111111111111111"), undefined);
    assert.equal(await an.anwesend(undefined, "111111111111111111"), undefined);
  });
});

describe("hochladen", () => {
  it("lädt in Teilen mit Prüfsumme hoch, verwirft Spuren ohne Zustimmung, löscht danach den Ordner", async () => {
    const wurzel = mkdtempSync(join(tmpdir(), "hochladen-"));
    const ordner = join(wurzel, "2026-11-07_20-00");
    await mkdir(ordner);
    writeFileSync(join(ordner, "01-a.opus"), Buffer.alloc(7000, 1));
    writeFileSync(join(ordner, "02-b.opus"), Buffer.alloc(100, 2));
    const teile: string[] = [];
    let abschluesse = 0;
    const n = nachbau((a) => {
      if (a.pfad.endsWith("/readiness")) return { status: 200, body: { states: { "111111111111111111": { state: "ready" }, "222222222222222222": { state: "consent_required" } } } };
      if (a.pfad.endsWith("/tracks/att-b")) return { status: 204 };
      if (a.pfad === "/sessions/s1/uploads") {
        assert.deepEqual((a.koerper as { files: unknown[] }).files, [{ fileName: "01-a.opus", sizeBytes: 7000, mimeType: "audio/ogg", trackAttendeeId: "att-a" }]);
        return { status: 201, body: { uploadId: "u1", chunkSizeBytes: 4096, files: [{ fileId: "f1", fileName: "01-a.opus", chunkCount: 2 }] } };
      }
      if (a.pfad.startsWith("/uploads/u1/files/f1/chunks/")) {
        teile.push(`${a.pfad.at(-1)}:${(a.koerper as Buffer).length}:${a.kopf["x-chunk-sha256"]?.length}`);
        return { status: 204 };
      }
      if (a.pfad === "/uploads/u1" && a.methode === "GET") return { status: 200, body: { files: [{ fileId: "f1", missingChunks: [] }] } };
      if (a.pfad === "/uploads/u1/complete") {
        abschluesse++;
        return abschluesse === 1 ? { status: 429, body: { code: "too_many_requests", message: "später" } } : { status: 202, body: {} };
      }
      return { status: 500, body: { code: "x", message: "y" } };
    });
    const an = new ServerAnbindung(new TalewardServer("https://srv", "geheim-geheim-geheim-geheim", n.holen));
    const meldungen: string[] = [];
    const h = new Hochlader(an, wurzel, async (_o, art) => void meldungen.push(art));
    const abschluss = {
      dauerMs: 1000,
      spuren: [
        { datei: "01-a.opus", attendeeId: "att-a", discordId: "111111111111111111" },
        { datei: "02-b.opus", attendeeId: "att-b", discordId: "222222222222222222" },
      ],
      ordner,
      sessionId: "s1",
      kontext: { kampagneId: "k1", titel: "t", sprache: "de" as const, pauseOhneZustimmung: false, laufendeRunde: null },
      beginn: Date.now(),
      grund: "stopp" as const,
    };
    await h.nachEnde(abschluss);
    // Erster Versuch: Teile gesendet, Abschluss vertagt (429) → Ordner bleibt mit Merkdatei.
    assert.deepEqual(teile, ["0:4096:64", "1:2904:64"]);
    assert.ok(existsSync(join(ordner, "hochladen.json")));
    assert.ok(!readFileSync(join(ordner, "hochladen.json"), "utf8").includes("111111111111111111"), "keine Discord-Kennung auf der Platte");
    assert.ok(!existsSync(join(ordner, "02-b.opus")), "Spur ohne Zustimmung gelöscht");
    assert.ok(n.aufrufe.some((a) => a.methode === "DELETE" && a.pfad.endsWith("/tracks/att-b")));
    // Zweiter Versuch: fehlende Teile abfragen (keine), Abschluss klappt → Ordner weg, „angekommen“.
    await h.versuchen(ordner);
    assert.ok(!existsSync(ordner));
    assert.deepEqual(meldungen, ["angekommen"]);
  });
  it("verworfene Spuren (track_invalid) fallen weg, Abschluss läuft mit den übrigen weiter; upload_closed → Ordner weg", async () => {
    const wurzel = mkdtempSync(join(tmpdir(), "hochladen-"));
    const ordner = join(wurzel, "runde");
    await mkdir(ordner);
    writeFileSync(join(ordner, "01-a.twse"), Buffer.alloc(10, 1));
    writeFileSync(join(ordner, "02-b.twse"), Buffer.alloc(10, 2));
    let abschluesse = 0;
    const n = nachbau((a) => {
      if (a.pfad.endsWith("/readiness")) return { status: 200, body: { states: { "111111111111111111": { state: "ready" }, "222222222222222222": { state: "ready" } } } };
      if (a.pfad === "/sessions/s1/uploads") {
        const files = (a.koerper as { files: { mimeType: string; fileName: string }[] }).files;
        assert.ok(files.every((f) => f.mimeType === "application/vnd.taleward.spur-verschluesselt" && f.fileName.endsWith(".twse")));
        return { status: 201, body: { uploadId: "u1", chunkSizeBytes: 4096, files: [{ fileId: "f1", fileName: "01-a.twse", chunkCount: 1 }, { fileId: "f2", fileName: "02-b.twse", chunkCount: 1 }] } };
      }
      if (a.pfad.includes("/chunks/")) return { status: 204 };
      if (a.pfad === "/uploads/u1/complete") {
        abschluesse++;
        if (abschluesse === 1) return { status: 400, body: { code: "track_invalid", message: "kaputt", details: { attendeeIds: ["att-b"] } } };
        return { status: 202, body: {} };
      }
      return { status: 500, body: { code: "x", message: "y" } };
    });
    const an = new ServerAnbindung(new TalewardServer("https://srv", "geheim-geheim-geheim-geheim", n.holen));
    const meldungen: string[] = [];
    const h = new Hochlader(an, wurzel, async (_o, art) => void meldungen.push(art));
    await h.nachEnde({
      dauerMs: 1000,
      spuren: [
        { datei: "01-a.twse", attendeeId: "att-a", discordId: "111111111111111111" },
        { datei: "02-b.twse", attendeeId: "att-b", discordId: "222222222222222222" },
      ],
      ordner,
      sessionId: "s1",
      kontext: { kampagneId: "k1", titel: "t", sprache: "de" as const, pauseOhneZustimmung: false, laufendeRunde: null },
      beginn: Date.now(),
      grund: "stopp" as const,
    });
    assert.equal(abschluesse, 2);
    assert.ok(!existsSync(ordner));
    assert.deepEqual(meldungen, ["angekommen"]);

    // Upload geschlossen: Ordner weg, Hinweis „nicht angekommen“, kein 24-Stunden-Wiederholen.
    const ordner2 = join(wurzel, "zu");
    await mkdir(ordner2);
    writeFileSync(join(ordner2, "01-a.twse"), Buffer.alloc(10, 1));
    writeFileSync(join(ordner2, "hochladen.json"), JSON.stringify({ sessionId: "s1", kampagneId: "k1", sprache: "de", beginn: Date.now(), spuren: [{ datei: "01-a.twse", attendeeId: "att-a" }], uploadId: "u2", dateien: { "01-a.twse": "f1" }, teilgroesse: 4096, versuche: 1 }));
    const n2 = nachbau((a) => {
      if (a.pfad === "/uploads/u2" && a.methode === "GET") return { status: 200, body: { files: [{ fileId: "f1", missingChunks: [] }] } };
      if (a.pfad === "/uploads/u2/complete") return { status: 409, body: { code: "upload_closed", message: "zu" } };
      return { status: 500, body: { code: "x", message: "y" } };
    });
    const h2 = new Hochlader(new ServerAnbindung(new TalewardServer("https://srv", "geheim-geheim-geheim-geheim", n2.holen)), wurzel, async (_o, art) => void meldungen.push(art));
    await h2.versuchen(ordner2);
    assert.ok(!existsSync(ordner2));
    assert.deepEqual(meldungen, ["angekommen", "hochladen_fehlt"]);
  });
  it("löscht Ordner nach 24 Stunden ohne Erfolg", async () => {
    const wurzel = mkdtempSync(join(tmpdir(), "hochladen-"));
    const ordner = join(wurzel, "alt");
    await mkdir(ordner);
    writeFileSync(join(ordner, "hochladen.json"), JSON.stringify({ sessionId: "s1", kampagneId: "k1", sprache: "de", beginn: 0, spuren: [], versuche: 3 }));
    const n = nachbau(() => ({ status: 500, body: { code: "x", message: "y" } }));
    const an = new ServerAnbindung(new TalewardServer("https://srv", "geheim-geheim-geheim-geheim", n.holen));
    const meldungen: string[] = [];
    const h = new Hochlader(an, wurzel, async (_o, art) => void meldungen.push(art), () => 25 * 3_600_000);
    await h.versuchen(ordner);
    assert.ok(!existsSync(ordner));
    assert.deepEqual(meldungen, ["hochladen_fehlt"]);
    assert.equal(n.aufrufe.length, 0);
  });
});
