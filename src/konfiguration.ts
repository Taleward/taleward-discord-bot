// Einstellungen aus der Umgebung (.env). Geheimnisse kommen nie ins Repo.

export interface Konfiguration {
  /** Bot-Schlüssel aus dem Discord-Entwicklerportal. Geheim. */
  discordToken: string;
  /** Anwendungs-ID der Discord-Anwendung. */
  anwendungId: string;
  /**
   * Helfer für den eigenen Discord-Server (/faq, /taleward-status, /feedback, Tester-Knopf). Fehlt, wenn
   * DISCORD_HEIM_GILDE nicht gesetzt ist – dann gibt es nur /taleward (Aufnahme mit Taleward-Server).
   */
  helfer?: HelferKonfiguration;
  /** Adresse des Taleward-Servers, zu dem der Bot gehört */
  serverUrl: string;
  /** Adresse der faq.json auf der Website. */
  faqUrl: string;
  /** Seite mit allen Fragen und Antworten, je Sprache. */
  faqSeite: Record<"de" | "en", string>;
  /** Seite mit der Anleitung für Tester, je Sprache. */
  testerSeite: Record<"de" | "en", string>;
  /** Adresse für Sicherheitsmeldungen. */
  sicherheitsMail: string;
  /** GitHub-Organisation für die Fassungen. */
  githubOrg: string;
  /** Aufnahme (Testmodus mit Listen). Fehlt, wenn AUFNAHME_LEITUNG nicht gesetzt ist. */
  aufnahme?: AufnahmeKonfiguration;
}

export interface HelferKonfiguration {
  /** Discord-Server (Gilde), auf dem die Helfer registriert sind. */
  heimGilde: string;
  /** Rolle „Tester“ auf diesem Discord-Server. */
  testerRolle: string;
  /** Privater Kanal, in den Rückmeldungen gehen. */
  rueckmeldungKanal: string;
}

export interface AufnahmeKonfiguration {
  /** Bot-Schlüssel des Taleward-Servers (Verwaltung → Discord-Bot). Geheim. Gesetzt = Server-Betrieb. */
  botSchluessel?: string;
  /** Testmodus (ohne Bot-Schlüssel): Discord-Kennung der Spielleitung. Nur sie startet, hält an und beendet. */
  leitung?: string;
  /** Testmodus: Discord-Kennungen der Personen mit schriftlicher Zustimmung. Nur sie werden aufgenommen. */
  teilnehmer: string[];
  /** Ordner für die Aufnahmen (eigener Datenträger im Container). */
  ordner: string;
  /** Höchstzahl aufgenommener Personen. */
  maxPersonen: number;
  /** Mindestens so viele GB müssen frei sein, sonst startet keine Aufnahme. */
  minFreiGb: number;
}

export const AUFNAHME_MAX_PERSONEN = 12;

function pflicht(env: NodeJS.ProcessEnv, name: string): string {
  const wert = env[name]?.trim();
  if (!wert) throw new Error(`Einstellung fehlt: ${name} (siehe .env.example)`);
  return wert;
}

function optional(env: NodeJS.ProcessEnv, name: string, standard: string): string {
  const wert = env[name]?.trim();
  return wert ? wert : standard;
}

function httpsAdresse(wert: string, name: string, ohneEndstrich = false): string {
  let url: URL;
  try {
    url = new URL(wert);
  } catch {
    throw new Error(`Einstellung ${name} ist keine Adresse: ${wert}`);
  }
  if (url.protocol !== "https:") throw new Error(`Einstellung ${name} muss mit https:// beginnen`);
  if (url.username || url.password) throw new Error(`Einstellung ${name} darf keine Zugangsdaten enthalten`);
  const text = url.toString();
  return ohneEndstrich ? text.replace(/\/$/, "") : text;
}

function kennung(wert: string, name: string): string {
  if (!/^\d{15,22}$/.test(wert)) throw new Error(`Einstellung ${name} ist keine Discord-Kennung (nur Ziffern)`);
  return wert;
}

// Die alten Namen PROBE_* aus der Erprobung gelten weiter.
function aufnahmeLaden(env: NodeJS.ProcessEnv): AufnahmeKonfiguration | undefined {
  const botSchluessel = env.TALEWARD_BOT_SCHLUESSEL?.trim();
  const leitung = (env.AUFNAHME_LEITUNG ?? env.PROBE_LEITUNG)?.trim();
  if (!botSchluessel && !leitung) return undefined;
  if (botSchluessel && leitung) throw new Error("Entweder TALEWARD_BOT_SCHLUESSEL (Server) oder AUFNAHME_LEITUNG (Testmodus), nicht beides");
  if (botSchluessel && botSchluessel.length < 20) throw new Error("TALEWARD_BOT_SCHLUESSEL ist zu kurz");
  const teilnehmer = [...new Set((env.AUFNAHME_TEILNEHMER ?? env.PROBE_TEILNEHMER ?? "").split(/[\s,;]+/).filter((x) => x !== ""))];
  if (leitung && teilnehmer.length === 0) throw new Error("Einstellung fehlt: AUFNAHME_TEILNEHMER (Kennungen der Personen mit Zustimmung)");
  if (teilnehmer.length > AUFNAHME_MAX_PERSONEN) throw new Error(`AUFNAHME_TEILNEHMER: höchstens ${AUFNAHME_MAX_PERSONEN} Personen`);
  const ordner = optional(env, "AUFNAHME_ORDNER", optional(env, "PROBE_ORDNER", "/aufnahmen"));
  if (!ordner.startsWith("/")) throw new Error("Einstellung AUFNAHME_ORDNER muss ein absoluter Pfad sein");
  return {
    ...(botSchluessel ? { botSchluessel } : {}),
    ...(leitung ? { leitung: kennung(leitung, "AUFNAHME_LEITUNG") } : {}),
    teilnehmer: teilnehmer.map((id) => kennung(id, "AUFNAHME_TEILNEHMER")),
    ordner,
    maxPersonen: AUFNAHME_MAX_PERSONEN,
    minFreiGb: 2,
  };
}

function helferLaden(env: NodeJS.ProcessEnv): HelferKonfiguration | undefined {
  const heimGilde = env.DISCORD_HEIM_GILDE?.trim();
  if (!heimGilde) return undefined;
  return {
    heimGilde: kennung(heimGilde, "DISCORD_HEIM_GILDE"),
    testerRolle: kennung(pflicht(env, "DISCORD_TESTER_ROLLE"), "DISCORD_TESTER_ROLLE"),
    rueckmeldungKanal: kennung(pflicht(env, "DISCORD_RUECKMELDUNG_KANAL"), "DISCORD_RUECKMELDUNG_KANAL"),
  };
}

// Mit Bot-Schlüssel ist die Serveradresse Pflicht: Der Schlüssel darf nie an einen anderen Server gehen als den,
// der ihn ausgestellt hat. Ohne Bot-Schlüssel (nur Helfer oder Testmodus) wird nichts Geheimes gesendet, dort reicht
// der Standard (Anzeige in /taleward-status).
function serverAdresse(env: NodeJS.ProcessEnv, mitBotSchluessel: boolean): string {
  const wert = env.TALEWARD_SERVER_URL?.trim();
  if (mitBotSchluessel && !wert) {
    throw new Error("Einstellung fehlt: TALEWARD_SERVER_URL – die Adresse des Taleward-Servers, der den Bot-Schlüssel ausgestellt hat (z. B. https://taleward.beispiel.de)");
  }
  return httpsAdresse(wert || "https://taleward.taleward.org", "TALEWARD_SERVER_URL", true);
}

export function konfigurationLaden(env: NodeJS.ProcessEnv = process.env): Konfiguration {
  const aufnahme = aufnahmeLaden(env);
  const helfer = helferLaden(env);
  if (!helfer && !aufnahme?.botSchluessel) {
    throw new Error("Einstellung fehlt: DISCORD_HEIM_GILDE (Helfer auf dem eigenen Discord) oder TALEWARD_BOT_SCHLUESSEL (Aufnahme mit Taleward-Server) – mindestens eins von beiden");
  }
  return {
    ...(aufnahme ? { aufnahme } : {}),
    ...(helfer ? { helfer } : {}),
    discordToken: pflicht(env, "DISCORD_TOKEN"),
    anwendungId: kennung(pflicht(env, "DISCORD_ANWENDUNG_ID"), "DISCORD_ANWENDUNG_ID"),
    serverUrl: serverAdresse(env, Boolean(aufnahme?.botSchluessel)),
    faqUrl: httpsAdresse(optional(env, "TALEWARD_FAQ_URL", "https://taleward.org/faq.json"), "TALEWARD_FAQ_URL"),
    faqSeite: {
      de: httpsAdresse(optional(env, "TALEWARD_FAQ_SEITE", "https://taleward.org/fuer-gruppen/#faq"), "TALEWARD_FAQ_SEITE"),
      en: httpsAdresse(optional(env, "TALEWARD_FAQ_SEITE_EN", "https://taleward.org/en/for-groups/#faq"), "TALEWARD_FAQ_SEITE_EN"),
    },
    testerSeite: {
      de: httpsAdresse(optional(env, "TALEWARD_TESTER_SEITE", "https://taleward.org/pilotrunden/"), "TALEWARD_TESTER_SEITE"),
      en: httpsAdresse(optional(env, "TALEWARD_TESTER_SEITE_EN", "https://taleward.org/en/pilot-tables/"), "TALEWARD_TESTER_SEITE_EN"),
    },
    sicherheitsMail: optional(env, "TALEWARD_SICHERHEITS_MAIL", "info@taleward.org"),
    githubOrg: optional(env, "TALEWARD_GITHUB_ORG", "Taleward"),
  };
}
