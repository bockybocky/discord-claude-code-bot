/**
 * AthenaBot-specific extensions. All functions no-op when PERSONA !== "athena".
 * Features:
 *   - postProcessAthenaOutput: detect <save-insight> tags and execute file writing to ai-memory
 */
import fs from "fs";
import path from "path";
import os from "os";
import type { Client } from "discord.js";

const PERSONA = process.env.PERSONA ?? "";
const IS_ATHENA = PERSONA === "athena";

// Canonical vault is D:\ai-memory (C:\Users\Charles\ai-memory is only a junction).
const AI_MEMORY = process.env.AI_MEMORY_ROOT ?? "D:\\ai-memory";
// Athena's dedicated insight memory folder
const ATHENA_INSIGHT_DIR = path.join(AI_MEMORY, "research", "athena_insights");

const SAVE_INSIGHT_RE = /<save-insight\s+topic="([^"]+)"\s*>([\s\S]*?)<\/save-insight>/gi;

export interface AthenaPostProcessResult {
  cleanedText: string;
  insightActions: Array<{ topic: string; content: string; ok: boolean; filepath?: string }>;
}

export function postProcessAthenaOutput(text: string): AthenaPostProcessResult {
  if (!IS_ATHENA) {
    return { cleanedText: text, insightActions: [] };
  }
  const insightActions: AthenaPostProcessResult["insightActions"] = [];

  let cleaned = text.replace(SAVE_INSIGHT_RE, (_m, topic: string, content: string) => {
    const cleanTopic = topic.trim().replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, "_");
    const result = saveAthenaInsight(cleanTopic, content.trim());
    insightActions.push({ topic: cleanTopic, content: content.trim(), ok: result.ok, filepath: result.filepath });
    return ""; // Remove the tag from the final discord message
  });

  return { cleanedText: cleaned.trim(), insightActions };
}

function saveAthenaInsight(topic: string, content: string): { ok: boolean, filepath?: string } {
  try {
    fs.mkdirSync(ATHENA_INSIGHT_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toISOString().slice(11, 19).replace(/:/g, "");
    const filename = `${date}_${time}_${topic}.md`;
    const filepath = path.join(ATHENA_INSIGHT_DIR, filename);
    
    const block = `# Athena Insight: ${topic}\nDate: ${date} ${time}\n\n${content}\n`;
    fs.writeFileSync(filepath, block, "utf-8");
    console.log(`[athena-ext] insight saved: ${filepath}`);
    return { ok: true, filepath };
  } catch (err) {
    console.error(`[athena-ext] failed to save insight for ${topic}:`, err);
    return { ok: false };
  }
}

export function formatAthenaActionFootnote(r: AthenaPostProcessResult): string {
  if (r.insightActions.length === 0) return "";
  const parts: string[] = [];
  for (const a of r.insightActions) {
    if (a.ok && a.filepath) {
      const filename = path.basename(a.filepath);
      parts.push(`🧠 實相歸檔成功 → \`${filename}\``);
    } else {
      parts.push(`❌ 歸檔失敗 → \`${a.topic}\``);
    }
  }
  return "\n\n---\n*" + parts.join(" · ") + "*";
}

export function renderLatestAthenaInsight(): string {
  try {
    if (!fs.existsSync(ATHENA_INSIGHT_DIR)) {
      return "⚠️ 尚無任何 Athena 歸檔紀錄。";
    }
    const files = fs.readdirSync(ATHENA_INSIGHT_DIR)
      .filter(f => f.endsWith('.md'))
      .sort();
    
    if (files.length === 0) return "⚠️ 尚無任何 Athena 歸檔紀錄。";
    
    const latest = path.join(ATHENA_INSIGHT_DIR, files[files.length - 1]);
    const content = fs.readFileSync(latest, "utf-8");
    return `🧠 **最新 Athena 實相歸檔** (${files[files.length - 1]})\n\n${content.slice(0, 1500)}`;
  } catch (err) {
    return `⚠️ 讀取 Athena 紀錄失敗：${(err as Error).message}`;
  }
}

export const ATHENA_EXT_ENABLED = IS_ATHENA;
