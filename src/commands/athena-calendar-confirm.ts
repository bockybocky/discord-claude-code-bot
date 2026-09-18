import { AthenaSlash } from "../lib/athena-slash.js";
import { getAthenaRuntime } from "../lib/athena-runtime.js";
import type { Command } from "@sapphire/framework";

export class AthenaCalendarConfirmCommand extends AthenaSlash {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, description: "確認寫入行事曆" });
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply();
    const text = await getAthenaRuntime().caps.confirmCalendar(
      interaction.options.getString("draft", true),
      interaction.user.id,
      interaction.channelId,
    );
    await interaction.editReply(text.slice(0, 1900));
  }
}
