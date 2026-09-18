import { Client, GatewayIntentBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import 'dotenv/config'; // loads .env automatically if needed

// Usage: node export_thread.js <channel_id> <output_filename.md>
const channelId = process.argv[2];
const outputFile = process.argv[3] || 'thread_export.md';

if (!channelId) {
  console.error("請提供 Discord Thread / Channel ID。用法: node export_thread.js <channel_id> <output_filename.md>");
  process.exit(1);
}

// You can specify the exact .env file if running SelinaBot
require('dotenv').config({ path: '.env.selinabot' });

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("未在環境變數中找到 DISCORD_TOKEN");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent] });

client.once('ready', async () => {
  console.log(`[export] Logged in as ${client.user?.tag}`);
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error("找不到該頻道，或該頻道不支援文字訊息。");
      process.exit(1);
    }

    let messages = [];
    let lastId;
    
    // Fetch all messages (Discord API limits 100 per request)
    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      
      const batch = await channel.messages.fetch(options);
      if (batch.size === 0) break;
      
      messages = messages.concat(Array.from(batch.values()));
      lastId = batch.last().id;
    }

    // Sort chronologically (oldest first)
    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    // Format to Gemini friendly Markdown
    const mdLines = messages.map(m => {
      const author = m.author.bot ? `**[${m.author.username} (Bot)]**` : `**[${m.author.username}]**`;
      const date = new Date(m.createdTimestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
      return `${author} _${date}_:\n${m.content}\n`;
    });

    const outputPath = path.resolve(process.cwd(), outputFile);
    fs.writeFileSync(outputPath, mdLines.join('\n---\n\n'), 'utf-8');
    
    console.log(`[export] 成功匯出 ${messages.length} 則訊息至 ${outputPath}`);
    console.log(`你可以將此檔案移至 D:\\ai-memory\\research\\ 作為 Gemini 的記憶庫。`);
  } catch (error) {
    console.error("[export] 匯出失敗:", error);
  } finally {
    client.destroy();
  }
});

client.login(token);
