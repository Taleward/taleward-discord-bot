// Bremse für Befehle vor dem Server (D5): Der Server begrenzt alle Anfragen eines Bot-Schlüssels gemeinsam. Damit
// Befehle von irgendeinem Discord-Server nicht die Anfragen laufender Aufnahmen anderer Gruppen verdrängen, zählt der
// Bot Befehle je Person, je Discord-Server und insgesamt; darüber gibt es nur einen Hinweis „kurz warten“ und keine
// Anfrage an den Server. Anfragen laufender Aufnahmen (Bereitschaft, Ereignisse, Widerruf, Hochladen) laufen nicht
// durch diese Bremse und behalten so ihren Teil der Grenze.

export interface BremsenGrenzen {
  /** Befehle je Person und Minute. */
  jePerson: number;
  /** Befehle je Discord-Server und Minute. */
  jeGilde: number;
  /** Befehle insgesamt je Minute – deutlich unter der Grenze des Servers je Bot-Schlüssel (600). */
  gesamt: number;
  fensterMs: number;
}

export const STANDARD_GRENZEN: BremsenGrenzen = { jePerson: 10, jeGilde: 30, gesamt: 300, fensterMs: 60_000 };

export type BremsErgebnis = "frei" | "person" | "gilde" | "gesamt";

/** Gleitendes Fenster je Schlüssel; alte Einträge fallen beim nächsten Blick heraus. */
export class Bremse {
  private readonly zeiten = new Map<string, number[]>();

  constructor(
    private readonly grenzen: BremsenGrenzen = STANDARD_GRENZEN,
    private readonly jetzt: () => number = Date.now,
  ) {}

  /** Prüft und zählt einen Befehl. „frei“ = darf zum Server; sonst, was voll ist. */
  pruefen(guildId: string, userId: string): BremsErgebnis {
    const t = this.jetzt();
    const person = this.frisch(`p:${userId}`, t);
    const gilde = this.frisch(`g:${guildId}`, t);
    const gesamt = this.frisch("*", t);
    if (person.length >= this.grenzen.jePerson) return "person";
    if (gilde.length >= this.grenzen.jeGilde) return "gilde";
    if (gesamt.length >= this.grenzen.gesamt) return "gesamt";
    person.push(t);
    gilde.push(t);
    gesamt.push(t);
    return "frei";
  }

  private frisch(schluessel: string, t: number): number[] {
    const alt = this.zeiten.get(schluessel) ?? [];
    const neu = alt.filter((z) => t - z < this.grenzen.fensterMs);
    this.zeiten.set(schluessel, neu);
    return neu;
  }

  /** Nur für Tests und Aufräumen. */
  leeren(): void {
    this.zeiten.clear();
  }
}
