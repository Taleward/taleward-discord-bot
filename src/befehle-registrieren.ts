// Registriert die Befehle einmalig. Aufruf: npm run befehle

import { REST, Routes } from "discord.js";
import { befehlsDefinitionen } from "./befehle.js";
import { konfigurationLaden } from "./konfiguration.js";

const konf = konfigurationLaden();
const rest = new REST({ version: "10" }).setToken(konf.discordToken);

// Mit Server-Anbindung gilt /taleward auf jedem Discord-Server (global, erscheint dort binnen einer Stunde);
// die Helfer bleiben auf dem eigenen Discord (DISCORD_HEIM_GILDE). Im Testmodus alles nur dort.
const serverBetrieb = konf.aufnahme?.botSchluessel !== undefined;
const alle = befehlsDefinitionen(konf.aufnahme !== undefined);
const global = serverBetrieb ? alle.filter((d) => d.name === "taleward") : [];
const gilde = konf.helfer ? (serverBetrieb ? alle.filter((d) => d.name !== "taleward") : alle) : [];
if (konf.helfer) await rest.put(Routes.applicationGuildCommands(konf.anwendungId, konf.helfer.heimGilde), { body: gilde });
await rest.put(Routes.applicationCommands(konf.anwendungId), { body: global });
console.log(`${konf.helfer ? `${gilde.length} Befehle auf dem eigenen Discord registriert` : "Keine Helfer (DISCORD_HEIM_GILDE fehlt)"}${serverBetrieb ? ", /taleward auf allen Discord-Servern" : ""}.`);
