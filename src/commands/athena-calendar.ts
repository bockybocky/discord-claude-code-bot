import { AthenaSlash } from "../lib/athena-slash.js";
import { getAthenaRuntime } from "../lib/athena-runtime.js";
import type { Command } from "@sapphire/framework";

export class AthenaCalendarCommand extends AthenaSlash {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, description: "建立行事曆草稿" });
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });
    const drafted = getAthenaRuntime().caps.draftCalendar({
      userId: interaction.user.id,
      channelId: interaction.channelId,
      summary: interaction.options.getString("summary", true),
      start: interaction.options.getString("start", true),
      duration: interaction.options.getInteger("duration") ?? 60,
      location: interaction.options.getString("location") ?? "",
    });
    await interaction.editReply(drafted.preview);
  }
}
