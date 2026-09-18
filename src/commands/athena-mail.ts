import { AthenaSlash } from "../lib/athena-slash.js";
import { getAthenaRuntime } from "../lib/athena-runtime.js";
import type { Command } from "@sapphire/framework";

export class AthenaMailCommand extends AthenaSlash {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, description: "建立寄信草稿" });
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });
    const drafted = getAthenaRuntime().caps.draftMail({
      userId: interaction.user.id,
      channelId: interaction.channelId,
      to: interaction.options.getString("to", true),
      subject: interaction.options.getString("subject", true),
      text: interaction.options.getString("text", true),
    });
    await interaction.editReply(drafted.preview);
  }
}
