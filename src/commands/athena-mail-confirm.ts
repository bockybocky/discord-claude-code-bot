import { AthenaSlash } from "../lib/athena-slash.js";
import { getAthenaRuntime } from "../lib/athena-runtime.js";
import type { Command } from "@sapphire/framework";

export class AthenaMailConfirmCommand extends AthenaSlash {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, description: "確認寄出信件" });
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply();
    const text = await getAthenaRuntime().caps.confirmMail(
      interaction.options.getString("draft", true),
      interaction.user.id,
      interaction.channelId,
    );
    await interaction.editReply(text.slice(0, 1900));
  }
}
