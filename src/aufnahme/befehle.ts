// /taleward …: Bedienung der Aufnahme, je Discord-Server eine Aufnahme (Grenze von Discord).
// Antworten nur für eine Person kommen in deren Discord-Sprache; die Namensliste und die Hinweise
// der Wache stehen für alle im Textchat des Kanals in der Sprache der Kampagne.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type StringSelectMenuInteraction,
  type VoiceBasedChannel,
} from "discord.js";
import { AUSWAHL, KNOPF, TW } from "../befehle.js";
import { Bremse } from "./bremse.js";
import { sauber } from "../helfer/status.js";
import type { AufnahmeKonfiguration } from "../konfiguration.js";
import { spracheAus, t, type Sprache } from "../texte/texte.js";
import type { Anbindung, Kontext } from "./anbindung.js";
import { Aufnahme, dauerText, type Abschluss, type Hinweisart, type Melder, type StartErgebnis } from "./aufnahme.js";
import { Hochlader } from "./hochladen.js";

const OHNE = { allowedMentions: { parse: [] as never[] } };

/** Nachricht „Aufnahme läuft: …“ im Kanal, die bei Änderungen bearbeitet wird; Hinweise als neue Nachrichten. */
export class KanalMelder implements Melder {
  private nachricht: Message | undefined;
  private kanal: VoiceBasedChannel | undefined;
  private sprache: Sprache = "de";

  setzen(nachricht: Message | undefined, kanal: VoiceBasedChannel, sprache: Sprache): void {
    this.nachricht = nachricht;
    this.kanal = kanal;
    this.sprache = sprache;
  }

  async namen(namen: string[]): Promise<void> {
    const liste = namen.map((n) => sauber(n, 40)).join(", ");
    const inhalt = { content: t(this.sprache, "tw_namen", { namen: liste }), ...OHNE };
    // Bearbeiten scheitert z. B., wenn die Nachricht gelöscht wurde: dann neu in den Kanal schreiben (D4).
    const bearbeitet = this.nachricht ? await this.nachricht.edit(inhalt).then(() => true, () => false) : false;
    if (bearbeitet) return;
    const neu = this.kanal ? await this.kanal.send(inhalt).catch(() => undefined) : undefined;
    if (neu) this.nachricht = neu;
    else console.warn("aufnahme: Namensliste im Kanal konnte nicht aktualisiert werden (kein Schreibrecht?)");
  }

  async hinweis(art: Hinweisart): Promise<void> {
    if (art === "angekommen" || art === "verworfen") {
      await this.nachricht?.edit({ content: t(this.sprache, art === "angekommen" ? "tw_angekommen" : "tw_verworfen_kanal"), ...OHNE }).catch(() => undefined);
      return;
    }
    if (!this.kanal) return;
    const ok = await this.kanal.send({ content: t(this.sprache, `tw_hinweis_${art}`), ...OHNE }).then(() => true, () => false);
    if (!ok) console.warn(`aufnahme: Hinweis „${art}“ konnte nicht in den Kanal geschrieben werden (kein Schreibrecht?)`);
  }
}

interface Eintrag {
  aufnahme: Aufnahme;
  melder: KanalMelder;
  /** Ordner der letzten Aufnahme, damit „angekommen“ an die richtige Nachricht geht. */
  ordnerZuletzt?: string;
}

/** Je Discord-Server eine Aufnahme mit eigenem Melder. */
export class Aufnahmen {
  private readonly je = new Map<string, Eintrag>();
  readonly hochlader: Hochlader;
  /** Bremse für Befehle vor dem Server (D5); Anfragen laufender Aufnahmen laufen nicht darüber. */
  readonly bremse = new Bremse();

  constructor(
    private readonly konf: AufnahmeKonfiguration,
    readonly anbindung: Anbindung,
  ) {
    this.hochlader = new Hochlader(anbindung, konf.ordner, async (ordner, art) => {
      const eintrag = [...this.je.values()].find((e) => e.ordnerZuletzt === ordner);
      await eintrag?.melder.hinweis(art);
    });
  }

  /**
   * Darf dieser Befehl zum Server? Die SL einer laufenden Aufnahme auf diesem Discord-Server wird nicht gebremst
   * (Pause, Weiter, Stopp müssen immer gehen); alle anderen Befehle zählen je Person, je Discord-Server und insgesamt.
   */
  darf(guildId: string, userId: string): boolean {
    if (this.anbindung.art !== "server") return true;
    const aktiv = this.je.get(guildId)?.aufnahme.aktiv;
    if (aktiv && aktiv.leitungId === userId) return true;
    return this.bremse.pruefen(guildId, userId) === "frei";
  }

  fuer(guildId: string): Eintrag {
    const vorhanden = this.je.get(guildId);
    if (vorhanden) return vorhanden;
    const melder = new KanalMelder();
    const eintrag = { melder } as Eintrag;
    eintrag.aufnahme = new Aufnahme(this.konf, this.anbindung, melder, async (abschluss: Abschluss) => {
      eintrag.ordnerZuletzt = abschluss.ordner;
      await this.hochlader.nachEnde(abschluss);
    });
    this.je.set(guildId, eintrag);
    return eintrag;
  }

  alle(): Aufnahme[] {
    return [...this.je.values()].map((e) => e.aufnahme);
  }
}

function zustimmenZeile(sprache: Sprache): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(KNOPF.zustimmen).setLabel(t(sprache, "tw_knopf_zustimmen")).setStyle(ButtonStyle.Primary),
  );
}

function oeffnenZeile(sprache: Sprache, url: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel(t(sprache, "tw_knopf_oeffnen")).setStyle(ButtonStyle.Link).setURL(url));
}

async function sprachkanal(guild: Guild | null, userId: string): Promise<VoiceBasedChannel | undefined> {
  if (!guild) return undefined;
  const mitglied = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => undefined));
  return mitglied?.voice.channel ?? undefined;
}

function zeitText(iso: string, sprache: Sprache): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(sprache === "de" ? "de-DE" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
}

/** Kampagnen der Person auf dieser Gilde; leer = nicht Spielleitung bzw. nicht verbunden. */
/** Eine Zeile: welche Kampagnen diese Person auf diesem Discord verbunden hat (nur mit Server). */
async function verbundenText(anbindung: Anbindung, guildId: string, userId: string, sprache: Sprache): Promise<string> {
  if (anbindung.art !== "server") return t(sprache, "tw_verbunden_testmodus");
  const k = await kampagnenSicher(anbindung, guildId, userId);
  if (k === "server_fehlt") return t(sprache, "tw_server_fehlt");
  if (k.length === 0) return t(sprache, "tw_verbunden_keine");
  const titel = k.map((x) => sauber(x.titel, 80)).join(", ");
  return k.length === 1 ? t(sprache, "tw_verbunden_eine", { titel }) : t(sprache, "tw_verbunden_mehrere", { titel });
}

async function kampagnenSicher(anbindung: Anbindung, guildId: string, userId: string): Promise<Kontext[] | "server_fehlt"> {
  try {
    return await anbindung.kampagnen(guildId, userId);
  } catch {
    return "server_fehlt";
  }
}

export async function talewardAutocomplete(interaktion: AutocompleteInteraction, aufnahmen: Aufnahmen | undefined): Promise<void> {
  if (!aufnahmen || !interaktion.guildId || !aufnahmen.darf(interaktion.guildId, interaktion.user.id)) {
    await interaktion.respond([]);
    return;
  }
  const liste = await kampagnenSicher(aufnahmen.anbindung, interaktion.guildId, interaktion.user.id);
  if (liste === "server_fehlt") {
    await interaktion.respond([]);
    return;
  }
  const eingabe = interaktion.options.getFocused().toLowerCase();
  await interaktion.respond(
    liste
      .filter((k) => k.titel.toLowerCase().includes(eingabe))
      .slice(0, 25)
      .map((k) => ({ name: sauber(k.titel, 100), value: k.kampagneId })),
  );
}

export async function talewardKnopf(interaktion: ButtonInteraction, aufnahmen: Aufnahmen | undefined): Promise<void> {
  const sprache = spracheAus(interaktion.locale);
  const leise = { flags: MessageFlags.Ephemeral } as const;
  const a = aufnahmen && interaktion.guildId ? aufnahmen.fuer(interaktion.guildId).aufnahme.aktiv : undefined;
  if (!aufnahmen || !a) {
    await interaktion.reply({ content: t(sprache, "tw_zustimmen_keine"), ...leise });
    return;
  }
  if (!aufnahmen.darf(interaktion.guildId ?? "", interaktion.user.id)) {
    await interaktion.reply({ content: t(sprache, "tw_kurz_warten"), ...leise });
    return;
  }
  await interaktion.deferReply({ ...leise });
  // Zustand aus dem letzten Takt, keine neue Anfrage (D5.1): der Takt fragt ohnehin alle 30 s.
  if (aufnahmen.fuer(interaktion.guildId ?? "").aufnahme.bereitschaftAusTakt(interaktion.user.id) === "ready") {
    await interaktion.editReply({ content: t(sprache, "tw_zustimmen_schon") });
    return;
  }
  const name = interaktion.guild?.members.cache.get(interaktion.user.id)?.displayName ?? interaktion.user.displayName;
  const link = await aufnahmen.anbindung.zustimmungslink(a.sessionId, interaktion.user.id, name).catch(() => undefined);
  if (!link) {
    await interaktion.editReply({ content: t(sprache, "tw_server_fehlt") });
    return;
  }
  await interaktion.editReply({ content: t(sprache, "tw_zustimmen_link", { url: link.url }), components: [oeffnenZeile(sprache, link.url)] });
}

/** Zeit seit dem Start als h:mm:ss, für gemerkte Stellen. */
function zeitSeitStart(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/** Auswahlmenü mit den Kampagnen dieser Person (höchstens 25, Grenze von Discord); nur die fragende Person darf wählen. */
function auswahlZeile(art: keyof typeof AUSWAHL, userId: string, kampagnen: Kontext[], sprache: Sprache): ActionRowBuilder<StringSelectMenuBuilder> {
  const menue = new StringSelectMenuBuilder()
    .setCustomId(`${AUSWAHL[art]}:${userId}`)
    .setPlaceholder(t(sprache, "tw_auswahl_platzhalter"))
    .addOptions(kampagnen.slice(0, 25).map((k) => ({ label: sauber(k.titel, 100) || k.kampagneId, value: k.kampagneId.slice(0, 100) })));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menue);
}

function verwerfenZeile(userId: string, sprache: Sprache): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${KNOPF.verwerfen}:${userId}`).setLabel(t(sprache, "tw_knopf_verwerfen")).setStyle(ButtonStyle.Danger),
  );
}

function startFehlerText(ergebnis: Exclude<StartErgebnis, { ok: true }>, sprache: Sprache, konf: AufnahmeKonfiguration): string {
  switch (ergebnis.grund) {
    case "laeuft_schon":
      return t(sprache, "tw_laeuft_schon", { kanal: sauber(ergebnis.kanal ?? "?", 60) });
    case "kein_platz":
      return t(sprache, "tw_kein_platz", { frei: ergebnis.frei ?? "?" });
    case "niemand":
      return t(sprache, "tw_niemand");
    case "zu_viele":
      return t(sprache, "tw_zu_viele", { max: String(konf.maxPersonen) });
    case "server_fehlt":
      return t(sprache, "tw_server_fehlt");
    case "server_ohne_schluessel":
      return t(sprache, "tw_server_ohne_schluessel");
    default:
      return t(sprache, "tw_verbindung_fehlt");
  }
}

/**
 * Öffentliche Nachricht mit Rückfall (D4): erst in den Kanal, scheitert das (kein Schreibrecht), als öffentliche
 * Antwort auf den Befehl. Liefert die Nachricht oder undefined, wenn beides scheitert.
 */
export async function oeffentlichMitRueckfall(
  kanal: () => Promise<Message | undefined>,
  antwort: () => Promise<Message | undefined>,
): Promise<Message | undefined> {
  const erste = await kanal().catch(() => undefined);
  if (erste) return erste;
  return antwort().catch(() => undefined);
}

/**
 * Aufnahme starten und das Ergebnis melden. `fehler` geht nur an die Person, `oeffentlich` in den Textchat für alle
 * (in der Sprache der Kampagne); die öffentliche Nachricht merkt sich der Melder für spätere Änderungen.
 */
export async function startDurchfuehren(
  eintrag: Eintrag,
  anbindung: Anbindung,
  konf: AufnahmeKonfiguration,
  kontext: Kontext,
  kanal: VoiceBasedChannel,
  guild: Guild,
  userId: string,
  sprache: Sprache,
  fehler: (inhalt: string) => Promise<unknown>,
  oeffentlich: (inhalt: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] }) => Promise<Message | undefined>,
  /** Wird vor der ersten öffentlichen Nachricht aufgerufen, damit die zurückgestellte Antwort der SL schon bearbeitet ist (D4.1). */
  vorbereiten: () => Promise<unknown> = async () => undefined,
): Promise<boolean> {
  const ergebnis = await eintrag.aufnahme.start(kanal, guild, userId, kontext);
  if (!ergebnis.ok) {
    await fehler(startFehlerText(ergebnis, sprache, konf));
    return false;
  }
  await vorbereiten().catch(() => undefined);
  const ks = kontext.sprache;
  const liste = { content: t(ks, "tw_gestartet", { namen: ergebnis.namen.map((n) => sauber(n, 40)).join(", "), bis: ergebnis.loeschenBis }), ...OHNE };
  const nachricht = await oeffentlichMitRueckfall(
    () => kanal.send(liste),
    () => oeffentlich(liste),
  );
  if (!nachricht) {
    // Ohne sichtbare Liste keine Aufnahme (D4): die Rechtstexte versprechen sie allen im Kanal.
    await eintrag.aufnahme.beenden("verwerfen").catch(() => undefined);
    await fehler(t(sprache, "tw_kein_schreibrecht"));
    return false;
  }
  eintrag.melder.setzen(nachricht, kanal, ks);
  if (ergebnis.offen.length > 0 && anbindung.art === "server") {
    const offen = { content: t(ks, "tw_noch_offen", { namen: ergebnis.offen.map((n) => sauber(n, 40)).join(", ") }), components: [zustimmenZeile(ks)], ...OHNE };
    const ok = await oeffentlichMitRueckfall(
      () => kanal.send(offen),
      () => oeffentlich(offen),
    );
    if (!ok) await fehler(t(sprache, "tw_noch_offen_fehlt"));
  }
  return true;
}

/** Auswahl aus dem Kampagnen-Menü (start oder trennen). */
export async function talewardAuswahl(interaktion: StringSelectMenuInteraction, aufnahmen: Aufnahmen | undefined, konf: AufnahmeKonfiguration | undefined): Promise<void> {
  const sprache = spracheAus(interaktion.locale);
  const [, art, fuerId] = interaktion.customId.split(":");
  const guild = interaktion.guild;
  if (!aufnahmen || !konf || !guild || (art !== "start" && art !== "unlink")) {
    await interaktion.reply({ content: t(sprache, "tw_nicht_eingerichtet"), flags: MessageFlags.Ephemeral });
    return;
  }
  if (fuerId !== interaktion.user.id) {
    await interaktion.reply({ content: t(sprache, "tw_auswahl_fremd"), flags: MessageFlags.Ephemeral });
    return;
  }
  if (!aufnahmen.darf(guild.id, interaktion.user.id)) {
    await interaktion.reply({ content: t(sprache, "tw_kurz_warten"), flags: MessageFlags.Ephemeral });
    return;
  }
  await interaktion.deferUpdate();
  const userId = interaktion.user.id;
  const kampagnen = await kampagnenSicher(aufnahmen.anbindung, guild.id, userId);
  const gewaehlt = interaktion.values[0];
  const kontext = kampagnen === "server_fehlt" ? undefined : kampagnen.find((k) => k.kampagneId === gewaehlt);
  if (!kontext) {
    await interaktion.editReply({ content: t(sprache, kampagnen === "server_fehlt" ? "tw_server_fehlt" : "tw_nicht_verbunden_kampagne"), components: [] });
    return;
  }
  if (art === "unlink") {
    const geloest = await aufnahmen.anbindung.verbindungLoesen(guild.id, kontext.kampagneId, userId).then(() => true, () => false);
    await interaktion.editReply({ content: t(sprache, geloest ? "tw_unlink_ok" : "tw_server_fehlt", { titel: sauber(kontext.titel, 80) }), components: [], ...OHNE });
    return;
  }
  const kanal = await sprachkanal(guild, userId);
  if (!kanal) {
    await interaktion.editReply({ content: t(sprache, "tw_kein_sprachkanal"), components: [] });
    return;
  }
  const eintrag = aufnahmen.fuer(guild.id);
  const gestartet = await startDurchfuehren(
    eintrag,
    aufnahmen.anbindung,
    konf,
    kontext,
    kanal,
    guild,
    userId,
    sprache,
    (inhalt) => interaktion.followUp({ content: inhalt, flags: MessageFlags.Ephemeral, ...OHNE }),
    (inhalt) => interaktion.followUp({ ...inhalt, ...OHNE }),
  );
  // F4: nur bei Erfolg die Menü-Nachricht abschließen; ein Fehlertext kam als eigene Folgenachricht.
  await interaktion
    .editReply({ content: t(sprache, gestartet ? "tw_auswahl_fertig" : "tw_auswahl_nicht_gestartet", { titel: sauber(kontext.titel, 80) }), components: [], ...OHNE })
    .catch(() => undefined);
}

/** Knopf „Ja, verwerfen“: beendet die Aufnahme ohne Hochladen und löscht die Spuren. */
export async function talewardVerwerfenKnopf(interaktion: ButtonInteraction, aufnahmen: Aufnahmen | undefined): Promise<void> {
  const sprache = spracheAus(interaktion.locale);
  const leise = { flags: MessageFlags.Ephemeral } as const;
  const fuerId = interaktion.customId.split(":")[2];
  const eintrag = aufnahmen && interaktion.guildId ? aufnahmen.fuer(interaktion.guildId) : undefined;
  if (!eintrag) {
    await interaktion.reply({ content: t(sprache, "tw_nicht_eingerichtet"), ...leise });
    return;
  }
  if (fuerId !== interaktion.user.id) {
    await interaktion.reply({ content: t(sprache, "tw_auswahl_fremd"), ...leise });
    return;
  }
  const a = eintrag.aufnahme.aktiv;
  if (!a || a.leitungId !== interaktion.user.id) {
    await interaktion.update({ content: t(sprache, a ? "tw_nur_leitung_runde" : "tw_laeuft_nicht"), components: [] });
    return;
  }
  await interaktion.deferUpdate();
  const ergebnis = await eintrag.aufnahme.beenden("verwerfen");
  if (!ergebnis) {
    await interaktion.editReply({ content: t(sprache, "tw_laeuft_nicht"), components: [] });
    return;
  }
  await eintrag.melder.hinweis("verworfen");
  await interaktion.editReply({ content: t(sprache, "tw_verworfen"), components: [] });
}

export async function talewardBefehl(interaktion: ChatInputCommandInteraction, aufnahmen: Aufnahmen | undefined, konf: AufnahmeKonfiguration | undefined): Promise<void> {
  const sprache = spracheAus(interaktion.locale);
  const leise = { flags: MessageFlags.Ephemeral } as const;
  const guild = interaktion.guild;
  if (!aufnahmen || !konf || !guild) {
    await interaktion.reply({ content: t(sprache, "tw_nicht_eingerichtet"), ...leise });
    return;
  }
  const eintrag = aufnahmen.fuer(guild.id);
  const { aufnahme } = eintrag;
  const anbindung = aufnahmen.anbindung;
  const unter = interaktion.options.getSubcommand();
  const userId = interaktion.user.id;

  if (unter === TW.help) {
    await interaktion.reply({ content: t(sprache, anbindung.art === "server" ? "tw_hilfe" : "tw_hilfe_testmodus"), ...leise });
    return;
  }
  if (!aufnahmen.darf(guild.id, userId)) {
    await interaktion.reply({ content: t(sprache, "tw_kurz_warten"), ...leise });
    return;
  }

  // Für alle: Stand und eigene Bereitschaft.
  if (unter === TW.status) {
    const a = aufnahme.aktiv;
    if (!a) {
      // Ohne Aufnahme: Stand des Bots und, mit Server, welche Kampagnen dieser Person hier verbunden sind.
      await interaktion.deferReply({ ...leise });
      const kopf = t(sprache, aufnahme.zustand === "verbunden" ? "tw_status_verbunden" : "tw_laeuft_nicht");
      await interaktion.editReply({ content: `${kopf}\n${await verbundenText(anbindung, guild.id, userId, sprache)}`, ...OHNE });
      return;
    }
    const dauer = t(sprache, "tw_dauer", dauerText(Date.now() - a.beginn));
    const namen = aufnahme.namen().map((n) => sauber(n, 40)).join(", ");
    const kanal = sauber(a.kanalName, 60);
    const kampagne = sauber(a.kontext.titel, 80);
    const text = a.pausiert ? t(sprache, "tw_status_pause", { dauer, kanal, namen, kampagne }) : t(sprache, "tw_status_laeuft", { dauer, kanal, namen, kampagne, bis: a.loeschenBis });
    await interaktion.reply({ content: text, ...OHNE, ...leise });
    return;
  }
  if (unter === TW.mark) {
    const a = aufnahme.aktiv;
    if (!a) {
      await interaktion.reply({ content: t(sprache, "tw_laeuft_nicht"), ...leise });
      return;
    }
    await interaktion.deferReply({ ...leise });
    const notiz = sauber(interaktion.options.getString("note") ?? "", 280) || null;
    const m = await aufnahme.merken(userId, notiz).catch(() => undefined);
    if (!m) {
      await interaktion.editReply({ content: t(sprache, "tw_server_fehlt") });
      return;
    }
    const text =
      m.ergebnis === "ok"
        ? t(sprache, "tw_gemerkt", { zeit: zeitSeitStart(m.zeitMs) }) + (notiz ? `\n${notiz}` : "")
        : t(sprache, m.ergebnis === "gast" ? "tw_merken_gast" : m.ergebnis === "zu_viele" ? "tw_merken_zu_viele" : m.ergebnis === "keine_aufnahme" ? "tw_laeuft_nicht" : "tw_merken_nicht_dabei");
    await interaktion.editReply({ content: text, ...OHNE });
    return;
  }
  if (unter === TW.ready) {
    const a = aufnahme.aktiv;
    if (!a) {
      await interaktion.reply({ content: t(sprache, "tw_ready_ohne_aufnahme"), ...leise });
      return;
    }
    await interaktion.deferReply({ ...leise });
    // Zustand aus dem letzten Takt, keine neue Anfrage (D5.1).
    if (aufnahme.bereitschaftAusTakt(userId) === "ready") {
      await interaktion.editReply({ content: t(sprache, "tw_ready_ok", { titel: sauber(a.kontext.titel, 80) }), ...OHNE });
      return;
    }
    const name = guild.members.cache.get(userId)?.displayName ?? interaktion.user.displayName;
    const link = await anbindung.zustimmungslink(a.sessionId, userId, name).catch(() => undefined);
    if (!link) {
      await interaktion.editReply({ content: t(sprache, "tw_server_fehlt") });
      return;
    }
    await interaktion.editReply({ content: t(sprache, "tw_ready_link", { url: link.url }), components: [oeffnenZeile(sprache, link.url)] });
    return;
  }

  // Verbinden geht vor der Prüfung „Spielleitung?“ – genau damit wird man es erst.
  if (unter === TW.link) {
    await interaktion.deferReply({ ...leise });
    const link = await anbindung.verbindungslink(guild.id, userId, guild.name).catch(() => "server_fehlt" as const);
    if (link === "server_fehlt") {
      await interaktion.editReply({ content: t(sprache, "tw_server_fehlt") });
      return;
    }
    if (!link) {
      await interaktion.editReply({ content: t(sprache, "tw_link_testmodus") });
      return;
    }
    const mitCode = interaktion.options.getString("code") === "yes";
    const text =
      t(sprache, "tw_link_antwort", { url: link.url, bis: zeitText(link.expiresAt, sprache) }) +
      (mitCode ? `\n${t(sprache, "tw_link_code", { code: link.code })}` : "") +
      `\n${await verbundenText(anbindung, guild.id, userId, sprache)}`;
    await interaktion.editReply({ content: text, components: [oeffnenZeile(sprache, link.url)], ...OHNE });
    return;
  }

  // Alles andere darf nur, wer hier eine Kampagne leitet.
  // Antworten nur für die Person; Ausnahmen: stopp (alle sollen es sehen) – der Start meldet sich öffentlich über eine eigene Nachricht.
  await interaktion.deferReply(unter === TW.stop ? {} : { ...leise });
  const kampagnen = await kampagnenSicher(anbindung, guild.id, userId);
  if (kampagnen === "server_fehlt") {
    await interaktion.editReply({ content: t(sprache, "tw_server_fehlt") });
    return;
  }
  if (kampagnen.length === 0) {
    await interaktion.editReply({ content: t(sprache, anbindung.art === "server" ? "tw_nicht_verbunden_kampagne" : "tw_nur_leitung") });
    return;
  }
  // Läuft eine Aufnahme, darf nur die Spielleitung dieser Runde eingreifen (P5.4), nicht jede SL einer anderen Kampagne.
  if (aufnahme.aktiv && aufnahme.aktiv.leitungId !== userId && unter !== TW.start) {
    await interaktion.editReply({ content: t(sprache, "tw_nur_leitung_runde") });
    return;
  }

  switch (unter) {
    case TW.unlink: {
      const gewuenscht = interaktion.options.getString("campaign");
      const k = gewuenscht ? kampagnen.find((x) => x.kampagneId === gewuenscht) : kampagnen.length === 1 ? kampagnen[0] : undefined;
      if (!k) {
        await interaktion.editReply({ content: t(sprache, "tw_welche_kampagne_trennen"), components: [auswahlZeile("unlink", userId, kampagnen, sprache)] });
        return;
      }
      const geloest = await anbindung.verbindungLoesen(guild.id, k.kampagneId, userId).then(() => true, () => false);
      await interaktion.editReply({ content: t(sprache, geloest ? "tw_unlink_ok" : "tw_server_fehlt", { titel: sauber(k.titel, 80) }), ...OHNE });
      return;
    }
    case TW.join: {
      const kanal = await sprachkanal(guild, userId);
      if (!kanal) {
        await interaktion.editReply({ content: t(sprache, "tw_kein_sprachkanal") });
        return;
      }
      const e = await aufnahme.beitreten(kanal, guild);
      const text = e === "ok" ? "tw_beigetreten" : e === "laeuft_schon" ? "tw_laeuft_schon" : "tw_verbindung_fehlt";
      await interaktion.editReply({ content: t(sprache, text, { kanal: sauber(aufnahme.aktiv?.kanalName ?? "?", 60) }), ...OHNE });
      return;
    }
    case TW.leave: {
      const e = aufnahme.verlassen();
      await interaktion.editReply({ content: t(sprache, e === "ok" ? "tw_verlassen" : e === "laeuft" ? "tw_verlassen_laeuft" : "tw_nicht_verbunden") });
      return;
    }
    case TW.start: {
      const kanal = await sprachkanal(guild, userId);
      if (!kanal) {
        await interaktion.editReply({ content: t(sprache, "tw_kein_sprachkanal") });
        return;
      }
      const gewuenscht = interaktion.options.getString("campaign");
      const kontext = gewuenscht ? kampagnen.find((k) => k.kampagneId === gewuenscht) : kampagnen.length === 1 ? kampagnen[0] : undefined;
      if (!kontext) {
        // Mehrere Kampagnen: Auswahlmenü nur für diese Person.
        await interaktion.editReply({ content: t(sprache, "tw_welche_kampagne"), components: [auswahlZeile("start", userId, kampagnen, sprache)] });
        return;
      }
      // Sichtbar für alle im Textchat, in der Sprache der Kampagne: wer aufgenommen wird; wird bei Änderungen bearbeitet.
          const gestartet = await startDurchfuehren(
        eintrag,
        anbindung,
        konf,
        kontext,
        kanal,
        guild,
        userId,
        sprache,
        (inhalt) => interaktion.editReply({ content: inhalt, ...OHNE }),
        (inhalt) => interaktion.followUp({ ...inhalt, ...OHNE }),
        // D4.1: Die zurückgestellte Antwort zuerst bearbeiten, sonst würde die erste Folgenachricht sie ersetzen und
        // deren Ephemeral-Eigenschaft erben – die Liste sähe dann nur die SL.
        () => interaktion.editReply({ content: t(sprache, "tw_start_laeuft_an", { titel: sauber(kontext.titel, 80) }), ...OHNE }),
      );
      // F4: Fehlertexte des Starts stehen in der Antwort und bleiben stehen; nur bei Erfolg „siehe Liste im Kanal“.
      if (gestartet) await interaktion.editReply({ content: t(sprache, "tw_auswahl_fertig", { titel: sauber(kontext.titel, 80) }), ...OHNE }).catch(() => undefined);
      return;
    }
    case TW.pause: {
      const e = await aufnahme.pause("hand");
      await interaktion.editReply({ content: t(sprache, e === "ok" ? "tw_pausiert" : e === "schon_pause" ? "tw_schon_pause" : "tw_laeuft_nicht") });
      return;
    }
    case TW.resume: {
      const e = await aufnahme.weiter();
      await interaktion.editReply({ content: t(sprache, e === "ok" ? "tw_weiter" : e === "keine_pause" ? "tw_keine_pause" : "tw_laeuft_nicht") });
      return;
    }
    case TW.discard: {
      if (!aufnahme.aktiv) {
        await interaktion.editReply({ content: t(sprache, "tw_laeuft_nicht") });
        return;
      }
      await interaktion.editReply({ content: t(sprache, "tw_verwerfen_frage", { titel: sauber(aufnahme.aktiv.kontext.titel, 80) }), components: [verwerfenZeile(userId, sprache)], ...OHNE });
      return;
    }
    case TW.stop: {
      if (!aufnahme.aktiv) {
        await interaktion.editReply({ content: t(sprache, "tw_laeuft_nicht") });
        return;
      }
      const ergebnis = await aufnahme.beenden("stopp");
      if (!ergebnis) {
        await interaktion.editReply({ content: t(sprache, "tw_laeuft_nicht") });
        return;
      }
      const dauer = t(sprache, "tw_dauer", dauerText(ergebnis.dauerMs));
      const text = ergebnis.sessionId
        ? t(sprache, "tw_hochladen_laeuft", { dauer })
        : t(sprache, "tw_beendet", { dauer, spuren: String(ergebnis.spuren.length), ordner: ergebnis.ordner });
      await interaktion.editReply({ content: text, ...OHNE });
      return;
    }
    default:
      return;
  }
}
