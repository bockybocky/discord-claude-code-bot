/**
 * Candidate #4 — capability adapters.
 * Grok / slash only propose; this module owns numbers, drafts, confirm, audit.
 * Calendar write never happens without an explicit confirm draft.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  renderAthenaHoldings,
  renderAthenaToday,
  renderAthenaScout,
  renderAthenaStatus,
  runAthenaQmd,
} from "./athena-mobile.js";
import { describeAthenaPolicy, type AthenaExecutionPolicy } from "./execution-policy.js";
import type { SessionLifecycle } from "./session-lifecycle.js";

const GCAL = path.join("D:\\ai-memory\\Projects\\discord-codex-bot", "scripts", "gcal-add.mjs");
const GMAIL = path.join("D:\\ai-memory\\Projects\\discord-codex-bot", "scripts", "gmail-send.mjs");

function runJsonNode(script: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).toString().slice(0, 800)));
        return;
      }
      const raw = stdout.toString().trim();
      try {
        resolve(JSON.parse(raw.split(/\r?\n/).filter(Boolean).at(-1) ?? raw));
      } catch (err) {
        reject(err);
      }
    });
    child.stdin?.end(JSON.stringify(input));
  });
}

export type CalendarParse =
  | { ok: true; summary: string; start: string }
  | { ok: false; need: string };

export type MailParse =
  | { ok: true; to: string; subject: string; text: string }
  | { ok: false; need: string };

function taipeiDate(offsetDays = 0): Date {
  const now = new Date();
  const tw = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  tw.setDate(tw.getDate() + offsetDays);
  return tw;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toTaipeiIso(d: Date, hour: number, minute: number): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:${pad(minute)}:00+08:00`;
}

/** VeraBot 手機用法：講話就排行程。缺欄位就問，不猜。 */
export function parseCalendarIntent(raw: string): CalendarParse | null {
  const t = raw.replace(/<@[!&]?\d+>/g, "").trim();
  if (!/(行事曆|加日曆|寫日曆|排進日曆|加到日曆|記行程|幫我排|schedule|calendar)/i.test(t)) {
    return null;
  }
  const iso = t.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\+\d{2}:\d{2})?)/);
  const hm = t.match(/(?:明天|後天|今日|今天)?\s*(?:下午|晚上)?\s*(\d{1,2})[:點時](\d{2})?/);
  let start = "";
  if (iso) {
    start = iso[1].length === 16 ? `${iso[1]}:00+08:00` : iso[1];
    if (!start.includes("+") && !start.endsWith("Z")) start += "+08:00";
  } else if (hm) {
    let hour = Number(hm[1]);
    const minute = Number(hm[2] ?? 0);
    if (/下午|晚上/.test(t) && hour < 12) hour += 12;
    const day = /後天/.test(t) ? 2 : /明天/.test(t) ? 1 : 0;
    start = toTaipeiIso(taipeiDate(day), hour, minute);
  }
  if (!start) {
    return { ok: false, need: "要寫行事曆可以，但缺開始時間。例如：寫行事曆 明天15:00 帶媽媽回診" };
  }
  const summary = t
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/(幫我)?(寫|加|排進|加到)?(行事曆|日曆|記行程)/g, "")
    .replace(iso?.[1] ?? "", "")
    .replace(/(明天|後天|今日|今天)/g, "")
    .replace(/(下午|晚上)?\s*\d{1,2}[:點時]\d{0,2}/g, "")
    .replace(/[:：]/g, " ")
    .trim() || "未命名行程";
  return { ok: true, summary, start };
}

export function parseMailIntent(raw: string): MailParse | null {
  const t = raw.replace(/<@[!&]?\d+>/g, "").trim();
  if (!/(寄信|寄出這封|寄gmail|send email|寄給)/i.test(t)) return null;
  const to = t.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] ?? "";
  const subject = t.match(/主旨[：:\s]+([^\n]+)/)?.[1]?.trim() ?? "";
  const body = t.match(/內文[：:\s]+([\s\S]+)/)?.[1]?.trim() ?? "";
  if (!to || !subject || !body) {
    return { ok: false, need: "要寄信可以，但收件人、主旨、內文都要有。例如：寄信給 a@b.com 主旨：會議 內文：明天下午三點見" };
  }
  return { ok: true, to, subject, text: body };
}

export function confirmButtons(kind: "cal" | "mail", draftId: string) {
  return {
    customOk: `ath${kind}_ok_${draftId}`,
    customNo: `ath${kind}_no_${draftId}`,
  };
}

export function isSensitivePath(dir: string): boolean {
  const lower = dir.replace(/\\/g, "/").toLowerCase();
  const blocked = ["/.ssh", "/.aws", "/.gnupg", "/.codex", "/.claude", "/etc/", "/root"];
  if (/(^|\/)\.env($|\.)/.test(lower)) return true;
  return blocked.some((b) => lower.includes(b));
}

export function createAthenaCapabilities(life: SessionLifecycle, policy: AthenaExecutionPolicy) {
  return {
    holdings: renderAthenaHoldings,
    today: renderAthenaToday,
    scout: renderAthenaScout,
    status: renderAthenaStatus,
    qmd: runAthenaQmd,

    health(): string {
      const last = "";
      return [
        renderAthenaStatus(),
        "",
        `執行政策：${describeAthenaPolicy(policy)}`,
        last,
      ].join("\n");
    },

    draftCalendar(input: {
      userId: string;
      channelId: string;
      summary: string;
      start: string;
      duration?: number;
      location?: string;
      description?: string;
    }): { draftId: string; preview: string } {
      const payload = {
        summary: input.summary,
        start: input.start,
        duration: input.duration ?? 60,
        location: input.location ?? "",
        description: input.description ?? "",
      };
      const draftId = life.createDraft({
        kind: "calendar",
        userId: input.userId,
        channelId: input.channelId,
        payload,
      });
      return {
        draftId,
        preview: [
          "行事曆草稿（還沒寫進去）",
          `編號 ${draftId}`,
          `標題 ${payload.summary}`,
          `開始 ${payload.start}`,
          `長度 ${payload.duration} 分鐘`,
          payload.location ? `地點 ${payload.location}` : "",
          "確認請用 `/athena-calendar-confirm` 填這個編號。公司規定：沒確認不寫日曆。",
        ].filter(Boolean).join("\n"),
      };
    },

    async confirmCalendar(draftId: string, userId: string, channelId: string): Promise<string> {
      const draft = life.claimDraft(draftId, userId, channelId);
      if (!draft || draft.kind !== "calendar") {
        if (draft) life.releaseDraft(draftId, userId, channelId);
        return "找不到這份草稿，或已過期／用過／正在處理。";
      }
      const p = draft.payload;
      const start = String(p.start ?? "");
      const mins = Number(p.duration ?? p.durationMinutes ?? 60);
      const end = new Date(new Date(start).getTime() + mins * 60_000).toISOString();
      try {
        const result = await runJsonNode(GCAL, {
          summary: p.summary,
          start,
          end,
          location: p.location || undefined,
          description: p.description || undefined,
        });
        life.completeDraft(draftId, userId, channelId);
        const html = typeof result.htmlLink === "string" ? result.htmlLink : "";
        return `已寫入行事曆。${html ? `\n${html}` : ""}\n草稿 ${draftId} 已用掉。`;
      } catch (err) {
        life.releaseDraft(draftId, userId, channelId);
        throw err;
      }
    },

    draftMail(input: {
      userId: string;
      channelId: string;
      to: string;
      subject: string;
      text: string;
    }): { draftId: string; preview: string } {
      const draftId = life.createDraft({
        kind: "mail",
        userId: input.userId,
        channelId: input.channelId,
        payload: { to: input.to, subject: input.subject, text: input.text },
      });
      return {
        draftId,
        preview: [
          "信件草稿（還沒寄）",
          `編號 ${draftId}`,
          `給 ${input.to}`,
          `主旨 ${input.subject}`,
          "確認請用 `/athena-mail-confirm`。沒確認不寄。",
        ].join("\n"),
      };
    },

    async confirmMail(draftId: string, userId: string, channelId: string): Promise<string> {
      const draft = life.getDraft(draftId, userId, channelId);
      if (!draft || draft.kind !== "mail") return "找不到這封草稿。";
      if (!life.consumeDraft(draftId, userId, channelId)) return "草稿無法確認。";
      const result = await runJsonNode(GMAIL, draft.payload);
      return `已寄出。${JSON.stringify(result).slice(0, 300)}`;
    },
  };
}

export function captureEpisode(threadId: string, userText: string, replyText: string, persona: string): void {
  const u = (userText || "").replace(/<@[!&]?\d+>/g, "").trim();
  const r = (replyText || "").trim();
  if (!u || !r) return;
  const py = process.env.PYTHON_BIN ?? "python";
  const script = path.join(os.homedir(), "scripts", "memory_api.py");
  const name = `chat-${persona}-${threadId}-${Date.now()}`;
  const text = `## 使用者\n${u.slice(0, 1500)}\n\n## ${persona}\n${r.slice(0, 3000)}`;
  execFile(py, [script, "add", "--no-reindex", "--mtype", "episode",
    "--agent", persona, "--user", "charles", "--session", threadId,
    "--name", name, "--text", text], { timeout: 30_000 }, (err) => {
    if (err) console.error("[memory-capture] failed:", err.message);
  });
}
