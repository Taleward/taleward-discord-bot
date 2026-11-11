// Tester-Rolle per Knopf. Der Knopf wird einmal vom Team mit /tester-knopf in einen Kanal gesetzt.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { KNOPF } from "../befehle.js";
import type { HelferKonfiguration, Konfiguration } from "../konfiguration.js";
import { spracheAus, t } from "../texte/texte.js";

export async function testerKnopfSetzen(interaktion: ChatInputCommandInteraction): Promise<void> {
  const sprache = spracheAus(interaktion.locale);
  if (!interaktion.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaktion.reply({ content: t(sprache, "nur_team"), flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaktion.channel || !interaktion.channel.isTextBased() || !("send" in interaktion.channel)) {
    await interaktion.reply({ content: t(sprache, "fehler"), flags: MessageFlags.Ephemeral });
    return;
  }
  // Die Nachricht steht für alle, darum beide Sprachen untereinander.
  const beschreibung = `${t("de", "tester_nachricht")}\n\n${t("en", "tester_nachricht")}`;
  const karte = new EmbedBuilder().setTitle(`${t("de", "tester_nachricht_titel")} / ${t("en", "tester_nachricht_titel")}`).setDescription(beschreibung);
  const reihe = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(KNOPF.testerWerden).setLabel(`${t("de", "tester_knopf_werden")} / ${t("en", "tester_knopf_werden")}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(KNOPF.testerAbgeben).setLabel(`${t("de", "tester_knopf_abgeben")} / ${t("en", "tester_knopf_abgeben")}`).setStyle(ButtonStyle.Secondary),
  );
  await interaktion.channel.send({ embeds: [karte], components: [reihe], allowedMentions: { parse: [] } });
  await interaktion.reply({ content: t(sprache, "tester_knopf_gesetzt"), flags: MessageFlags.Ephemeral });
}

export async function testerKnopfGedrueckt(interaktion: ButtonInteraction, konf: Konfiguration, helfer: HelferKonfiguration): Promise<void> {
  const sprache = spracheAus(interaktion.locale);
  if (interaktion.guildId !== helfer.heimGilde || !(interaktion.member instanceof GuildMember)) {
    await interaktion.reply({ content: t(sprache, "nur_hier"), flags: MessageFlags.Ephemeral });
    return;
  }
  const mitglied = interaktion.member;
  const hatRolle = mitglied.roles.cache.has(helfer.testerRolle);
  try {
    if (interaktion.customId === KNOPF.testerWerden) {
      if (hatRolle) {
        await interaktion.reply({ content: t(sprache, "tester_schon", { url: konf.testerSeite[sprache] }), flags: MessageFlags.Ephemeral });
        return;
      }
      await mitglied.roles.add(helfer.testerRolle, "Tester werden (Knopf)");
      await interaktion.reply({ content: t(sprache, "tester_jetzt", { url: konf.testerSeite[sprache] }), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!hatRolle) {
      await interaktion.reply({ content: t(sprache, "tester_war_nicht"), flags: MessageFlags.Ephemeral });
      return;
    }
    await mitglied.roles.remove(helfer.testerRolle, "Rolle abgeben (Knopf)");
    await interaktion.reply({ content: t(sprache, "tester_abgegeben"), flags: MessageFlags.Ephemeral });
  } catch (fehler) {
    console.error("tester: Rolle ändern fehlgeschlagen:", fehler instanceof Error ? fehler.message : fehler);
    await interaktion.reply({ content: t(sprache, "tester_fehler"), flags: MessageFlags.Ephemeral });
  }
}
