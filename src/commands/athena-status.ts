import { AthenaSlash } from "../lib/athena-slash.js";
import { getAthenaRuntime } from "../lib/athena-runtime.js";
import type { Command } from "@sapphire/framework";

export class AthenaStatusCommand extends AthenaSlash {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, description: "Athena 活著嗎" });
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply();
    await interaction.editReply(getAthenaRuntime().caps.status().slice(0, 1900));
  }
}
