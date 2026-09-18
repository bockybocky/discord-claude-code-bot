/**
 * Candidate #5 — Discord control-plane registry.
 * New Athena commands live here so index.ts if-chain does not keep growing.
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { SessionLifecycle } from "./session-lifecycle.js";
import type { createAthenaCapabilities } from "./capabilities.js";

export function extraAthenaSlashCommands() {
  return [
    new SlashCommandBuilder().setName("athena-retry").setDescription("重試這個討論串上一則問題"),
    new SlashCommandBuilder().setName("athena-health").setDescription("後端＋執行政策＋上一跑健康檢查"),
    new SlashCommandBuilder()
      .setName("athena-calendar")
      .setDescription("建立行事曆草稿（確認後才寫）")
      .addStringOption((o) => o.setName("summary").setDescription("標題").setRequired(true))
      .addStringOption((o) => o.setName("start").setDescription("開始時間，例如 2026-08-20T15:00:00+08:00").setRequired(true))
      .addIntegerOption((o) => o.setName("duration").setDescription("分鐘，預設 60").setMinValue(15).setMaxValue(1440))
      .addStringOption((o) => o.setName("location").setDescription("地點")),
    new SlashCommandBuilder()
      .setName("athena-calendar-confirm")
      .setDescription("確認並寫入行事曆草稿")
      .addStringOption((o) => o.setName("draft").setDescription("草稿編號").setRequired(true)),
    new SlashCommandBuilder()
      .setName("athena-mail")
      .setDescription("建立寄信草稿（確認後才寄）")
      .addStringOption((o) => o.setName("to").setDescription("收件人").setRequired(true))
      .addStringOption((o) => o.setName("subject").setDescription("主旨").setRequired(true))
      .addStringOption((o) => o.setName("text").setDescription("內文").setRequired(true)),
    new SlashCommandBuilder()
      .setName("athena-mail-confirm")
      .setDescription("確認並寄出信件草稿")
      .addStringOption((o) => o.setName("draft").setDescription("草稿編號").setRequired(true)),
  ];
}

export const EXTRA_ATHENA_HELP = [
  "`/athena-retry` — 重試上一則",
  "`/athena-health` — 健康與執行政策",
  "`/athena-calendar` → `/athena-calendar-confirm` — 先草稿再寫日曆",
  "`/athena-mail` → `/athena-mail-confirm` — 先草稿再寄信",
].join("\n");

type Caps = ReturnType<typeof createAthenaCapabilities>;

export async function dispatchExtraAthenaCommand(opts: {
  interaction: ChatInputCommandInteraction;
  life: SessionLifecycle;
  caps: Caps;
  retry: (prompt: string) => Promise<void>;
}): Promise<boolean> {
  const { interaction, life, caps, retry } = opts;
  const name = interaction.commandName;
  if (!name.startsWith("athena-")) return false;

  if (name === "athena-health") {
    await interaction.deferReply();
    const last = life.latestRun(interaction.channelId);
    const tail = last
      ? `\n上一跑 ${last.status}　${new Date(last.startedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`
      : "\n這個討論串還沒有跑過回合。";
    await interaction.editReply((caps.health() + tail).slice(0, 1900));
    return true;
  }

  if (name === "athena-retry") {
    await interaction.deferReply();
    const last = life.lastPrompt(interaction.channelId);
    if (!last) {
      await interaction.editReply("這個討論串沒有上一則可重試。");
      return true;
    }
    await interaction.editReply(`重試上一則：${last.prompt.slice(0, 80)}`);
    await retry(last.prompt);
    return true;
  }

  if (name === "athena-calendar") {
    await interaction.deferReply({ ephemeral: true });
    const drafted = caps.draftCalendar({
      userId: interaction.user.id,
      channelId: interaction.channelId,
      summary: interaction.options.getString("summary", true),
      start: interaction.options.getString("start", true),
      duration: interaction.options.getInteger("duration") ?? 60,
      location: interaction.options.getString("location") ?? "",
    });
    await interaction.editReply(drafted.preview);
    return true;
  }

  if (name === "athena-calendar-confirm") {
    await interaction.deferReply();
    const text = await caps.confirmCalendar(
      interaction.options.getString("draft", true),
      interaction.user.id,
      interaction.channelId,
    );
    await interaction.editReply(text.slice(0, 1900));
    return true;
  }

  if (name === "athena-mail") {
    await interaction.deferReply({ ephemeral: true });
    const drafted = caps.draftMail({
      userId: interaction.user.id,
      channelId: interaction.channelId,
      to: interaction.options.getString("to", true),
      subject: interaction.options.getString("subject", true),
      text: interaction.options.getString("text", true),
    });
    await interaction.editReply(drafted.preview);
    return true;
  }

  if (name === "athena-mail-confirm") {
    await interaction.deferReply();
    const text = await caps.confirmMail(
      interaction.options.getString("draft", true),
      interaction.user.id,
      interaction.channelId,
    );
    await interaction.editReply(text.slice(0, 1900));
    return true;
  }

  return false;
}
