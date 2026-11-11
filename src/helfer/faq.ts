// /faq: Fragen und Antworten aus der faq.json der Website.
// Quelle der Wahrheit bleibt die Website; der Bot zeigt nur an.
//
// Erwartetes Format der faq.json (liegt bei der Website, TALEWARD_FAQ_URL):
// {
//   "de": [ { "id": "kosten", "frage": "Was kostet Taleward?", "antwort": "…", "link": "https://taleward.org/…" } ],
//   "en": [ { "id": "kosten", "frage": "What does Taleward cost?", "antwort": "…", "link": "https://taleward.org/…" } ]
// }
// Gleiche ids in beiden Sprachen. "link" ist freiwillig.

import type { Sprache } from "../texte/texte.js";

export interface FaqEintrag {
  id: string;
  frage: string;
  antwort: string;
  link?: string;
}

export type FaqDaten = Record<Sprache, FaqEintrag[]>;

const ANTWORT_MAX = 1800; // Discord erlaubt 2000 Zeichen je Nachricht
const ID_MUSTER = /^[a-z0-9-]{1,64}$/;

/** Prüft fremde Daten streng. Unbrauchbare Einträge werden übersprungen, nicht übernommen. */
export function faqParsen(rohdaten: unknown): FaqDaten {
  const ergebnis: FaqDaten = { de: [], en: [] };
  if (typeof rohdaten !== "object" || rohdaten === null) return ergebnis;
  for (const sprache of ["de", "en"] as const) {
    const liste = (rohdaten as Record<string, unknown>)[sprache];
    if (!Array.isArray(liste)) continue;
    for (const e of liste) {
      if (typeof e !== "object" || e === null) continue;
      const { id, frage, antwort, link } = e as Record<string, unknown>;
      if (typeof id !== "string" || !ID_MUSTER.test(id)) continue;
      if (typeof frage !== "string" || frage.trim() === "" || frage.length > 100) continue;
      if (typeof antwort !== "string" || antwort.trim() === "") continue;
      const eintrag: FaqEintrag = { id, frage: frage.trim(), antwort: kuerzen(antwort.trim(), ANTWORT_MAX) };
      if (typeof link === "string" && /^https:\/\/[^\s<>"']+$/.test(link) && link.length <= 500) eintrag.link = link;
      if (ergebnis[sprache].some((x) => x.id === id)) continue;
      ergebnis[sprache].push(eintrag);
      if (ergebnis[sprache].length >= 100) break;
    }
  }
  return ergebnis;
}

export function kuerzen(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 2).trimEnd() + " …";
}

/** Vorschläge für die Autovervollständigung: höchstens 25, Treffer im Fragetext. */
export function faqVorschlaege(daten: FaqDaten, sprache: Sprache, eingabe: string): FaqEintrag[] {
  const suche = eingabe.trim().toLowerCase();
  const liste = daten[sprache].length > 0 ? daten[sprache] : daten[sprache === "de" ? "en" : "de"];
  const treffer = suche === "" ? liste : liste.filter((e) => e.frage.toLowerCase().includes(suche));
  return treffer.slice(0, 25);
}

export function faqFinden(daten: FaqDaten, sprache: Sprache, id: string): FaqEintrag | undefined {
  return daten[sprache].find((e) => e.id === id) ?? daten[sprache === "de" ? "en" : "de"].find((e) => e.id === id);
}

/** Lädt die faq.json mit Zwischenspeicher. Fehler liefern die letzte gute Fassung oder leere Listen. */
export class FaqQuelle {
  private daten: FaqDaten = { de: [], en: [] };
  private geladenUm = 0;

  constructor(
    private readonly url: string,
    private readonly haltbarkeitMs = 60 * 60 * 1000,
    private readonly holen: typeof fetch = fetch,
  ) {}

  async aktuell(): Promise<FaqDaten> {
    if (Date.now() - this.geladenUm < this.haltbarkeitMs) return this.daten;
    try {
      const antwort = await this.holen(this.url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
      const text = await antwort.text();
      if (text.length > 500_000) throw new Error("faq.json zu groß");
      const neu = faqParsen(JSON.parse(text));
      if (neu.de.length + neu.en.length > 0) this.daten = neu;
      this.geladenUm = Date.now();
    } catch (fehler) {
      console.warn("faq: konnte nicht laden:", fehler instanceof Error ? fehler.message : fehler);
      // Nächster Versuch frühestens in 10 Minuten, nicht bei jedem Befehl.
      this.geladenUm = Date.now() - this.haltbarkeitMs + 10 * 60 * 1000;
    }
    return this.daten;
  }
}
