import { AthenaSlash } from "../lib/athena-slash.js";
import { getAthenaRuntime } from "../lib/athena-runtime.js";
import type { Command } from "@sapphire/framework";

export class AthenaAskBrainCommand extends AthenaSlash {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, description: "查 D:\\ai-memory、公司記憶與 Codex" });
  }

  public override registerApplicationCommands(): void {}

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply();
    const query = interaction.options.getString("query", true);
    const out = await getAthenaRuntime().caps.qmd(query);
    await interaction.editReply(out.slice(0, 1900));
  }
}
