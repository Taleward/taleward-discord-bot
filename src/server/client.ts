// Zugang zum Taleward-Server über die Schnittstelle 0.4.32 (/bot/… und Upload), mit dem Bot-Schlüssel
// im Kopf X-Taleward-Bot. Der Bot liest nie Inhalte; er kennt nur, was diese Wege liefern.
// Alle Antworten werden geprüft, bevor etwas daraus wird; Fehler tragen Status und Code des Servers.

import { createHash } from "node:crypto";
import type { Bereitschaft } from "../aufnahme/zustimmung.js";

export class ServerFehler extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    nachricht: string,
    /** Zusatzangaben des Servers (z. B. `attendeeIds` bei `track_invalid`), nur bekannte Formen. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(nachricht);
    this.name = "ServerFehler";
  }
}

export interface Kampagne {
  campaignId: string;
  title: string;
  language: string;
  pauseOnUnconsented: boolean;
  liveSessionId: string | null;
}

export interface Bereitschaften {
  states: Map<string, { state: Bereitschaft; attendeeId: string | null }>;
  sessionState: string | null;
}

/** Öffentlicher Schlüssel des Servers für verschlüsselte Spuren (S65), kommt mit der Runde. */
export interface SpurenSchluessel {
  /** Hex der SHA-256 des rohen öffentlichen Schlüssels. */
  keyId: string;
  /** Roher X25519-Schlüssel, 32 Bytes. */
  oeffentlich: Buffer;
}

export interface UploadDatei {
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  trackAttendeeId: string;
}

export interface UploadAngelegt {
  uploadId: string;
  chunkSizeBytes: number;
  files: { fileId: string; fileName: string; chunkCount: number }[];
}

const SNOWFLAKE = /^[0-9]{15,21}$/;

/** `trackKey: { keyId, publicKey }` (Vorschlag für YAML 0.4.34): publicKey Base64 des rohen 32-Byte-Schlüssels, keyId Hex der SHA-256 davon. */
export function spurenSchluesselParsen(roh: unknown): SpurenSchluessel | undefined {
  if (typeof roh !== "object" || roh === null) return undefined;
  const r = roh as Record<string, unknown>;
  const keyId = text(r.keyId, 64);
  const b64 = text(r.publicKey, 64);
  if (!keyId || !b64 || !/^[0-9a-f]{64}$/.test(keyId)) return undefined;
  const oeffentlich = Buffer.from(b64, "base64");
  if (oeffentlich.length !== 32) return undefined;
  if (createHash("sha256").update(oeffentlich).digest("hex") !== keyId) return undefined;
  return { keyId, oeffentlich };
}
const KENNUNG = /^[A-Za-z0-9_-]{1,64}$/;

function text(x: unknown, max = 200): string | undefined {
  return typeof x === "string" && x.length <= max ? x : undefined;
}

export class TalewardServer {
  constructor(
    private readonly basis: string,
    private readonly schluessel: string,
    private readonly holen: typeof fetch = fetch,
    private readonly fassung = "0.1.0",
  ) {}

  private async anfrage(methode: string, pfad: string, koerper?: unknown, roh?: Buffer, zusatz: Record<string, string> = {}): Promise<unknown> {
    const kopf: Record<string, string> = {
      "X-Taleward-Bot": this.schluessel,
      "user-agent": `taleward-discord-bot/${this.fassung}`,
      accept: "application/json",
      "accept-language": "de",
      ...zusatz,
    };
    let body: BodyInit | null = null;
    if (roh) {
      kopf["content-type"] = "application/octet-stream";
      body = new Uint8Array(roh);
    } else if (koerper !== undefined) {
      kopf["content-type"] = "application/json";
      body = JSON.stringify(koerper);
    }
    const antwort = await this.holen(`${this.basis}/api/v1${pfad}`, { method: methode, headers: kopf, body, signal: AbortSignal.timeout(roh ? 120_000 : 15_000) });
    if (antwort.status === 204) return undefined;
    const inhalt: unknown = await antwort.json().catch(() => undefined);
    if (!antwort.ok) {
      const f = typeof inhalt === "object" && inhalt !== null ? (inhalt as Record<string, unknown>) : {};
      const details = typeof f.details === "object" && f.details !== null ? (f.details as Record<string, unknown>) : {};
      throw new ServerFehler(antwort.status, text(f.code, 60) ?? "unbekannt", text(f.message, 500) ?? `Server antwortet mit ${antwort.status}`, details);
    }
    return inhalt;
  }

  /** Ist der Server da und hat er den Bot eingeschaltet? */
  async info(): Promise<{ erreichbar: boolean; discordBot: boolean; apiVersion?: string }> {
    try {
      const antwort = await this.holen(`${this.basis}/api/v1/info`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!antwort.ok) return { erreichbar: false, discordBot: false };
      const i = (await antwort.json()) as Record<string, unknown>;
      const apiVersion = text(i.apiVersion, 20);
      return { erreichbar: true, discordBot: i.discordBot === true, ...(apiVersion ? { apiVersion } : {}) };
    } catch {
      return { erreichbar: false, discordBot: false };
    }
  }

  async linkAnfordern(guildId: string, discordUserId: string, guildName: string): Promise<{ url: string; code: string; expiresAt: string }> {
    const a = (await this.anfrage("POST", "/bot/links", { guildId, discordUserId, guildName: guildName.slice(0, 100) })) as Record<string, unknown>;
    const url = text(a.url, 500);
    const code = text(a.code, 80);
    const expiresAt = text(a.expiresAt, 40);
    if (!url || !code || !expiresAt || !url.startsWith("https://")) throw new ServerFehler(502, "antwort_unbrauchbar", "Link vom Server unbrauchbar");
    return { url, code, expiresAt };
  }

  async kampagnen(guildId: string, discordUserId: string): Promise<Kampagne[]> {
    const a = (await this.anfrage("GET", `/bot/guilds/${guildId}/campaigns?discordUserId=${encodeURIComponent(discordUserId)}`)) as Record<string, unknown>;
    const liste = Array.isArray(a.campaigns) ? a.campaigns : [];
    const aus: Kampagne[] = [];
    for (const k of liste) {
      if (typeof k !== "object" || k === null) continue;
      const r = k as Record<string, unknown>;
      const campaignId = text(r.campaignId, 64);
      const title = text(r.title, 200);
      if (!campaignId || !KENNUNG.test(campaignId) || title === undefined) continue;
      aus.push({
        campaignId,
        title,
        language: text(r.language, 10) ?? "de",
        pauseOnUnconsented: r.pauseOnUnconsented === true,
        liveSessionId: text(r.liveSessionId, 64) ?? null,
      });
    }
    return aus;
  }

  async verbindungLoesen(guildId: string, campaignId: string, discordUserId: string): Promise<void> {
    await this.anfrage("DELETE", `/bot/guilds/${guildId}/campaigns/${campaignId}?discordUserId=${encodeURIComponent(discordUserId)}`);
  }

  async bereitschaft(campaignId: string, discordUserIds: readonly string[], sessionId?: string): Promise<Bereitschaften> {
    const ids = [...new Set(discordUserIds.filter((id) => SNOWFLAKE.test(id)))].slice(0, 25);
    const aus: Bereitschaften = { states: new Map(), sessionState: null };
    if (ids.length === 0) return aus;
    const a = (await this.anfrage("POST", `/bot/campaigns/${campaignId}/readiness`, { discordUserIds: ids, ...(sessionId ? { sessionId } : {}) })) as Record<string, unknown>;
    const states = typeof a.states === "object" && a.states !== null ? (a.states as Record<string, unknown>) : {};
    for (const id of ids) {
      const s = typeof states[id] === "object" && states[id] !== null ? (states[id] as Record<string, unknown>) : {};
      const state = s.state === "ready" || s.state === "consent_required" ? s.state : "link_required";
      const attendeeId = text(s.attendeeId, 64);
      aus.states.set(id, { state, attendeeId: attendeeId && KENNUNG.test(attendeeId) ? attendeeId : null });
    }
    aus.sessionState = text(a.sessionState, 40) ?? null;
    return aus;
  }

  async rundeAnlegen(campaignId: string, guildId: string, discordUserId: string, startedAt: Date): Promise<{ sessionId: string; number: number; spurenSchluessel?: SpurenSchluessel }> {
    const a = (await this.anfrage("POST", `/bot/campaigns/${campaignId}/sessions`, { guildId, discordUserId, startedAt: startedAt.toISOString() })) as Record<string, unknown>;
    const sessionId = text(a.sessionId, 64);
    if (!sessionId || !KENNUNG.test(sessionId)) throw new ServerFehler(502, "antwort_unbrauchbar", "Runde ohne Kennung");
    const spurenSchluessel = spurenSchluesselParsen(a.trackKey);
    return { sessionId, number: typeof a.number === "number" ? a.number : 0, ...(spurenSchluessel ? { spurenSchluessel } : {}) };
  }

  async anwesend(sessionId: string, discordUserId: string): Promise<string> {
    const a = (await this.anfrage("POST", `/bot/sessions/${sessionId}/attendees`, { discordUserId })) as Record<string, unknown>;
    const attendeeId = text(a.attendeeId, 64);
    if (!attendeeId || !KENNUNG.test(attendeeId)) throw new ServerFehler(502, "antwort_unbrauchbar", "Anwesender ohne Kennung");
    return attendeeId;
  }

  async zustimmungslink(sessionId: string, discordUserId: string, displayName: string): Promise<{ url: string; expiresAt: string }> {
    const a = (await this.anfrage("POST", `/bot/sessions/${sessionId}/consent-links`, { discordUserId, displayName: displayName.slice(0, 40) })) as Record<string, unknown>;
    const url = text(a.url, 500);
    const expiresAt = text(a.expiresAt, 40);
    if (!url || !expiresAt || !url.startsWith("https://")) throw new ServerFehler(502, "antwort_unbrauchbar", "Link vom Server unbrauchbar");
    return { url, expiresAt };
  }

  async ereignis(sessionId: string, art: "pause" | "resume" | "interrupted" | "stopped" | "discarded", zeit: Date): Promise<void> {
    await this.anfrage("POST", `/bot/sessions/${sessionId}/events`, { type: art, at: zeit.toISOString() });
  }

  /**
   * Stelle merken für eine Person der laufenden Bot-Runde (Vorschlag YAML 0.4.35: POST /bot/sessions/{s}/bookmarks).
   * Der Server ordnet die Discord-Kennung dem Mitglied zu und rechnet die Zeit in der Aufnahme aus seinen Ereignissen.
   */
  async merken(sessionId: string, discordUserId: string, at: Date, note: string | null): Promise<{ offsetMs: number | null }> {
    const a = (await this.anfrage("POST", `/bot/sessions/${sessionId}/bookmarks`, { discordUserId, at: at.toISOString(), note })) as Record<string, unknown>;
    return { offsetMs: typeof a.offsetMs === "number" && Number.isFinite(a.offsetMs) && a.offsetMs >= 0 ? Math.floor(a.offsetMs) : null };
  }

  async spurVerwerfen(sessionId: string, attendeeId: string): Promise<void> {
    await this.anfrage("DELETE", `/bot/sessions/${sessionId}/tracks/${attendeeId}`);
  }

  async uploadAnlegen(sessionId: string, dateien: UploadDatei[]): Promise<UploadAngelegt> {
    const a = (await this.anfrage("POST", `/sessions/${sessionId}/uploads`, { source: "discord", files: dateien })) as Record<string, unknown>;
    const uploadId = text(a.uploadId, 64);
    const chunkSizeBytes = typeof a.chunkSizeBytes === "number" && a.chunkSizeBytes > 0 ? a.chunkSizeBytes : 0;
    const files: UploadAngelegt["files"] = [];
    for (const f of Array.isArray(a.files) ? a.files : []) {
      const r = (f ?? {}) as Record<string, unknown>;
      const fileId = text(r.fileId, 64);
      const fileName = text(r.fileName, 200);
      if (fileId && KENNUNG.test(fileId) && fileName && typeof r.chunkCount === "number") files.push({ fileId, fileName, chunkCount: r.chunkCount });
    }
    if (!uploadId || !KENNUNG.test(uploadId) || !chunkSizeBytes || files.length !== dateien.length) throw new ServerFehler(502, "antwort_unbrauchbar", "Upload-Antwort unbrauchbar");
    return { uploadId, chunkSizeBytes, files };
  }

  async teilHochladen(uploadId: string, fileId: string, index: number, teil: Buffer): Promise<void> {
    const pruefsumme = createHash("sha256").update(teil).digest("hex");
    await this.anfrage("PUT", `/uploads/${uploadId}/files/${fileId}/chunks/${index}`, undefined, teil, { "X-Chunk-SHA256": pruefsumme });
  }

  async fehlendeTeile(uploadId: string): Promise<Map<string, number[]>> {
    const a = (await this.anfrage("GET", `/uploads/${uploadId}`)) as Record<string, unknown>;
    const aus = new Map<string, number[]>();
    for (const f of Array.isArray(a.files) ? a.files : []) {
      const r = (f ?? {}) as Record<string, unknown>;
      const fileId = text(r.fileId, 64);
      if (fileId) aus.set(fileId, Array.isArray(r.missingChunks) ? r.missingChunks.filter((n): n is number => typeof n === "number") : []);
    }
    return aus;
  }

  /** Liefert true, wenn abgeschlossen; false, wenn Teile fehlen (chunks_missing) oder der Server gerade misst (429). */
  /**
   * Abschluss des Uploads. `fertig`: alles angekommen. `spaeter`: Teile fehlen oder 429, später erneut.
   * `ungueltig`: der Server hat die genannten Spuren verworfen (400 `track_invalid`), der Upload bleibt offen.
   * `geschlossen`: der Upload nimmt nichts mehr an (409 `upload_closed`), Ordner kann weg.
   */
  async uploadAbschliessen(uploadId: string): Promise<{ art: "fertig" } | { art: "spaeter" } | { art: "ungueltig"; attendeeIds: string[] } | { art: "geschlossen" }> {
    try {
      await this.anfrage("POST", `/uploads/${uploadId}/complete`);
      return { art: "fertig" };
    } catch (f) {
      if (f instanceof ServerFehler) {
        if (f.code === "chunks_missing" || f.status === 429) return { art: "spaeter" };
        if (f.status === 400 && f.code === "track_invalid") {
          const roh = Array.isArray(f.details.attendeeIds) ? f.details.attendeeIds : [];
          const attendeeIds = roh.filter((x): x is string => typeof x === "string" && KENNUNG.test(x)).slice(0, 12);
          return { art: "ungueltig", attendeeIds };
        }
        if (f.status === 409 && f.code === "upload_closed") return { art: "geschlossen" };
      }
      throw f;
    }
  }
}
