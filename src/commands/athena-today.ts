import { AthenaSlash } from "../lib/athena-slash.js";
import { getAthenaRuntime } from "../lib/athena-runtime.js";
import type { Command } from "@sapphire/framework";

export class AthenaTodayCommand extends AthenaSlash {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, description: "今日開工卡" });
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply();
    await interaction.editReply(getAthenaRuntime().caps.today().slice(0, 1900));
  }
}
