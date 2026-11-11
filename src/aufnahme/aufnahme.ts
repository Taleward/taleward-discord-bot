// Aufnahme einer Online-Runde: eine Tonspur je Person mit Zustimmung, nichts sonst.
//
// Grundsätze:
// - Aufgenommen wird nur, wer laut Anbindung „ready“ ist (Testmodus: Liste in der .env, sonst der
//   Taleward-Server). Für alle anderen wird kein Empfang bestellt (receiver.subscribe); ihre Pakete
//   verwirft die Voice-Bibliothek, bevor sie entschlüsselt werden.
// - Jede Spur läuft nach der Wanduhr des Aufnahmebeginns; Lücken (auch Pausen) werden mit Stille
//   gefüllt, alle Spuren sind gleich lang.
// - Töne (Holzklang, toene.ts): Start und Weiter aufwärts, Pause und Stopp abwärts. Der erste
//   Anschlag des Starttons ist die Nullmarke und liegt in 00-signal.opus.
// - Widerruf: Spur sofort schließen, Datei löschen, dem Server melden; der Name verschwindet still.
// - Die Wache (wache.ts) hält an und beendet, wenn die Spielleitung geht, der Kanal leer ist
//   oder 6 Stunden erreicht sind. Server 2 Minuten weg → Pause, 30 Minuten → Ende.
// - Mit Server liegen die Spuren nur verschlüsselt auf der Platte (S65, verschluesselung.ts): Der Server gibt beim
//   Anlegen der Runde seinen öffentlichen Schlüssel mit; fehlt er, startet keine Aufnahme.
// - Nach dem Ende lädt hochladen.ts die Spuren zum Server (nur mit Server) und löscht sie danach.

import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Guild, VoiceBasedChannel } from "discord.js";
import { mkdir, rm, statfs, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import prism from "prism-media";
import type { AufnahmeKonfiguration } from "../konfiguration.js";
import type { Anbindung, Kontext } from "./anbindung.js";
import { OpusSpur, dateiZiel, type OggZiel } from "./ogg.js";
import { bereitschaftsFehlerArt, type Bereitschaft } from "./anbindung.js";
import { DATEIENDUNG, VerschluesselndesZiel, dateiSchreibziel } from "./verschluesselung.js";
import type { SpurenSchluessel } from "../server/client.js";
import { TON_PAUSE, TON_START, TON_STOPP, TON_WEITER } from "./toene.js";
import { Wache } from "./wache.js";

export interface Spur {
  id: string;
  /** Kennung des Anwesenden beim Server (Testmodus: Discord-Kennung). */
  attendeeId: string;
  name: string;
  datei: string;
  spur: OpusSpur;
  strom?: AudioReceiveStream;
}

export interface Laufend {
  guildId: string;
  kanalId: string;
  kanalName: string;
  leitungId: string;
  kontext: Kontext;
  sessionId: string | undefined;
  /** Mit Server: öffentlicher Schlüssel für die Spuren; ohne (Testmodus) Klartext. */
  spurenSchluessel: SpurenSchluessel | undefined;
  ordner: string;
  beginn: number; // Wanduhr (ms), Beginn des Starttons
  loeschenBis: string;
  spuren: Map<string, Spur>;
  signal: OpusSpur;
  verbindung: VoiceConnection;
  /** Kennungen, die laut Anbindung aufgenommen werden dürfen (alle 30 s neu abgefragt). */
  zugestimmt: Set<string>;
  /** Letzte erfolgreiche Bereitschaftsabfrage: Zeitpunkt und Zustand je Person (für „Zustimmen“/`bereit` ohne neue Anfrage, D5.1). */
  bereitschaftZeit: number;
  bereitschaftStaende: Map<string, Bereitschaft>;
  /** Sprechereignisse von Personen ohne Zustimmung, nur gezählt, keine Kennungen. */
  ignorierteSprecher: number;
  pausiert: boolean;
  pauseDurchWache: boolean;
  pauseDurchServer: boolean;
  /** Die Pause kam von der Kampagnen-Einstellung „anhalten, wenn jemand ohne Zustimmung dazukommt“. */
  pauseDurchZustimmung: boolean;
  /** Personen ohne Zustimmung, für die schon angehalten bzw. die beim Start schon da waren (keine zweite Pause). */
  ohneZustimmungGemeldet: Set<string>;
  pausen: { vonMs: number; bisMs?: number }[];
  ereignisse: { zeitMs: number; was: string }[];
  /** Gemerkte Stellen, nur im Testmodus ins Protokoll (mit Server merkt sie der Server je Person); nie die Notiz. */
  merkstellen: { zeitMs: number }[];
  wache: Wache;
  takt?: NodeJS.Timeout;
}

export type Hinweisart =
  | "verworfen"
  | "pause_leitung"
  | "weiter_leitung"
  | "ende_leitung"
  | "ende_leer"
  | "ende_dauer"
  | "ende_verbindung"
  | "pause_server"
  | "weiter_server"
  | "pause_zustimmung"
  | "weiter_zustimmung"
  | "ende_server"
  | "angekommen"
  | "hochladen_fehlt";

/** Was die Aufnahme nach außen meldet (Textchat des Kanals). */
export interface Melder {
  /** Die Namensliste hat sich geändert (Widerruf, Dazukommen). */
  namen(namen: string[]): Promise<void>;
  hinweis(art: Hinweisart): Promise<void>;
}

export type Zustand = "bereit" | "verbunden" | "laeuft" | "pausiert";

/** Dateiname aus einem Anzeigenamen: nur a–z, 0–9, Bindestrich. */
export function dateiname(name: string, nummer: number): string {
  const kern = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${String(nummer).padStart(2, "0")}-${kern || "person"}.opus`;
}

export function ordnername(zeit: Date): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${zeit.getFullYear()}-${z(zeit.getMonth() + 1)}-${z(zeit.getDate())}_${z(zeit.getHours())}-${z(zeit.getMinutes())}`;
}

/** Löschfrist: 14 Tage nach dem Beginn, als TT.MM.JJJJ. */
export function loeschfrist(beginn: Date, tage = 14): string {
  const d = new Date(beginn.getTime() + tage * 86_400_000);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${z(d.getDate())}.${z(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function dauerText(ms: number): { h: string; m: string } {
  const min = Math.floor(ms / 60000);
  return { h: String(Math.floor(min / 60)), m: String(min % 60) };
}

export async function freieGb(pfad: string): Promise<number> {
  const s = await statfs(pfad);
  return (Number(s.bavail) * Number(s.bsize)) / 1024 ** 3;
}

/** Liest die Opus-Pakete einer kleinen Ogg/Opus-Datei im Speicher (für die Signalspur). */
export function oggPakete(ogg: Buffer): Promise<Buffer[]> {
  return new Promise((ok, fehler) => {
    const pakete: Buffer[] = [];
    Readable.from([ogg])
      .pipe(new prism.opus.OggDemuxer())
      .on("data", (p: Buffer) => pakete.push(p))
      .on("end", () => ok(pakete))
      .on("error", fehler);
  });
}

/** So lange ohne frischen Zustimmungsstand (Server weg oder Bremse), dann endet die Aufnahme. */
export const SERVER_ENDE_MS = 30 * 60_000;
/** Älter darf der Zustimmungsstand nicht sein, sonst hält die Aufnahme an (P5.2, D5.1). */
export const BEREITSCHAFT_HOECHSTALTER_MS = 60_000;

/**
 * Ist der letzte bekannte Zustimmungsstand zu alt, um weiter aufzunehmen?
 * `vorausMs`: Abstand bis zur nächsten Gelegenheit zu prüfen (der Takt). Würde der Stand bis dahin die Grenze
 * überschreiten, gilt er schon jetzt als veraltet – so kommt die Pause spätestens bei 60 s, nicht erst bei 90 s.
 */
export function bereitschaftVeraltet(letzteZeit: number, jetzt: number, grenzeMs = BEREITSCHAFT_HOECHSTALTER_MS, vorausMs = 0): boolean {
  return jetzt - letzteZeit + vorausMs > grenzeMs;
}

/**
 * Was tun, wenn der Takt keinen frischen Zustimmungsstand bekommt (Server weg oder Bremse, D5.1)?
 * 30 min nach dem letzten Stand Ende; ist der Stand bis zum nächsten Takt älter als 60 s, Pause (einmal).
 */
export function ohneStandEntscheiden(letzteZeit: number, jetzt: number, taktMs: number, pausiert: boolean): "ende" | "pause" | "weiter" {
  if (jetzt - letzteZeit >= SERVER_ENDE_MS) return "ende";
  if (!pausiert && bereitschaftVeraltet(letzteZeit, jetzt, BEREITSCHAFT_HOECHSTALTER_MS, taktMs)) return "pause";
  return "weiter";
}

/** Lage für die Kampagnen-Einstellung „anhalten, wenn jemand ohne Zustimmung dazukommt“. */
export interface ZustimmungsLage {
  /** Einstellung der Kampagne an? */
  aktiv: boolean;
  /** Alle Personen im Kanal (ohne Bots). */
  imKanal: readonly string[];
  zugestimmt: ReadonlySet<string>;
  /** Personen ohne Zustimmung, für die schon angehalten wurde bzw. die beim Start da waren. */
  gemeldet: ReadonlySet<string>;
  pausiert: boolean;
  pauseDurchZustimmung: boolean;
}

/**
 * Entscheidung zur Kampagnen-Einstellung, rein: „pause“ bei einer neuen Person ohne Zustimmung (einmal je Person),
 * „weiter“ sobald niemand ohne Zustimmung mehr im Kanal ist und die Pause von hier kam, sonst „nichts“.
 * Liefert die fortgeschriebene Merkliste (nur Personen, die noch da und noch ohne Zustimmung sind).
 */
export function ohneZustimmungEntscheiden(l: ZustimmungsLage): { entscheidung: "pause" | "weiter" | "nichts"; gemeldet: Set<string> } {
  const offen = l.imKanal.filter((id) => !l.zugestimmt.has(id));
  const gemeldet = new Set(offen.filter((id) => l.gemeldet.has(id)));
  if (!l.aktiv) return { entscheidung: "nichts", gemeldet };
  const neu = offen.filter((id) => !l.gemeldet.has(id));
  for (const id of neu) gemeldet.add(id);
  if (neu.length > 0 && !l.pausiert) return { entscheidung: "pause", gemeldet };
  if (offen.length === 0 && l.pausiert && l.pauseDurchZustimmung) return { entscheidung: "weiter", gemeldet };
  return { entscheidung: "nichts", gemeldet };
}

export type StartErgebnis =
  | { ok: true; namen: string[]; offen: string[]; loeschenBis: string; sessionId: string | undefined }
  | { ok: false; grund: "laeuft_schon" | "kein_platz" | "verbindung_fehlt" | "niemand" | "zu_viele" | "server_fehlt" | "server_ohne_schluessel"; kanal?: string; frei?: string };

export type EndeGrund = "stopp" | "verwerfen" | "ende_leitung" | "ende_leer" | "ende_dauer" | "ende_verbindung" | "ende_server" | "beenden";

/** Was nach dem Ende übrig bleibt und hochgeladen wird. */
export interface Abschluss {
  dauerMs: number;
  spuren: { datei: string; attendeeId: string; discordId: string }[];
  ordner: string;
  sessionId: string | undefined;
  kontext: Kontext;
  beginn: number;
  grund: EndeGrund;
}

export class Aufnahme {
  private laufend: Laufend | undefined;
  private verbunden: { guildId: string; kanalId: string; verbindung: VoiceConnection } | undefined;
  private wirdBeendet = false;

  constructor(
    private readonly konf: AufnahmeKonfiguration,
    private readonly anbindung: Anbindung,
    private readonly melder: Melder,
    private readonly nachEnde: (abschluss: Abschluss) => Promise<void> = async () => undefined,
    private readonly taktMs = 30_000,
  ) {}

  get aktiv(): Laufend | undefined {
    return this.laufend;
  }

  /** Zustand einer Person aus dem letzten Takt (ohne neue Anfrage); undefined = im letzten Takt nicht im Kanal. */
  bereitschaftAusTakt(discordId: string): Bereitschaft | undefined {
    const a = this.laufend;
    if (!a) return undefined;
    if (a.zugestimmt.has(discordId)) return "ready";
    return a.bereitschaftStaende.get(discordId);
  }

  /** Stelle merken: Zeit seit dem Startton; mit Server erledigt der Server das Merken je Person. */
  async merken(discordId: string, notiz: string | null): Promise<{ zeitMs: number; ergebnis: "ok" | "gast" | "nicht_dabei" | "zu_viele" | "keine_aufnahme" } | undefined> {
    const a = this.laufend;
    if (!a) return undefined;
    const jetzt = new Date();
    const zeitMs = jetzt.getTime() - a.beginn;
    const ergebnis = await this.anbindung.merken(a.sessionId, discordId, jetzt, notiz);
    if (ergebnis === "ok" && this.anbindung.art === "listen") a.merkstellen.push({ zeitMs });
    this.ereignis("merken");
    return { zeitMs, ergebnis };
  }

  get zustand(): Zustand {
    if (this.laufend) return this.laufend.pausiert ? "pausiert" : "laeuft";
    return this.verbunden ? "verbunden" : "bereit";
  }

  /** In den Kanal kommen und den Startton zur Probe spielen, ohne aufzunehmen. */
  async beitreten(kanal: VoiceBasedChannel, guild: Guild): Promise<"ok" | "laeuft_schon" | "verbindung_fehlt"> {
    if (this.laufend) return "laeuft_schon";
    const verbindung = await this.verbinden(kanal, guild);
    if (!verbindung) return "verbindung_fehlt";
    this.verbunden = { guildId: guild.id, kanalId: kanal.id, verbindung };
    await this.tonSpielen(verbindung, TON_START);
    return "ok";
  }

  /** Den Kanal verlassen; nicht während einer Aufnahme. */
  verlassen(): "ok" | "laeuft" | "nicht_verbunden" {
    if (this.laufend) return "laeuft";
    if (!this.verbunden) return "nicht_verbunden";
    this.verbunden.verbindung.destroy();
    this.verbunden = undefined;
    return "ok";
  }

  private async verbinden(kanal: VoiceBasedChannel, guild: Guild): Promise<VoiceConnection | undefined> {
    const vorhanden = getVoiceConnection(guild.id);
    if (vorhanden && vorhanden.joinConfig.channelId === kanal.id && vorhanden.state.status === VoiceConnectionStatus.Ready) return vorhanden;
    const verbindung = joinVoiceChannel({
      channelId: kanal.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
    });
    try {
      await entersState(verbindung, VoiceConnectionStatus.Ready, 20_000);
      return verbindung;
    } catch {
      verbindung.destroy();
      return undefined;
    }
  }

  async start(kanal: VoiceBasedChannel, guild: Guild, leitungId: string, kontext: Kontext): Promise<StartErgebnis> {
    if (this.laufend) return { ok: false, grund: "laeuft_schon", kanal: this.laufend.kanalName };

    await mkdir(this.konf.ordner, { recursive: true, mode: 0o700 });
    const frei = await freieGb(this.konf.ordner);
    if (frei < this.konf.minFreiGb) return { ok: false, grund: "kein_platz", frei: frei.toFixed(1) };

    const personen = [...kanal.members.values()].filter((m) => !m.user.bot);
    if (personen.length > this.konf.maxPersonen) return { ok: false, grund: "zu_viele" };

    let bereit;
    try {
      bereit = await this.anbindung.bereitschaft(kontext, personen.map((m) => m.id));
    } catch {
      return { ok: false, grund: "server_fehlt" };
    }
    const anwesend = personen.filter((m) => bereit.states.get(m.id)?.state === "ready");
    const offen = personen.filter((m) => bereit.states.get(m.id)?.state !== "ready").map((m) => m.displayName);
    if (anwesend.length === 0) return { ok: false, grund: "niemand" };

    const verbindung = await this.verbinden(kanal, guild);
    if (!verbindung) return { ok: false, grund: "verbindung_fehlt" };
    this.verbunden = undefined;

    // Ohne Server kein Start (mit Server): Runde anlegen, bevor der Ton erklingt.
    const jetzt = new Date();
    let runde;
    try {
      runde = await this.anbindung.rundeAnlegen(kontext, guild.id, leitungId, jetzt);
    } catch {
      verbindung.destroy();
      return { ok: false, grund: "server_fehlt" };
    }
    const sessionId = runde?.sessionId;
    const spurenSchluessel = runde?.spurenSchluessel;
    if (this.anbindung.art === "server" && !spurenSchluessel) {
      // Ohne Schlüssel des Servers läge die Spur im Klartext auf der Platte – das tun wir nicht (S65).
      await this.anbindung.ereignis(sessionId, "discarded", new Date()).catch(() => undefined);
      verbindung.destroy();
      return { ok: false, grund: "server_ohne_schluessel" };
    }

    const ordner = join(this.konf.ordner, ordnername(jetzt));
    await mkdir(ordner, { recursive: true, mode: 0o700 });

    const startTon = await oggPakete(TON_START);
    const signalZiel = await this.ziel(join(ordner, "00-signal"), spurenSchluessel, sessionId, "signal");
    const signal = new OpusSpur(signalZiel.ziel, 1, 2, spurenSchluessel ? {} : { TITLE: "Signal (Toene des Bots)" });

    const a: Laufend = {
      guildId: guild.id,
      kanalId: kanal.id,
      kanalName: kanal.name,
      leitungId,
      kontext,
      sessionId,
      spurenSchluessel,
      ordner,
      beginn: jetzt.getTime(),
      loeschenBis: loeschfrist(jetzt),
      spuren: new Map(),
      signal,
      verbindung,
      zugestimmt: new Set(anwesend.map((m) => m.id)),
      bereitschaftZeit: Date.now(),
      bereitschaftStaende: new Map([...bereit.states].map(([id, s]) => [id, s.state])),
      ignorierteSprecher: 0,
      pausiert: false,
      pauseDurchWache: false,
      pauseDurchServer: false,
      pauseDurchZustimmung: false,
      // Wer beim Start ohne Zustimmung da ist, steht in „Noch offen“; die SL hat das gesehen. Angehalten wird nur
      // für Personen, die später dazukommen (Kampagnen-Einstellung).
      ohneZustimmungGemeldet: new Set(personen.filter((m) => bereit.states.get(m.id)?.state !== "ready").map((m) => m.id)),
      pausen: [],
      ereignisse: [],
      merkstellen: [],
      wache: new Wache(),
    };
    this.laufend = a;

    for (const m of anwesend) await this.spurAnlegen(a, m.id, m.displayName);

    verbindung.receiver.speaking.on("start", (userId) => {
      if (this.laufend !== a) return;
      if (!a.zugestimmt.has(userId)) {
        a.ignorierteSprecher++;
        return;
      }
      if (!a.spuren.has(userId)) {
        const mitglied = guild.members.cache.get(userId);
        void this.spurAnlegen(a, userId, mitglied?.displayName ?? "person").then(() => this.melder.namen(this.namen()));
      }
    });

    verbindung.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.laufend !== a) return;
      try {
        await Promise.race([
          entersState(verbindung, VoiceConnectionStatus.Signalling, 15_000),
          entersState(verbindung, VoiceConnectionStatus.Connecting, 15_000),
        ]);
        this.ereignis("verbindung_kurz_weg");
        await this.anbindung.ereignis(a.sessionId, "interrupted", new Date()).catch(() => undefined);
        // Nach jeder Unterbrechung die Zustimmung frisch abfragen (Bedingung 20 / P5.2), nicht erst beim nächsten Takt.
        void this.takt(kanal, guild);
      } catch {
        this.ereignis("verbindung_verloren");
        await this.melder.hinweis("ende_verbindung");
        await this.beenden("ende_verbindung");
      }
    });

    // Startton: seine erste Millisekunde ist die Nullmarke der Aufnahme.
    a.beginn = await this.tonSpielen(verbindung, TON_START);
    this.signalSchreiben(a, startTon, 0);
    this.ereignis("start");

    a.takt = setInterval(() => void this.takt(kanal, guild), this.taktMs);
    return { ok: true, namen: this.namen(), offen, loeschenBis: a.loeschenBis, sessionId };
  }

  namen(): string[] {
    return this.laufend ? [...this.laufend.spuren.values()].map((s) => s.name) : [];
  }

  /** Alle 30 Sekunden: Zustimmung neu abfragen (Widerruf), Server-Erreichbarkeit, Wache prüfen. */
  private async takt(kanal: VoiceBasedChannel, guild: Guild): Promise<void> {
    const a = this.laufend;
    if (!a || this.wirdBeendet) return;
    const frisch = guild.channels.cache.get(kanal.id);
    const mitglieder = frisch && frisch.isVoiceBased() ? [...frisch.members.values()].filter((m) => !m.user.bot) : [];
    try {
      const ids = [...new Set([...mitglieder.map((m) => m.id), ...a.spuren.keys()])];
      let bereit;
      try {
        bereit = await this.anbindung.bereitschaft(a.kontext, ids, a.sessionId);
      } catch (fehler) {
        if (bereitschaftsFehlerArt(fehler) === "ratenlimit") {
          // Zu viele Anfragen (D5): kein Ausfall, die bekannte Liste gilt weiter, nächster Takt fragt neu.
          // Niemand wird dabei als zugestimmt angenommen – wer nicht bestätigt ist, bleibt draußen.
          console.warn("aufnahme: Server bremst (429), Bereitschaft beim nächsten Takt");
        } else {
          console.warn("aufnahme: server nicht erreichbar:", fehler instanceof Error ? fehler.message : fehler);
        }
        await this.ohneFrischenStand(a);
        if (this.laufend !== a) return;
        await this.wachen(a, mitglieder.some((m) => m.id === a.leitungId), mitglieder.length > 0);
        return;
      }
      a.bereitschaftZeit = Date.now();
      a.bereitschaftStaende = new Map([...bereit.states].map(([id, s]) => [id, s.state]));
      await this.serverDa(a);
      if (a.sessionId && bereit.sessionState && bereit.sessionState !== "recording") {
        // Die SL hat in der App gelöst oder der Server hat die Runde beendet.
        await this.melder.hinweis("ende_server");
        await this.beenden("ende_server");
        return;
      }
      let geaendert = false;
      for (const id of ids) {
        const darf = bereit.states.get(id)?.state === "ready";
        if (darf && !a.zugestimmt.has(id)) a.zugestimmt.add(id);
        if (!darf && a.zugestimmt.has(id)) {
          a.zugestimmt.delete(id);
          if (a.spuren.has(id)) {
            await this.spurVerwerfen(a, id);
            geaendert = true;
          }
        }
      }
      if (geaendert) await this.melder.namen(this.namen());
      await this.zustimmungPruefen(a, mitglieder.map((m) => m.id));
      if (this.laufend !== a) return;
    } catch (fehler) {
      console.warn("aufnahme: takt", fehler instanceof Error ? fehler.message : fehler);
    }
    await this.wachen(a, mitglieder.some((m) => m.id === a.leitungId), mitglieder.length > 0);
  }

  /**
   * Kein frischer Zustimmungsstand (Server weg oder Bremse), P5.2/D5.1: Ist der letzte Stand bis zum nächsten Takt
   * älter als 60 s, anhalten (Spuren laufen mit Stille weiter); 30 min nach dem letzten Stand Ende.
   */
  private async ohneFrischenStand(a: Laufend): Promise<void> {
    switch (ohneStandEntscheiden(a.bereitschaftZeit, Date.now(), this.taktMs, a.pausiert)) {
      case "ende":
        await this.melder.hinweis("ende_server");
        await this.beenden("ende_server");
        return;
      case "pause":
        await this.pause("server");
        await this.melder.hinweis("pause_server");
        return;
      default:
        return;
    }
  }

  /**
   * Kampagnen-Einstellung „Aufnahme anhalten, wenn jemand ohne Zustimmung dazukommt“: kommt eine Person ohne
   * Zustimmung neu in den Kanal, Pause mit Hinweis; sobald alle im Kanal zugestimmt haben oder die Person weg ist,
   * geht es weiter. Für dieselbe Person wird nur einmal angehalten (die SL kann mit /taleward weiter übersteuern).
   */
  private async zustimmungPruefen(a: Laufend, imKanal: readonly string[]): Promise<void> {
    const z = ohneZustimmungEntscheiden({
      aktiv: a.kontext.pauseOhneZustimmung,
      imKanal,
      zugestimmt: a.zugestimmt,
      gemeldet: a.ohneZustimmungGemeldet,
      pausiert: a.pausiert,
      pauseDurchZustimmung: a.pauseDurchZustimmung,
    });
    a.ohneZustimmungGemeldet = z.gemeldet;
    if (z.entscheidung === "pause") {
      await this.pause("zustimmung");
      await this.melder.hinweis("pause_zustimmung");
    } else if (z.entscheidung === "weiter") {
      await this.weiter();
      await this.melder.hinweis("weiter_zustimmung");
    }
  }

  private async serverDa(a: Laufend): Promise<void> {
    if (a.pausiert && a.pauseDurchServer) {
      await this.weiter();
      await this.melder.hinweis("weiter_server");
    }
  }

  private async wachen(a: Laufend, leitungDa: boolean, jemandDa: boolean): Promise<void> {
    if (this.laufend !== a || this.wirdBeendet) return;
    const entscheidung = a.wache.pruefen({ jetzt: Date.now(), beginn: a.beginn, leitungDa, jemandDa, pausiert: a.pausiert, pauseDurchWache: a.pauseDurchWache });
    switch (entscheidung) {
      case "pause_leitung":
        await this.pause("wache");
        await this.melder.hinweis("pause_leitung");
        return;
      case "weiter_leitung":
        await this.weiter();
        await this.melder.hinweis("weiter_leitung");
        return;
      case "ende_leitung":
      case "ende_leer":
      case "ende_dauer":
        await this.melder.hinweis(entscheidung);
        await this.beenden(entscheidung);
        return;
      default:
        return;
    }
  }

  /** Von Discord gemeldete Bewegung im Sprachkanal: sofort reagieren, ohne auf den Takt zu warten. */
  async sprachzustand(userId: string, vonKanal: string | null, nachKanal: string | null, kanal: VoiceBasedChannel | undefined): Promise<void> {
    const a = this.laufend;
    if (!a || this.wirdBeendet || userId !== a.leitungId) return;
    if (vonKanal === a.kanalId && nachKanal !== a.kanalId) {
      await this.wachen(a, false, true);
    } else if (nachKanal === a.kanalId && vonKanal !== a.kanalId) {
      const jemandDa = kanal ? [...kanal.members.values()].some((m) => !m.user.bot) : true;
      await this.wachen(a, true, jemandDa);
    }
  }

  async pause(durch: "hand" | "wache" | "server" | "zustimmung" = "hand"): Promise<"ok" | "laeuft_nicht" | "schon_pause"> {
    const a = this.laufend;
    if (!a) return "laeuft_nicht";
    if (a.pausiert) return "schon_pause";
    a.pausiert = true;
    a.pauseDurchWache = durch === "wache";
    a.pauseDurchServer = durch === "server";
    a.pauseDurchZustimmung = durch === "zustimmung";
    const jetzt = new Date();
    a.pausen.push({ vonMs: jetzt.getTime() - a.beginn });
    this.ereignis(`pause_${durch}`);
    const tonBeginn = await this.tonSpielen(a.verbindung, TON_PAUSE);
    this.signalSchreiben(a, await oggPakete(TON_PAUSE), tonBeginn - a.beginn);
    await this.anbindung.ereignis(a.sessionId, "pause", jetzt).catch(() => undefined);
    return "ok";
  }

  async weiter(): Promise<"ok" | "laeuft_nicht" | "keine_pause"> {
    const a = this.laufend;
    if (!a) return "laeuft_nicht";
    if (!a.pausiert) return "keine_pause";
    const tonBeginn = await this.tonSpielen(a.verbindung, TON_WEITER);
    this.signalSchreiben(a, await oggPakete(TON_WEITER), tonBeginn - a.beginn);
    a.pausiert = false;
    a.pauseDurchWache = false;
    a.pauseDurchServer = false;
    a.pauseDurchZustimmung = false;
    const jetzt = new Date();
    const p = a.pausen.at(-1);
    if (p && p.bisMs === undefined) p.bisMs = jetzt.getTime() - a.beginn;
    this.ereignis("weiter");
    await this.anbindung.ereignis(a.sessionId, "resume", jetzt).catch(() => undefined);
    return "ok";
  }

  /** Ziel für eine Spur: mit Server verschlüsselt (.twse), sonst Klartext (.opus). */
  private async ziel(pfadOhneEndung: string, schluessel: SpurenSchluessel | undefined, sessionId: string | undefined, attendeeId: string): Promise<{ ziel: OggZiel; datei: string }> {
    if (schluessel && sessionId) {
      const datei = `${pfadOhneEndung}${DATEIENDUNG}`;
      return { ziel: await VerschluesselndesZiel.anlegen(dateiSchreibziel(datei), schluessel.oeffentlich, sessionId, attendeeId), datei };
    }
    const datei = `${pfadOhneEndung}.opus`;
    return { ziel: dateiZiel(datei), datei };
  }

  private async spurAnlegen(a: Laufend, id: string, name: string): Promise<void> {
    if (a.spuren.size >= this.konf.maxPersonen || a.spuren.has(id)) return;
    let attendeeId: string | undefined;
    try {
      attendeeId = await this.anbindung.anwesend(a.sessionId, id);
    } catch (fehler) {
      console.warn("aufnahme: anwesend", fehler instanceof Error ? fehler.message : fehler);
      return;
    }
    if (!attendeeId) return; // Server sagt: keine Zustimmung (mehr) oder zu viele Spuren.
    if (this.laufend !== a || a.spuren.has(id)) return;
    const nummer = a.spuren.size + 1;
    // Mit Server: keine Namen in Dateinamen oder Opus-Kopf (Bedingung 13) und verschlüsselt (S65); nur im Testmodus Klartext zum Anhören.
    const mitNamen = this.anbindung.art === "listen";
    const basis = dateiname(mitNamen ? name : "", nummer).replace(/\.opus$/, "");
    const z = await this.ziel(join(a.ordner, basis), a.spurenSchluessel, a.sessionId, attendeeId);
    if (this.laufend !== a || a.spuren.has(id)) return;
    const datei = basename(z.datei);
    const spur = new OpusSpur(z.ziel, nummer + 1, 2, mitNamen ? { TITLE: name, TRACKNUMBER: String(nummer) } : { TRACKNUMBER: String(nummer) });
    const strom = a.verbindung.receiver.subscribe(id, { end: { behavior: EndBehaviorType.Manual } });
    strom.on("data", (paket: Buffer) => {
      if (a.pausiert) return; // In der Pause wird nichts geschrieben; die Lücke wird Stille.
      spur.paket(paket, Date.now() - a.beginn);
    });
    strom.on("error", (f) => console.warn("aufnahme: empfang", f.message));
    a.spuren.set(id, { id, attendeeId, name, datei, spur, strom });
    this.ereignis(`spur ${nummer}`);
  }

  /** Widerruf: Empfang beenden, Datei löschen, Server Bescheid sagen, Name aus der Liste. */
  private async spurVerwerfen(a: Laufend, id: string): Promise<void> {
    const s = a.spuren.get(id);
    if (!s) return;
    a.spuren.delete(id);
    s.strom?.destroy();
    await s.spur.beenden();
    await rm(join(a.ordner, s.datei), { force: true });
    await this.anbindung.spurVerwerfen(a.sessionId, s.attendeeId).catch(() => undefined);
    this.ereignis("spur verworfen");
  }

  private signalSchreiben(a: Laufend, pakete: Buffer[], abMs: number): void {
    let z = abMs;
    for (const p of pakete) {
      a.signal.paket(p, z);
      z += 20;
    }
  }

  private ereignis(was: string): void {
    const a = this.laufend;
    if (!a) return;
    a.ereignisse.push({ zeitMs: Math.max(0, Date.now() - a.beginn), was });
  }

  /** Spielt einen kleinen Ogg/Opus-Puffer ab und liefert den Zeitpunkt (ms), an dem er zu spielen begann. */
  /**
   * Mit DAVE (Ende-zu-Ende-Verschlüsselung) ist die Verbindung „Ready“, bevor die Gruppenschlüssel ausgehandelt sind;
   * Ton, der vorher gesendet wird, hört niemand. Deshalb kurz warten, bis die DAVE-Sitzung bereit ist (höchstens 5 s).
   */
  private async daveBereit(verbindung: VoiceConnection, maxMs = 5000): Promise<void> {
    const bis = Date.now() + maxMs;
    for (;;) {
      const z = verbindung.state;
      if (z.status !== VoiceConnectionStatus.Ready) return;
      const netz = z.networking.state as { dave?: { session?: { ready: boolean } } };
      if (!netz.dave || netz.dave.session?.ready) return;
      if (Date.now() >= bis) return;
      await new Promise((ok) => setTimeout(ok, 100));
    }
  }

  private async tonSpielen(verbindung: VoiceConnection, ogg: Buffer): Promise<number> {
    if (verbindung.state.status !== VoiceConnectionStatus.Ready) return Date.now();
    await this.daveBereit(verbindung);
    const spieler = createAudioPlayer();
    const abo = verbindung.subscribe(spieler);
    const resource = createAudioResource(Readable.from([ogg]), { inputType: StreamType.OggOpus });
    let begonnen = 0;
    const fertig = new Promise<void>((ok) => {
      spieler.once(AudioPlayerStatus.Playing, () => {
        begonnen = Date.now();
      });
      spieler.once(AudioPlayerStatus.Idle, () => ok());
      spieler.once("error", () => ok());
    });
    spieler.play(resource);
    await Promise.race([fertig, new Promise((ok) => setTimeout(ok, 4000))]);
    abo?.unsubscribe();
    spieler.stop(true);
    return begonnen || Date.now();
  }

  /** Aufnahme beenden: Endton, Spuren schließen, Protokoll, Kanal verlassen, danach Hochladen anstoßen. */
  async beenden(grund: EndeGrund = "stopp"): Promise<Abschluss | undefined> {
    const a = this.laufend;
    if (!a || this.wirdBeendet) return undefined;
    this.wirdBeendet = true;
    if (a.takt) clearInterval(a.takt);
    try {
      this.ereignis(grund);
      let endeMs = Date.now() - a.beginn;
      if (a.verbindung.state.status === VoiceConnectionStatus.Ready) {
        const tonBeginn = await this.tonSpielen(a.verbindung, TON_STOPP);
        this.signalSchreiben(a, await oggPakete(TON_STOPP), tonBeginn - a.beginn);
        endeMs = Date.now() - a.beginn;
      }
      const p = a.pausen.at(-1);
      if (p && p.bisMs === undefined) p.bisMs = endeMs;
      for (const s of a.spuren.values()) {
        s.strom?.destroy();
        s.spur.stilleBis(endeMs);
      }
      a.signal.stilleBis(endeMs);
      await Promise.all([a.signal.beenden(), ...[...a.spuren.values()].map((s) => s.spur.beenden())]);
      a.verbindung.destroy();
      await this.anbindung
        .ereignis(a.sessionId, grund === "verwerfen" ? "discarded" : grund === "ende_verbindung" ? "interrupted" : "stopped", new Date(a.beginn + endeMs))
        .catch(() => undefined);

      const abschluss: Abschluss = {
        dauerMs: endeMs,
        spuren: [...a.spuren.values()].map((s) => ({ datei: s.datei, attendeeId: s.attendeeId, discordId: s.id })),
        ordner: a.ordner,
        sessionId: a.sessionId,
        kontext: a.kontext,
        beginn: a.beginn,
        grund,
      };
      // Protokoll ohne Namen, Kennungen und Kanal, wenn ein Server im Spiel ist (Bedingung 13).
      const mitNamen = this.anbindung.art === "listen";
      const protokoll = {
        ...(mitNamen ? { kanal: a.kanalName } : {}),
        beginn: new Date(a.beginn).toISOString(),
        ende: new Date(a.beginn + endeMs).toISOString(),
        dauerMs: endeMs,
        endeGrund: grund,
        loeschenBis: a.loeschenBis,
        hinweis: "Zeit 0 jeder Spur ist der Beginn des Starttons (00-signal.opus). 20 ms je Paket, 48 kHz. Pausen sind in allen Spuren Stille.",
        spuren: [...a.spuren.values()].map((s) => ({ datei: s.datei, ...(mitNamen ? { name: s.name } : {}), pakete: s.spur.pakete, echtePakete: s.spur.echtePakete })),
        pausen: a.pausen,
        ...(mitNamen ? { merkstellen: a.merkstellen } : {}),
        ignorierteSprechereignisse: a.ignorierteSprecher,
        ereignisse: a.ereignisse,
      };
      if (grund === "verwerfen") {
        // Auf Wunsch der Spielleitung: nichts hochladen, Spuren sofort löschen; der Server hat „discarded“ bekommen.
        await rm(a.ordner, { recursive: true, force: true });
        return abschluss;
      }
      await writeFile(join(a.ordner, "protokoll.json"), JSON.stringify(protokoll, null, 2), { mode: 0o600 });
      void this.nachEnde(abschluss).catch((f: unknown) => console.error("aufnahme: nach dem Ende", f instanceof Error ? f.message : f));
      return abschluss;
    } finally {
      this.laufend = undefined;
      this.verbunden = undefined;
      this.wirdBeendet = false;
    }
  }
}
