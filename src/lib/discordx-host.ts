import "reflect-metadata";
import { Client } from "discordx";
import { GatewayIntentBits, type Interaction } from "discord.js";
import "../discordx/athena-buttons.js";

let host: Client | undefined;

export async function getDiscordxHost(): Promise<Client> {
  if (host) return host;
  host = new Client({
    intents: [GatewayIntentBits.Guilds],
    silent: true,
  });
  await host.build();
  return host;
}

export async function runDiscordxInteraction(interaction: Interaction): Promise<boolean> {
  const dx = await getDiscordxHost();
  const result = await dx.executeInteraction(interaction);
  return result != null;
}
