import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { befehlsDefinitionen } from "../dist/befehle.js";
import { konfigurationLaden } from "../dist/konfiguration.js";
import { BEREITSCHAFT_HOECHSTALTER_MS, SERVER_ENDE_MS, bereitschaftVeraltet, dateiname, ohneStandEntscheiden, ohneZustimmungEntscheiden, dauerText, loeschfrist, oggPakete, ordnername } from "../dist/aufnahme/aufnahme.js";
import { OpusSpur, PAKET_SAMPLES, STILLE, dateiZiel, oggCrc, oggSeite, opusHead } from "../dist/aufnahme/ogg.js";
import { TON_PAUSE, TON_START, TON_STOPP, TON_WEITER } from "../dist/aufnahme/toene.js";
import { Wache } from "../dist/aufnahme/wache.js";
import { ListenAnbindung, ServerAnbindung, bereitschaftsFehlerArt } from "../dist/aufnahme/anbindung.js";
import { Bremse } from "../dist/aufnahme/bremse.js";
import { ServerFehler, TalewardServer } from "../dist/server/client.js";
import { Aufnahmen, oeffentlichMitRueckfall, startDurchfuehren, talewardKnopf } from "../dist/aufnahme/befehle.js";

const basis = {
  DISCORD_TOKEN: "abc",
  DISCORD_ANWENDUNG_ID: "123456789012345678",
  DISCORD_HEIM_GILDE: "123456789012345678",
  DISCORD_TESTER_ROLLE: "123456789012345678",
  DISCORD_RUECKMELDUNG_KANAL: "123456789012345678",
};

function ffprobeVorhanden(): boolean {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("ogg", () => {
  it("rechnet die Ogg-Prüfsumme wie der Standard", () => {
    // Bekannter Wert: CRC des leeren Puffers ist 0; eine Seite mit nur Kopf ist konsistent.
    assert.equal(oggCrc(Buffer.alloc(0)), 0);
    const seite = oggSeite([opusHead(2)], 7, 0, 0n, 0x02);
    const gespeichert = seite.readUInt32LE(22);
    seite.writeUInt32LE(0, 22);
    assert.equal(oggCrc(seite), gespeichert);
  });
  it("füllt Lücken mit Stille und zählt die Zeit in Paketen", async () => {
    const teile: Buffer[] = [];
    const spur = new OpusSpur({ write: (d) => void teile.push(d), end: (f) => f?.() }, 3, 2, { TITLE: "Test" });
    spur.paket(Buffer.from([1, 2, 3]), 0);
    spur.paket(Buffer.from([4, 5, 6]), 100); // 5 Pakete später -> 4 Stille dazwischen
    spur.stilleBis(1000);
    await spur.beenden();
    assert.equal(spur.pakete, 50);
    assert.equal(spur.echtePakete, 2);
    const datei = Buffer.concat(teile);
    assert.equal(datei.subarray(0, 4).toString("ascii"), "OggS");
    assert.ok(datei.includes(Buffer.from("OpusHead")));
    assert.ok(datei.includes(Buffer.from("TITLE=Test")));
    assert.ok(datei.includes(STILLE));
    // Letzte Seite trägt das Ende-Bit und die Gesamtzahl der Samples.
    const letzte = datei.lastIndexOf(Buffer.from("OggS"));
    assert.equal(datei.readUInt8(letzte + 5) & 0x04, 0x04);
    assert.equal(datei.readBigInt64LE(letzte + 6), BigInt(50 * PAKET_SAMPLES));
  });
  it("schreibt eine Datei, die ffprobe als Opus mit der richtigen Länge liest", async (tk) => {
    if (!ffprobeVorhanden()) return tk.skip("kein ffprobe");
    const ordner = mkdtempSync(join(tmpdir(), "probe-"));
    const pfad = join(ordner, "x.opus");
    const spur = new OpusSpur(dateiZiel(pfad), 9, 2, { TITLE: "Länge" });
    // Echte Pakete aus dem Startton, dann Stille bis 3 s.
    const pakete = await oggPakete(TON_START);
    let z = 500;
    for (const p of pakete) {
      spur.paket(p, z);
      z += 20;
    }
    spur.stilleBis(4000);
    await spur.beenden();
    const aus = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,channels", "-of", "json", pfad]).toString();
    const info = JSON.parse(aus);
    assert.equal(info.streams[0].codec_name, "opus");
    assert.equal(info.streams[0].channels, 2);
    assert.ok(Math.abs(Number(info.format.duration) - 4.0) < 0.1, `Dauer ${info.format.duration}`);
  });
  it("liest die Pakete der vier Töne (20 ms je Paket)", async () => {
    for (const [name, ton, sekunden] of [["start", TON_START, 2.2], ["pause", TON_PAUSE, 1.6], ["weiter", TON_WEITER, 1.6], ["stopp", TON_STOPP, 2.4]] as const) {
      const pakete = await oggPakete(ton);
      assert.ok(Math.abs(pakete.length * 0.02 - sekunden) < 0.1, `${name}: ${pakete.length} Pakete`);
    }
  });
});

describe("aufnahme", () => {
  it("bildet sichere Dateinamen", () => {
    assert.equal(dateiname("Jörg Müller-Lüdenscheidt", 3), "03-jorg-muller-ludenscheidt.opus");
    assert.equal(dateiname("@everyone ../../x", 1), "01-everyone-x.opus");
    assert.equal(dateiname("日本", 12), "12-person.opus");
  });
  it("nennt Ordner nach Zeit und rechnet Dauern", () => {
    assert.match(ordnername(new Date(2026, 9, 24, 19, 5)), /^2026-10-24_19-05$/);
    assert.deepEqual(dauerText(3 * 3600_000 + 7 * 60_000 + 59_000), { h: "3", m: "7" });
    assert.equal(loeschfrist(new Date(2026, 9, 24, 19, 5)), "07.11.2026");
  });
  it("ist ohne AUFNAHME_LEITUNG aus und prüft die Liste (alte Namen PROBE_* gelten weiter)", () => {
    assert.equal(konfigurationLaden(basis).aufnahme, undefined);
    const k = konfigurationLaden({ ...basis, AUFNAHME_LEITUNG: "111111111111111111", AUFNAHME_TEILNEHMER: "222222222222222222, 333333333333333333 222222222222222222" });
    assert.deepEqual(k.aufnahme?.teilnehmer, ["222222222222222222", "333333333333333333"]);
    assert.equal(k.aufnahme?.ordner, "/aufnahmen");
    const alt = konfigurationLaden({ ...basis, PROBE_LEITUNG: "111111111111111111", PROBE_TEILNEHMER: "222222222222222222" });
    assert.equal(alt.aufnahme?.leitung, "111111111111111111");
    assert.throws(() => konfigurationLaden({ ...basis, AUFNAHME_LEITUNG: "111111111111111111" }), /AUFNAHME_TEILNEHMER/);
    assert.throws(() => konfigurationLaden({ ...basis, AUFNAHME_LEITUNG: "111111111111111111", AUFNAHME_TEILNEHMER: "abc" }), /Kennung/);
    const viele = Array.from({ length: 13 }, (_, i) => String(100000000000000000n + BigInt(i))).join(",");
    assert.throws(() => konfigurationLaden({ ...basis, AUFNAHME_LEITUNG: "111111111111111111", AUFNAHME_TEILNEHMER: viele }), /höchstens 12/);
    assert.throws(() => konfigurationLaden({ ...basis, AUFNAHME_LEITUNG: "111111111111111111", AUFNAHME_TEILNEHMER: "222222222222222222", AUFNAHME_ORDNER: "rel" }), /absoluter/);
    const mitServer = { ...basis, TALEWARD_SERVER_URL: "https://taleward.beispiel.de/" };
    const server = konfigurationLaden({ ...mitServer, TALEWARD_BOT_SCHLUESSEL: "abcdefghijklmnopqrstuvwxyz" });
    assert.equal(server.aufnahme?.botSchluessel, "abcdefghijklmnopqrstuvwxyz");
    assert.equal(server.aufnahme?.leitung, undefined);
    assert.equal(server.serverUrl, "https://taleward.beispiel.de");
    assert.throws(() => konfigurationLaden({ ...mitServer, TALEWARD_BOT_SCHLUESSEL: "kurz" }), /zu kurz/);
    assert.throws(() => konfigurationLaden({ ...mitServer, TALEWARD_BOT_SCHLUESSEL: "abcdefghijklmnopqrstuvwxyz", AUFNAHME_LEITUNG: "111111111111111111", AUFNAHME_TEILNEHMER: "222222222222222222" }), /nicht beides/);
  });
  it("D6 – mit Bot-Schlüssel ist die Serveradresse Pflicht, kein Rückfall auf einen fremden Server", () => {
    const schluessel = "abcdefghijklmnopqrstuvwxyz";
    assert.throws(() => konfigurationLaden({ ...basis, TALEWARD_BOT_SCHLUESSEL: schluessel }), /TALEWARD_SERVER_URL.*ausgestellt/);
    assert.throws(() => konfigurationLaden({ ...basis, TALEWARD_BOT_SCHLUESSEL: schluessel, TALEWARD_SERVER_URL: "  " }), /TALEWARD_SERVER_URL/);
    assert.throws(() => konfigurationLaden({ ...basis, TALEWARD_BOT_SCHLUESSEL: schluessel, TALEWARD_SERVER_URL: "http://taleward.beispiel.de" }), /https/);
    // Ohne Bot-Schlüssel (Helfer, Testmodus) bleibt der Standard für die Anzeige.
    assert.equal(konfigurationLaden(basis).serverUrl, "https://taleward.taleward.org");
    assert.equal(konfigurationLaden({ ...basis, AUFNAHME_LEITUNG: "111111111111111111", AUFNAHME_TEILNEHMER: "222222222222222222" }).serverUrl, "https://taleward.taleward.org");
  });
  it("registriert /taleward nur, wenn die Aufnahme eingerichtet ist, mit allen Unterbefehlen in beiden Sprachen", () => {
    assert.deepEqual(befehlsDefinitionen().map((d) => d.name), ["faq", "taleward-status", "feedback", "tester-knopf"]);
    const mit = befehlsDefinitionen(true);
    assert.equal(mit.at(-1)?.name, "taleward");
    const unter = (mit.at(-1)?.options ?? []) as { name: string; name_localizations?: Record<string, string>; description_localizations?: Record<string, string> }[];
    assert.deepEqual(unter.map((o) => o.name), ["link", "unlink", "ready", "join", "leave", "start", "pause", "resume", "stop", "discard", "mark", "status", "help"]);
    assert.deepEqual(unter.map((o) => o.name_localizations?.de), ["verbinden", "trennen", "bereit", "beitreten", "verlassen", "start", "pause", "weiter", "stopp", "verwerfen", "merken", "status", "hilfe"]);
    for (const o of unter) assert.ok(o.description_localizations?.de && o.description_localizations?.["en-US"], o.name);
  });
  it("Listen-Anbindung: nur die Leitung leitet, nur Gelistete sind bereit, keine Runde", async () => {
    const q = new ListenAnbindung("1", ["2", "3"]);
    assert.equal((await q.kampagnen("g", "1")).length, 1);
    assert.equal((await q.kampagnen("g", "2")).length, 0);
    const k = (await q.kampagnen("g", "1"))[0]!;
    const b = await q.bereitschaft(k, ["2", "4"]);
    assert.equal(b.states.get("2")?.state, "ready");
    assert.equal(b.states.get("4")?.state, "consent_required");
    assert.equal(await q.rundeAnlegen(k, "g", "1", new Date()), undefined);
    assert.equal(await q.anwesend(undefined, "2"), "2");
    assert.equal(await q.anwesend(undefined, "4"), undefined);
  });
  it("Wache: Leitung weg → Pause, nach 5 min Ende; zurück → weiter; leer 5 min → Ende; 6 h → Ende", () => {
    const min = 60_000;
    const lage = (jetzt: number, leitungDa: boolean, jemandDa: boolean, pausiert: boolean, pauseDurchWache = pausiert) => ({ jetzt, beginn: 0, leitungDa, jemandDa, pausiert, pauseDurchWache });
    const w = new Wache();
    assert.equal(w.pruefen(lage(1 * min, true, true, false)), "nichts");
    assert.equal(w.pruefen(lage(2 * min, false, true, false)), "pause_leitung");
    assert.equal(w.pruefen(lage(4 * min, false, true, true)), "nichts");
    assert.equal(w.pruefen(lage(7 * min, false, true, true)), "ende_leitung");
    const w2 = new Wache();
    assert.equal(w2.pruefen(lage(2 * min, false, true, false)), "pause_leitung");
    assert.equal(w2.pruefen(lage(3 * min, true, true, true)), "weiter_leitung");
    assert.equal(w2.pruefen(lage(4 * min, true, true, true, false)), "nichts"); // Pause von Hand bleibt
    const w3 = new Wache();
    assert.equal(w3.pruefen(lage(10 * min, true, false, false)), "nichts");
    assert.equal(w3.pruefen(lage(16 * min, true, false, false)), "ende_leer");
    assert.equal(new Wache().pruefen(lage(6 * 60 * min, true, true, false)), "ende_dauer");
  });
});

describe("D4 – Liste im Kanal mit Rückfall", () => {
  it("nimmt die Kanalnachricht, sonst die öffentliche Antwort, sonst nichts", async () => {
    const m = { id: "m" } as unknown as import("discord.js").Message;
    assert.equal(await oeffentlichMitRueckfall(async () => m, async () => undefined), m);
    assert.equal(
      await oeffentlichMitRueckfall(
        async () => {
          throw new Error("Missing Permissions");
        },
        async () => m,
      ),
      m,
    );
    assert.equal(
      await oeffentlichMitRueckfall(
        async () => {
          throw new Error("Missing Permissions");
        },
        async () => {
          throw new Error("Unknown Webhook");
        },
      ),
      undefined,
    );
  });
});

describe("D4 – Start ohne Schreibrecht", () => {
  function aufbau(kanalSendet: boolean, antwortSendet: boolean, startOk = true) {
    const aufrufe: string[] = [];
    const eintrag = {
      aufnahme: {
        start: async () => (startOk ? { ok: true, namen: ["Ava"], offen: ["Ben"], loeschenBis: "x", sessionId: "s1" } : { ok: false, grund: "niemand" }),
        beenden: async (grund: string) => {
          aufrufe.push(`beenden:${grund}`);
          return { dauerMs: 1 };
        },
      },
      melder: { setzen: () => aufrufe.push("melder") },
    };
    const kanal = {
      send: async () => {
        aufrufe.push("kanal.send");
        if (!kanalSendet) throw new Error("Missing Permissions");
        return { id: "k" };
      },
    };
    const fehler: string[] = [];
    const oeffentlich = async () => {
      aufrufe.push("antwort");
      if (!antwortSendet) throw new Error("kaputt");
      return { id: "a" };
    };
    const konf = { maxPersonen: 12 };
    const kontext = { kampagneId: "k1", titel: "T", sprache: "de", pauseOhneZustimmung: false, laufendeRunde: null };
    const lauf = () =>
      startDurchfuehren(
        eintrag as never,
        { art: "server" } as never,
        konf as never,
        kontext as never,
        kanal as never,
        {} as never,
        "1",
        "de",
        async (inhalt: string) => void fehler.push(inhalt),
        oeffentlich as never,
        async () => void aufrufe.push("vorbereiten"),
      );
    return { lauf, aufrufe, fehler };
  }
  it("Kanal verweigert → Liste als öffentliche Antwort, Aufnahme läuft weiter", async () => {
    const t = aufbau(false, true);
    await t.lauf();
    assert.ok(t.aufrufe.includes("melder"));
    assert.ok(!t.aufrufe.some((a) => a.startsWith("beenden")));
    assert.deepEqual(t.fehler, []);
    // D4.1: Die Antwort der SL wird vor der ersten Folgenachricht bearbeitet; Liste und „Noch offen“ jeweils erst Kanal, dann Antwort.
    assert.deepEqual(t.aufrufe.filter((a) => a !== "melder"), ["vorbereiten", "kanal.send", "antwort", "kanal.send", "antwort"]);
  });
  it("F4: scheitert der Start, bleibt der Fehlertext stehen (Rückgabe false, keine Vorbereitung)", async () => {
    const t = aufbau(true, true, false);
    assert.equal(await t.lauf(), false);
    assert.equal(t.fehler.length, 1);
    assert.deepEqual(t.aufrufe, []);
  });
  it("Erfolg liefert true", async () => {
    const t = aufbau(true, true);
    assert.equal(await t.lauf(), true);
  });
  it("beides verweigert → Aufnahme verworfen, Hinweis an die Spielleitung", async () => {
    const t = aufbau(false, false);
    assert.equal(await t.lauf(), false);
    assert.ok(t.aufrufe.includes("beenden:verwerfen"));
    assert.ok(!t.aufrufe.includes("melder"));
    assert.equal(t.fehler.length, 1);
    assert.match(t.fehler[0]!, /nicht schreiben/);
  });
});

describe("D5 – Bremse vor dem Server", () => {
  it("zählt je Person, je Discord-Server und insgesamt in einem gleitenden Fenster", () => {
    let t = 0;
    const b = new Bremse({ jePerson: 2, jeGilde: 3, gesamt: 4, fensterMs: 1000 }, () => t);
    assert.equal(b.pruefen("g1", "u1"), "frei");
    assert.equal(b.pruefen("g1", "u1"), "frei");
    assert.equal(b.pruefen("g1", "u1"), "person");
    assert.equal(b.pruefen("g1", "u2"), "frei");
    assert.equal(b.pruefen("g1", "u3"), "gilde");
    assert.equal(b.pruefen("g2", "u4"), "frei");
    assert.equal(b.pruefen("g2", "u5"), "gesamt");
    t = 1001; // Fenster vorbei
    assert.equal(b.pruefen("g1", "u1"), "frei");
  });
  it("Testmodus bremst nicht, Server-Betrieb bremst ab der 11. Anfrage einer Person", () => {
    const konf = { ordner: mkdtempSync(join(tmpdir(), "bremse-")), maxPersonen: 12, minFreiGb: 0 } as never;
    const listen = new Aufnahmen(konf, new ListenAnbindung("1", ["2"]));
    for (let i = 0; i < 20; i++) assert.equal(listen.darf("g", "u"), true);
    const server = new Aufnahmen(konf, new ServerAnbindung(new TalewardServer("https://srv", "geheim-geheim-geheim-geheim", async () => new Response(null, { status: 500 }))));
    for (let i = 0; i < 10; i++) assert.equal(server.darf("g", "u"), true);
    assert.equal(server.darf("g", "u"), false);
    assert.equal(server.darf("g", "andere"), true);
    listen.hochlader.beenden();
    server.hochlader.beenden();
  });
  it("429 bei der Bereitschaft ist eine Bremse, kein „Server weg“", () => {
    assert.equal(bereitschaftsFehlerArt(new ServerFehler(429, "rate_limited", "zu viele")), "ratenlimit");
    assert.equal(bereitschaftsFehlerArt(new ServerFehler(503, "unavailable", "weg")), "weg");
    assert.equal(bereitschaftsFehlerArt(new TypeError("fetch failed")), "weg");
  });
});

describe("D5.1 – Alter des Zustimmungsstands", () => {
  it("älter als 60 s gilt als veraltet; mit Blick auf den nächsten Takt schon vorher", () => {
    assert.equal(BEREITSCHAFT_HOECHSTALTER_MS, 60_000);
    assert.equal(bereitschaftVeraltet(1_000_000, 1_000_000 + 59_000), false);
    assert.equal(bereitschaftVeraltet(1_000_000, 1_000_000 + 60_000), false);
    assert.equal(bereitschaftVeraltet(1_000_000, 1_000_000 + 60_001), true);
    // Takt alle 30 s: bei 30 s wäre der Stand beim nächsten Takt genau 60 s alt (noch gültig), bei 60 s wäre er 90 s alt.
    assert.equal(bereitschaftVeraltet(1_000_000, 1_000_000 + 30_000, 60_000, 30_000), false);
    assert.equal(bereitschaftVeraltet(1_000_000, 1_000_000 + 60_000, 60_000, 30_000), true);
  });
  it("Takte ohne frischen Stand (429 oder Server weg): Pause spätestens bei 60 s, nicht erst bei 90 s; Ende nach 30 min", () => {
    const stand = 1_000_000;
    const takt = 30_000;
    assert.equal(ohneStandEntscheiden(stand, stand + takt, takt, false), "weiter");
    assert.equal(ohneStandEntscheiden(stand, stand + 2 * takt, takt, false), "pause");
    assert.equal(ohneStandEntscheiden(stand, stand + 2 * takt + 1_000, takt, false), "pause");
    // Läuft die Pause schon, bleibt es dabei, bis ein frischer Stand kommt oder die 30 min um sind.
    assert.equal(ohneStandEntscheiden(stand, stand + 3 * takt, takt, true), "weiter");
    assert.equal(ohneStandEntscheiden(stand, stand + SERVER_ENDE_MS - 1, takt, true), "weiter");
    assert.equal(ohneStandEntscheiden(stand, stand + SERVER_ENDE_MS, takt, true), "ende");
    assert.equal(ohneStandEntscheiden(stand, stand + SERVER_ENDE_MS, takt, false), "ende");
  });
  it("Knopf „Zustimmen“ während der Aufnahme fragt den Server nicht nach der Bereitschaft", async () => {
    let bereitschaftGefragt = 0;
    let linkGefragt = 0;
    const anbindung = {
      art: "server",
      bereitschaft: async () => {
        bereitschaftGefragt++;
        throw new Error("darf nicht gefragt werden");
      },
      zustimmungslink: async () => {
        linkGefragt++;
        return { url: "https://srv/discord/abc", code: "a-b-c" };
      },
    };
    const antworten: string[] = [];
    const interaktion = (userId: string) => ({
      locale: "de",
      guildId: "g",
      user: { id: userId, displayName: "Mira" },
      guild: { members: { cache: new Map() } },
      deferReply: async () => undefined,
      reply: async (x: { content: string }) => void antworten.push(x.content),
      editReply: async (x: { content: string }) => void antworten.push(x.content),
    });
    const staende = new Map([["schon", "ready"]]);
    const aufnahmen = {
      anbindung,
      darf: () => true,
      fuer: () => ({ aufnahme: { aktiv: { sessionId: "s1", leitungId: "sl" }, bereitschaftAusTakt: (id: string) => staende.get(id) } }),
    };
    await talewardKnopf(interaktion("schon") as never, aufnahmen as never);
    await talewardKnopf(interaktion("neu") as never, aufnahmen as never);
    assert.equal(bereitschaftGefragt, 0);
    assert.equal(linkGefragt, 1);
    assert.equal(antworten.length, 2);
    assert.match(antworten[0], /schon/i);
    assert.match(antworten[1], /https:\/\/srv\/discord\/abc/);
  });
});

describe("Kampagnen-Einstellung – anhalten, wenn jemand ohne Zustimmung dazukommt", () => {
  const z = new Set(["sl", "mira"]);
  it("aus: nie anhalten, Merkliste läuft trotzdem mit", () => {
    const r = ohneZustimmungEntscheiden({ aktiv: false, imKanal: ["sl", "mira", "gast"], zugestimmt: z, gemeldet: new Set(), pausiert: false, pauseDurchZustimmung: false });
    assert.equal(r.entscheidung, "nichts");
    assert.deepEqual([...r.gemeldet], []);
  });
  it("an: neue Person ohne Zustimmung → Pause, einmal; dieselbe Person im nächsten Takt → nichts", () => {
    const r1 = ohneZustimmungEntscheiden({ aktiv: true, imKanal: ["sl", "mira", "gast"], zugestimmt: z, gemeldet: new Set(), pausiert: false, pauseDurchZustimmung: false });
    assert.equal(r1.entscheidung, "pause");
    assert.deepEqual([...r1.gemeldet], ["gast"]);
    // Die SL hat von Hand fortgesetzt: keine zweite Pause für dieselbe Person.
    const r2 = ohneZustimmungEntscheiden({ aktiv: true, imKanal: ["sl", "mira", "gast"], zugestimmt: z, gemeldet: r1.gemeldet, pausiert: false, pauseDurchZustimmung: false });
    assert.equal(r2.entscheidung, "nichts");
    // Eine weitere neue Person → wieder Pause.
    const r3 = ohneZustimmungEntscheiden({ aktiv: true, imKanal: ["sl", "mira", "gast", "noch"], zugestimmt: z, gemeldet: r2.gemeldet, pausiert: false, pauseDurchZustimmung: false });
    assert.equal(r3.entscheidung, "pause");
    assert.deepEqual([...r3.gemeldet].sort(), ["gast", "noch"]);
  });
  it("weiter, sobald alle zugestimmt haben oder die Person weg ist – nur wenn die Pause von hier kam", () => {
    const g = new Set(["gast"]);
    const weg = ohneZustimmungEntscheiden({ aktiv: true, imKanal: ["sl", "mira"], zugestimmt: z, gemeldet: g, pausiert: true, pauseDurchZustimmung: true });
    assert.equal(weg.entscheidung, "weiter");
    assert.deepEqual([...weg.gemeldet], []);
    const zugestimmt = ohneZustimmungEntscheiden({ aktiv: true, imKanal: ["sl", "mira", "gast"], zugestimmt: new Set([...z, "gast"]), gemeldet: g, pausiert: true, pauseDurchZustimmung: true });
    assert.equal(zugestimmt.entscheidung, "weiter");
    // Pause von Hand oder durch die Wache: nicht von hier fortsetzen.
    const hand = ohneZustimmungEntscheiden({ aktiv: true, imKanal: ["sl", "mira"], zugestimmt: z, gemeldet: g, pausiert: true, pauseDurchZustimmung: false });
    assert.equal(hand.entscheidung, "nichts");
    // Noch jemand offen → keine Fortsetzung.
    const bleibt = ohneZustimmungEntscheiden({ aktiv: true, imKanal: ["sl", "mira", "gast"], zugestimmt: z, gemeldet: g, pausiert: true, pauseDurchZustimmung: true });
    assert.equal(bleibt.entscheidung, "nichts");
  });
  it("wer beim Start schon ohne Zustimmung da war, löst keine Pause aus (steht in „Noch offen“)", () => {
    const r = ohneZustimmungEntscheiden({ aktiv: true, imKanal: ["sl", "mira", "gast"], zugestimmt: z, gemeldet: new Set(["gast"]), pausiert: false, pauseDurchZustimmung: false });
    assert.equal(r.entscheidung, "nichts");
  });
  it("kommt jemand während einer Pause von Hand, wird er gemerkt, aber nicht noch einmal angehalten", () => {
    const r = ohneZustimmungEntscheiden({ aktiv: true, imKanal: ["sl", "mira", "gast"], zugestimmt: z, gemeldet: new Set(), pausiert: true, pauseDurchZustimmung: false });
    assert.equal(r.entscheidung, "nichts");
    assert.deepEqual([...r.gemeldet], ["gast"]);
  });
});
