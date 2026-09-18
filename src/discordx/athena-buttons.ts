import { ButtonComponent, Discord } from "discordx";
import type { ButtonInteraction } from "discord.js";
import { getAthenaRuntime } from "../lib/athena-runtime.js";

@Discord()
export class AthenaConfirmButtons {
  @ButtonComponent({ id: /^athcal_ok_/ })
  async calendarOk(interaction: ButtonInteraction) {
    await this.confirm(interaction, "cal");
  }

  @ButtonComponent({ id: /^athcal_no_/ })
  async calendarNo(interaction: ButtonInteraction) {
    await this.cancel(interaction, "cal");
  }

  @ButtonComponent({ id: /^athmail_ok_/ })
  async mailOk(interaction: ButtonInteraction) {
    await this.confirm(interaction, "mail");
  }

  @ButtonComponent({ id: /^athmail_no_/ })
  async mailNo(interaction: ButtonInteraction) {
    await this.cancel(interaction, "mail");
  }

  private draftId(interaction: ButtonInteraction, prefix: string): string {
    return interaction.customId.slice(prefix.length);
  }

  private async cancel(interaction: ButtonInteraction, kind: "cal" | "mail") {
    const { life } = getAthenaRuntime();
    const draftId = this.draftId(interaction, kind === "cal" ? "athcal_no_" : "athmail_no_");
    const cancelled = life.cancelDraft(draftId, interaction.user.id, interaction.channelId);
    await interaction.update({
      content: cancelled ? "已取消，沒有寫進去。" : "草稿已失效或不屬於你。",
      components: [],
    });
  }

  private async confirm(interaction: ButtonInteraction, kind: "cal" | "mail") {
    const { caps } = getAthenaRuntime();
    const draftId = this.draftId(interaction, kind === "cal" ? "athcal_ok_" : "athmail_ok_");
    await interaction.deferUpdate();
    try {
      const text = kind === "cal"
        ? await caps.confirmCalendar(draftId, interaction.user.id, interaction.channelId)
        : await caps.confirmMail(draftId, interaction.user.id, interaction.channelId);
      await interaction.editReply({ content: text.slice(0, 1900), components: [] });
    } catch (err) {
      await interaction.editReply({
        content: `沒寫成：${(err as Error).message}`.slice(0, 1900),
        components: [],
      });
    }
  }
}
