import { AthenaSlash } from "../lib/athena-slash.js";
import { renderLatestAthenaInsight } from "../athena-extensions.js";
import type { Command } from "@sapphire/framework";

export class AthenaInsightCommand extends AthenaSlash {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, description: "最近一筆實相歸檔" });
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply();
    await interaction.editReply(renderLatestAthenaInsight().slice(0, 1900));
  }
}
