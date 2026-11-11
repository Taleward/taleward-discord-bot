import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { befehlsDefinitionen } from "../dist/befehle.js";
import { FaqQuelle, faqFinden, faqParsen, faqVorschlaege, kuerzen } from "../dist/helfer/faq.js";
import { fassungAusTag, freigegebeneFassung, sauber, serverStandParsen, statusText } from "../dist/helfer/status.js";
import { konfigurationLaden } from "../dist/konfiguration.js";
import { spracheAus, t, texte } from "../dist/texte/texte.js";

describe("texte", () => {
  it("hat alle Schlüssel in beiden Sprachen", () => {
    assert.deepEqual(Object.keys(texte.en).sort(), Object.keys(texte.de).sort());
    for (const s of Object.keys(texte.de) as (keyof typeof texte.de)[]) {
      assert.notEqual(texte.en[s].trim(), "");
      assert.notEqual(texte.de[s].trim(), "");
    }
  });
  it("hält den Ton: keine Ausrufezeichen, keine Emojis", () => {
    for (const sprache of ["de", "en"] as const) {
      for (const [k, v] of Object.entries(texte[sprache])) {
        assert.doesNotMatch(v, /!/, `${sprache}.${k}`);
        assert.doesNotMatch(v, /\p{Extended_Pictographic}/u, `${sprache}.${k}`);
      }
    }
  });
  it("setzt Platzhalter ein", () => {
    assert.equal(t("de", "faq_mehr", { url: "https://x" }), "Mehr dazu auf der Website: https://x");
    assert.equal(t("en", "faq_mehr", { url: "https://x" }), "More on the website: https://x");
  });
  it("wählt die Sprache nach Discord-Locale", () => {
    assert.equal(spracheAus("de"), "de");
    assert.equal(spracheAus("en-GB"), "en");
    assert.equal(spracheAus(undefined), "en");
    assert.equal(spracheAus("fr"), "en");
  });
});

describe("faq", () => {
  const roh = {
    de: [
      { id: "kosten", frage: "Was kostet Taleward?", antwort: "Nichts, außer der Verarbeitung.", link: "https://taleward.org/kosten" },
      { id: "böse", frage: "x", antwort: "y" },
      { id: "ohne", frage: "", antwort: "y" },
      { id: "link", frage: "Link?", antwort: "a", link: "javascript:alert(1)" },
      { id: "kosten", frage: "Doppelt", antwort: "z" },
    ],
    en: [{ id: "kosten", frage: "What does Taleward cost?", antwort: "Nothing, except processing." }],
  };
  it("übernimmt nur saubere Einträge", () => {
    const d = faqParsen(roh);
    assert.deepEqual(d.de.map((e) => e.id), ["kosten", "link"]);
    assert.equal(d.de[0]?.link, "https://taleward.org/kosten");
    assert.equal(d.de[1]?.link, undefined);
    assert.equal(d.en.length, 1);
  });
  it("verträgt Unsinn", () => {
    assert.deepEqual(faqParsen(null), { de: [], en: [] });
    assert.deepEqual(faqParsen("x"), { de: [], en: [] });
    assert.deepEqual(faqParsen({ de: "x" }), { de: [], en: [] });
  });
  it("schlägt vor und findet, mit Rückfall auf die andere Sprache", () => {
    const d = faqParsen(roh);
    assert.deepEqual(faqVorschlaege(d, "de", "kost").map((e) => e.id), ["kosten"]);
    assert.deepEqual(faqVorschlaege(d, "en", "").map((e) => e.id), ["kosten"]);
    assert.equal(faqFinden(d, "en", "link")?.frage, "Link?");
    assert.equal(faqFinden(d, "de", "gibtsnicht"), undefined);
  });
  it("kürzt lange Texte", () => {
    assert.equal(kuerzen("abcdef", 4), "ab …");
    assert.equal(kuerzen("abc", 4), "abc");
  });
  it("behält die letzte gute Fassung, wenn das Laden scheitert", async () => {
    let antworten = 0;
    const holen = (async () => {
      antworten++;
      if (antworten === 1) return new Response(JSON.stringify(roh), { status: 200 });
      return new Response("kaputt", { status: 500 });
    }) as unknown as typeof fetch;
    const q = new FaqQuelle("https://example.org/faq.json", 0, holen);
    assert.equal((await q.aktuell()).de.length, 2);
    assert.equal((await q.aktuell()).de.length, 2);
    assert.equal(antworten, 2);
  });
});

describe("status", () => {
  it("liest Fassungen aus Tags", () => {
    assert.equal(fassungAusTag("v0.4.118"), "0.4.118");
    assert.equal(fassungAusTag("worker-v0.3.21"), "0.3.21");
    assert.equal(fassungAusTag("box-v1.0.0"), undefined);
    assert.equal(fassungAusTag(3), undefined);
  });
  it("nimmt nur freigegebene Releases, das neueste zuerst", () => {
    const releases = [
      { tag_name: "v0.4.120", draft: false, prerelease: false, published_at: "2026-10-23T10:00:00Z", assets: [] },
      { tag_name: "v0.4.119", draft: false, prerelease: false, published_at: "2026-10-22T10:00:00Z", assets: [{ name: "freigabe.txt" }] },
      { tag_name: "v0.4.121", draft: false, prerelease: true, published_at: "2026-10-24T10:00:00Z", assets: [{ name: "freigabe.txt" }] },
      { tag_name: "v0.4.118", draft: false, prerelease: false, published_at: "2026-10-21T10:00:00Z", assets: [{ name: "freigabe.txt" }] },
    ];
    assert.equal(freigegebeneFassung(releases), "0.4.119");
    assert.equal(freigegebeneFassung([]), undefined);
    assert.equal(freigegebeneFassung({}), undefined);
  });
  it("säubert Fremdtext", () => {
    assert.equal(sauber("Hallo @everyone **fett** ​⁦x⁩", 100), "Hallo everyone fett x");
    assert.equal(sauber("abcdefgh", 4), "abc…");
  });
  it("liest den Serverstand", () => {
    assert.deepEqual(serverStandParsen({ name: "Taleward", apiVersion: "0.4.22" }), { erreichbar: true, name: "Taleward", apiVersion: "0.4.22" });
    assert.deepEqual(serverStandParsen({ name: 1, apiVersion: "x" }), { erreichbar: true });
  });
  it("baut den Statustext", () => {
    const text = statusText("de", { erreichbar: true, name: "Taleward", apiVersion: "0.4.22" }, { app: "0.28.5", server: "0.4.118" });
    assert.match(text, /Server Taleward: erreichbar, Schnittstelle 0\.4\.22/);
    assert.match(text, /App: 0\.28\.5/);
    assert.match(text, /Worker: Fassung gerade nicht abrufbar/);
    assert.match(statusText("en", { erreichbar: false }, {}), /not reachable/);
  });
});

describe("befehle", () => {
  it("sind vier, alle mit deutschen und englischen Beschreibungen", () => {
    const defs = befehlsDefinitionen();
    assert.deepEqual(defs.map((d) => d.name), ["faq", "taleward-status", "feedback", "tester-knopf"]);
    for (const d of defs) {
      assert.ok(d.description_localizations?.de);
      assert.ok(d.description_localizations?.["en-US"]);
    }
  });
});

describe("konfiguration", () => {
  const basis = {
    DISCORD_TOKEN: "abc",
    DISCORD_ANWENDUNG_ID: "123456789012345678",
    DISCORD_HEIM_GILDE: "123456789012345678",
    DISCORD_TESTER_ROLLE: "123456789012345678",
    DISCORD_RUECKMELDUNG_KANAL: "123456789012345678",
  };
  it("lädt mit Standardwerten", () => {
    const k = konfigurationLaden(basis);
    assert.equal(k.serverUrl, "https://taleward.taleward.org");
    assert.equal(k.faqUrl, "https://taleward.org/faq.json");
    assert.equal(k.faqSeite.de, "https://taleward.org/fuer-gruppen/#faq");
    assert.equal(k.testerSeite.en, "https://taleward.org/en/pilot-tables/");
  });
  it("Helfer sind freiwillig: ohne DISCORD_HEIM_GILDE nur /taleward mit Server", () => {
    const { DISCORD_HEIM_GILDE: _g, DISCORD_TESTER_ROLLE: _r, DISCORD_RUECKMELDUNG_KANAL: _k, ...ohne } = basis;
    assert.throws(() => konfigurationLaden(ohne), /DISCORD_HEIM_GILDE.*TALEWARD_BOT_SCHLUESSEL/);
    const k = konfigurationLaden({ ...ohne, TALEWARD_BOT_SCHLUESSEL: "a".repeat(40), TALEWARD_SERVER_URL: "https://taleward.beispiel.de" });
    assert.equal(k.helfer, undefined);
    assert.equal(k.aufnahme?.botSchluessel, "a".repeat(40));
    assert.equal(konfigurationLaden(basis).helfer?.heimGilde, basis.DISCORD_HEIM_GILDE);
    // Mit Gilde müssen Rolle und Kanal dabei sein.
    assert.throws(() => konfigurationLaden({ ...ohne, DISCORD_HEIM_GILDE: basis.DISCORD_HEIM_GILDE, TALEWARD_BOT_SCHLUESSEL: "a".repeat(40), TALEWARD_SERVER_URL: "https://taleward.beispiel.de" }), /DISCORD_TESTER_ROLLE/);
  });
  it("lehnt Fehlendes und Unsicheres ab", () => {
    assert.throws(() => konfigurationLaden({ ...basis, DISCORD_TOKEN: "" }), /DISCORD_TOKEN/);
    assert.throws(() => konfigurationLaden({ ...basis, DISCORD_HEIM_GILDE: "abc" }), /Kennung/);
    assert.throws(() => konfigurationLaden({ ...basis, TALEWARD_SERVER_URL: "http://x" }), /https/);
    assert.throws(() => konfigurationLaden({ ...basis, TALEWARD_SERVER_URL: "https://a:b@x" }), /Zugangsdaten/);
  });
});
