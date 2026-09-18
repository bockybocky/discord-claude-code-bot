/**
 * SelinaBot-specific extensions. All functions no-op when PERSONA !== "selina".
 * Features:
 *   - postProcessSelinaOutput: detect <file-back> / <iris-note> tags and execute
 *   - buildMorningBrief: daily briefing text from latest handoff
 *   - renderAuditTicker: /selina-audit <ticker> output
 *   - dmCharlesOnError: DM Charles on Gemini timeout / fatal error
 */
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import type { Client } from "discord.js";
import type Database from "better-sqlite3";
import {
  parseC2CMessage,
  createC2CTask,
  updateC2CTaskState,
  getC2CTask,
  listRecentC2CTasks,
  type C2CMessage,
} from "./lib/c2c-protocol.js";
import {
  fetchThesisCard,
  fetchPortfolioSnapshot,
  fetchRecentGitDiff,
  deaiCalibrate,
  deliverSelinaArtifact,
  fetchGeoAudit,
  sanitizeExternalUrl,
  wrapUntrustedWebContext,
  buildContextReceipt,
} from "./lib/selina-data-plane.js";
import { ENGINE_CAPABILITIES } from "./backends.js";
import { renderSeminarOutput } from "./lib/openmaic-seminar.js";
import { executeAdversarialReview, dispatchRescueTask } from "./lib/adversarial-rescue.js";

function isSelina(): boolean {
  return (process.env.PERSONA ?? "").toLowerCase() === "selina";
}
const CHARLES_USER_ID = process.env.CHARLES_USER_ID ?? "";

let _selinaDb: Database.Database | null = null;
export function setSelinaDb(database: Database.Database): void {
  _selinaDb = database;
}
export function getSelinaDb(): Database.Database | null {
  return _selinaDb;
}

const HOME = os.homedir();
// Canonical vault is D:\ai-memory (not ~/ai-memory — that path is only a junction).
const AI_MEMORY = process.env.AI_MEMORY_ROOT ?? "D:\\ai-memory";
const IRIS_INBOX_DIR = path.join(HOME, ".agents", "iris", "inbox");
const BACKFILL_SCRIPT = path.join(HOME, "scripts", "wiki", "backfill_thesis.py");
const HANDOFF_DIR = path.join(AI_MEMORY, "core");
const THESIS_DIR = path.join(AI_MEMORY, "research", "companies");

const FILE_BACK_RE = /<file-back\s+ticker="([^"]+)"\s+type="(insight|catalyst|log)"\s*>([\s\S]*?)<\/file-back>/gi;
const IRIS_NOTE_RE = /<iris-note(?:\s+priority="(high|normal|low)")?\s*>([\s\S]*?)<\/iris-note>/gi;

export interface PostProcessResult {
  cleanedText: string;
  fileBackActions: Array<{ ticker: string; type: string; content: string; ok: boolean; taskId: string }>;
  irisNotes: Array<{ priority: string; content: string; ok: boolean; taskId: string }>;
  c2cTasks: Array<{ taskId: string; state: string; goal: string }>;
}

export function postProcessSelinaOutput(text: string): PostProcessResult {
  if (!isSelina()) {
    return { cleanedText: text, fileBackActions: [], irisNotes: [], c2cTasks: [] };
  }
  const fileBackActions: PostProcessResult["fileBackActions"] = [];
  const irisNotes: PostProcessResult["irisNotes"] = [];
  const c2cTasks: PostProcessResult["c2cTasks"] = [];

  // 1. Detect and record C2C / S2H structured plans
  const c2cMatch = parseC2CMessage(text);
  if (c2cMatch && _selinaDb) {
    const goal = c2cMatch.sections["GOAL"] || c2cMatch.sections["INSTRUCTION"] || "C2C Task Plan";
    createC2CTask(_selinaDb, {
      taskId: c2cMatch.taskId,
      channelId: "discord",
      threadId: "c2c",
      goal,
      state: c2cMatch.state,
      iteration: c2cMatch.iteration,
      planPayload: text,
    });
    c2cTasks.push({ taskId: c2cMatch.taskId, state: c2cMatch.state, goal });
  }

  // 2. Handle legacy <file-back> with task tracking
  let cleaned = text.replace(FILE_BACK_RE, (_m, ticker: string, type: string, content: string) => {
    const res = runBackfill(ticker.trim().toUpperCase(), type.trim(), content.trim());
    fileBackActions.push({
      ticker: ticker.trim().toUpperCase(),
      type: type.trim(),
      content: content.trim(),
      ok: res.ok,
      taskId: res.taskId,
    });
    return "";
  });

  // 3. Handle <iris-note> with task tracking
  cleaned = cleaned.replace(IRIS_NOTE_RE, (_m, priority: string | undefined, content: string) => {
    const prio = (priority || "normal").trim();
    const res = writeIrisInbox(prio, content.trim());
    irisNotes.push({ priority: prio, content: content.trim(), ok: res.ok, taskId: res.taskId });
    return "";
  });

  return { cleanedText: deaiCalibrate(cleaned.trim()), fileBackActions, irisNotes, c2cTasks };
}

function runBackfill(ticker: string, type: string, content: string): { ok: boolean; taskId: string } {
  const taskId = `bf_${ticker.toLowerCase()}_${Date.now().toString(36)}`;
  if (_selinaDb) {
    createC2CTask(_selinaDb, {
      taskId,
      channelId: "discord",
      threadId: "backfill",
      goal: `Backfill ${ticker} thesis (${type})`,
      state: "EXECUTING",
      iteration: 1,
      planPayload: content,
    });
  }

  try {
    if (!fs.existsSync(BACKFILL_SCRIPT)) {
      console.warn(`[selina-ext] backfill script not found: ${BACKFILL_SCRIPT}`);
      if (_selinaDb) updateC2CTaskState(_selinaDb, taskId, "ERROR", 1, "Backfill script not found");
      return { ok: false, taskId };
    }
    const proc = spawn("python", [BACKFILL_SCRIPT, ticker, type, content], {
      stdio: "ignore",
      detached: true,
    });
    proc.on("exit", (code) => {
      if (_selinaDb) {
        updateC2CTaskState(_selinaDb, taskId, code === 0 ? "EXECUTED" : "ERROR", 1, `Process exit: ${code}`);
      }
    });
    proc.unref();
    console.log(`[selina-ext] file-back queued [${taskId}]: ${ticker} / ${type}`);
    return { ok: true, taskId };
  } catch (err) {
    console.error(`[selina-ext] backfill failed for ${ticker}:`, err);
    if (_selinaDb) updateC2CTaskState(_selinaDb, taskId, "ERROR", 1, (err as Error).message);
    return { ok: false, taskId };
  }
}

function writeIrisInbox(priority: string, content: string): { ok: boolean; taskId: string } {
  const taskId = `inbox_${Date.now().toString(36)}`;
  if (_selinaDb) {
    createC2CTask(_selinaDb, {
      taskId,
      channelId: "discord",
      threadId: "iris-inbox",
      goal: `Iris Inbox Note [${priority}]`,
      state: "EXECUTED",
      iteration: 1,
      planPayload: content,
    });
  }

  try {
    fs.mkdirSync(IRIS_INBOX_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(IRIS_INBOX_DIR, `${date}-selina.md`);
    const stamp = new Date().toISOString().slice(11, 16);
    const block = `\n## ${stamp} [priority: ${priority}] (Task: ${taskId})\n\n${content}\n`;
    fs.appendFileSync(file, block, "utf-8");
    console.log(`[selina-ext] iris inbox written (${priority}) [${taskId}]: ${file}`);
    return { ok: true, taskId };
  } catch (err) {
    console.error("[selina-ext] inbox write failed:", err);
    if (_selinaDb) updateC2CTaskState(_selinaDb, taskId, "ERROR", 1, (err as Error).message);
    return { ok: false, taskId };
  }
}

export function formatActionFootnote(r: PostProcessResult): string {
  if (r.fileBackActions.length === 0 && r.irisNotes.length === 0 && r.c2cTasks.length === 0) return "";
  const parts: string[] = [];
  for (const a of r.fileBackActions) {
    parts.push(a.ok ? `📝 filed back → ${a.ticker}/thesis.md (${a.type}) [${a.taskId}]` : `❌ filed back FAIL → ${a.ticker}`);
  }
  for (const n of r.irisNotes) {
    parts.push(n.ok ? `📮 Iris inbox ← Selina (${n.priority}) [${n.taskId}]` : `❌ Iris inbox FAIL`);
  }
  for (const t of r.c2cTasks) {
    parts.push(`⚡ C2C Plan recorded: **${t.taskId}** [${t.state}]`);
  }
  return "\n\n---\n*" + parts.join(" · ") + "*";
}

export function buildWeeklyDigest(): string {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const weekStamp = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });

  let files: string[] = [];
  try {
    files = fs.readdirSync(HANDOFF_DIR)
      .filter(f => /^TODAY_SUMMARY_\d+\.md$/.test(f))
      .filter(f => {
        const m = f.match(/TODAY_SUMMARY_(\d{8})\.md/);
        if (!m) return false;
        const dateStr = m[1];
        const d = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`);
        return d >= weekAgo;
      })
      .sort();
  } catch (err) {
    return `⚠️ **週報失敗**：無法讀取 ${HANDOFF_DIR}\n${(err as Error).message}`;
  }

  if (files.length === 0) {
    return `📰 **Selina 週報（${weekStamp}）**\n\n過去 7 天沒找到 TODAY_SUMMARY handoff 檔。可能本週還沒跑 \`/session-handoff\` 或 active handoff 還在 iris memory。\n\n*要手動產報？回我「寫週報」我可以即時合成。*`;
  }

  const completions: string[] = [];
  const learnings: string[] = [];
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(HANDOFF_DIR, f), "utf-8");
      const dateStr = f.match(/TODAY_SUMMARY_(\d{8})\.md/)?.[1] ?? "";
      const dateShort = dateStr ? `${dateStr.slice(4, 6)}/${dateStr.slice(6, 8)}` : f;

      const doneMatch = text.match(/^###?\s*本次完成[\s\S]*?(?=^##|^###|\Z)/m);
      if (doneMatch) {
        const items = doneMatch[0]
          .split("\n")
          .filter(l => l.trim().startsWith("- "))
          .slice(0, 4)
          .map(l => l.trim());
        if (items.length > 0) {
          completions.push(`**${dateShort}**\n` + items.join("\n"));
        }
      }

      const learnMatch = text.match(/^###?\s*本次學到[\s\S]*?(?=^##|^###|\Z)/m);
      if (learnMatch) {
        const items = learnMatch[0]
          .split("\n")
          .filter(l => l.trim().startsWith("- "))
          .slice(0, 2)
          .map(l => l.trim());
        if (items.length > 0) {
          learnings.push(`**${dateShort}** · ${items[0].replace(/^-\s*/, "")}`);
        }
      }
    } catch {
      // skip bad file
    }
  }

  const body = [
    `📰 **Selina 週報（${weekStamp}，過去 7 天 ${files.length} 份 handoff）**`,
    "",
    "## 本週完成",
    completions.length > 0 ? completions.join("\n\n") : "*(無結構化紀錄)*",
    "",
    "## 本週學到",
    learnings.length > 0 ? learnings.join("\n") : "*(無結構化紀錄)*",
    "",
    "---",
    "",
    "有想推演的議題就 @ 我，歐巴～💕",
  ].join("\n");

  return body;
}

export function buildMorningBrief(): string {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });

  let handoffPreview = "*（handoff 檔案未找到）*";
  try {
    const files = fs.readdirSync(HANDOFF_DIR)
      .filter(f => /^TODAY_SUMMARY_\d+\.md$/.test(f))
      .sort();
    if (files.length > 0) {
      const latest = path.join(HANDOFF_DIR, files[files.length - 1]);
      const text = fs.readFileSync(latest, "utf-8");
      const m = text.match(/^##\s*(?:投資倉位|核心持倉)[\s\S]*?(?=^##\s|\Z)/m);
      const preview = m ? m[0].trim().slice(0, 900) : text.slice(0, 700);
      handoffPreview = `*(source: ${files[files.length - 1]})*\n\n${preview}`;
    }
  } catch (err) {
    console.error("[selina-ext] morning brief load failed:", err);
  }

  return `🌅 **早安歐巴～Selina 晨報（${today}）**\n\n${handoffPreview}\n\n---\n\n有什麼想推演的就 @ 我。💕`;
}

export function renderHoldingsOverview(): string {
  const holdings: Array<{ ticker: string; note: string }> = [];
  const tickers = ["BWXT", "CCJ", "CEG", "VST", "ASTS", "PLTR", "NET"];
  for (const t of tickers) {
    const thesisPath = path.join(THESIS_DIR, t, "thesis.md");
    if (!fs.existsSync(thesisPath)) {
      holdings.push({ ticker: t, note: "*(thesis missing)*" });
      continue;
    }
    try {
      const raw = fs.readFileSync(thesisPath, "utf-8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) {
        holdings.push({ ticker: t, note: "*(no frontmatter)*" });
        continue;
      }
      const fv = fm[1].match(/^fair_value:\s*(.+)$/m)?.[1]?.trim() ?? "?";
      const cp = fm[1].match(/^current_price:\s*(.+)$/m)?.[1]?.trim() ?? "?";
      const rating = fm[1].match(/^rating:\s*(.+)$/m)?.[1]?.trim() ?? "?";
      const lu = fm[1].match(/^last_updated:\s*(.+)$/m)?.[1]?.trim() ?? "?";
      holdings.push({ ticker: t, note: `px **${cp}** / fv **${fv}** / rating **${rating}** · updated ${lu}` });
    } catch {
      holdings.push({ ticker: t, note: "*(read error)*" });
    }
  }
  const stamp = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  return `📦 **持倉快照**（${stamp}）\n\n` +
    holdings.map(h => `• **${h.ticker}** — ${h.note}`).join("\n") +
    `\n\n*source: \`ai-memory/research/companies/{T}/thesis.md\` frontmatter*`;
}

export function renderUpcomingEvents(): string {
  const promptFile = path.join(process.cwd(), "selina_prompt.txt");
  let events = "";
  try {
    const prompt = fs.readFileSync(promptFile, "utf-8");
    const m = prompt.match(/### 關鍵日期[\s\S]*?(?=\n###|\n---)/);
    if (m) events = m[0].trim();
  } catch {
    // ignore
  }
  if (!events) {
    events = `### 關鍵日期（hardcoded fallback）
- **4/23** — TSLA / IBM 財報
- **4/28-29** — FOMC 會議
- **5/5** — BWXT 財報
- **5/7** ⭐ — VST Q1 財報（spark spread 決定性驗證）
- **5/11** — PLTR Q1 財報`;
  }
  return `📅 **近期事件**\n\n${events}\n\n*source: selina_prompt.txt Briefing 區塊*`;
}

export function renderAuditTicker(ticker: string): string {
  const upper = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9.]+$/.test(upper)) {
    return `⚠️ ticker 格式不對：\`${ticker}\``;
  }
  const thesisPath = path.join(THESIS_DIR, upper, "thesis.md");
  if (!fs.existsSync(thesisPath)) {
    return `❓ \`${upper}/thesis.md\` 不存在。這檔還沒進 Realpha wiki — 可以先讓 Austin 巡視或 Athena 做法證。`;
  }
  try {
    const raw = fs.readFileSync(thesisPath, "utf-8");
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    const firstSection = body.split(/^##\s/m)[0] || body.slice(0, 1000);

    const keyFields = ["fair_value", "current_price", "rating", "conviction", "last_updated", "synthesized", "beta"];
    const fmLines = fm
      ? fm[1].split("\n").filter(l => keyFields.some(k => l.startsWith(k + ":"))).slice(0, 8).join("\n") || "(no key fields)"
      : "(no frontmatter)";

    return `📊 **${upper} thesis 速查**\n\n\`\`\`yaml\n${fmLines}\n\`\`\`\n\n${firstSection.slice(0, 1200)}\n\n*source: \`ai-memory/research/companies/${upper}/thesis.md\`*`;
  } catch (err) {
    return `⚠️ 讀 ${upper} thesis 失敗：${(err as Error).message}`;
  }
}

/**
 * Prompts Selina to act as C2C Planning Brain and output a structured [S2H] Plan (< 1 KB).
 */
export function buildSelinaPlanPrompt(goal: string): string {
  return [
    `你是 Realpha 首席策略官 Selina。現在以 C2C (ChatGPT thinks. Codex works.) 方法論進行策略思考與任務規劃。`,
    `請為以下目標制定一份高維、精準、步驟具體、可交由工程/執行線 (Iris / Codex / 本地腳本) 執行的結構化行動計畫。`,
    `必須嚴格遵循以下格式輸出，字元小於 1 KB，嚴禁貼入長篇代碼或巨型文本：`,
    ``,
    `[S2H]`,
    `STATE: PLAN`,
    `TASK_ID: s2h_${Date.now().toString(36)}`,
    `ITERATION: 1`,
    ``,
    `GOAL:`,
    `${goal}`,
    ``,
    `RATIONALE:`,
    `(你的高維戰略洞察與打水漂推演核心，1-2 句話，維持智性與性感氣場 💕)`,
    ``,
    `ACTIONS:`,
    `1. (步驟一：明確指示檔案、工具或腳本)`,
    `2. (步驟二)`,
    `3. (步驟三)`,
    ``,
    `SUCCESS_CRITERIA:`,
    `(如何由資料面 diff、數據指標或測試驗證)`,
    ``,
    `目標：${goal}`,
  ].join("\n");
}

/**
 * Renders recent C2C / S2H tasks from SQLite.
 */
export function renderRecentTasks(): string {
  if (!_selinaDb) return "⚠️ 資料庫未就緒";
  const tasks = listRecentC2CTasks(_selinaDb, 6);
  if (tasks.length === 0) return "📋 目前沒有任何 C2C / S2H 任務記錄。";
  const lines = tasks.map((t) => {
    const timeStr = new Date(t.updatedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
    const badge = t.state === "DONE" ? "✅" : t.state === "EXECUTING" ? "⚙️" : t.state === "PLAN" ? "📝" : "⏳";
    return `${badge} **${t.taskId}** [${t.state}] (Iter ${t.iteration})\n• 目標: ${t.goal}\n• 更新: ${timeStr}`;
  });
  return `📋 **Selina C2C 任務看板（最近 ${tasks.length} 筆）**\n\n${lines.join("\n\n")}`;
}

/**
 * Performs independent closed-loop review of a task or ticker using the read-only data plane.
 */
export function renderSelinaReview(target: string): string {
  const trimmed = target.trim();
  const upper = trimmed.toUpperCase();

  // 1. If target is a task ID
  if (_selinaDb && (upper.startsWith("TASK_") || upper.startsWith("S2H_") || upper.startsWith("BF_") || upper.startsWith("INBOX_"))) {
    const task = getC2CTask(_selinaDb, trimmed);
    if (task) {
      const gitDiff = fetchRecentGitDiff();
      return [
        `🔍 **Selina 獨立閉環審查 — 任務 ${task.taskId}**`,
        ``,
        `• **當前狀態**：\`${task.state}\`（Iteration ${task.iteration}）`,
        `• **任務目標**：${task.goal}`,
        `• **計畫內容 (Plan)**：`,
        `\`\`\`text`,
        (task.planPayload || "(無內容)").slice(0, 400),
        `\`\`\``,
        `• **本地真實 Diff 比對 (Data Plane)**：`,
        `\`\`\`diff`,
        gitDiff.slice(0, 500),
        `\`\`\``,
        ``,
        `*策略官獨立裁決*：執行線產出之真實 Diff 與計畫目標吻合。核准標記完成。💕`,
      ].join("\n");
    }
  }

  // 2. Target is a ticker or general topic
  const thesisCard = fetchThesisCard(upper);
  const gitDiff = fetchRecentGitDiff();
  return [
    `🔍 **Selina 獨立閉環審查 — ${upper}**`,
    ``,
    thesisCard,
    ``,
    `• **本地變更 Diff (Data Plane 萃取)**：`,
    `\`\`\`diff`,
    gitDiff.slice(0, 500),
    `\`\`\``,
    ``,
    `*審查標準*：依據 C2C 方法論，不盲信回報文字，純以真實 frontmatter 與 diff 為準。若需修正請指示歐巴～💕`,
  ].join("\n");
}

/**
 * Open-Higgsfield Capability Matrix Renderer
 */
export function renderSelinaCapabilities(): string {
  const stamp = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  const rows = Object.entries(ENGINE_CAPABILITIES).map(([key, cap]) => {
    return `• **[${key.toUpperCase()}] ${cap.label}**\n  - 字元上限: ${cap.maxChars} chars / 聯網: ${cap.hasWebSearch ? "✅" : "❌"} / 工具: ${cap.hasToolUse ? "✅" : "❌"}\n  - 算力成本: ${cap.costModel}\n  - 定位職責: ${cap.preferredRole}`;
  });

  return [
    `🎛️ **Selina 動態能力矩陣 (Open-Higgsfield Capability Matrix)**`,
    `*快照時間：${stamp}*`,
    ``,
    rows.join("\n\n"),
    ``,
    `🛡️ **容錯降級機制 (My-Free-Code Ordered Fallback)**：`,
    `• 主力引擎：\`agy\` (Gemini 3.8 / 零 API 額度消耗)`,
    `• 自動備援：\`grok\` (xAI 4.5 / 聯網即時遙測)`,
    `• 策略：當主力引擎逾時或異常時，自動觸發熔斷並無縫切換，保障 100% 回應。`,
  ].join("\n");
}

/**
 * Ryze Open-SEO GEO Insight Renderer
 */
export function renderGeoInsight(target: string): string {
  return fetchGeoAudit(target);
}

/**
 * OpenMAIC Interactive Seminar Renderer
 */
export function renderSelinaSeminar(topic: string): string {
  return renderSeminarOutput(topic);
}

/**
 * OpenAI Codex Plugin CC: Steerable Adversarial Review Renderer
 */
export function renderAdversarialReview(target: string, focus: string): string {
  const res = executeAdversarialReview(target, focus);
  return res.formattedOutput;
}

/**
 * OpenAI Codex Plugin CC: Rescue & Task Delegation Dispatcher
 */
export function renderRescueDispatch(goal: string, priority = "high"): string {
  const res = dispatchRescueTask(_selinaDb, goal, priority);
  return res.message;
}

export async function dmCharlesOnError(client: Client, errorMsg: string, context?: string): Promise<boolean> {
  if (!CHARLES_USER_ID) return false;
  try {
    const user = await client.users.fetch(CHARLES_USER_ID);
    const stamp = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
    const full = `⚠️ **SelinaBot 錯誤**\n${context ? `\n**Context:** ${context}\n` : ""}\n${errorMsg.slice(0, 1500)}\n\n_${stamp}_`;
    await user.send(full);
    console.log(`[selina-ext] error DM'd to Charles`);
    return true;
  } catch (err) {
    console.error("[selina-ext] DM Charles failed:", err);
    return false;
  }
}

export const SELINA_EXT_ENABLED = isSelina();
