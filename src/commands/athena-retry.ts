import { AthenaSlash } from "../lib/athena-slash.js";
import { getAthenaRuntime } from "../lib/athena-runtime.js";
import type { Command } from "@sapphire/framework";

export class AthenaRetryCommand extends AthenaSlash {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, description: "重試上一則" });
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply();
    const { life, retry } = getAthenaRuntime();
    const last = life.lastPrompt(interaction.channelId);
    if (!last) {
      await interaction.editReply("這個討論串沒有上一則可重試。");
      return;
    }
    await interaction.editReply(`重試上一則：${last.prompt.slice(0, 80)}`);
    await retry(last.prompt, interaction.user.id, interaction.channelId, interaction.user.username);
  }
}
