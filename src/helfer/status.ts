// /taleward-status: Ist der Taleward-Server erreichbar, welche Fassungen sind freigegeben.
// Liest nur Öffentliches: /api/v1/info des Servers (ohne Anmeldung) und die Freigaben auf GitHub.
// Eine Fassung gilt als freigegeben, wenn das Release (kein Entwurf, keine Vorabfassung)
// die Datei freigabe.txt trägt – wie beim Website-Workflow.

import { spracheAus, t, type Sprache } from "../texte/texte.js";

export interface ServerStand {
  erreichbar: boolean;
  name?: string;
  apiVersion?: string;
}

export interface Fassungen {
  app?: string;
  server?: string;
  worker?: string;
}

// Je Repo liegen zwischen zwei Freigaben oft viele Zwischenfassungen (beim Server auch box-v…), darum 40 Einträge.
const REPOS = { app: "taleward-app", server: "taleward-server", worker: "taleward-worker" } as const;
const TAG_MUSTER = /^(worker-)?v(\d+\.\d+\.\d+)$/;

export function fassungAusTag(tag: unknown): string | undefined {
  if (typeof tag !== "string") return undefined;
  const m = TAG_MUSTER.exec(tag);
  return m?.[2];
}

/** Sucht in einer GitHub-Releases-Liste die neueste freigegebene Fassung. */
export function freigegebeneFassung(releases: unknown): string | undefined {
  if (!Array.isArray(releases)) return undefined;
  const kandidaten: { zeit: number; fassung: string }[] = [];
  for (const r of releases) {
    if (typeof r !== "object" || r === null) continue;
    const { draft, prerelease, tag_name, assets, published_at } = r as Record<string, unknown>;
    if (draft === true || prerelease === true) continue;
    const fassung = fassungAusTag(tag_name);
    if (!fassung) continue;
    if (!Array.isArray(assets)) continue;
    const freigabe = assets.some((a) => typeof a === "object" && a !== null && (a as Record<string, unknown>).name === "freigabe.txt");
    if (!freigabe) continue;
    const zeit = typeof published_at === "string" ? Date.parse(published_at) : 0;
    kandidaten.push({ zeit: Number.isNaN(zeit) ? 0 : zeit, fassung });
  }
  kandidaten.sort((a, b) => b.zeit - a.zeit);
  return kandidaten[0]?.fassung;
}

export function serverStandParsen(rohdaten: unknown): ServerStand {
  if (typeof rohdaten !== "object" || rohdaten === null) return { erreichbar: true };
  const { name, apiVersion } = rohdaten as Record<string, unknown>;
  const stand: ServerStand = { erreichbar: true };
  if (typeof name === "string" && name.trim() !== "") stand.name = sauber(name, 60);
  if (typeof apiVersion === "string" && /^\d+\.\d+\.\d+$/.test(apiVersion)) stand.apiVersion = apiVersion;
  return stand;
}

/** Entfernt Steuerzeichen, Erwähnungen und Markdown aus fremdem Text. */
export function sauber(text: string, max: number): string {
  const ohne = text.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").replace(/[@*_`~|>\\]/g, "").trim();
  return ohne.length <= max ? ohne : ohne.slice(0, max - 1) + "…";
}

export function statusText(sprache: Sprache, server: ServerStand, fassungen: Fassungen): string {
  const zeilen: string[] = [t(sprache, "status_titel")];
  if (server.erreichbar) {
    zeilen.push(t(sprache, "status_server_ok", { name: server.name ?? "Taleward", version: server.apiVersion ?? "?" }));
  } else {
    zeilen.push(t(sprache, "status_server_weg"));
  }
  for (const teil of ["app", "server", "worker"] as const) {
    const name = t(sprache, `teil_${teil}`);
    const version = fassungen[teil];
    zeilen.push(version ? t(sprache, "status_fassung", { teil: name, version }) : t(sprache, "status_fassung_unbekannt", { teil: name }));
  }
  return zeilen.join("\n");
}

export class StatusQuelle {
  private fassungen: Fassungen = {};
  private fassungenUm = 0;

  constructor(
    private readonly serverUrl: string,
    private readonly githubOrg: string,
    private readonly holen: typeof fetch = fetch,
    private readonly haltbarkeitMs = 10 * 60 * 1000,
  ) {}

  async server(): Promise<ServerStand> {
    try {
      const antwort = await this.holen(`${this.serverUrl}/api/v1/info`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!antwort.ok) return { erreichbar: false };
      return serverStandParsen(await antwort.json());
    } catch {
      return { erreichbar: false };
    }
  }

  async freigaben(): Promise<Fassungen> {
    if (Date.now() - this.fassungenUm < this.haltbarkeitMs) return this.fassungen;
    const neu: Fassungen = {};
    await Promise.all(
      (Object.keys(REPOS) as (keyof typeof REPOS)[]).map(async (teil) => {
        try {
          const antwort = await this.holen(`https://api.github.com/repos/${this.githubOrg}/${REPOS[teil]}/releases?per_page=40`, {
            headers: { accept: "application/vnd.github+json", "user-agent": "taleward-discord-bot" },
            signal: AbortSignal.timeout(8000),
          });
          if (!antwort.ok) return;
          const fassung = freigegebeneFassung(await antwort.json());
          if (fassung) neu[teil] = fassung;
        } catch (fehler) {
          console.warn(`status: ${teil} nicht abrufbar:`, fehler instanceof Error ? fehler.message : fehler);
        }
      }),
    );
    // Fehlende Teile aus der letzten guten Abfrage behalten.
    this.fassungen = { ...this.fassungen, ...neu };
    this.fassungenUm = Date.now();
    return this.fassungen;
  }

  async text(locale: string | undefined): Promise<string> {
    const [server, fassungen] = await Promise.all([this.server(), this.freigaben()]);
    return statusText(spracheAus(locale), server, fassungen);
  }
}
