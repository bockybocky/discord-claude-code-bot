/**
 * AthenaBot skill curator — dsh-skill-curator / Hermes background-review loop,
 * scoped to one owned file. Never blocks the Discord turn.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const IS_ATHENA = (process.env.PERSONA ?? "") === "athena";
const DIR = path.join(import.meta.dirname, "..", "athena-curator");
const SKILL_PATH = path.join(DIR, "SKILL.md");
const REVIEWS_PATH = path.join(DIR, "reviews.json");
const INTERVAL = Math.max(1, Number(process.env.ATHENA_CURATOR_INTERVAL ?? 5) || 5);
const TAIL = 8;
const DIGEST_MAX = 12_000;
const REVIEW_TIMEOUT_MS = 90_000;
const GROK_CALL = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", "scripts", "grok_call.py");
const AUTHOR = "athenabot-curator";
const STUB = "尚無從對話沉澱的可複用規則";

type Pair = { role: "user" | "assistant"; text: string };
type Review =
  | { kind: "skip"; reason: string }
  | { kind: "patch"; old: string; neu: string }
  | { kind: "replace"; body: string };

const turns = new Map<string, number>();
const history = new Map<string, Pair[]>();
let busy = false;

export function loadAthenaCuratedBody(): string {
  try {
    const raw = fs.readFileSync(SKILL_PATH, "utf8");
    const body = stripFrontmatter(raw).trim();
    if (!body || body.includes(STUB)) return "";
    return body.slice(0, 4000);
  } catch {
    return "";
  }
}

export function noteAthenaTurn(threadId: string, userText: string, replyText: string): void {
  if (!IS_ATHENA) return;
  const u = (userText || "").replace(/<@[!&]?\d+>/g, "").trim();
  const r = (replyText || "").trim();
  if (!u || !r) return;

  const pairs = history.get(threadId) ?? [];
  pairs.push({ role: "user", text: u.slice(0, 4000) });
  pairs.push({ role: "assistant", text: r.slice(0, 4000) });
  if (pairs.length > 48) pairs.splice(0, pairs.length - 48);
  history.set(threadId, pairs);

  const n = (turns.get(threadId) ?? 0) + 1;
  if (n < INTERVAL) {
    turns.set(threadId, n);
    return;
  }
  turns.set(threadId, 0);
  const digest = buildDigest(pairs);
  setImmediate(() => {
    runReview(threadId, digest).catch((err) => {
      console.error("[athena-curator] review failed:", (err as Error).message);
    });
  });
}

function buildDigest(pairs: Pair[]): string {
  const kept = Math.min(TAIL, pairs.length);
  const head = pairs.slice(0, Math.max(0, pairs.length - kept));
  const recent = pairs.slice(Math.max(0, pairs.length - kept));
  const lines: string[] = [];
  for (const p of head) {
    const t = p.text.replace(/\s+/g, " ").slice(0, p.role === "user" ? 600 : 400);
    lines.push(`${p.role === "user" ? "USER" : "ASSISTANT"}: ${t}`);
  }
  for (const p of recent) {
    lines.push(p.role === "user" ? `## 使用者\n${p.text}` : `## 助手\n${p.text}`);
  }
  const text = lines.join("\n\n");
  if (text.length <= DIGEST_MAX) return text;
  return text.slice(0, DIGEST_MAX) + "\n\n[已截斷]";
}

function reviewPrompt(digest: string, currentSkill: string): string {
  return [
    "你是 AthenaBot 的後台技能策展子代理。只根據下面對話沉澱可複用規則。",
    "## 對話紀錄",
    digest,
    "",
    "## 目前策展課（唯一可改的檔）",
    currentSkill || "（空）",
    "",
    "## 何時該動手",
    "Charles 糾正語氣／格式／囉嗦、糾正工作流、出現可複用的抓 X／摘要／Discord 手法。",
    "多數有糾正的場次至少該更新一次。沒糾正、沒新手法 → SKIP。",
    "",
    "## 不要寫（會變成咬自己的持久約束）",
    "- 環境故障、缺套件、路徑暫時對不上",
    "- 「X 工具壞了」這類否定断言",
    "- 重試就好的瞬時錯誤",
    "- 一次性任務（「摘要這則推文」不是技能類）",
    "- 沒驗證成功的死胡同",
    "- 打水漂五階、一階二階口吻（已停用）",
    "",
    "## 優先序",
    "1. 補丁上面這份策展課（加 pitfall／偏好／步驟）",
    "2. 沒東西可補才 SKIP",
    "禁止新建其他 skill、禁止改 athena_prompt.txt、禁止改公司 ~/.claude/skills",
    "",
    "## 輸出（只能三選一，不要解釋外套）",
    "===SKIP===",
    "reason: 一句話",
    "",
    "===PATCH===",
    "<<<OLD",
    "（必須是目前策展課裡的原文片段）",
    "OLD>>>",
    "<<<NEW",
    "（取代片段）",
    "NEW>>>",
    "",
    "===REPLACE===",
    "（策展課全文，不要 frontmatter）",
    "正文用繁體中文，短、可操作、面向下一場 Discord。",
  ].join("\n");
}

async function runReview(threadId: string, digest: string): Promise<void> {
  if (busy) {
    console.log("[athena-curator] skip, already running");
    return;
  }
  busy = true;
  try {
    const current = loadAthenaCuratedBody() || fs.readFileSync(SKILL_PATH, "utf8");
    const raw = await callGrok(reviewPrompt(digest, current));
    const review = parseReview(raw);
    if (!review) {
      logReview(threadId, "parse-fail", raw.slice(0, 400));
      return;
    }
    if (review.kind === "skip") {
      logReview(threadId, "skip", review.reason);
      return;
    }
    applyReview(review);
    logReview(threadId, review.kind, review.kind === "patch" ? "patched SKILL.md" : "replaced SKILL.md");
    console.log(`[athena-curator] ${review.kind} thread=${threadId}`);
  } finally {
    busy = false;
  }
}

function parseReview(raw: string): Review | null {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (/===SKIP===/i.test(text)) {
    const m = text.match(/reason:\s*(.+)/i);
    return { kind: "skip", reason: (m?.[1] || "no reason").trim().slice(0, 300) };
  }
  if (/===PATCH===/i.test(text)) {
    const old = text.match(/<<<OLD\n([\s\S]*?)\nOLD>>>/);
    const neu = text.match(/<<<NEW\n([\s\S]*?)\nNEW>>>/);
    if (!old || !neu) return null;
    return { kind: "patch", old: old[1], neu: neu[1] };
  }
  if (/===REPLACE===/i.test(text)) {
    const body = text.split(/===REPLACE===\s*/i)[1]?.trim() ?? "";
    if (!body || body.length < 20) return null;
    return { kind: "replace", body: body.slice(0, 6000) };
  }
  return null;
}

function applyReview(review: Extract<Review, { kind: "patch" | "replace" }>): void {
  const raw = fs.readFileSync(SKILL_PATH, "utf8");
  const fm = raw.match(/^---\n[\s\S]*?\n---\n/)?.[0];
  if (!fm || !fm.includes(`author: ${AUTHOR}`)) {
    throw new Error("refusing to write: ownership marker missing");
  }
  let next = raw;
  if (review.kind === "replace") {
    next = `${fm}\n${review.body.trim()}\n`;
  } else {
    if (!raw.includes(review.old)) {
      throw new Error("patch oldString not found");
    }
    next = raw.replace(review.old, review.neu);
    if (!next.includes(`author: ${AUTHOR}`)) {
      throw new Error("patch would drop ownership marker");
    }
  }
  const tmp = `${SKILL_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, "utf8");
  fs.renameSync(tmp, SKILL_PATH);
}

function callGrok(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python",
      [GROK_CALL, "策展", "--timeout", "90", "--effort", "low"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { err += c.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("review timeout"));
    }, REVIEW_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        reject(new Error(err.trim().slice(0, 300) || `grok_call exit ${code}`));
        return;
      }
      resolve(out.trim());
    });
    child.stdin?.write(prompt, "utf8");
    child.stdin?.end();
  });
}

function logReview(threadId: string, kind: string, detail: string): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    let rows: unknown[] = [];
    if (fs.existsSync(REVIEWS_PATH)) {
      rows = JSON.parse(fs.readFileSync(REVIEWS_PATH, "utf8"));
      if (!Array.isArray(rows)) rows = [];
    }
    rows.push({ ts: new Date().toISOString(), threadId, kind, detail: detail.slice(0, 400) });
    fs.writeFileSync(REVIEWS_PATH, JSON.stringify(rows.slice(-50), null, 2), "utf8");
  } catch (e) {
    console.error("[athena-curator] log failed:", (e as Error).message);
  }
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "");
}
