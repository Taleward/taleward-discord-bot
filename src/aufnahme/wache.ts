// Die Wache entscheidet ohne Discord, was mit einer laufenden Aufnahme passiert:
// Spielleitung weg → Pause, nach 5 Minuten Ende; Kanal 5 Minuten leer → Ende; 6 Stunden → Ende.
// Reine Logik, damit sie sich ohne Sprachverbindung prüfen lässt.

export interface Lage {
  jetzt: number;
  beginn: number;
  /** Die Spielleitung ist im Kanal. */
  leitungDa: boolean;
  /** Mindestens eine Person außer dem Bot ist im Kanal. */
  jemandDa: boolean;
  pausiert: boolean;
  /** Die Pause wurde von der Wache ausgelöst (nicht von Hand). */
  pauseDurchWache: boolean;
}

export type Entscheidung = "nichts" | "pause_leitung" | "weiter_leitung" | "ende_leitung" | "ende_leer" | "ende_dauer";

export class Wache {
  private leitungWegSeit: number | undefined;
  private leerSeit: number | undefined;

  constructor(
    private readonly leitungFristMs = 5 * 60_000,
    private readonly leerFristMs = 5 * 60_000,
    private readonly maxDauerMs = 6 * 3_600_000,
  ) {}

  pruefen(lage: Lage): Entscheidung {
    if (lage.jetzt - lage.beginn >= this.maxDauerMs) return "ende_dauer";

    if (!lage.jemandDa) {
      this.leerSeit ??= lage.jetzt;
      if (lage.jetzt - this.leerSeit >= this.leerFristMs) return "ende_leer";
    } else {
      this.leerSeit = undefined;
    }

    if (!lage.leitungDa) {
      this.leitungWegSeit ??= lage.jetzt;
      if (lage.jetzt - this.leitungWegSeit >= this.leitungFristMs) return "ende_leitung";
      if (!lage.pausiert) return "pause_leitung";
      return "nichts";
    }
    this.leitungWegSeit = undefined;
    if (lage.pausiert && lage.pauseDurchWache) return "weiter_leitung";
    return "nichts";
  }
}
