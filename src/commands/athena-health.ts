import { AthenaSlash } from "../lib/athena-slash.js";
import { getAthenaRuntime } from "../lib/athena-runtime.js";
import type { Command } from "@sapphire/framework";

export class AthenaHealthCommand extends AthenaSlash {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, description: "健康與執行政策" });
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply();
    const { life, caps } = getAthenaRuntime();
    const last = life.latestRun(interaction.channelId);
    const tail = last
      ? `\n上一跑 ${last.status}　${new Date(last.startedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`
      : "\n這個討論串還沒有跑過回合。";
    await interaction.editReply((caps.health() + tail).slice(0, 1900));
  }
}
