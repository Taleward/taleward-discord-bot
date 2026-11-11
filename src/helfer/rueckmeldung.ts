// /rueckmeldung: Formular in Discord, Antwort geht in den privaten Kanal.
// Der Bot speichert nichts. Sicherheitsmeldungen gehören per E-Mail an das Team.

import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  type Client,
} from "discord.js";
import { FORMULAR } from "../befehle.js";
import type { HelferKonfiguration, Konfiguration } from "../konfiguration.js";
import { spracheAus, t } from "../texte/texte.js";
import { sauber } from "./status.js";

export async function rueckmeldungOeffnen(interaktion: ChatInputCommandInteraction, konf: Konfiguration): Promise<void> {
  const sprache = spracheAus(interaktion.locale);
  const formular = new ModalBuilder().setCustomId(FORMULAR.rueckmeldung).setTitle(t(sprache, "rueckmeldung_titel"));
  const text = new TextInputBuilder()
    .setCustomId(FORMULAR.feldText)
    .setLabel(t(sprache, "rueckmeldung_feld_text"))
    .setPlaceholder(t(sprache, "rueckmeldung_feld_text_hinweis", { mail: konf.sicherheitsMail }).slice(0, 100))
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(1500);
  const kontakt = new TextInputBuilder()
    .setCustomId(FORMULAR.feldKontakt)
    .setLabel(t(sprache, "rueckmeldung_feld_kontakt"))
    .setPlaceholder(t(sprache, "rueckmeldung_feld_kontakt_hinweis"))
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100);
  formular.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(text),
    new ActionRowBuilder<TextInputBuilder>().addComponents(kontakt),
  );
  await interaktion.showModal(formular);
}

export async function rueckmeldungAbgeben(interaktion: ModalSubmitInteraction, client: Client, konf: Konfiguration, helfer: HelferKonfiguration): Promise<void> {
  const sprache = spracheAus(interaktion.locale);
  const text = sauber(interaktion.fields.getTextInputValue(FORMULAR.feldText), 1500);
  const kontaktRoh = interaktion.fields.getTextInputValue(FORMULAR.feldKontakt);
  const kontakt = kontaktRoh ? sauber(kontaktRoh, 100) : "";
  try {
    const kanal = await client.channels.fetch(helfer.rueckmeldungKanal);
    if (!kanal || !kanal.isTextBased() || !("send" in kanal)) throw new Error("Rückmeldekanal nicht gefunden oder kein Textkanal");
    // Die Person wird nur mit Name und Kennung genannt, damit das Team antworten kann. Keine Erwähnung.
    const name = sauber(interaktion.user.username, 40);
    const eingang = new EmbedBuilder()
      .setTitle(t("de", "rueckmeldung_eingang", { name: `${name} (${interaktion.user.id})` }))
      .setDescription(text)
      .setFooter({ text: kontakt ? t("de", "rueckmeldung_eingang_kontakt", { kontakt }) : t("de", "rueckmeldung_eingang_kein_kontakt") })
      .setTimestamp(new Date());
    await kanal.send({ embeds: [eingang], allowedMentions: { parse: [] } });
    await interaktion.reply({ content: t(sprache, "rueckmeldung_danke"), flags: MessageFlags.Ephemeral });
  } catch (fehler) {
    console.error("rueckmeldung: senden fehlgeschlagen:", fehler instanceof Error ? fehler.message : fehler);
    await interaktion.reply({ content: t(sprache, "rueckmeldung_fehler", { mail: konf.sicherheitsMail }), flags: MessageFlags.Ephemeral });
  }
}
