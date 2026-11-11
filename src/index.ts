// Taleward-Discord-Bot: Aufnahme von Online-Runden (/taleward …) und, wenn DISCORD_HEIM_GILDE gesetzt ist,
// Helfer auf dem eigenen Discord (/faq, /taleward-status, /feedback, Tester-Knopf). Mit TALEWARD_BOT_SCHLUESSEL
// spricht der Bot mit dem Taleward-Server (Schnittstelle ab 0.4.34) und arbeitet auf jedem Discord-Server, dessen
// Kampagne verbunden ist; mit AUFNAHME_LEITUNG läuft der Testmodus mit Listen nur auf dem eigenen Discord.
// Intents: Guilds, dazu GuildVoiceStates.

import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { AUSWAHL, BEFEHL, FORMULAR, KNOPF } from "./befehle.js";
import { ListenAnbindung, ServerAnbindung } from "./aufnahme/anbindung.js";
import { Aufnahmen, talewardAuswahl, talewardAutocomplete, talewardBefehl, talewardKnopf, talewardVerwerfenKnopf } from "./aufnahme/befehle.js";
import { TalewardServer } from "./server/client.js";
import { FaqQuelle, faqFinden, faqVorschlaege, kuerzen } from "./helfer/faq.js";
import { rueckmeldungAbgeben, rueckmeldungOeffnen } from "./helfer/rueckmeldung.js";
import { StatusQuelle } from "./helfer/status.js";
import { testerKnopfGedrueckt, testerKnopfSetzen } from "./helfer/tester.js";
import { konfigurationLaden } from "./konfiguration.js";
import { spracheAus, t } from "./texte/texte.js";

const konf = konfigurationLaden();
const faq = new FaqQuelle(konf.faqUrl);
const status = new StatusQuelle(konf.serverUrl, konf.githubOrg);

const anbindung = konf.aufnahme
  ? konf.aufnahme.botSchluessel
    ? new ServerAnbindung(new TalewardServer(konf.serverUrl, konf.aufnahme.botSchluessel))
    : new ListenAnbindung(konf.aufnahme.leitung ?? "", konf.aufnahme.teilnehmer)
  : undefined;
const aufnahmen = konf.aufnahme && anbindung ? new Aufnahmen(konf.aufnahme, anbindung) : undefined;
const serverBetrieb = anbindung?.art === "server";

const client = new Client({ intents: [GatewayIntentBits.Guilds, ...(aufnahmen ? [GatewayIntentBits.GuildVoiceStates] : [])] });

client.once(Events.ClientReady, (c) => {
  console.log(`Angemeldet als ${c.user.tag}.${konf.helfer ? " Helfer bereit." : ""}${aufnahmen ? (serverBetrieb ? " Aufnahme mit Taleward-Server." : " Aufnahme eingerichtet (Testmodus mit Listen).") : ""}`);
  void faq.aktuell();
  // Liegen gebliebene Spuren weiter hochladen (nach Neustart), zu alte löschen.
  void aufnahmen?.hochlader.aufnehmen();
});

client.on(Events.InteractionCreate, async (interaktion) => {
  try {
    // /taleward gibt es mit Server-Anbindung überall; die Helfer nur auf dem eigenen Discord.
    const istAufnahme = (interaktion.isChatInputCommand() || interaktion.isAutocomplete()) && interaktion.commandName === BEFEHL.taleward;
    const istZustimmen = interaktion.isButton() && interaktion.customId === KNOPF.zustimmen;
    const istVerwerfen = interaktion.isButton() && interaktion.customId.startsWith(`${KNOPF.verwerfen}:`);
    const istAuswahl = interaktion.isStringSelectMenu() && (interaktion.customId.startsWith(`${AUSWAHL.start}:`) || interaktion.customId.startsWith(`${AUSWAHL.unlink}:`));
    if (interaktion.guildId !== konf.helfer?.heimGilde && !(serverBetrieb && (istAufnahme || istZustimmen || istVerwerfen || istAuswahl))) {
      if (interaktion.isRepliable()) {
        await interaktion.reply({ content: t(spracheAus(interaktion.locale), "nur_hier"), flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaktion.isAutocomplete() && interaktion.commandName === BEFEHL.taleward) {
      await talewardAutocomplete(interaktion, aufnahmen);
      return;
    }

    if (interaktion.isAutocomplete() && interaktion.commandName === BEFEHL.faq) {
      const daten = await faq.aktuell();
      const eingabe = interaktion.options.getFocused();
      const vorschlaege = faqVorschlaege(daten, spracheAus(interaktion.locale), eingabe);
      await interaktion.respond(vorschlaege.map((e) => ({ name: e.frage, value: e.id })));
      return;
    }

    if (interaktion.isChatInputCommand()) {
      const sprache = spracheAus(interaktion.locale);
      switch (interaktion.commandName) {
        case BEFEHL.faq: {
          const daten = await faq.aktuell();
          const id = interaktion.options.getString("frage", true);
          if (daten.de.length + daten.en.length === 0) {
            await interaktion.reply({ content: t(sprache, "faq_keine_daten", { url: konf.faqSeite[sprache] }), flags: MessageFlags.Ephemeral });
            return;
          }
          const eintrag = faqFinden(daten, sprache, id);
          if (!eintrag) {
            await interaktion.reply({ content: t(sprache, "faq_unbekannt", { url: konf.faqSeite[sprache] }), flags: MessageFlags.Ephemeral });
            return;
          }
          const mehr = eintrag.link ? `\n\n${t(sprache, "faq_mehr", { url: eintrag.link })}` : "";
          await interaktion.reply({ content: kuerzen(`**${eintrag.frage}**\n${eintrag.antwort}${mehr}`, 2000), allowedMentions: { parse: [] } });
          return;
        }
        case BEFEHL.status: {
          await interaktion.deferReply();
          await interaktion.editReply({ content: await status.text(interaktion.locale), allowedMentions: { parse: [] } });
          return;
        }
        case BEFEHL.rueckmeldung:
          if (konf.helfer) await rueckmeldungOeffnen(interaktion, konf);
          return;
        case BEFEHL.testerKnopf:
          await testerKnopfSetzen(interaktion);
          return;
        case BEFEHL.taleward:
          await talewardBefehl(interaktion, aufnahmen, konf.aufnahme);
          return;
        default:
          return;
      }
    }

    if (interaktion.isButton() && interaktion.customId === KNOPF.zustimmen) {
      await talewardKnopf(interaktion, aufnahmen);
      return;
    }
    if (interaktion.isButton() && istVerwerfen) {
      await talewardVerwerfenKnopf(interaktion, aufnahmen);
      return;
    }
    if (interaktion.isStringSelectMenu() && istAuswahl) {
      await talewardAuswahl(interaktion, aufnahmen, konf.aufnahme);
      return;
    }

    if (konf.helfer && interaktion.isButton() && (interaktion.customId === KNOPF.testerWerden || interaktion.customId === KNOPF.testerAbgeben)) {
      await testerKnopfGedrueckt(interaktion, konf, konf.helfer);
      return;
    }

    if (konf.helfer && interaktion.isModalSubmit() && interaktion.customId === FORMULAR.rueckmeldung) {
      await rueckmeldungAbgeben(interaktion, client, konf, konf.helfer);
      return;
    }
  } catch (fehler) {
    console.error("interaktion:", fehler instanceof Error ? fehler.message : fehler);
    if (interaktion.isRepliable() && !interaktion.replied && !interaktion.deferred) {
      await interaktion.reply({ content: t(spracheAus(interaktion.locale), "fehler"), flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
});

// Bewegung im Sprachkanal: Spielleitung geht oder kommt zurück.
client.on(Events.VoiceStateUpdate, (alt, neu) => {
  if (!aufnahmen) return;
  const kanal = neu.channel ?? alt.channel ?? undefined;
  void aufnahmen
    .fuer(neu.guild.id)
    .aufnahme.sprachzustand(neu.id, alt.channelId, neu.channelId, kanal ?? undefined)
    .catch((f: unknown) => console.error("aufnahme:", f instanceof Error ? f.message : f));
});

client.on(Events.Error, (fehler) => console.error("discord:", fehler.message));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("Beende.");
    void (async () => {
      // Laufende Aufnahme sauber abschließen, damit keine Datei halb bleibt.
      aufnahmen?.hochlader.beenden();
      for (const a of aufnahmen?.alle() ?? []) await a.beenden("beenden").catch((f: unknown) => console.error("aufnahme:", f instanceof Error ? f.message : f));
      await client.destroy();
      process.exit(0);
    })();
  });
}

await client.login(konf.discordToken);
