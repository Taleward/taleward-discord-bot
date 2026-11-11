// Die Anbindung beantwortet alles, was die Aufnahme über Kampagne, Zustimmung und Runde wissen muss.
// Zwei Fassungen: Listen aus der .env (Testmodus) und der Taleward-Server (Schnittstelle 0.4.32).
// Die Aufnahme selbst kennt nur diese Schnittstelle.

import type { Sprache } from "../texte/texte.js";
import { ServerFehler, TalewardServer, type Bereitschaften, type SpurenSchluessel } from "../server/client.js";
import type { Bereitschaft } from "./zustimmung.js";

export type { Bereitschaft };

export interface Kontext {
  kampagneId: string;
  titel: string;
  sprache: Sprache;
  /** Kampagnen-Einstellung: anhalten, wenn jemand ohne Zustimmung dazukommt. */
  pauseOhneZustimmung: boolean;
  /** Laufende Bot-Runde dieser Kampagne laut Server (z. B. nach einem Neustart). */
  laufendeRunde: string | null;
}

/** Fehler der Bereitschaftsabfrage einordnen: 429 ist eine Bremse des Servers, alles andere „Server weg“. */
export function bereitschaftsFehlerArt(fehler: unknown): "ratenlimit" | "weg" {
  return fehler instanceof ServerFehler && fehler.status === 429 ? "ratenlimit" : "weg";
}

export type Ereignisart = "pause" | "resume" | "interrupted" | "stopped" | "discarded";

export interface Anbindung {
  readonly art: "listen" | "server";
  /** Kampagnen, die diese Person auf dieser Gilde leitet. Leer = darf nicht leiten. */
  kampagnen(guildId: string, discordId: string): Promise<Kontext[]>;
  bereitschaft(kontext: Kontext, discordIds: readonly string[], sessionId?: string): Promise<Bereitschaften>;
  /** Runde beim Start anlegen; liefert die Kennung und den Schlüssel für verschlüsselte Spuren (Testmodus: nichts). */
  rundeAnlegen(kontext: Kontext, guildId: string, discordId: string, start: Date): Promise<{ sessionId: string; spurenSchluessel?: SpurenSchluessel } | undefined>;
  /** Person mit Zustimmung in die Runde aufnehmen; liefert die Kennung für die Spur. */
  anwesend(sessionId: string | undefined, discordId: string): Promise<string | undefined>;
  zustimmungslink(sessionId: string | undefined, discordId: string, anzeigename: string): Promise<{ url: string; expiresAt: string } | undefined>;
  ereignis(sessionId: string | undefined, art: Ereignisart, zeit: Date): Promise<void>;
  spurVerwerfen(sessionId: string | undefined, attendeeId: string): Promise<void>;
  /** Stelle merken (0.4.35); `gast` = Gast ohne Konto, `nicht_dabei` = nicht Anwesende, `zu_viele` = 200 erreicht, `keine_aufnahme`. Testmodus: `ok`. */
  merken(sessionId: string | undefined, discordId: string, at: Date, note: string | null): Promise<"ok" | "gast" | "nicht_dabei" | "zu_viele" | "keine_aufnahme">;
  verbindungslink(guildId: string, discordId: string, guildName: string): Promise<{ url: string; code: string; expiresAt: string } | undefined>;
  verbindungLoesen(guildId: string, kampagneId: string, discordId: string): Promise<void>;
  /** Nur mit Server: für das Hochladen. */
  readonly server?: TalewardServer;
}

/** Testmodus: feste Listen aus der .env, keine Runde auf dem Server. */
export class ListenAnbindung implements Anbindung {
  readonly art = "listen" as const;
  constructor(
    private readonly leitung: string,
    private readonly teilnehmer: readonly string[],
  ) {}

  kampagnen(_guildId: string, discordId: string): Promise<Kontext[]> {
    if (discordId !== this.leitung) return Promise.resolve([]);
    return Promise.resolve([{ kampagneId: "testmodus", titel: "Testmodus", sprache: "de", pauseOhneZustimmung: false, laufendeRunde: null }]);
  }

  bereitschaft(_k: Kontext, discordIds: readonly string[]): Promise<Bereitschaften> {
    const states = new Map<string, { state: Bereitschaft; attendeeId: string | null }>();
    for (const id of discordIds) states.set(id, { state: this.teilnehmer.includes(id) ? "ready" : "consent_required", attendeeId: id });
    return Promise.resolve({ states, sessionState: null });
  }

  rundeAnlegen(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  anwesend(_s: string | undefined, discordId: string): Promise<string | undefined> {
    return Promise.resolve(this.teilnehmer.includes(discordId) ? discordId : undefined);
  }

  zustimmungslink(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  ereignis(): Promise<void> {
    return Promise.resolve();
  }

  spurVerwerfen(): Promise<void> {
    return Promise.resolve();
  }

  merken(): Promise<"ok"> {
    return Promise.resolve("ok");
  }

  verbindungslink(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  verbindungLoesen(): Promise<void> {
    return Promise.resolve();
  }
}

/** Der Taleward-Server als Quelle der Wahrheit. */
export class ServerAnbindung implements Anbindung {
  readonly art = "server" as const;
  constructor(readonly server: TalewardServer) {}

  async kampagnen(guildId: string, discordId: string): Promise<Kontext[]> {
    const liste = await this.server.kampagnen(guildId, discordId);
    return liste.map((k) => ({
      kampagneId: k.campaignId,
      titel: k.title,
      sprache: k.language.toLowerCase().startsWith("de") ? "de" : "en",
      pauseOhneZustimmung: k.pauseOnUnconsented,
      laufendeRunde: k.liveSessionId,
    }));
  }

  bereitschaft(kontext: Kontext, discordIds: readonly string[], sessionId?: string): Promise<Bereitschaften> {
    return this.server.bereitschaft(kontext.kampagneId, discordIds, sessionId);
  }

  async rundeAnlegen(kontext: Kontext, guildId: string, discordId: string, start: Date): Promise<{ sessionId: string; spurenSchluessel?: SpurenSchluessel }> {
    const r = await this.server.rundeAnlegen(kontext.kampagneId, guildId, discordId, start);
    return { sessionId: r.sessionId, ...(r.spurenSchluessel ? { spurenSchluessel: r.spurenSchluessel } : {}) };
  }

  async anwesend(sessionId: string | undefined, discordId: string): Promise<string | undefined> {
    if (!sessionId) return undefined;
    try {
      return await this.server.anwesend(sessionId, discordId);
    } catch (f) {
      if (f instanceof ServerFehler && f.status === 409) return undefined; // consent_missing, too_many_tracks
      throw f;
    }
  }

  zustimmungslink(sessionId: string | undefined, discordId: string, anzeigename: string): Promise<{ url: string; expiresAt: string } | undefined> {
    if (!sessionId) return Promise.resolve(undefined);
    return this.server.zustimmungslink(sessionId, discordId, anzeigename);
  }

  async ereignis(sessionId: string | undefined, art: Ereignisart, zeit: Date): Promise<void> {
    if (sessionId) await this.server.ereignis(sessionId, art, zeit);
  }

  async spurVerwerfen(sessionId: string | undefined, attendeeId: string): Promise<void> {
    if (sessionId) await this.server.spurVerwerfen(sessionId, attendeeId);
  }

  async merken(sessionId: string | undefined, discordId: string, at: Date, note: string | null): Promise<"ok" | "gast" | "nicht_dabei" | "zu_viele" | "keine_aufnahme"> {
    if (!sessionId) return "nicht_dabei";
    try {
      await this.server.merken(sessionId, discordId, at, note);
      return "ok";
    } catch (f) {
      if (f instanceof ServerFehler && f.status === 409) {
        if (f.code === "guest_no_bookmarks") return "gast";
        if (f.code === "bookmark_limit") return "zu_viele";
        if (f.code === "session_not_recording") return "keine_aufnahme";
      }
      if (f instanceof ServerFehler && (f.status === 404 || f.status === 409 || f.status === 429)) return "nicht_dabei";
      throw f;
    }
  }

  verbindungslink(guildId: string, discordId: string, guildName: string): Promise<{ url: string; code: string; expiresAt: string }> {
    return this.server.linkAnfordern(guildId, discordId, guildName);
  }

  verbindungLoesen(guildId: string, kampagneId: string, discordId: string): Promise<void> {
    return this.server.verbindungLoesen(guildId, kampagneId, discordId);
  }
}
