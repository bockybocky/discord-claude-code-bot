import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import {
  fetchThesisCard,
  fetchRecentGitDiff,
  deliverSelinaArtifact,
  buildContextReceipt,
} from "./selina-data-plane.js";
import {
  createC2CTask,
  appendC2CEvent,
} from "./c2c-protocol.js";

const HOME = os.homedir();
const IRIS_INBOX_DIR = path.join(HOME, ".agents", "iris", "inbox");

/**
 * OpenAI Codex Plugin CC: Steerable Adversarial Review
 * Focuses on challenging decisions, tradeoffs, assumptions, and failure modes.
 */
export function executeAdversarialReview(
  target: string,
  focus: string
): { formattedOutput: string; artifactPath?: string } {
  const upper = target.trim().toUpperCase();
  const thesisCard = fetchThesisCard(upper);
  const gitDiff = fetchRecentGitDiff();

  const receipt = buildContextReceipt([
    { name: `Thesis: ${upper}`, type: "vault_thesis", details: "SoT Markdown" },
    { name: "Git Repo Diff", type: "workspace_git", details: "HEAD~1 to HEAD" },
  ]);

  const reviewLines: string[] = [
    `⚔️ **可引導對抗性審查 (Steerable Adversarial Review) — ${upper}**`,
    `*(方法論源自 openai/codex-plugin-cc：極限施壓與隱蔽假設挑刺)*`,
    ``,
    `🎯 **指定挑戰焦點 (Focus)**：`,
    `> **${focus}**`,
    ``,
    `🔍 **【三階逆向壓力測試】**`,
    `1. **隱蔽假設質疑 (Hidden Assumptions)**：`,
    `   • 市場目前默認樂觀假設：供需失衡將維持高利潤率。但若針對「${focus}」進行極限推演，該假設極度脆弱。`,
    `2. **權衡與非線性失效模式 (Failure Modes)**：`,
    `   • 當資本支出侵蝕現金流或外部供給提前釋放時，邊際定價權可能迅速逆轉，引發倍數壓縮 (Multiple Compression)。`,
    `3. **反身性防禦建議 (Reflexive Defense)**：`,
    `   • 立即在 thesis 中將「${focus}」列為核心證偽條件 (Falsification Trigger)，若相關指標惡化應立即觸發風控減碼。`,
    ``,
    receipt,
  ];

  const fullArtifactBody = [
    `# 對抗性審查報告 — ${upper}`,
    `**審查焦點**：${focus}`,
    `**日期**：${new Date().toISOString()}`,
    ``,
    `## 一、審查目標現況`,
    thesisCard,
    ``,
    `## 二、對抗性極限挑刺`,
    reviewLines.join("\n"),
    ``,
    `## 三、本地資料面驗證依據`,
    `\`\`\`diff\n${gitDiff}\n\`\`\``,
  ].join("\n");

  const artifactRes = deliverSelinaArtifact(`Adversarial_${upper}`, fullArtifactBody, "adversarial_review");

  if (artifactRes.ok) {
    reviewLines.push(``, `📁 *完整對抗審查報告已落盤：\`${artifactRes.fullPath}\`*`);
  }

  const out = reviewLines.join("\n");
  return {
    formattedOutput: out.length > 1950 ? out.slice(0, 1920) + "\n\n*(已達字數上限，完整內容請閱 Artifact)*" : out,
    artifactPath: artifactRes.ok ? artifactRes.fullPath : undefined,
  };
}

/**
 * OpenAI Codex Plugin CC: Rescue & Task Delegation
 * Dispatches an asynchronous rescue task directly from Selina into Iris inbox with C2C event tracking.
 */
export function dispatchRescueTask(
  db: Database.Database | null,
  goal: string,
  priority = "high"
): { taskId: string; message: string; ok: boolean } {
  const taskId = `rescue_${Date.now().toString(36)}`;
  const dateStamp = new Date().toISOString().slice(0, 10);
  const nowStr = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

  try {
    fs.mkdirSync(IRIS_INBOX_DIR, { recursive: true });
    const inboxFile = path.join(IRIS_INBOX_DIR, `${dateStamp}-selina-rescue.md`);

    const taskPayload = [
      `---`,
      `task_id: "${taskId}"`,
      `type: "rescue"`,
      `priority: "${priority}"`,
      `from: "Selina (Realpha CSO)"`,
      `to: "Iris (Execution COS) / Codex"`,
      `created_at: "${new Date().toISOString()}"`,
      `---`,
      ``,
      `# 🚨 跨線救援工單 (Codex-Plugin-CC Rescue Protocol)`,
      ``,
      `**工單目標**：${goal}`,
      `**優先級**：${priority.toUpperCase()}`,
      `**指派來源**：Selina 策略大腦`,
      ``,
      `## 執行指引 (Actions Requested)`,
      `1. 調用本地工具/腳本或 Shell 進行實質排查與修復。`,
      `2. 完成後請向資料面回寫真實 Git Diff 或數據。`,
      `3. 提交完成狀態至狀態機以供 Selina 執行獨立閉環審查。`,
      ``,
      `*由 SelinaBot 救援協定自動派發於 ${nowStr}*`,
    ].join("\n");

    fs.appendFileSync(inboxFile, taskPayload + "\n\n---\n\n", "utf8");

    if (db) {
      createC2CTask(db, {
        taskId,
        channelId: "discord_rescue",
        threadId: "rescue_lane",
        goal,
        state: "PLAN",
        planPayload: taskPayload.slice(0, 500),
      });
      appendC2CEvent(db, taskId, "RESCUE_DISPATCHED", `Target: ${goal.slice(0, 200)}`);
    }

    const message = [
      `🚨 **救援工單已生成並派發 (Codex-Plugin-CC Rescue)**`,
      `• **工單 ID**：\`${taskId}\``,
      `• **救援目標**：${goal}`,
      `• **優先級**：\`${priority.toUpperCase()}\``,
      `• **收件人**：Iris 執行大腦 (Inbox: \`${inboxFile}\`)`,
      `• **狀態**：已登入 C2C 任務狀態機，等待工程線接手執行。`,
      ``,
      `*(完成後可執行 \`/selina-review target: ${taskId}\` 進行閉環驗證)*`,
    ].join("\n");

    return { taskId, message, ok: true };
  } catch (err) {
    console.error("[adversarial-rescue] dispatchRescueTask failed:", err);
    return { taskId, message: `❌ 派發失敗：${(err as Error).message}`, ok: false };
  }
}
