// Befehle der Helfer. Nur auf dem Taleward-Discord registriert (Gilden-Befehle).

import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { beide } from "./texte/texte.js";

export const BEFEHL = {
  faq: "faq",
  status: "taleward-status",
  rueckmeldung: "feedback",
  testerKnopf: "tester-knopf",
  taleward: "taleward",
} as const;

/** Unterbefehle von /taleward: englischer Grundname, deutsche Übersetzung. */
export const TW = {
  link: "link",
  unlink: "unlink",
  ready: "ready",
  join: "join",
  leave: "leave",
  start: "start",
  pause: "pause",
  resume: "resume",
  stop: "stop",
  discard: "discard",
  mark: "mark",
  status: "status",
  help: "help",
} as const;
const TW_DEUTSCH: Record<keyof typeof TW, string> = { link: "verbinden", unlink: "trennen", ready: "bereit", join: "beitreten", leave: "verlassen", start: "start", pause: "pause", resume: "weiter", stop: "stopp", discard: "verwerfen", mark: "merken", status: "status", help: "hilfe" };

export const KNOPF = {
  zustimmen: "tw:zustimmen",
  /** Bestätigung für /taleward verwerfen; dahinter „:<Discord-Kennung>“ der Person, die gefragt hat. */
  verwerfen: "tw:verwerfen",
  testerWerden: "tester:werden",
  testerAbgeben: "tester:abgeben",
} as const;

/** Auswahlmenüs für /taleward start bzw. trennen bei mehreren Kampagnen; dahinter „:<Discord-Kennung>“. */
export const AUSWAHL = {
  start: "tw:start",
  unlink: "tw:unlink",
} as const;

export const FORMULAR = {
  rueckmeldung: "rueckmeldung",
  feldText: "text",
  feldKontakt: "kontakt",
} as const;

export function befehlsDefinitionen(mitAufnahme = false) {
  const taleward = new SlashCommandBuilder().setName(BEFEHL.taleward).setDescription(beide("tw_befehl")["en-US"]).setDescriptionLocalizations(beide("tw_befehl"));
  for (const schluessel of Object.keys(TW) as (keyof typeof TW)[]) {
    const de = TW_DEUTSCH[schluessel];
    taleward.addSubcommand((u) => {
      u.setName(TW[schluessel])
        .setNameLocalizations({ de, "en-US": TW[schluessel], "en-GB": TW[schluessel] })
        .setDescription(beide(`tw_${schluessel}_befehl`)["en-US"])
        .setDescriptionLocalizations(beide(`tw_${schluessel}_befehl`));
      if (schluessel === "link") {
        // Als Auswahl „ja“/„yes“, damit die Texte der App (`verbinden code:ja`) wörtlich stimmen.
        u.addStringOption((o) =>
          o
            .setName("code")
            .setDescription(beide("tw_link_option_code")["en-US"])
            .setDescriptionLocalizations(beide("tw_link_option_code"))
            .addChoices({ name: "yes", name_localizations: { de: "ja", "en-US": "yes", "en-GB": "yes" }, value: "yes" }),
        );
      }
      if (schluessel === "mark") {
        u.addStringOption((o) =>
          o
            .setName("note")
            .setNameLocalizations({ de: "notiz", "en-US": "note", "en-GB": "note" })
            .setDescription(beide("tw_mark_option_notiz")["en-US"])
            .setDescriptionLocalizations(beide("tw_mark_option_notiz"))
            .setMaxLength(280),
        );
      }
      if (schluessel === "start" || schluessel === "unlink") {
        u.addStringOption((o) =>
          o
            .setName("campaign")
            .setNameLocalizations({ de: "kampagne", "en-US": "campaign", "en-GB": "campaign" })
            .setDescription(beide("tw_start_option_kampagne")["en-US"])
            .setDescriptionLocalizations(beide("tw_start_option_kampagne"))
            .setAutocomplete(true),
        );
      }
      return u;
    });
  }
  return [
    new SlashCommandBuilder()
      .setName(BEFEHL.faq)
      .setDescription(beide("faq_befehl")["en-US"])
      .setDescriptionLocalizations(beide("faq_befehl"))
      .addStringOption((o) =>
        o
          .setName("frage")
          .setNameLocalizations({ de: "frage", "en-US": "question", "en-GB": "question" })
          .setDescription(beide("faq_option_frage")["en-US"])
          .setDescriptionLocalizations(beide("faq_option_frage"))
          .setRequired(true)
          .setAutocomplete(true),
      ),
    new SlashCommandBuilder()
      .setName(BEFEHL.status)
      .setDescription(beide("status_befehl")["en-US"])
      .setDescriptionLocalizations(beide("status_befehl")),
    new SlashCommandBuilder()
      .setName(BEFEHL.rueckmeldung)
      .setNameLocalizations({ de: "rueckmeldung", "en-US": "feedback", "en-GB": "feedback" })
      .setDescription(beide("rueckmeldung_befehl")["en-US"])
      .setDescriptionLocalizations(beide("rueckmeldung_befehl")),
    new SlashCommandBuilder()
      .setName(BEFEHL.testerKnopf)
      .setDescription(beide("tester_knopf_befehl")["en-US"])
      .setDescriptionLocalizations(beide("tester_knopf_befehl"))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    ...(mitAufnahme ? [taleward] : []),
  ].map((b) => b.toJSON());
}
