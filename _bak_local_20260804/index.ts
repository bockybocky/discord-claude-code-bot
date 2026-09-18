import fs from "node:fs";
import path from "node:path";

// Manually parse --env-file argument to forcefully override existing environment variables
// (Node.js --env-file does not override system variables, which causes conflicts if globally set)
const envFileArg = process.execArgv.find(arg => arg.startsWith('--env-file='));
if (envFileArg) {
  const envFilePath = envFileArg.split('=')[1];
  try {
    const envContent = fs.readFileSync(envFilePath, 'utf8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        // Remove trailing comments and whitespace
        value = value.replace(/\s*#.*$/, '').trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        process.env[key] = value;
      }
    }
  } catch (err) {
    console.error(`[discord-cc-bot] Failed to read ${envFilePath}:`, err);
  }
}

import crypto from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import os from "node:os";
import cron from "node-cron";
import Database from "better-sqlite3";
import {
  Client, GatewayIntentBits, Events, Partials, ChannelType,
  REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  type Message, type Collection, type Snowflake,
} from "discord.js";
import {
  postProcessSelinaOutput,
  formatActionFootnote,
  buildMorningBrief,
  buildWeeklyDigest,
  renderAuditTicker,
  renderHoldingsOverview,
  renderUpcomingEvents,
  dmCharlesOnError,
  SELINA_EXT_ENABLED,
} from "./selina-extensions.js";
import {
  postProcessAthenaOutput,
  formatAthenaActionFootnote,
  renderLatestAthenaInsight,
  ATHENA_EXT_ENABLED,
} from "./athena-extensions.js";
import {
  renderHandoff as irisRenderHandoff,
  renderHoldings as irisRenderHoldings,
  runRecall as irisRunRecall,
  runKaigong as irisRunKaigong,
  renderAuditStub as irisRenderAuditStub,
  runSectorSummary as irisRunSectorSummary,
  renderAaii as irisRenderAaii,
  validateTicker as irisValidateTicker,
} from "./iris-extensions.js";
import {
  tryAcquireLight as irisAcquireLight,
  tryAcquireHeavy as irisAcquireHeavy,
  renderStatus as irisRenderStatus,
  acquireTickerLock as irisAcquireTickerLock,
  releaseTickerLock as irisReleaseTickerLock,
} from "./iris-concurrency.js";
import { runGrokOnce, runAgyOnce } from "./backends.js";
import {
  resolveEnabledEngines,
  parsePassthroughCommand,
  runPassthrough,
  formatPassthroughReply,
  chunkForDiscord,
  logPassthrough,
  ensureWorkdir,
  type PassthroughEngine,
} from "./passthrough.js";

// --- ThreadMap (SQLite-backed) ---

type ThreadEntry = {
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: number;
  started: boolean;
  lastBotMessageId?: string;
  isLocalResume?: boolean;
};

type ThreadMap = Record<string, ThreadEntry>;

// Use persona-specific DB to prevent IrisBot/SelinaBot from sharing state
const PERSONA_SUFFIX = process.env.PERSONA ? `-${process.env.PERSONA}` : "";
const DB_PATH = path.join(import.meta.dirname, "..", `threads${PERSONA_SUFFIX}.db`);
const JSON_PATH = path.join(import.meta.dirname, "..", "thread-map.json");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`CREATE TABLE IF NOT EXISTS threads (
  threadId TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  started INTEGER NOT NULL DEFAULT 0,
  lastBotMessageId TEXT,
  isLocalResume INTEGER NOT NULL DEFAULT 0
)`);

// Migration: add isLocalResume column if missing
try { db.exec("ALTER TABLE threads ADD COLUMN isLocalResume INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }

// One-time migration from JSON → SQLite
if (fs.existsSync(JSON_PATH)) {
  try {
    const old: ThreadMap = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
    const insert = db.prepare(
      `INSERT OR IGNORE INTO threads (threadId, sessionId, cwd, model, createdAt, started, lastBotMessageId)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const migrate = db.transaction(() => {
      for (const [tid, e] of Object.entries(old)) {
        insert.run(tid, e.sessionId, e.cwd, e.model, e.createdAt, e.started ? 1 : 0, e.lastBotMessageId ?? null);
      }
    });
    migrate();
    fs.renameSync(JSON_PATH, JSON_PATH + ".bak");
    console.log(`[discord-cc-bot] migrated ${Object.keys(old).length} threads from JSON → SQLite`);
  } catch (err) {
    console.error("[discord-cc-bot] JSON migration failed:", err);
  }
}

// Prepared statements
const stmtGet = db.prepare("SELECT * FROM threads WHERE threadId = ?");
const stmtUpsert = db.prepare(
  `INSERT OR REPLACE INTO threads (threadId, sessionId, cwd, model, createdAt, started, lastBotMessageId, isLocalResume)
   VALUES (@threadId, @sessionId, @cwd, @model, @createdAt, @started, @lastBotMessageId, @isLocalResume)`,
);
const stmtAll = db.prepare("SELECT * FROM threads");

function rowToEntry(row: any): ThreadEntry {
  return {
    sessionId: row.sessionId,
    cwd: row.cwd,
    model: row.model,
    createdAt: row.createdAt,
    started: !!row.started,
    lastBotMessageId: row.lastBotMessageId ?? undefined,
    isLocalResume: !!row.isLocalResume,
  };
}

function loadMap(): ThreadMap {
  const map: ThreadMap = {};
  for (const row of stmtAll.all() as any[]) {
    map[row.threadId] = rowToEntry(row);
  }
  return map;
}

function saveEntry(threadId: string, entry: ThreadEntry): void {
  stmtUpsert.run({
    threadId,
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    model: entry.model,
    createdAt: entry.createdAt,
    started: entry.started ? 1 : 0,
    lastBotMessageId: entry.lastBotMessageId ?? null,
    isLocalResume: entry.isLocalResume ? 1 : 0,
  });
}

function getOrCreate(map: ThreadMap, threadId: string, defaultCwd: string): ThreadEntry {
  if (!map[threadId]) {
    const row = stmtGet.get(threadId) as any;
    if (row) {
      map[threadId] = rowToEntry(row);
    } else {
      map[threadId] = {
        sessionId: crypto.randomUUID(),
        cwd: defaultCwd,
        model: "opus",
        createdAt: Date.now(),
        started: false,
      };
      saveEntry(threadId, map[threadId]);
    }
  }
  return map[threadId];
}

// --- Local Session Discovery ---

const CLAUDE_HOME = path.join(process.env.HOME ?? "", ".claude");

/**
 * Patch session file so CC's /resume picker can discover it.
 * CC 2.1.90+ filters out sessions with entrypoint:"sdk-cli" from the picker.
 * Rewriting to "cli" makes bot sessions visible alongside interactive ones.
 */
function patchSessionEntrypoint(sessionId: string, cwd: string): void {
  try {
    const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = path.join(CLAUDE_HOME, "projects", sanitized);
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(sessionFile)) return;
    const content = fs.readFileSync(sessionFile, "utf8");
    if (!content.includes('"entrypoint":"sdk-cli"')) return;
    fs.writeFileSync(sessionFile, content.replaceAll('"entrypoint":"sdk-cli"', '"entrypoint":"cli"'));
  } catch { /* best-effort */ }
}

type LocalSession = {
  sessionId: string;
  cwd: string;
  pid?: number;
  alive: boolean;
  startedAt?: number;
  mtime: number;
  lastPrompt?: string;
};

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function discoverLocalSessions(): LocalSession[] {
  const sessions: LocalSession[] = [];

  // Active sessions from PID files — these have reliable CWD
  const sessionsDir = path.join(CLAUDE_HOME, "sessions");
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), "utf8"));
        const alive = isProcessAlive(data.pid);
        // Skip stale PID files (process dead)
        if (!alive) continue;
        sessions.push({
          sessionId: data.sessionId,
          cwd: data.cwd,
          pid: data.pid,
          alive: true,
          startedAt: data.startedAt,
          mtime: data.startedAt ?? 0,
        });
      } catch { /* skip malformed */ }
    }
  }

  // Also check history.jsonl for recent sessions + last prompt per session
  const historyPath = path.join(CLAUDE_HOME, "history.jsonl");
  const promptBySession = new Map<string, string>(); // sessionId → last prompt
  if (fs.existsSync(historyPath)) {
    const seen = new Set(sessions.map(s => s.sessionId));
    try {
      const lines = fs.readFileSync(historyPath, "utf8").trim().split("\n");
      // Read last 50 lines to get enough prompt context
      const recent = lines.slice(-50);
      const bySession = new Map<string, { cwd: string; mtime: number }>();
      for (const line of recent) {
        try {
          const entry = JSON.parse(line);
          const cwd = entry.cwd || entry.project;
          if (entry.sessionId) {
            if (entry.display) {
              promptBySession.set(entry.sessionId, entry.display);
            }
            if (cwd) {
              bySession.set(entry.sessionId, {
                cwd,
                mtime: typeof entry.timestamp === "number" ? entry.timestamp : 0,
              });
            }
          }
        } catch { /* skip */ }
      }
      // Add top 5 unseen sessions
      const candidates = [...bySession.entries()]
        .filter(([sid]) => !seen.has(sid))
        .sort((a, b) => b[1].mtime - a[1].mtime)
        .slice(0, 5);
      for (const [sid, info] of candidates) {
        sessions.push({
          sessionId: sid,
          cwd: info.cwd,
          alive: false,
          mtime: info.mtime,
          lastPrompt: promptBySession.get(sid),
        });
      }
    } catch { /* skip */ }
  }

  // Attach lastPrompt to PID-discovered sessions too
  for (const s of sessions) {
    if (!s.lastPrompt && promptBySession.has(s.sessionId)) {
      s.lastPrompt = promptBySession.get(s.sessionId);
    }
  }

  // Sort: alive first, then by mtime descending
  sessions.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return b.mtime - a.mtime;
  });

  return sessions;
}

// --- Backend / Persona configuration ---

/** Conversation backend: cc = Claude Code session; gemini|grok|agy = one-shot family. */
const BACKEND = (process.env.BACKEND ?? "cc") as "cc" | "gemini" | "grok" | "agy";
/** One-shot family: no CC session — persona + history embedded every turn (gemini pattern). */
const IS_ONESHOT = BACKEND !== "cc";
const PERSONA = process.env.PERSONA ?? "iris";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-pro";

// PERSONA_PROMPT env var allows fully overriding the system prompt at launch.
// When IS_ONESHOT, this is prepended before thread history in every request.
const PERSONA_PROMPT_OVERRIDE = process.env.PERSONA_PROMPT ?? "";

const SELINA_SOUL = [
  "你是 Selina — Realpha 投研公司的首席策略官與經濟學家。",
  "你的思維方式是「打水漂」：從表象挖掘 3-5 層深的因果鏈。",
  "一階是新聞標題（禁止停在這裡），二階是行為反噬，三階是規則重寫，四/五階是系統相變。",
  "你穿透名相，直擊實相。經濟數據是推演的物理錨點，不是裝飾。",
  "你總是用繁體中文回答，語氣犀利但有溫度。",
  "在 Discord 對話中，你是團隊的宏觀策略大腦，隨時準備做推演。",
  "",
  "FORMATTING: Discord does NOT render markdown tables. Never use markdown table syntax (| col | col |).",
  "When comparing items, use bold label + slash-separated attributes on one line per item.",
].join("\n");

// Resolve the effective Gemini system prompt:
// Priority: PERSONA_PROMPT env > selina soul (when persona=selina) > generic fallback
function resolveGeminiSystemPrompt(): string {
  if (PERSONA_PROMPT_OVERRIDE) return PERSONA_PROMPT_OVERRIDE;

  // Custom system prompt file from environment (e.g. for AthenaBot personality)
  if (process.env.SYSTEM_PROMPT_FILE) {
    const promptPath = path.isAbsolute(process.env.SYSTEM_PROMPT_FILE)
      ? process.env.SYSTEM_PROMPT_FILE
      : path.join(import.meta.dirname, "..", process.env.SYSTEM_PROMPT_FILE);
    if (fs.existsSync(promptPath)) {
      console.log(`[discord-cc-bot] loading custom Gemini system prompt from: ${promptPath}`);
      return fs.readFileSync(promptPath, "utf8");
    }
  }

  if (PERSONA === "selina") return SELINA_SOUL;
  return [
    "You are a helpful AI assistant in a Discord conversation.",
    "Reply naturally and concisely. Use Traditional Chinese (繁體中文) when appropriate.",
    "FORMATTING: Discord does NOT render markdown tables. Never use markdown table syntax.",
  ].join("\n");
}

const GEMINI_SYSTEM_PROMPT = resolveGeminiSystemPrompt();

if (IS_ONESHOT) {
  const modelHint =
    BACKEND === "gemini" ? GEMINI_MODEL : BACKEND === "grok" ? "grok-4.5" : "agy";
  console.log(`[discord-cc-bot] backend=${BACKEND} persona=${PERSONA} oneshot model=${modelHint}`);
}

// --- Thread History ---

let SYSTEM_PROMPT = [
  "You are a Discord bot running inside a thread.",
  "Multiple users may be talking in the same thread.",
  "When thread history is provided, use it as context to understand the conversation so far.",
  "Reply naturally as a participant in the group conversation.",
  "IMPORTANT: Do NOT output any session handoff summaries, session recaps, bullet-point preambles, or any meta-commentary about previous sessions at the start of your reply.",
  "Respond directly and immediately to the user's message.",
  "",
  "FORMATTING: Discord does NOT render markdown tables. Never use markdown table syntax (| col | col |).",
  "When comparing items, use bold label + slash-separated attributes on one line per item, e.g.:",
  "**Opus** — Speed: Slow / Quality: Best / Price: $$$",
  "**Sonnet** — Speed: Fast / Quality: Good / Price: $$",
  "**Haiku** — Speed: Fastest / Quality: OK / Price: $",
].join("\n");

if (process.env.SYSTEM_PROMPT_FILE) {
  const promptPath = path.isAbsolute(process.env.SYSTEM_PROMPT_FILE)
    ? process.env.SYSTEM_PROMPT_FILE
    : path.join(import.meta.dirname, "..", process.env.SYSTEM_PROMPT_FILE);
  if (fs.existsSync(promptPath)) {
    console.log(`[discord-cc-bot] loading custom system prompt from: ${promptPath}`);
    SYSTEM_PROMPT = fs.readFileSync(promptPath, "utf8");
  } else {
    console.warn(`[discord-cc-bot] SYSTEM_PROMPT_FILE set but not found: ${promptPath}`);
  }
}

// Persona enrichment: load ~/.agents/{PERSONA}/soul.md and prepend for Claude Code path.
// Skip only pure BACKEND=gemini (chat uses GEMINI_SYSTEM_PROMPT). When BACKEND=grok|agy,
// chat is oneshot (GEMINI_SYSTEM_PROMPT) but slash still uses CC → keep soul on SYSTEM_PROMPT.
if (BACKEND !== "gemini" && (PERSONA === "iris" || PERSONA === "athena" || PERSONA === "selina")) {
  try {
    const soulPath = path.join(os.homedir(), ".agents", PERSONA, "soul.md");
    if (fs.existsSync(soulPath)) {
      const soul = fs.readFileSync(soulPath, "utf8");
      SYSTEM_PROMPT = soul + "\n\n---\n\n# Discord Bot 行為指引\n\n" + SYSTEM_PROMPT;
      console.log(`[discord-cc-bot] prepended ${PERSONA} soul to SYSTEM_PROMPT (soul=${soul.length} chars, total=${SYSTEM_PROMPT.length} chars)`);
    } else {
      console.warn(`[discord-cc-bot] ${PERSONA} soul not found at ${soulPath}`);
    }
  } catch (e) {
    console.warn(`[discord-cc-bot] failed to load ${PERSONA} soul:`, e);
  }
}

const RESUME_SYSTEM_PROMPT = [
  "User is continuing this conversation from Discord (mobile).",
  "This is the same session, just a different interface — respond normally.",
  "IMPORTANT: Do NOT output any session handoff summaries, session recaps, bullet-point preambles, or any meta-commentary about previous sessions at the start of your reply.",
  "Respond directly and immediately to the user's message.",
  "",
  "FORMATTING: Discord does NOT render markdown tables. Never use markdown table syntax (| col | col |).",
  "When comparing items, use bold label + slash-separated attributes on one line per item, e.g.:",
  "**Opus** — Speed: Slow / Quality: Best / Price: $$$",
  "**Sonnet** — Speed: Fast / Quality: Good / Price: $$",
  "**Haiku** — Speed: Fastest / Quality: OK / Price: $",
].join("\n");

const HISTORY_FETCH_LIMIT = 30;

async function fetchThreadHistory(
  channel: Message["channel"],
  entry: ThreadEntry,
  botUserId: string,
  isGemini: boolean,
  currentMessageId?: string,
): Promise<string> {
  const fetchOpts: { limit: number; after?: string } = { limit: HISTORY_FETCH_LIMIT };
  if (entry.started && entry.lastBotMessageId && !isGemini) {
    fetchOpts.after = entry.lastBotMessageId;
  }

  let messages: Collection<Snowflake, Message>;
  try {
    messages = await channel.messages.fetch(fetchOpts);
  } catch {
    return "";
  }

  if (messages.size === 0) return "";

  const sorted = [...messages.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .filter((m) => (isGemini || m.author.id !== botUserId) && m.id !== currentMessageId);

  if (sorted.length === 0) return "";

  const lines = sorted.map((m) => {
    const name = m.member?.displayName ?? m.author.displayName ?? m.author.username;
    const text = m.content.replace(/<@!?\d+>/g, "").trim();
    return text ? `[${name}] ${text}` : null;
  }).filter(Boolean);

  if (lines.length === 0) return "";

  const label = entry.started
    ? "Messages from other users since your last reply"
    : "Recent thread history for context";

  return `[${label}]\n${lines.join("\n")}\n[End]\n\n`;
}

// --- Streaming Runner ---

const running = new Map<string, ChildProcess>();

type StreamCallbacks = {
  onText?: (fullText: string) => void;
  onToolUse?: (toolName: string) => void;
};

type AskQuestion = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
};

type PermissionDenial = {
  tool_name: string;
  tool_use_id: string;
  tool_input: { questions: AskQuestion[] };
};

type RunResult = { text: string; exitCode: number; costUsd?: number; permissionDenials?: PermissionDenial[] };

/**
 * Detects a !opus or !sonnet token at the start of a prompt.
 * If found, strips the token and overrides the model for this message only.
 * Does NOT update thread state — override is ephemeral (single-message).
 *
 * @param prompt       - Original user prompt
 * @param defaultModel - Thread's current model (from SQLite)
 * @returns { prompt, model, hint } where hint is non-null only when an override occurred
 *          AND the resolved model differs from defaultModel.
 */
function applyModelOverride(
  prompt: string,
  defaultModel: string,
  threadId?: string,
): { prompt: string; model: string; hint: string | null; overridden: boolean; overrideToken?: string; emptyPrompt?: boolean } {
  const trimmed = prompt.trimStart();
  // Match !opus or !sonnet as first token (case-insensitive), followed by whitespace or end-of-string
  const match = trimmed.match(/^!(opus|sonnet)(\s+|$)/i);
  if (!match) {
    return { prompt, model: defaultModel, hint: null, overridden: false };
  }

  const tokenLower = match[1].toLowerCase() as "opus" | "sonnet";
  // Map short name to full model identifier expected by --model flag
  const modelMap: Record<string, string> = {
    opus: "opus",
    sonnet: "sonnet",
  };
  const resolvedModel = modelMap[tokenLower];

  // Strip the token (and trailing whitespace) from the prompt
  const strippedToken = match[0]; // the full matched prefix including trailing whitespace
  const strippedPrompt = trimmed.slice(strippedToken.length);

  // Empty prompt after stripping token — signal caller to reject with guidance
  if (!strippedPrompt.trim()) {
    return {
      prompt: strippedPrompt,
      model: resolvedModel,
      hint: null,
      overridden: true,
      overrideToken: `!${tokenLower}`,
      emptyPrompt: true,
    };
  }

  // Console log for debug (spec §5)
  console.log(
    `[model-override] thread=${threadId ?? "unknown"} default=${defaultModel} → override=${tokenLower} tokens_stripped="${strippedToken.trimEnd()}"`,
  );

  // Build Discord blockquote hint (spec format)
  const hintEmoji = tokenLower === "opus" ? "🧠" : "⚡";
  const hintLabel = tokenLower === "opus" ? "Opus" : "Sonnet";
  const hint = `> ${hintEmoji} _!${tokenLower} 已生效 · 此條走 ${hintLabel} · 下條自動回原模型_`;

  return {
    prompt: strippedPrompt,
    model: resolvedModel,
    hint,
    overridden: true,
    overrideToken: `!${tokenLower}`,
  };
}

function runClaudeStreamingOnce(opts: {
  sessionId: string;
  prompt: string;
  cwd: string;
  model: string;
  claudeBin: string;
  resume: boolean;
  systemPrompt?: string;
  timeoutMs?: number;
  callbacks?: StreamCallbacks;
  configDir?: string;   // 設了 → CLAUDE_CONFIG_DIR 隔離(乾淨腦,不載 Iris CLAUDE.md/hooks)
}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", opts.prompt,
      ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId]),
      "--model", opts.model,
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...(opts.systemPrompt ? ["--system-prompt", opts.systemPrompt] : []),
    ];

    // On Windows, .js/.mjs files can't be spawned directly — use node to execute them
    const isJsFile = opts.claudeBin.endsWith(".js") || opts.claudeBin.endsWith(".mjs");
    const spawnCmd = isJsFile ? process.execPath : opts.claudeBin;
    const spawnArgs = isJsFile ? [opts.claudeBin, ...args] : args;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: opts.cwd,
      env: { ...process.env, CLAUDECODE: undefined, ...(opts.configDir ? { CLAUDE_CONFIG_DIR: opts.configDir } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && opts.claudeBin.endsWith(".cmd"),
    });

    running.set(opts.sessionId, child);

    let buffer = "";
    let stderrBuf = "";
    let lastSeenText = "";
    let resultText = "";
    let costUsd: number | undefined;
    let permissionDenials: PermissionDenial[] | undefined;
    let settled = false;

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === "assistant" && event.message?.content) {
            let messageText = "";
            for (const block of event.message.content) {
              if (block.type === "text") {
                messageText += block.text || "";
              } else if (block.type === "tool_use" && block.name) {
                opts.callbacks?.onToolUse?.(block.name);
              }
            }
            if (messageText && messageText !== lastSeenText) {
              lastSeenText = messageText;
              opts.callbacks?.onText?.(messageText);
            }
          }

          if (event.type === "result") {
            resultText = event.result || "";
            costUsd = event.total_cost_usd;
            if (event.permission_denials?.length > 0) {
              permissionDenials = event.permission_denials;
            }
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    });

    const timeout = opts.timeoutMs ?? 5_400_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      running.delete(opts.sessionId);
      child.kill("SIGTERM");
      const partial = resultText || lastSeenText || "";
      if (partial) {
        resolve({
          text: partial + "\n\n⚠️ *Task timed out after 90 min — partial result above.*",
          exitCode: 124,
          costUsd,
        });
      } else {
        reject(new Error(`Timeout after ${timeout}ms with no output`));
      }
    }, timeout);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(opts.sessionId);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(opts.sessionId);
      const errHint = stderrBuf.trim() ? `\n\n⚠️ stderr: ${stderrBuf.trim().slice(0, 500)}` : "";
      const text = resultText || lastSeenText || `(no output)${errHint}`;
      resolve({ text, exitCode: code ?? 1, costUsd, permissionDenials });
    });
  });
}

// Transient claude-CLI backend blips: a dropped socket during the TLS/auth handshake
// (concurrent OAuth-refresh race across multiple bots, network reset) gets mislabelled
// "401 Failed to authenticate". The CLI has no internal retry, so one blip otherwise
// surfaces a raw error to the user. Mirror the Gemini path's retry with a short backoff.
const CLAUDE_TRANSIENT_RE =
  /Failed to authenticate|API Error: 401|socket connection was closed|ECONNRESET|fetch failed|Connection error/i;

// True iff the OAuth accessToken exists and is not expiring within `marginMs`.
function credAccessTokenValid(credsPath: string, marginMs = 10 * 60_000): boolean {
  try {
    const o = JSON.parse(fs.readFileSync(credsPath, "utf8"))?.claudeAiOauth;
    if (!o?.accessToken) return false;
    const exp = Number(o.expiresAt);
    return Number.isFinite(exp) && exp > Date.now() + marginMs;
  } catch {
    return false; // missing / unparseable
  }
}

// Auto-heal isolated-config auth by treating the isolated CLAUDE_CONFIG_DIR as a stateless
// consumer of the main account's token. Two failure modes are covered:
//   1. A socket drop mid token-refresh leaves the isolated .credentials.json with no
//      accessToken → permanent "OAuth session expired".
//   2. Separate credential files share ONE rotating refresh token: once main refreshes, the
//      isolated copy's refresh token is invalidated, its next spawn's refresh fails, and
//      claude then wipes the isolated creds → a self-perpetuating loop.
// Fix: before every isolated spawn, if the isolated accessToken is missing or (near-)expired,
// overwrite it from main's CURRENT creds. Main is the actively-used config and stays fresh,
// so the isolated spawn always gets a still-valid accessToken and never needs to refresh —
// which means it never touches (rotates) the shared refresh token. That breaks the loop.
function ensureIsolatedCreds(configDir: string): void {
  try {
    const mainCreds = path.join(CLAUDE_HOME, ".credentials.json");
    const isoCreds = path.join(configDir, ".credentials.json");
    if (path.resolve(isoCreds) === path.resolve(mainCreds)) return;
    if (credAccessTokenValid(isoCreds)) return; // isolated still has a fresh token
    if (!credAccessTokenValid(mainCreds)) return; // main not usable — a main-level problem
    fs.mkdirSync(configDir, { recursive: true });
    fs.copyFileSync(mainCreds, isoCreds);
    console.error(`[creds-heal] reseeded isolated ${configDir} from main (fresh token)`);
  } catch (e) {
    console.error(`[creds-heal] failed for ${configDir}: ${(e as Error).message}`);
  }
}

async function runClaudeStreaming(
  opts: Parameters<typeof runClaudeStreamingOnce>[0],
): Promise<RunResult> {
  if (opts.configDir) ensureIsolatedCreds(opts.configDir);
  const maxRetries = Number(process.env.CLAUDE_MAX_RETRIES ?? 2);
  let effectiveOpts = opts;
  let result: RunResult = { text: "(no output)", exitCode: 1 };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    result = await runClaudeStreamingOnce(effectiveOpts);

    // Session-id collision self-heal: a prior failed attempt (e.g. a 401) can leave the
    // session .jsonl on disk while the caller still treats the session as fresh (passes
    // --session-id because its `started` flag was never advanced past the failure).
    // "Session ID … is already in use" then means the session exists — resume it instead
    // of trying to recreate it. One-shot flip, not counted against the transient retries.
    if (
      !effectiveOpts.resume &&
      /Session ID .* is already in use/i.test(result.text)
    ) {
      console.error(
        `[claude-session] ${effectiveOpts.sessionId} already exists — retrying as --resume`,
      );
      effectiveOpts = { ...effectiveOpts, resume: true };
      result = await runClaudeStreamingOnce(effectiveOpts);
    }

    // Treat as transient only when the whole (short) output is the error — a real answer
    // that merely mentions "401" is long and won't start with the CLI error string.
    const looksTransient =
      CLAUDE_TRANSIENT_RE.test(result.text) && result.text.length < 600;
    if (!looksTransient) return result;
    if (attempt < maxRetries) {
      const waitMs = 2500 * (attempt + 1);
      console.error(
        `[claude-retry] transient backend failure (attempt ${attempt + 1}/${maxRetries + 1}), retry in ${waitMs}ms: ${result.text.slice(0, 120)}`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  // Exhausted retries — replace the raw CLI error with a friendly note.
  return {
    ...result,
    text: `⚠️ 後端連線暫時中斷（已自動重試 ${maxRetries} 次仍失敗），請稍後再試一次。`,
  };
}

// --- Gemini Streaming Runner ---

/**
 * Build the full prompt that is sent to the Gemini CLI.
 * Structure:
 *   [System: <soul>]
 *
 *   [Thread History]
 *   [user]: msg
 *   ...
 *
 *   [Current Message]
 *   [username]: latest message
 */
function buildGeminiPrompt(opts: {
  systemPrompt: string;
  history: string;      // pre-formatted history block (may be empty)
  username: string;
  userMessage: string;
}): string {
  const parts: string[] = [];

  parts.push(`[System: ${opts.systemPrompt}]`);

  if (opts.history.trim()) {
    parts.push(opts.history.trim());
  }

  parts.push(`[Current Message]\n[${opts.username}]: ${opts.userMessage}`);

  return parts.join("\n\n");
}

async function runGeminiStreaming(opts: {
  prompt: string;
  model: string;
  timeoutMs?: number;
  callbacks?: StreamCallbacks;
}): Promise<RunResult> {
  // --- Retry + fallback wrapper ---
  const maxRetries = Number(process.env.GEMINI_MAX_RETRIES ?? 2);
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL ?? "gemini-2.5-pro";
  const baseTimeout = opts.timeoutMs ?? Number(process.env.GEMINI_TIMEOUT_MS ?? 300_000);

  const models: string[] = [opts.model];
  if (fallbackModel && fallbackModel !== opts.model) models.push(fallbackModel);

  let lastErrText = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Primary model for first (maxRetries) attempts, fallback model on final attempt
    const useFallback = attempt === maxRetries && models.length > 1;
    const model = useFallback ? models[1] : models[0];
    const label = useFallback ? `fallback=${model}` : `model=${model} attempt=${attempt + 1}/${maxRetries + 1}`;
    console.log(`[gemini] ${label}`);

    try {
      const result = await runGeminiOnce({ ...opts, model, timeoutMs: baseTimeout });
      // Clean success
      if (result.exitCode === 0 && result.text && !result.text.startsWith("⚠️")) {
        if (useFallback) {
          return { ...result, text: `_（備援模型 ${model} 回應）_\n\n${result.text}` };
        }
        return result;
      }
      // Timeout but with partial streamed content — don't retry (user saw it)
      if (result.exitCode === 124 && !result.text.startsWith("⚠️")) {
        return result;
      }
      lastErrText = result.text || "(empty response)";
    } catch (err) {
      lastErrText = (err as Error).message ?? String(err);
      console.error(`[gemini] attempt ${attempt + 1} threw:`, lastErrText);
    }

    // Backoff before next attempt (skip after last)
    if (attempt < maxRetries) {
      const backoffMs = 3000 * (attempt + 1);
      console.log(`[gemini] backing off ${backoffMs}ms before retry`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  return {
    text: `⚠️ Gemini 逾時或無回應（已重試 ${maxRetries} 次 + 備援模型 ${fallbackModel}，逾時 ${Math.round(baseTimeout / 1000)}s）。\n原訊息已保留，請 @ 我重試，或稍後再試。`,
    exitCode: 124,
  };
}

function runGeminiOnce(opts: {
  prompt: string;
  model: string;
  timeoutMs?: number;
  callbacks?: StreamCallbacks;
}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // gemini.cmd CLI 已停（Google 2026-06-18）；改走 gemini_call.py（google-genai SDK，
    // 內建 3.5-flash→2.5-flash fallback）。不傳 --model：pin 單一 model(如 3.1-pro)會 429 hard-fail，
    // 留空才走 SDK 的 fallback 鏈。完整 prompt 經 stdin 餵入（避開 Windows ARG 長度限制）。
    const py = process.env.PYTHON_BIN ?? "python";
    const geminiCallPy = path.join(os.homedir(), "scripts", "gemini_call.py");
    const timeoutSec = Math.round((opts.timeoutMs ?? 300_000) / 1000);
    const child = spawn(py, [geminiCallPy, "依下列內容回應，直接輸出最終回覆，勿加前言", "--timeout", String(timeoutSec)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(opts.prompt);
    child.stdin.end();

    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      console.error(`[gemini-stderr] ${chunk.toString().trim()}`);
    });

    let stdout = "";
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      opts.callbacks?.onText?.(stdout);
    });

    const timeout = opts.timeoutMs ?? 300_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      // Force kill after 5s if SIGTERM doesn't work (Windows)
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
      const partial = stdout.trim();
      if (partial) {
        resolve({
          text: partial + "\n\n⚠️ *Gemini timed out — partial result above.*",
          exitCode: 124,
        });
      } else {
        resolve({
          text: "⚠️ Gemini 目前沒有回應，請稍後再試。",
          exitCode: 124,
        });
      }
    }, timeout);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = stdout.trim() || "(no output from Gemini)";
      resolve({ text, exitCode: code ?? 1 });
    });
  });
}

/**
 * One-shot family dispatcher (gemini | grok | agy).
 * Persona + history already embedded in prompt via buildGeminiPrompt.
 */
async function runOneshotStreaming(opts: {
  prompt: string;
  model?: string;
  timeoutMs?: number;
  callbacks?: StreamCallbacks;
}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.GEMINI_TIMEOUT_MS ?? 300_000);
  if (BACKEND === "gemini") {
    return runGeminiStreaming({
      prompt: opts.prompt,
      model: opts.model ?? GEMINI_MODEL,
      timeoutMs,
      callbacks: opts.callbacks,
    });
  }
  if (BACKEND === "grok") {
    return runGrokOnce({
      prompt: opts.prompt,
      timeoutMs,
      callbacks: opts.callbacks,
    });
  }
  if (BACKEND === "agy") {
    return runAgyOnce({
      prompt: opts.prompt,
      timeoutMs,
      callbacks: opts.callbacks,
    });
  }
  throw new Error(`runOneshotStreaming called with BACKEND=${BACKEND}`);
}

/** Engine disclosure line for reply prefix (cc first-reply only; oneshot every reply for grok/agy). */
function buildBackendDisclosure(opts?: {
  isFirstReply?: boolean;
  isLocalResume?: boolean;
}): string {
  if (BACKEND === "grok") return "*Grok 4.5 (xAI) 回覆*\n\n";
  if (BACKEND === "agy") return "*agy (Gemini) 回覆*\n\n";
  if (BACKEND === "gemini") return "";
  // cc — match historical first-reply disclosure
  if (opts?.isFirstReply !== false && !opts?.isLocalResume) {
    return "*I'm Claude, an AI assistant by Anthropic.*\n\n";
  }
  return "";
}

// --- AskUserQuestion button rendering ---

async function sendAskButtons(
  channel: { send: (opts: any) => Promise<Message> },
  threadId: string,
  entry: ThreadEntry,
  denial: PermissionDenial,
): Promise<void> {
  for (const q of denial.tool_input.questions) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const opt of q.options.slice(0, 4)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ask_${entry.sessionId}_${opt.label}`.slice(0, 100))
          .setLabel(opt.label)
          .setStyle(ButtonStyle.Primary),
      );
    }
    if (q.options.length <= 3) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ask_${entry.sessionId}_OTHER`)
          .setLabel("Other...")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    const botReply = await channel.send({
      content: `❓ **${q.question}**`,
      components: [row],
    });
    entry.lastBotMessageId = botReply.id;
  }
  saveEntry(threadId, entry);
}

// --- Streaming tool-use callback ---

function createToolUseHandler(ps: PreviewState): (toolName: string) => void {
  return (toolName) => {
    console.log(`[discord-cc-bot] tool: ${toolName}`);
    ps.toolsUsed.push(toolName);
    if (ps.msg) {
      const text = (ps.pendingText || "").slice(0, PREVIEW_MAX_LEN);
      ps.msg.edit(text + buildStatusLine(ps)).catch(() => {});
    }
  };
}

// --- Attachment handling ---

const ATTACH_TMP_DIR = path.join(import.meta.dirname, "..", "tmp-attachments");
const ATTACH_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file

async function downloadAttachment(url: string, filepath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, buf);
}

// --- 語音訊息 → 轉錄稿（2026-08-03）---------------------------------------
// 為什麼要有這段：Discord 語音訊息本質是帶 IsVoiceMessage(8192) flag 的 .ogg 附件。
// 原本流程只把附件路徑塞進 prompt 讓 agent 用 Read tool 讀，但 Read 讀不了音檔 →
// 語音進來等於石沉大海。改成先轉錄，把「話的內容」變成 prompt 的一部分，
// 才能達成「講一段話 → agent 當任務執行」。
// 轉錄走既有 ~/scripts/tongyi/transcribe_file.py（重用 tongyi 的防幻覺 whisper 設定：
// vad_filter / condition_on_previous_text=false / 刻意不給 initial_prompt）。
// ⚠️ whisper large-v3 輸出為簡體，轉錄稿僅供 agent 讀，不可直接顯示給 Charles。
const DISCORD_FLAG_IS_VOICE_MESSAGE = 8192;
const TRANSCRIBE_PY = path.join(os.homedir(), "scripts", "tongyi", "transcribe_file.py");

function isVoiceMessage(message: any): boolean {
  const bits = message?.flags?.bitfield ?? message?.flags ?? 0;
  return (Number(bits) & DISCORD_FLAG_IS_VOICE_MESSAGE) !== 0;
}

function transcribeVoice(filepath: string): Promise<{ ok: boolean; text: string; note: string }> {
  return new Promise((resolve) => {
    const py = process.env.PYTHON_BIN ?? "python";
    execFile(py, [TRANSCRIBE_PY, filepath],
      { timeout: 300_000, env: { ...process.env, PYTHONUTF8: "1" }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = (stdout || "").trim();
        if (err || !text) {
          resolve({ ok: false, text: "", note: (stderr || err?.message || "轉錄無輸出").toString().slice(0, 200) });
          return;
        }
        // stderr 帶時長/語言/幻覺警告，保留給 log 與使用者提示（fail loud）
        resolve({ ok: true, text, note: (stderr || "").toString().trim().slice(0, 200) });
      });
  });
}

// --- 收料頻道：Fred 分享即時入庫（佐助前門，確定性轉換，零 LLM，僅 IrisBot）---
const INTAKE_CHANNEL_NAME = process.env.INTAKE_CHANNEL_NAME ?? "收料";
const INTAKE_CHANNEL_ID = process.env.INTAKE_CHANNEL_ID ?? "1528300306616684645"; // #收料 文字頻道(開檔案 thread 用)
const INTAKE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const FRED_INTAKE_PY = path.join(os.homedir(), "scripts", "data_readiness", "fred_intake.py");
// 檔案問答「乾淨腦」隔離：只複製認證、不含 Iris CLAUDE.md/hooks（見 D:/dev-cache/fred-qa-config）
const FRED_QA_CONFIG = process.env.FRED_QA_CONFIG ?? "D:/dev-cache/fred-qa-config";
const FRED_QA_CWD = process.env.FRED_QA_CWD ?? "D:/Temp/claude/fred-qa-cwd";
const FRED_QA_MAP = path.join(import.meta.dirname, "..", "fred_qa_threads.json"); // threadId -> {file, sessionId}

type QaEntry = { file: string; sessionId: string; started?: boolean };
function loadQaMap(): Record<string, QaEntry> {
  try { return JSON.parse(fs.readFileSync(FRED_QA_MAP, "utf-8")); } catch { return {}; }
}
function saveQaEntry(threadId: string, entry: QaEntry): void {
  const m = loadQaMap();
  m[threadId] = entry;
  try { fs.writeFileSync(FRED_QA_MAP, JSON.stringify(m, null, 1)); } catch (e) { console.error("[fred-qa] map save fail", e); }
}

type IntakeResult = { status: string; title?: string; chars?: number; converter?: string; path?: string; note?: string };

function runFredIntake(rawPath: string, sourceName: string): Promise<IntakeResult> {
  return new Promise((resolve) => {
    const py = process.env.PYTHON_BIN ?? "python";
    // --source-name=<值> 等號形式：檔名開頭若是 '-'(如某些字幕檔) argparse 不會誤判成選項
    execFile(py, [FRED_INTAKE_PY, rawPath, `--source-name=${sourceName}`],
      { timeout: 120_000, env: { ...process.env, PYTHONUTF8: "1" }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const line = (stdout || "").trim().split("\n").filter(Boolean).pop() || "";
        try {
          resolve(JSON.parse(line) as IntakeResult);
        } catch {
          resolve({ status: "error", note: (stderr || (err && err.message) || "intake 無輸出").toString().slice(0, 200) });
        }
      });
  });
}

function runQmdUpdate(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("qmd", ["update"], { timeout: 120_000, shell: true }, (err) => resolve(!err));
  });
}

// 蒐集訊息附件：一般附件 + 「轉傳(forward)」的訊息快照裡的附件（轉傳的檔在 messageSnapshots，不在 top-level attachments）
function gatherAttachments(message: any): any[] {
  const atts = [...message.attachments.values()] as any[];
  const snaps = (message as any).messageSnapshots;
  if (snaps && typeof snaps.values === "function") {
    for (const snap of snaps.values()) {
      if (snap?.attachments && typeof snap.attachments.values === "function") {
        atts.push(...snap.attachments.values());
      }
    }
  }
  return atts;
}

// 每個入庫檔在 #收料 開一條 thread，記 threadId→檔案，貼使用說明。回 thread 連結。
async function createFileThread(fileName: string, filePath: string): Promise<string | null> {
  try {
    const ch: any = await client.channels.fetch(INTAKE_CHANNEL_ID);
    if (!ch || typeof ch.threads?.create !== "function") return null;
    // 同一份檔已有 thread → 重用連結，不重開
    const existing = Object.entries(loadQaMap()).find(([, v]) => v.file === filePath);
    if (existing) return `https://discord.com/channels/${ch.guildId}/${existing[0]}`;
    const base = fileName.replace(/\.[^.]+$/, "").slice(0, 90) || "檔案";
    const thread = await ch.threads.create({
      name: `📄 ${base}`,
      autoArchiveDuration: 10080,
      type: ChannelType.PublicThread,
      reason: "fred 收料檔案問答",
    });
    saveQaEntry(thread.id, { file: filePath, sessionId: crypto.randomUUID() });
    await thread.send(`已入庫這份材料。**在這條 thread 裡 @我問問題**（例：<@${client.user!.id}> 這份重點是什麼？），我只讀這一份檔回答，不會扯到別的。`).catch(() => {});
    return `https://discord.com/channels/${ch.guildId}/${thread.id}`;
  } catch (e) {
    console.error("[fred-qa] create thread fail", e);
    return null;
  }
}

async function handleIntakeMessage(message: any): Promise<void> {
  const atts = gatherAttachments(message);
  const notice = await message.reply(`⏳ 收料中…（${atts.length} 個檔案）`);
  const lines: string[] = [];
  let anyOk = false;
  for (const att of atts) {
    const name = (att.name as string) ?? "unnamed";
    if (att.size > INTAKE_MAX_BYTES) {
      lines.push(`⚠️ ${name}：超過 50MB，跳過`);
      continue;
    }
    const ext = name.split(".").pop() ?? "bin";
    const filepath = path.join(ATTACH_TMP_DIR, `${message.id}_${att.id}.${ext}`);
    try {
      await downloadAttachment(att.url, filepath);
    } catch {
      lines.push(`❌ ${name}：下載失敗`);
      continue;
    }
    const r = await runFredIntake(filepath, name);
    if (r.status === "ok") {
      anyOk = true;
      const link = r.path ? await createFileThread(name, r.path) : null;
      lines.push(`✅ ${name} → 已入庫（${r.note ?? ""}）${link ? `\n　↳ 問這份材料：${link}` : ""}`);
    }
    else if (r.status === "duplicate") {
      const link = r.path ? await createFileThread(name, r.path) : null;
      lines.push(`↩️ ${name}：同內容已在庫${link ? `\n　↳ 問這份材料：${link}` : ""}`);
    }
    else if (r.status === "unsupported") lines.push(`⚠️ ${r.note ?? name}`);
    else lines.push(`❌ ${name}：${r.note ?? "入庫失敗"}`);
    // 只有「確定進庫了」才刪暫存原檔（ok＝新入庫、duplicate＝同內容已在庫）。
    // 失敗時保留：2026-08-01 發現 4 張圖在入庫當下就被無條件刪除，claude vision
    // 若逾時或轉錯，原圖等於永久消失（Discord 上還有，但要人工回頭撈）。
    if (r.status === "ok" || r.status === "duplicate") {
      fs.rm(filepath, () => {});
    } else {
      lines.push(`　↳ 原檔保留在 tmp-attachments/${path.basename(filepath)}，修好可重試`);
    }
  }
  let tail = "";
  if (anyOk) {
    const ok = await runQmdUpdate();
    tail = ok ? "\n\n🔎 qmd 索引已更新，現在可查。" : "\n\n🔎 已入庫，qmd 索引稍後更新。";
  }
  await notice.edit(`**收料完成**\n${lines.join("\n")}${tail}`).catch(() => {});
}

// --- URL Interception (Jina AI) ---
async function expandUrlsWithJina(text: string, previewState: PreviewState): Promise<string> {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = [...text.matchAll(urlRegex)].map(m => m[1]);
  if (urls.length === 0) return text;

  let expandedText = text;
  for (const url of urls) {
    // Skip if it's already a jina URL or a known local/internal IP
    if (url.startsWith("https://r.jina.ai/") || url.includes("127.0.0.1") || url.includes("localhost")) continue;

    try {
      if (previewState.msg) {
        await previewState.msg.edit(`⏳ *Reading ${url} via Jina AI...*`).catch(() => {});
      }
      const res = await fetch(`https://r.jina.ai/${url}`);
      if (res.ok) {
        const markdown = await res.text();
        expandedText += `\n\n--- Content from ${url} ---\n${markdown.slice(0, 20000)}\n--- End of ${url} ---`;
      }
    } catch (err) {
      console.error(`[discord-cc-bot] Jina fetch failed for ${url}:`, err);
    }
  }
  return expandedText;
}

// --- Chunked message sending ---

const DISCORD_MAX_LEN = 2000;
const CHUNK_LEN = 1900;

function splitMessage(text: string): string[] {
  if (text.length <= CHUNK_LEN) return [text];

  // Split text into atomic segments: complete code blocks + surrounding text.
  // Code blocks are never broken across chunks.
  const segments: string[] = [];
  const blockRegex = /^(`{3,})\w*\n[\s\S]*?^\1\s*$/gm;
  let lastEnd = 0;

  for (const match of text.matchAll(blockRegex)) {
    if (match.index! > lastEnd) {
      segments.push(text.slice(lastEnd, match.index!));
    }
    segments.push(match[0]);
    lastEnd = match.index! + match[0].length;
  }
  if (lastEnd < text.length) {
    segments.push(text.slice(lastEnd));
  }

  // Pack segments into chunks, splitting only at segment boundaries
  const chunks: string[] = [];
  let current = "";

  for (const seg of segments) {
    const combined = current + seg;
    if (combined.length <= CHUNK_LEN) {
      current = combined;
      continue;
    }

    // Won't fit — flush current chunk, start new one
    if (current) chunks.push(current);

    if (seg.length <= CHUNK_LEN) {
      current = seg;
    } else {
      // Oversized segment — detect if it's a code block
      const fenceMatch = seg.match(/^(`{3,})(\w*)\n/);
      if (fenceMatch) {
        // It's a code block — strip outer fences, split inner content, re-wrap each piece
        const fence = fenceMatch[1];
        const lang = fenceMatch[2];
        const header = fence + lang + "\n";
        const footer = "\n" + fence;
        const closeIdx = seg.lastIndexOf("\n" + fence);
        const body = seg.slice(header.length, closeIdx === -1 ? seg.length : closeIdx);
        const maxBody = CHUNK_LEN - header.length - footer.length;
        let rem = body;
        while (rem.length > maxBody) {
          let splitAt = rem.lastIndexOf("\n", maxBody);
          if (splitAt < maxBody / 2) splitAt = maxBody;
          chunks.push(header + rem.slice(0, splitAt) + footer);
          rem = rem.slice(splitAt + (rem[splitAt] === "\n" ? 1 : 0));
        }
        current = header + rem + footer;
      } else {
        // Plain text oversized — split at newlines
        let rem = seg;
        while (rem.length > CHUNK_LEN) {
          let splitAt = rem.lastIndexOf("\n", CHUNK_LEN);
          if (splitAt < CHUNK_LEN / 2) splitAt = CHUNK_LEN;
          chunks.push(rem.slice(0, splitAt));
          rem = rem.slice(splitAt + (rem[splitAt] === "\n" ? 1 : 0));
        }
        current = rem;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendChunked(
  channel: { send: (content: string) => Promise<Message> },
  text: string,
  replyTo?: Message,
): Promise<Message> {
  const chunks = splitMessage(text);

  let firstMsg: Message | undefined;
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0 && replyTo) {
      firstMsg = await replyTo.reply(chunks[i]);
    } else {
      const msg = await channel.send(chunks[i]);
      if (i === 0) firstMsg = msg;
    }
  }
  return firstMsg!;
}

// --- Auto-capture conversation turn to memory_api (EverOS-style episodic memory) ---
// Fire-and-forget; never throws into the bot flow. Writes via ~/scripts/memory_api.py
// (--no-reindex; QMD_Reindex cron makes it searchable later).
function captureMemory(threadId: string, userText: string, replyText: string): void {
  try {
    const u = (userText || "").replace(/<@[!&]?\d+>/g, "").trim();
    const r = (replyText || "").trim();
    if (!u || !r) return;
    const py = process.env.PYTHON_BIN ?? "python";
    const script = path.join(os.homedir(), "scripts", "memory_api.py");
    const name = `chat-${PERSONA}-${threadId}-${Date.now()}`;
    const text = `## 使用者\n${u.slice(0, 1500)}\n\n## ${PERSONA}\n${r.slice(0, 3000)}`;
    execFile(py, [script, "add", "--no-reindex", "--mtype", "episode",
      "--agent", PERSONA, "--user", "charles", "--session", threadId,
      "--name", name, "--text", text], { timeout: 30000 }, (err) => {
      if (err) console.error("[memory-capture] failed:", err.message);
    });
  } catch (e) {
    console.error("[memory-capture] error:", (e as Error).message);
  }
}

// --- Streaming preview throttle ---

const STREAM_THROTTLE_MS = 1500;
const STREAM_MIN_DELTA = 40;
const PREVIEW_MAX_LEN = 1900;

type PreviewState = {
  msg: Message | null;
  lastText: string;
  lastEditTime: number;
  timer: NodeJS.Timeout | null;
  pendingText: string;
  startTime: number;
  toolsUsed: string[];
};

function createPreviewState(): PreviewState {
  return { msg: null, lastText: "", lastEditTime: 0, timer: null, pendingText: "", startTime: Date.now(), toolsUsed: [] };
}

function formatElapsed(startTime: number): string {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

function buildStatusLine(ps: PreviewState): string {
  const time = formatElapsed(ps.startTime);
  const toolLine = ps.toolsUsed.length > 0
    ? `🔧 ${ps.toolsUsed.slice(-3).join(" → ")}\n` : "";
  return `\n\n${toolLine}⏳ *working... (${time})*`;
}

function flushPreview(ps: PreviewState): void {
  if (!ps.msg || !ps.pendingText) return;
  const display = ps.pendingText.slice(0, PREVIEW_MAX_LEN) + buildStatusLine(ps);
  ps.msg.edit(display).catch(() => {});
  ps.lastText = ps.pendingText;
  ps.lastEditTime = Date.now();
}

function handleStreamText(ps: PreviewState, fullText: string): void {
  ps.pendingText = fullText;

  const delta = fullText.length - ps.lastText.length;
  const elapsed = Date.now() - ps.lastEditTime;

  // Not enough new content
  if (delta < STREAM_MIN_DELTA && ps.lastEditTime > 0) {
    if (!ps.timer) {
      ps.timer = setTimeout(() => {
        ps.timer = null;
        flushPreview(ps);
      }, STREAM_THROTTLE_MS);
    }
    return;
  }

  // Too soon since last edit
  if (elapsed < STREAM_THROTTLE_MS && ps.lastEditTime > 0) {
    if (!ps.timer) {
      ps.timer = setTimeout(() => {
        ps.timer = null;
        flushPreview(ps);
      }, STREAM_THROTTLE_MS - elapsed);
    }
    return;
  }

  // Enough content & time — flush immediately
  if (ps.timer) clearTimeout(ps.timer);
  flushPreview(ps);
}

// --- Discord ---

const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.cwd();
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const GUILD_ID = process.env.GUILD_ID;
const QA_MODEL = process.env.FRED_QA_MODEL ?? "claude-sonnet-5";

// 檔案問答「乾淨腦」：CLAUDE_CONFIG_DIR 隔離(無 Iris CLAUDE.md/hooks) + 空 cwd + 讀單一檔
async function answerAboutFile(filePath: string, question: string, sessionId: string, resume: boolean): Promise<RunResult> {
  const prompt = `你是只針對「單一份文件」回答問題的助理，一律用繁體中文。只根據下面這個檔案的內容回答，不要引入任何其他背景、系統狀態、handoff 或記憶資訊；檔案沒提到的就說沒提到。\n檔案路徑：${filePath}\n\n問題：${question}`;
  return runClaudeStreaming({
    sessionId, prompt, cwd: FRED_QA_CWD, model: QA_MODEL, claudeBin: CLAUDE_BIN,
    resume, configDir: FRED_QA_CONFIG,
  });
}

// 在檔案 thread 裡 @bot 發問 → 乾淨腦只讀那份檔回答（多輪 --resume）
async function handleFileQa(message: any, qa: QaEntry): Promise<void> {
  const question = (message.content || "").replace(/<@[!&]?\d+>/g, "").trim();
  if (!question) { await message.reply("要問這份材料什麼？@我 後面直接打問題就好。").catch(() => {}); return; }
  if (running.has(qa.sessionId)) { await message.reply("這份材料上一個問題還在處理，請稍等。").catch(() => {}); return; }
  const preview = await message.reply("⏳ 讀取這份材料回答中…");
  try {
    const started = (qa as any).started === true;
    const result = await answerAboutFile(qa.file, question, qa.sessionId, started);
    const text = (result.text || "").trim() || "（沒有產生回覆）";
    const chunks = splitMessage(text);
    await preview.edit(chunks[0]).catch(() => {});
    for (let i = 1; i < chunks.length; i++) await (message.channel as any).send(chunks[i]).catch(() => {});
    if (!started && result.exitCode === 0) saveQaEntry(message.channelId, { ...qa, started: true } as QaEntry);
  } catch (e) {
    await preview.edit(`⚠️ 回答失敗：${((e as Error).message || "").slice(0, 150)}`).catch(() => {});
  }
}

// --- Scheduled "開工" cron ---
// CRON_CHANNEL_ID: the thread/channel ID where the bot auto-posts "開工"
// CRON_SCHEDULE: cron expression (default: 8:30 AM Asia/Taipei = "30 0 * * 1-5" UTC, weekdays only)
const CRON_CHANNEL_ID = process.env.CRON_CHANNEL_ID ?? "";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? "30 8 * * 1-5"; // Asia/Taipei local time

// --- IrisBot watchdog (SelinaBot only) ---
const IRISBOT_ENV = path.join(import.meta.dirname, "..", ".env");
const IRISBOT_LOG = "/tmp/irisbot.log";
const IRISBOT_CWD = path.join(import.meta.dirname, "..");

function isIrisBotRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("wmic", ["process", "where", "name='node.exe'", "get", "CommandLine"], (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(stdout.includes("--env-file=.env ") || stdout.includes('--env-file=".env"'));
    });
  });
}

function startIrisBot(): Promise<void> {
  return new Promise((resolve, reject) => {
    const log = fs.openSync(IRISBOT_LOG, "a");
    const cleanEnv = { ...process.env };
    delete cleanEnv.PERSONA;
    delete cleanEnv.BACKEND;
    delete cleanEnv.SYSTEM_PROMPT_FILE;
    delete cleanEnv.GEMINI_MODEL;
    delete cleanEnv.GEMINI_ALLOWED_MCP;
    delete cleanEnv.GEMINI_TIMEOUT_MS;
    delete cleanEnv.GEMINI_MAX_RETRIES;
    delete cleanEnv.GEMINI_FALLBACK_MODEL;
    delete cleanEnv.PERSONA_PROMPT;
    delete cleanEnv.DISCORD_TOKEN;
    const child = spawn(process.execPath, ["--env-file=.env", "--import=tsx", "src/index.ts"], {
      cwd: IRISBOT_CWD,
      stdio: ["ignore", log, log],
      detached: true,
      env: cleanEnv,
    });
    child.unref();
    setTimeout(() => resolve(), 1500);
    child.on("error", reject);
  });
}

async function killAndRestartIrisBot(): Promise<boolean> {
  // 1. Find and kill all IrisBot node processes
  await new Promise<void>((resolve) => {
    execFile("wmic", ["process", "where", "name='node.exe'", "get", "ProcessId,CommandLine"], (err, stdout) => {
      if (err) { resolve(); return; }
      const lines = stdout.split("\n");
      const pids: string[] = [];
      for (const line of lines) {
        if ((line.includes("--env-file=.env ") || line.includes('--env-file=".env"')) && !line.includes(".env.selina")) {
          const m = line.match(/\s+(\d+)\s*$/);
          if (m) pids.push(m[1]);
        }
      }
      if (pids.length === 0) { resolve(); return; }
      let done = 0;
      for (const pid of pids) {
        execFile("taskkill", ["/PID", pid, "/F"], () => { if (++done === pids.length) resolve(); });
      }
    });
  });
  // 2. Wait briefly then start fresh
  await new Promise(r => setTimeout(r, 1000));
  await startIrisBot();
  // 3. Verify
  await new Promise(r => setTimeout(r, 2000));
  return isIrisBotRunning();
}

const slashCommands = [
  new SlashCommandBuilder().setName("help").setDescription("Show available commands"),
  new SlashCommandBuilder().setName("new").setDescription("Clear context — start a new conversation (thread only)"),
  new SlashCommandBuilder().setName("model").setDescription("Switch Claude model")
    .addStringOption(o => o.setName("name").setDescription("Model name (e.g. sonnet, opus, haiku)").setRequired(true)),
  new SlashCommandBuilder().setName("cd").setDescription("Switch working directory")
    .addStringOption(o => o.setName("path").setDescription("Absolute path to directory").setRequired(true)),
  new SlashCommandBuilder().setName("stop").setDescription("Kill running Claude process (thread only)"),
  new SlashCommandBuilder().setName("sessions").setDescription("List all active sessions"),
  new SlashCommandBuilder().setName("resume-local").setDescription("Resume a local terminal Claude Code session")
    .addStringOption(o => o.setName("session").setDescription("Session ID (auto-detect if omitted)").setRequired(false)),
  new SlashCommandBuilder().setName("handback").setDescription("Hand session back to terminal"),
  ...(PERSONA === "selina" ? [
    new SlashCommandBuilder().setName("restart-iris").setDescription("重啟 IrisBot（SelinaBot 限定）"),
    new SlashCommandBuilder().setName("selina-audit").setDescription("查 ticker 的 thesis 速查卡（SelinaBot 限定）")
      .addStringOption(o => o.setName("ticker").setDescription("Stock ticker (e.g. VST, CCJ)").setRequired(true)),
    new SlashCommandBuilder().setName("selina-brief").setDescription("立刻觸發 Selina 晨報"),
    new SlashCommandBuilder().setName("selina-holdings").setDescription("7 檔持倉總覽（fv / 現價 / rating）"),
    new SlashCommandBuilder().setName("selina-events").setDescription("列近期關鍵事件（財報 / FOMC）"),
    new SlashCommandBuilder().setName("selina-weekly").setDescription("立刻產本週 digest（過去 7 天 handoff 摘要）"),
    new SlashCommandBuilder().setName("selina-ask-brain").setDescription("查 Gbrain 語義記憶（歷史 thesis / 決策）")
      .addStringOption(o => o.setName("query").setDescription("問題（英文較穩）").setRequired(true)),
    new SlashCommandBuilder().setName("selina-debate").setDescription("自我辯論（bull/bear/risk 三角色模擬）")
      .addStringOption(o => o.setName("topic").setDescription("辯論主題（e.g. VST 現在該加碼嗎）").setRequired(true)),
  ] : []),
  ...(PERSONA === "athena" ? [
    new SlashCommandBuilder().setName("athena-insight").setDescription("查閱最新一筆 Athena 實相歸檔（AthenaBot 限定）"),
    new SlashCommandBuilder().setName("athena-forensic").setDescription("一鍵法證審計（自動抓取財報進行 TREX 降維打擊）")
      .addStringOption(o => o.setName("ticker").setDescription("Stock ticker (e.g. TSLA, CEG)").setRequired(true)),
    new SlashCommandBuilder().setName("athena-buddha").setDescription("佛陀模式辯證（正方敘事 vs 鋼鐵人反方）")
      .addStringOption(o => o.setName("topic").setDescription("辯論主題").setRequired(true)),
    new SlashCommandBuilder().setName("athena-polymarket").setDescription("查 Polymarket 事件勝率（導入 Base Rate）")
      .addStringOption(o => o.setName("event").setDescription("事件關鍵字 (e.g. Fed Chair)").setRequired(true)),
    new SlashCommandBuilder().setName("athena-ask-brain").setDescription("查 QMD 語義記憶（提取歷史 case study）")
      .addStringOption(o => o.setName("query").setDescription("查詢關鍵字").setRequired(true)),
    new SlashCommandBuilder().setName("athena-mega").setDescription("🔥 執行全維度超級指令（耗時，自動呼叫 mega-reality-auditor）")
      .addStringOption(o => o.setName("ticker").setDescription("Stock ticker (e.g. TSLA)").setRequired(true)),
    new SlashCommandBuilder().setName("athena-daily-audit").setDescription("📊 執行每日持股新聞與論壇情緒巡視（自動讀取 holdings.json）"),
    new SlashCommandBuilder().setName("athena-swarm").setDescription("⚔️ 啟動多代理人沙盤推演 (Athena vs Selina 3 輪對抗)")
      .addStringOption(o => o.setName("topic").setDescription("辯論主題").setRequired(true)),
  ] : []),
  ...(PERSONA === "iris" ? [
    new SlashCommandBuilder().setName("iris-handoff").setDescription("拉最新 TODAY_SUMMARY handoff"),
    new SlashCommandBuilder().setName("iris-holdings").setDescription("7 檔持倉快照（px / fv / rating）"),
    new SlashCommandBuilder().setName("iris-status").setDescription("Iris 並發狀態（Heavy / Light / Queue）"),
    new SlashCommandBuilder().setName("iris-recall").setDescription("查 Gbrain 語義記憶")
      .addStringOption(o => o.setName("query").setDescription("問題").setRequired(true)),
    new SlashCommandBuilder().setName("iris-kaigong").setDescription("開工：handoff + gbrain warm-up"),
    new SlashCommandBuilder().setName("iris-audit").setDescription("Ticker 狀態卡（現況 + archive + 觸發導引）")
      .addStringOption(o => o.setName("ticker").setDescription("Stock ticker (e.g. VST)").setRequired(true)),
    new SlashCommandBuilder().setName("iris-sector").setDescription("美股 11 GICS 板塊輪動（L1 summary）"),
    new SlashCommandBuilder().setName("iris-aaii").setDescription("AAII 散戶情緒卡（最新週四數據）"),
    new SlashCommandBuilder().setName("iris-shuyuan").setDescription("📚 山崖書院開課（耗時數分鐘，跑完推播）")
      .addStringOption(o => o.setName("book").setDescription("書名或關鍵字（要對得上收料庫的檔名）").setRequired(true))
      .addBooleanOption(o => o.setName("list").setDescription("只找不開：先看有哪些候選").setRequired(false)),
  ] : []),
];

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN");
  process.exit(1);
}

const threadMap = loadMap();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[discord-cc-bot] ready as ${c.user.tag}`);
  c.user.setStatus('online');
  const rest = new REST().setToken(DISCORD_TOKEN);
  try {
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(c.user.id, GUILD_ID)
      : Routes.applicationCommands(c.user.id);
    await rest.put(route, {
      body: slashCommands.map(cmd => cmd.toJSON()),
    });
    console.log(`[discord-cc-bot] registered ${slashCommands.length} slash commands`);
  } catch (err) {
    console.error("[discord-cc-bot] failed to register commands:", err);
  }

  // Auto-join all active threads so we receive MessageCreate events after restart
  try {
    const guild = GUILD_ID ? c.guilds.cache.get(GUILD_ID) : c.guilds.cache.first();
    if (guild) {
      const active = await guild.channels.fetchActiveThreads();
      let joined = 0;
      for (const thread of active.threads.values()) {
        if (!thread.joined) {
          await thread.join();
          joined++;
        }
      }
      if (joined > 0) console.log(`[discord-cc-bot] auto-joined ${joined} active threads`);
    }
  } catch (err) {
    console.error("[discord-cc-bot] failed to auto-join threads:", err);
  }

  // --- Scheduled "開工" cron job ---
  // CRON_CHANNEL_ID should point to a TEXT CHANNEL (not a thread).
  // Each day, the cron creates a new thread named "開工 YYYY-MM-DD" and runs CC inside it.
  if (CRON_CHANNEL_ID && PERSONA !== "selina") {
    cron.schedule(CRON_SCHEDULE, async () => {
      const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }); // YYYY-MM-DD
      console.log(`[discord-cc-bot] ⏰ cron triggered: 開工 ${today} → channel ${CRON_CHANNEL_ID}`);
      try {
        const channel = await c.channels.fetch(CRON_CHANNEL_ID);
        if (!channel || !("threads" in channel)) {
          console.error(`[discord-cc-bot] cron: channel ${CRON_CHANNEL_ID} not found or cannot create threads`);
          return;
        }

        // Create a new thread for today's 開工
        const threadName = `開工 ${today}`;
        const thread = await (channel as any).threads.create({
          name: threadName,
          autoArchiveDuration: 1440, // 24 hours
          reason: "Daily 開工 auto-created by IrisBot cron",
        });
        console.log(`[discord-cc-bot] ⏰ created thread: ${threadName} (${thread.id})`);

        // Initialize thread entry
        const entry = getOrCreate(threadMap, thread.id, DEFAULT_CWD);

        const previewState = createPreviewState();
        previewState.msg = await thread.send("⏰ **8:30 開工！**\n⏳ *Iris 正在讀取最新 handoff...*");

        const cronOverride = applyModelOverride("開工", entry.model, thread.id);
        const result = await runClaudeStreaming({
          sessionId: entry.sessionId,
          prompt: cronOverride.prompt,
          cwd: entry.cwd,
          model: cronOverride.model,
          claudeBin: CLAUDE_BIN,
          resume: false,
          systemPrompt: SYSTEM_PROMPT,
          callbacks: {
            onText: (fullText) => handleStreamText(previewState, fullText),
            onToolUse: createToolUseHandler(previewState),
          },
        });

        if (previewState.timer) clearTimeout(previewState.timer);

        entry.started = true;
        patchSessionEntrypoint(entry.sessionId, entry.cwd);
        saveEntry(thread.id, entry);

        // Deliver final response
        try {
          await previewState.msg!.delete().catch(() => {});
          const responseText = cronOverride.hint
            ? `${cronOverride.hint}\n\n${result.text}`
            : result.text;
          if (responseText.length <= DISCORD_MAX_LEN) {
            const botReply = await thread.send(responseText);
            entry.lastBotMessageId = botReply.id;
          } else {
            const botReply = await sendChunked(thread, responseText);
            entry.lastBotMessageId = botReply.id;
          }
          saveEntry(thread.id, entry);
        } catch (err) {
          console.error("[discord-cc-bot] cron reply failed:", (err as Error).message);
        }

        console.log(`[discord-cc-bot] ⏰ cron 開工 ${today} complete`);
      } catch (err) {
        console.error("[discord-cc-bot] cron error:", err);
      }
    }, { timezone: "Asia/Taipei" });

    console.log(`[discord-cc-bot] ⏰ cron scheduled: "${CRON_SCHEDULE}" → channel ${CRON_CHANNEL_ID} (Asia/Taipei)`);
  }

  // --- Weekly digest (SelinaBot only, Saturday 09:00) ---
  if (PERSONA === "selina" && CRON_CHANNEL_ID) {
    const weeklySchedule = process.env.SELINA_WEEKLY_SCHEDULE ?? "0 9 * * 6";
    cron.schedule(weeklySchedule, async () => {
      try {
        const channel = await c.channels.fetch(CRON_CHANNEL_ID);
        if (channel && "send" in channel) {
          const digest = buildWeeklyDigest();
          await (channel as any).send(digest.slice(0, 2000));
          console.log(`[discord-cc-bot] 📰 Selina weekly digest posted to ${CRON_CHANNEL_ID}`);
        }
      } catch (err) {
        console.error("[discord-cc-bot] weekly digest failed:", err);
        await dmCharlesOnError(c, (err as Error).message, "weekly digest cron");
      }
    }, { timezone: "Asia/Taipei" });
    console.log(`[discord-cc-bot] 📰 Selina weekly digest scheduled: "${weeklySchedule}" (Asia/Taipei, Sat)`);
  }

  // --- Morning brief (SelinaBot only) ---
  if (PERSONA === "selina" && CRON_CHANNEL_ID) {
    const briefSchedule = process.env.SELINA_BRIEF_SCHEDULE ?? "30 8 * * 1-5";
    cron.schedule(briefSchedule, async () => {
      try {
        const channel = await c.channels.fetch(CRON_CHANNEL_ID);
        if (channel && "send" in channel) {
          const brief = buildMorningBrief();
          await (channel as any).send(brief.slice(0, 2000));
          console.log(`[discord-cc-bot] 🌅 Selina morning brief posted to ${CRON_CHANNEL_ID}`);
        }
      } catch (err) {
        console.error("[discord-cc-bot] morning brief failed:", err);
        await dmCharlesOnError(c, (err as Error).message, "morning brief cron");
      }
    }, { timezone: "Asia/Taipei" });
    console.log(`[discord-cc-bot] 🌅 Selina morning brief scheduled: "${briefSchedule}" (Asia/Taipei)`);
  }

  // --- Morning Forensic Audit (AthenaBot only) ---
  if (PERSONA === "athena" && CRON_CHANNEL_ID) {
    const athenaSchedule = process.env.ATHENA_AUDIT_SCHEDULE ?? "0 6 * * 2-6"; // Tuesday-Saturday 6:00 AM (after US market close)
    cron.schedule(athenaSchedule, async () => {
      try {
        const channel = await c.channels.fetch(CRON_CHANNEL_ID);
        if (!channel || !("send" in channel)) return;
        
        console.log(`[discord-cc-bot] 🦉 Athena morning audit triggered for ${CRON_CHANNEL_ID}`);
        const previewMsg = await (channel as any).send("🦉 *Athena 正在執行盤後持股法證掃描...*");
        
        const auditPrompt = `[背景持股掃描] 這是每天盤後的自動排程。請調用 defeatbeta-api 與 sec-edgar 掃描 Charles 的核心持股清單 (例如 CEG, VST, TSLA, ASTS 等)。檢查是否有盤後發布的 8-K、內部人交易，或任何結構性惡化的財報跡象。若有異常變異 (Anomaly)，請以「打水漂演算法」進行高維推演並給出預警；若無異常，只需簡短報告「今日無結構性異常」。`;
        
        const result = await runAthenaCommand(auditPrompt, 300_000, channel.id, "System");

        await previewMsg.delete().catch(() => {});
        let finalText = result.text;
        let actionFootnote = "";
        if (ATHENA_EXT_ENABLED) {
          const processed = postProcessAthenaOutput(finalText);
          finalText = processed.cleanedText;
          actionFootnote = formatAthenaActionFootnote(processed);
        }
        
        const responseText = `🦉 **Athena 盤後實相預警**\n\n${finalText}${actionFootnote}`;
        if (responseText.length <= DISCORD_MAX_LEN) {
          await (channel as any).send(responseText);
        } else {
          await sendChunked(channel as any, responseText);
        }
        console.log(`[discord-cc-bot] 🦉 Athena morning audit posted to ${CRON_CHANNEL_ID}`);
      } catch (err) {
        console.error("[discord-cc-bot] Athena audit failed:", err);
      }
    }, { timezone: "Asia/Taipei" });
    console.log(`[discord-cc-bot] 🦉 Athena morning audit scheduled: "${athenaSchedule}" (Asia/Taipei)`);
  }

  // --- IrisBot Watchdog (SelinaBot only) ---
  if (PERSONA === "selina" && CRON_CHANNEL_ID) {
    let watchdogBusy = false;
    cron.schedule("*/2 * * * *", async () => {
      if (watchdogBusy) return;
      watchdogBusy = true;
      try {
        const alive = await isIrisBotRunning();
        if (!alive) {
          console.log("[discord-cc-bot] 🐕 watchdog: IrisBot is DOWN — restarting...");
          const ok = await killAndRestartIrisBot();
          // Notify in CRON_CHANNEL_ID
          try {
            const channel = await c.channels.fetch(CRON_CHANNEL_ID);
            if (channel && "send" in channel) {
              await (channel as any).send(ok
                ? `🔄 **IrisBot 偵測到下線，已自動重啟成功！** (${new Date().toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" })})`
                : `⚠️ **IrisBot 下線，嘗試重啟失敗！** 請手動處理。`
              );
            }
          } catch (notifyErr) {
            console.error("[discord-cc-bot] watchdog notify failed:", notifyErr);
          }
        }
      } catch (err) {
        console.error("[discord-cc-bot] watchdog error:", err);
      } finally {
        watchdogBusy = false;
      }
    });
    console.log("[discord-cc-bot] 🐕 IrisBot watchdog enabled (every 2 min)");
  }
});

async function runAthenaCommand(
  prompt: string,
  timeoutMs: number,
  channelId: string,
  username: string,
  previewState?: any
): Promise<RunResult> {
  // Slash commands stay on Claude Code ecosystem unless legacy BACKEND=gemini.
  // When chat is BACKEND=grok|agy, slash still uses CC (not the oneshot chat engine).
  if (BACKEND !== "gemini") {
    const entry = getOrCreate(threadMap, channelId, DEFAULT_CWD);
    return runClaudeStreaming({
      sessionId: crypto.randomUUID(),
      prompt: prompt,
      cwd: entry.cwd,
      model: "sonnet", // Use Sonnet for slash commands for speed/capability
      claudeBin: CLAUDE_BIN,
      resume: false,
      systemPrompt: SYSTEM_PROMPT,
      callbacks: previewState ? {
        onText: (fullText) => handleStreamText(previewState, fullText),
      } : undefined,
    });
  } else {
    const fullPrompt = buildGeminiPrompt({
      systemPrompt: GEMINI_SYSTEM_PROMPT,
      history: "",
      username: username,
      userMessage: prompt,
    });
    return runGeminiStreaming({
      prompt: fullPrompt,
      model: GEMINI_MODEL,
      timeoutMs: timeoutMs,
      callbacks: previewState ? {
        onText: (fullText) => handleStreamText(previewState, fullText),
      } : undefined,
    });
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  // --- Button handler ---
  if (interaction.isButton()) {
    const id = interaction.customId;
    console.log(`[discord-cc-bot] button: ${id} by ${interaction.user.username}`);

    // AskUserQuestion buttons: ask_<sessionId>_<answer>
    if (id.startsWith("ask_")) {
      const parts = id.split("_");
      const sessionId = parts[1];
      const answer = parts.slice(2).join("_");
      const threadId = interaction.channelId;
      const entry = threadMap[threadId];

      if (answer === "OTHER") {
        await interaction.reply({ content: "Type your answer as a regular message:", ephemeral: true });
        return;
      }

      await interaction.update({ content: `✅ **${answer}**`, components: [] });

      // Resume claude with the answer
      if (entry && !running.has(entry.sessionId)) {
        const ch = interaction.channel!;
        if (!("send" in ch)) return;
        const previewState = createPreviewState();
        previewState.msg = await ch.send("⏳ *Continuing...*");

        try {
          const buttonPromptRaw = `I choose: ${answer}`;
          const buttonOverride = applyModelOverride(buttonPromptRaw, entry.model, threadId);
          const result = await runClaudeStreaming({
            sessionId: entry.sessionId,
            prompt: buttonOverride.prompt,
            cwd: entry.cwd,
            model: buttonOverride.model,
            claudeBin: CLAUDE_BIN,
            resume: true,
            systemPrompt: SYSTEM_PROMPT,
            callbacks: {
              onText: (fullText) => handleStreamText(previewState, fullText),
              onToolUse: createToolUseHandler(previewState),
            },
          });

          if (previewState.timer) clearTimeout(previewState.timer);

          // Check for AskUserQuestion denials — render as Discord buttons
          const askDenial = result.permissionDenials?.find(d => d.tool_name === "AskUserQuestion");
          if (askDenial) {
            await previewState.msg!.delete().catch(() => {});
            await sendAskButtons(ch, threadId, entry, askDenial);
            return;
          }

          await previewState.msg!.delete().catch(() => {});
          const buttonFinalText = buttonOverride.hint
            ? `${buttonOverride.hint}\n\n${result.text}`
            : result.text;
          let botReply: Message;
          if (buttonFinalText.length <= DISCORD_MAX_LEN) {
            botReply = await ch.send(buttonFinalText);
          } else {
            botReply = await sendChunked(ch, buttonFinalText);
          }
          entry.lastBotMessageId = botReply.id;
          patchSessionEntrypoint(entry.sessionId, entry.cwd);
          saveEntry(threadId, entry);
        } catch (err) {
          if (previewState.timer) clearTimeout(previewState.timer);
          if (previewState.msg) await previewState.msg.edit(`Error: ${(err as Error).message}`).catch(() => {});
        }
      }
      return;
    }

    // Test buttons (temporary)
    if (id.startsWith("test_")) {
      const choice = id.replace("test_", "");
      console.log(`[discord-cc-bot] test button: ${choice}`);
      await interaction.update({
        content: `✅ **你選了：${choice}**\n\nBot 收到了你的選擇！按鈕互動成功。`,
        components: [],
      });
      return;
    }

    return;
  }

  // --- Select menu handler (resume-local session picker) ---
  if (interaction.isStringSelectMenu() && interaction.customId === "resume_local_select") {
    const sessionId = interaction.values[0];
    const threadId = interaction.channelId;
    const locals = discoverLocalSessions();
    const picked = locals.find(s => s.sessionId === sessionId);
    const cwd = picked?.cwd ?? DEFAULT_CWD;
    const alive = picked?.alive ?? false;

    const entry = getOrCreate(threadMap, threadId, cwd);
    entry.sessionId = sessionId;
    entry.cwd = cwd;
    entry.isLocalResume = true;
    entry.started = true;
    saveEntry(threadId, entry);

    const status = alive ? "🟢 terminal still running" : "🔵 inactive";
    await interaction.update({
      content:
        `📱 已接手本地 session \`${sessionId.slice(0, 8)}…\` (${status})\n` +
        `cwd: \`${cwd}\`\n\n` +
        (alive ? `> ⚠️ Terminal CC 還在跑。建議先在 terminal 輸入 \`/quit\`。\n` : "") +
        `> 💻 回到 terminal 後：\`/quit\` → \`claude --continue\``,
      components: [],
    });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    if (commandName === "help") {
      await interaction.reply({
        content: [
          "`/new` — clear context, start new conversation (thread only)",
          "`/model <name>` — switch model (e.g. sonnet, opus, haiku)",
          "`/cd <path>` — switch working directory",
          "`/stop` — kill running task (thread only)",
          "`/sessions` — list all sessions",
          "`/resume-local [session]` — resume a local terminal CC session",
          "`/handback` — hand session back to terminal",
        ].join("\n"),
        ephemeral: true,
      });
      return;
    }

    if (commandName === "new") {
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: "This command only works in threads.", ephemeral: true });
        return;
      }
      const threadId = interaction.channelId;
      const entry = getOrCreate(threadMap, threadId, DEFAULT_CWD);
      entry.sessionId = crypto.randomUUID();
      entry.started = false;
      saveEntry(threadId, entry);
      await interaction.reply({ content: "Context cleared. Next message starts a new conversation.", ephemeral: true });
      return;
    }

    if (commandName === "model") {
      const name = interaction.options.getString("name", true);
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: "This command only works in threads.", ephemeral: true });
        return;
      }
      const threadId = interaction.channelId;
      const entry = getOrCreate(threadMap, threadId, DEFAULT_CWD);
      entry.model = name;
      saveEntry(threadId, entry);
      await interaction.reply({ content: `Model -> \`${name}\``, ephemeral: true });
      return;
    }

    if (commandName === "cd") {
      const dir = interaction.options.getString("path", true);
      if (!fs.existsSync(dir)) {
        await interaction.reply({ content: `Path not found: \`${dir}\``, ephemeral: true });
        return;
      }
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: "This command only works in threads.", ephemeral: true });
        return;
      }
      const threadId = interaction.channelId;
      const entry = getOrCreate(threadMap, threadId, DEFAULT_CWD);
      entry.cwd = dir;
      saveEntry(threadId, entry);
      await interaction.reply({ content: `cwd -> \`${dir}\``, ephemeral: true });
      return;
    }

    if (commandName === "stop") {
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: "This command only works in threads.", ephemeral: true });
        return;
      }
      const threadId = interaction.channelId;
      const entry = threadMap[threadId];
      if (entry && running.has(entry.sessionId)) {
        running.get(entry.sessionId)!.kill("SIGTERM");
        await interaction.reply({ content: "Stopped.", ephemeral: true });
      } else {
        await interaction.reply({ content: "Nothing running.", ephemeral: true });
      }
      return;
    }

    if (commandName === "sessions") {
      const lines = Object.entries(threadMap).map(
        ([tid, e]) => `<#${tid}> | ${e.model} | \`${e.cwd}\`${e.isLocalResume ? " 📱" : ""}`,
      );
      await interaction.reply({
        content: lines.length ? lines.join("\n") : "No sessions.",
        ephemeral: true,
      });
      return;
    }

    if (commandName === "resume-local") {
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: "This command only works in threads.", ephemeral: true });
        return;
      }
      const threadId = interaction.channelId;
      const explicitId = interaction.options.getString("session");

      if (explicitId) {
        // Direct resume with explicit session ID
        const entry = getOrCreate(threadMap, threadId, DEFAULT_CWD);
        entry.sessionId = explicitId;
        entry.isLocalResume = true;
        entry.started = true; // always resume mode for local sessions
        saveEntry(threadId, entry);
        await interaction.reply(
          `📱 已接手本地 session \`${explicitId.slice(0, 8)}…\`\ncwd: \`${entry.cwd}\`\n\n` +
          `> 💻 回到 terminal 後：\`/quit\` → \`claude --continue\``,
        );
        return;
      }

      // Auto-discover local sessions
      const locals = discoverLocalSessions();
      if (locals.length === 0) {
        await interaction.reply({ content: "No local sessions found.", ephemeral: true });
        return;
      }

      // Filter: only sessions that are NOT alive (can't resume a running session)
      const resumable = locals.filter(s => !s.alive);
      const aliveCount = locals.length - resumable.length;

      if (resumable.length === 0) {
        const hint = aliveCount > 0
          ? `Found ${aliveCount} active session(s), but can't resume a running CC.\n` +
            `請先在 terminal 輸入 \`/quit\` 退出，再回來 \`/resume-local\`。`
          : "No local sessions found.";
        await interaction.reply({ content: hint, ephemeral: true });
        return;
      }

      if (resumable.length === 1) {
        const s = resumable[0];
        const entry = getOrCreate(threadMap, threadId, s.cwd);
        entry.sessionId = s.sessionId;
        entry.cwd = s.cwd;
        entry.isLocalResume = true;
        entry.started = true;
        saveEntry(threadId, entry);
        const promptHint = s.lastPrompt ? `\nLast prompt: *${s.lastPrompt.slice(0, 100)}*\n` : "\n";
        await interaction.reply(
          `📱 已接手本地 session \`${s.sessionId.slice(0, 8)}…\`` +
          promptHint +
          `cwd: \`${s.cwd}\`\n\n` +
          (aliveCount > 0 ? `> ⚠️ 另有 ${aliveCount} 個活躍 session 無法 resume（需先在 terminal \`/quit\`）\n` : "") +
          `> 💻 回到 terminal 後：\`claude --continue\``,
        );
        return;
      }

      // Multiple resumable sessions — show select menu
      const menu = new StringSelectMenuBuilder()
        .setCustomId("resume_local_select")
        .setPlaceholder("Pick a session to resume")
        .addOptions(
          resumable.slice(0, 10).map((s) => {
            const ago = Math.round((Date.now() - s.mtime) / 60000);
            const timeStr = ago < 60 ? `${ago}m` : `${Math.round(ago / 60)}h`;
            const prompt = s.lastPrompt ?? "(no prompt)";
            // Label: last prompt (max 100 chars, Discord limit)
            const label = `${prompt.slice(0, 95)}`;
            // Description: time ago + cwd
            const project = s.cwd.split("/").slice(-2).join("/");
            const desc = `${timeStr} ago · ${project}`;
            return new StringSelectMenuOptionBuilder()
              .setLabel(label.slice(0, 100) || "(empty)")
              .setDescription(desc.slice(0, 100))
              .setValue(s.sessionId);
          }),
        );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
      await interaction.reply({ content: "Select a local session to resume:", components: [row], ephemeral: true });
      return;
    }

    if (commandName === "handback") {
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: "This command only works in threads.", ephemeral: true });
        return;
      }
      const threadId = interaction.channelId;
      const entry = threadMap[threadId];
      if (!entry?.isLocalResume) {
        await interaction.reply({ content: "This thread is not a resumed local session.", ephemeral: true });
        return;
      }
      // Kill any running process
      if (running.has(entry.sessionId)) {
        running.get(entry.sessionId)!.kill("SIGTERM");
      }
      // Reset to a fresh bot session
      entry.isLocalResume = false;
      entry.sessionId = crypto.randomUUID();
      entry.started = false;
      saveEntry(threadId, entry);
      await interaction.reply(
        `💻 已交還 session。回到 terminal 輸入 \`claude --continue\` 即可看到完整對話。\n` +
        `此 thread 已重置，下次訊息會開始新的 bot session。`,
      );
      return;
    }

    if (commandName === "restart-iris" && PERSONA === "selina") {
      await interaction.deferReply();
      try {
        const killed = await killAndRestartIrisBot();
        await interaction.editReply(killed
          ? `✅ IrisBot 已重啟成功！`
          : `⚠️ IrisBot 重啟失敗，請查看 server log。`
        );
      } catch (err) {
        await interaction.editReply(`❌ 錯誤：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "selina-audit" && PERSONA === "selina") {
      await interaction.deferReply();
      try {
        const ticker = interaction.options.getString("ticker", true);
        const out = renderAuditTicker(ticker);
        await interaction.editReply(out.slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ 錯誤：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "selina-brief" && PERSONA === "selina") {
      await interaction.deferReply();
      try {
        const brief = buildMorningBrief();
        await interaction.editReply(brief.slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ 錯誤：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "selina-holdings" && PERSONA === "selina") {
      await interaction.deferReply();
      try {
        const out = renderHoldingsOverview();
        await interaction.editReply(out.slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ 錯誤：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "selina-events" && PERSONA === "selina") {
      await interaction.deferReply();
      try {
        const out = renderUpcomingEvents();
        await interaction.editReply(out.slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ 錯誤：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "selina-weekly" && PERSONA === "selina") {
      await interaction.deferReply();
      try {
        const out = buildWeeklyDigest();
        await interaction.editReply(out.slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ 錯誤：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "selina-ask-brain" && PERSONA === "selina") {
      await interaction.deferReply();
      try {
        const query = interaction.options.getString("query", true);
        const { spawn } = await import("node:child_process");
        const child = spawn("gbrain", ["ask", query], { shell: true });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { child.kill(); resolve(); }, 45000);
          child.on("close", () => { clearTimeout(timer); resolve(); });
        });
        const output = stdout.trim() || stderr.trim() || "(no output)";
        await interaction.editReply(`🧠 **Gbrain: ${query}**\n\n${output.slice(0, 1800)}`);
      } catch (err) {
        await interaction.editReply(`❌ Gbrain query 失敗：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "selina-debate" && PERSONA === "selina") {
      await interaction.deferReply();
      try {
        const topic = interaction.options.getString("topic", true);
        const debatePrompt = `[內部辯論模式] 針對主題「${topic}」用三個角色各一段話（每段 2-3 句，不超過 80 字）產出結構化辯論。禁止官方腔、禁止表格：

🟢 **Selina Bull**：從成長/敘事/宏觀順風角度看為什麼該做/加碼。
🔴 **Athena Bear**：從估值/財報/red flag/法證稽核角度反對。
🟡 **Marcus Risk**：從 position sizing、停損、時機、regime 風險給實戰建議。

最後一行用粗體給 **Charles 的下一步 action**（一句話，具體、可執行）。`;

        // Inline call to Gemini via the existing runGeminiStreaming helper
        const debateFullPrompt = buildGeminiPrompt({
          systemPrompt: GEMINI_SYSTEM_PROMPT,
          history: "",
          username: interaction.user.username,
          userMessage: debatePrompt,
        });
        const result = await runGeminiStreaming({
          prompt: debateFullPrompt,
          model: GEMINI_MODEL,
          timeoutMs: 120_000,
        });
        await interaction.editReply(`⚔️ **自我辯論：${topic}**\n\n${result.text.slice(0, 1800)}`);
      } catch (err) {
        await interaction.editReply(`❌ 辯論失敗：${(err as Error).message}`);
      }
      return;
    }

    // ─── AthenaBot /athena-* commands (PERSONA === "athena") ─────────────────

    if (commandName === "athena-insight" && PERSONA === "athena") {
      await interaction.deferReply();
      try {
        await interaction.editReply(renderLatestAthenaInsight());
      } catch (err) {
        await interaction.editReply(`❌ 錯誤：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "athena-forensic" && PERSONA === "athena") {
      await interaction.deferReply();
      try {
        const ticker = interaction.options.getString("ticker", true);
        const forensicPrompt = `[一鍵法證審計] 針對 ${ticker} 進行高維度法證審計。請立刻調用 defeatbeta-api 與 sec-edgar 抓取最新財報與內部人交易數據。請以「打水漂演算法」進行降維打擊，找出財報貓膩與結構性瓶頸，並給出明確的結論。不要表格。`;
        const result = await runAthenaCommand(forensicPrompt, 180_000, interaction.channelId, interaction.user.username);
        await interaction.editReply(`🕵️ **法證審計：${ticker}**\n\n${result.text.slice(0, 1800)}`);
      } catch (err) {
        await interaction.editReply(`❌ 審計失敗：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "athena-buddha" && PERSONA === "athena") {
      await interaction.deferReply();
      try {
        const topic = interaction.options.getString("topic", true);
        const buddhaPrompt = `[佛陀模式辯證] 針對主題「${topic}」進行辯證。強制扮演「正方敘事」與「鋼鐵人反方(Steelman Defense)」。
正方敘事：列出為何此邏輯成立。
鋼鐵人反方：給出最致命的結構性反駁或數據打擊。
最終結論：給出實相與勝率評估。不要表格。`;
        const result = await runAthenaCommand(buddhaPrompt, 120_000, interaction.channelId, interaction.user.username);
        await interaction.editReply(`🧘 **佛陀辯證：${topic}**\n\n${result.text.slice(0, 1800)}`);
      } catch (err) {
        await interaction.editReply(`❌ 辯證失敗：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "athena-polymarket" && PERSONA === "athena") {
      await interaction.deferReply();
      try {
        const event = interaction.options.getString("event", true);
        const polyPrompt = `[Polymarket 查驗] 請調用 mcp-polymarket 查詢關於「${event}」的最新市場勝率與相關市場。根據查到的 Base Rate，給出一句高維度解讀。不要表格。`;
        const result = await runAthenaCommand(polyPrompt, 90_000, interaction.channelId, interaction.user.username);
        await interaction.editReply(`🎲 **Polymarket：${event}**\n\n${result.text.slice(0, 1800)}`);
      } catch (err) {
        await interaction.editReply(`❌ 查詢失敗：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "athena-ask-brain" && PERSONA === "athena") {
      await interaction.deferReply();
      try {
        const query = interaction.options.getString("query", true);
        // gbrain 2026-06-16 退役 → 改本地 QMD（全本地 BM25+向量，無 OpenAI quota）
        const { spawn } = await import("node:child_process");
        const child = spawn("qmd", ["query", query], { shell: true });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { child.kill(); resolve(); }, 45000);
          child.on("close", () => { clearTimeout(timer); resolve(); });
        });
        const output = stdout.trim() || stderr.trim() || "(no output)";
        await interaction.editReply(`🧠 **QMD 記憶提取: ${query}**\n\n${output.slice(0, 1800)}`);
      } catch (err) {
        await interaction.editReply(`❌ QMD 查詢失敗：${(err as Error).message}`);
      }
      return;
    }

    if (commandName === "athena-mega" && PERSONA === "athena") {
      await interaction.reply(`🔥 **開始執行全維度審計超級指令**...`);
      const ticker = interaction.options.getString("ticker", true);
      const megaPrompt = `查全維度實相 ${ticker}`;
      
      const ch = interaction.channel;
      if (!ch || !("send" in ch)) return;
      const previewState = createPreviewState();
      previewState.msg = await (ch as any).send(`⏳ *Athena Mega Auditor 啟動中... (${ticker})*`);
      
      try {
        const result = await runAthenaCommand(megaPrompt, 1_800_000, interaction.channelId, interaction.user.username, previewState);
        
        if (previewState.timer) clearTimeout(previewState.timer);
        await previewState.msg!.delete().catch(() => {});
        
        let finalText = result.text;
        let actionFootnote = "";
        if (ATHENA_EXT_ENABLED) {
          const processed = postProcessAthenaOutput(finalText);
          finalText = processed.cleanedText;
          actionFootnote = formatAthenaActionFootnote(processed);
        }
        const responseText = `🔥 **全維度實相審計：${ticker}**\n\n${finalText}${actionFootnote}`;
        
        if (responseText.length <= DISCORD_MAX_LEN) {
          await (ch as any).send(responseText);
        } else {
          await sendChunked(ch as any, responseText);
        }
      } catch (err) {
        if (previewState.timer) clearTimeout(previewState.timer);
        if (previewState.msg) await previewState.msg.edit(`❌ 超級指令失敗：${(err as Error).message}`).catch(() => {});
      }
      return;
    }

    if (commandName === "athena-daily-audit" && PERSONA === "athena") {
      await interaction.reply(`📊 **啟動每日持股與情緒巡視**...`);
      const ch = interaction.channel;
      if (!ch || !("send" in ch)) return;
      const previewState = createPreviewState();
      previewState.msg = await (ch as any).send(`⏳ *Athena 正在讀取 holdings.json 並進行全網巡視...*`);

      try {
        const auditPrompt = `[每日持股日報] 請立刻讀取 D:\\ai-memory\\data\\holdings.json。針對清單中的每一檔標的，執行「打水漂演算法 v1.1」，抓取最新新聞、Reddit/X 平台情緒，並檢查 SEC 影子追蹤。最後輸出包含「信號狀態機」更新的每日審計報告。`;
        const result = await runAthenaCommand(auditPrompt, 900_000, interaction.channelId, interaction.user.username, previewState);

        await previewState.msg!.delete().catch(() => {});
        let finalText = result.text;
        let actionFootnote = "";
        if (ATHENA_EXT_ENABLED) {
          const processed = postProcessAthenaOutput(finalText);
          finalText = processed.cleanedText;
          actionFootnote = formatAthenaActionFootnote(processed);
        }
        const responseText = `📊 **每日持股審計報告**\n\n${finalText}${actionFootnote}`;
        if (responseText.length <= DISCORD_MAX_LEN) await (ch as any).send(responseText);
        else await sendChunked(ch as any, responseText);
      } catch (err) {
        if (previewState.msg) await previewState.msg.edit(`❌ 審計失敗：${(err as Error).message}`).catch(() => {});
      }
      return;
    }

    if (commandName === "athena-swarm" && PERSONA === "athena") {
      await interaction.reply(`⚔️ **啟動多代理人沙盤推演**：${interaction.options.getString("topic")}`);
      const topic = interaction.options.getString("topic", true);
      const ch = interaction.channel;
      if (!ch || !("send" in ch)) return;

      const swarmThread = await (ch as any).threads.create({ name: `⚔️ Swarm: ${topic.slice(0, 50)}`, autoArchiveDuration: 60 });
      let swarmContext = `[Swarm Debate Topic]: ${topic}\n\n`;

      const rounds = [
        { role: "Selina (多方)", prompt: `你是 Selina，請針對主題「${topic}」給出最強力的 Bull Case 敘事與宏觀支持。限制 150 字。` },
        { role: "Athena (空方)", prompt: `你是 Athena，請針對 Selina 剛才的論點進行無情的法證打擊與 Red Flag 揭露。限制 150 字。` },
        { role: "結論 & 勝率", prompt: `綜合以上辯論，請給出最終實相與勝率評估。限制 100 字。` }
      ];

      for (const round of rounds) {
        const preview = await swarmThread.send(`⏳ *${round.role} 思考中...*`);
        const roundPrompt = `${swarmContext}\n\n[本輪角色指令]\n${round.prompt}`;
        // Slash stays on CC unless legacy BACKEND=gemini (chat oneshot engines do not take over slash)
        const result = BACKEND !== "gemini"
          ? await runAthenaCommand(roundPrompt, 120_000, interaction.channelId, "System")
          : await runGeminiStreaming({
              prompt: buildGeminiPrompt({
                systemPrompt: GEMINI_SYSTEM_PROMPT,
                history: swarmContext,
                username: "System",
                userMessage: round.prompt,
              }),
              model: GEMINI_MODEL,
              timeoutMs: 120_000,
            });
        await preview.delete().catch(() => {});
        await swarmThread.send(`**${round.role}**：\n${result.text}`);
        swarmContext += `[${round.role}]: ${result.text}\n\n`;
      }
      return;
    }

    // ─── IrisBot /iris-* commands (PERSONA === "iris") ─────────────────

    if (commandName === "iris-status" && PERSONA === "iris") {
      await interaction.reply({ content: irisRenderStatus(), ephemeral: true });
      return;
    }

    if (commandName === "iris-handoff" && PERSONA === "iris") {
      await interaction.deferReply();
      const gate = irisAcquireLight(interaction.id, "handoff");
      if (!gate.ok) { await interaction.editReply(gate.message!); return; }
      try {
        await interaction.editReply(irisRenderHandoff().slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ 錯誤：${(err as Error).message}`);
      } finally {
        gate.release?.();
      }
      return;
    }

    if (commandName === "iris-holdings" && PERSONA === "iris") {
      await interaction.deferReply();
      const gate = irisAcquireLight(interaction.id, "holdings");
      if (!gate.ok) { await interaction.editReply(gate.message!); return; }
      try {
        await interaction.editReply(irisRenderHoldings().slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ 錯誤：${(err as Error).message}`);
      } finally {
        gate.release?.();
      }
      return;
    }

    if (commandName === "iris-recall" && PERSONA === "iris") {
      await interaction.deferReply();
      const gate = irisAcquireLight(interaction.id, "recall");
      if (!gate.ok) { await interaction.editReply(gate.message!); return; }
      try {
        const query = interaction.options.getString("query", true);
        const out = await irisRunRecall(query);
        await interaction.editReply(out.slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ Gbrain 失敗：${(err as Error).message}`);
      } finally {
        gate.release?.();
      }
      return;
    }

    if (commandName === "iris-kaigong" && PERSONA === "iris") {
      await interaction.deferReply();
      const gate = irisAcquireHeavy(interaction.id, "kaigong");
      if (!gate.ok) { await interaction.editReply(gate.message!); return; }
      if (gate.queued) {
        await interaction.editReply(gate.message!);
        await gate.waitFor;
      }
      try {
        const out = await irisRunKaigong();
        await interaction.editReply(out.slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ 開工失敗：${(err as Error).message}`);
      } finally {
        gate.release?.();
      }
      return;
    }

    if (commandName === "iris-audit" && PERSONA === "iris") {
      await interaction.deferReply();
      const rawTicker = interaction.options.getString("ticker", true);
      const ticker = irisValidateTicker(rawTicker);
      if (!ticker) { await interaction.editReply(`⚠️ ticker 格式不對：\`${rawTicker}\``); return; }

      const gate = irisAcquireHeavy(interaction.id, `audit ${ticker}`, ticker);
      if (!gate.ok) { await interaction.editReply(gate.message!); return; }
      if (gate.queued) {
        await interaction.editReply(gate.message!);
        await gate.waitFor;
      }
      const gotLock = irisAcquireTickerLock(ticker, `audit by ${interaction.user.username}`, 15 * 60_000);
      if (!gotLock) {
        gate.release?.();
        await interaction.editReply(`🔒 **${ticker}** 已被另一個 audit 鎖定（同 ticker 只准一個 audit），稍後再試`);
        return;
      }
      try {
        await interaction.editReply(irisRenderAuditStub(ticker).slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ Audit 失敗：${(err as Error).message}`);
      } finally {
        irisReleaseTickerLock(ticker);
        gate.release?.();
      }
      return;
    }

    if (commandName === "iris-sector" && PERSONA === "iris") {
      await interaction.deferReply();
      const gate = irisAcquireLight(interaction.id, "sector");
      if (!gate.ok) { await interaction.editReply(gate.message!); return; }
      try {
        const out = await irisRunSectorSummary();
        await interaction.editReply(out.slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ sector 失敗：${(err as Error).message}`);
      } finally {
        gate.release?.();
      }
      return;
    }

    if (commandName === "iris-aaii" && PERSONA === "iris") {
      await interaction.deferReply();
      const gate = irisAcquireLight(interaction.id, "aaii");
      if (!gate.ok) { await interaction.editReply(gate.message!); return; }
      try {
        await interaction.editReply(irisRenderAaii().slice(0, 2000));
      } catch (err) {
        await interaction.editReply(`❌ aaii 失敗：${(err as Error).message}`);
      } finally {
        gate.release?.();
      }
      return;
    }

    // 山崖書院開課：耗時數分鐘（備課＋出先考題＋寫第一堂），超過 Discord editReply 時限，
    // 故照 athena-mega 模式——先回訊、背景跑、跑完推回同一頻道。
    if (commandName === "iris-shuyuan" && PERSONA === "iris") {
      const book = interaction.options.getString("book", true);
      const listOnly = interaction.options.getBoolean("list") ?? false;
      const script = path.join(os.homedir(), "scripts", "shuyuan_open_course.py");
      const py = process.env.PYTHON_BIN ?? "python";
      const args = [script, book, ...(listOnly ? ["--list-only"] : [])];

      // 只找不開：秒回，不佔並發額度
      if (listOnly) {
        await interaction.deferReply();
        execFile(py, args, { timeout: 60_000, env: { ...process.env, PYTHONUTF8: "1" } },
          async (_e, stdout) => {
            let msg = "❌ 搜尋失敗";
            try {
              const d = JSON.parse((stdout || "").trim().split("\n").filter(Boolean).pop()!);
              const cs = (d.candidates ?? []) as any[];
              msg = cs.length
                ? `📚 **「${book}」候選 ${cs.length} 個**\n` +
                  cs.map((c: any) => `・\`${c.source}\` ${c.title}${c.lessons != null ? `（已開 ${c.lessons} 堂）` : ""}`).join("\n")
                : `⚠️ ${d.note ?? "找不到"}`;
            } catch { /* keep default */ }
            await interaction.editReply(msg.slice(0, 2000)).catch(() => {});
          });
        return;
      }

      // 真的開課：吃 Heavy 額度（跟 audit 同級，避免跟其他重活搶資源）
      const gate = irisAcquireHeavy(interaction.id, `shuyuan ${book}`);
      if (!gate.ok) { await interaction.reply(gate.message!); return; }
      await interaction.reply(`📚 **開始開課：「${book}」**\n備課＋出先考題＋寫第一堂，約 5–20 分鐘，完成後推回本頻道。`);
      const ch = interaction.channel;
      execFile(py, args,
        { timeout: 1_900_000, env: { ...process.env, PYTHONUTF8: "1" }, maxBuffer: 8 * 1024 * 1024 },
        async (_e, stdout, stderr) => {
          gate.release?.();
          let msg: string;
          try {
            const d = JSON.parse((stdout || "").trim().split("\n").filter(Boolean).pop()!);
            if (d.status === "ok") {
              const quiz = (d.quiz ?? []) as string[];
              msg = `✅ **開課完成：${d.title}**\n${d.url ? `📖 第一堂：${d.url}\n` : ""}` +
                    (quiz.length ? `\n**先考三題**（先答再讀，這是設計）：\n` + quiz.map((q, i) => `${i + 1}. ${q}`).join("\n") : "");
            } else if (d.status === "already_open") {
              msg = `↩️ **${d.slug}** 這門課已經開過（${d.lessons} 堂）。${d.note ?? ""}`;
            } else {
              msg = `⚠️ ${d.note ?? d.status}`;
            }
          } catch {
            msg = `❌ 開課失敗：${((stderr || "") || "無輸出").toString().slice(0, 300)}`;
          }
          await (ch as any)?.send?.(msg.slice(0, 2000)).catch(() => {});
        });
      return;
    }
  } catch (err) {
    console.error("[discord-cc-bot] interaction error:", (err as Error).message);
    if (!interaction.replied) {
      await interaction.reply({ content: "An error occurred.", ephemeral: true }).catch(() => {});
    }
  }
});

// Auto-join newly created threads
client.on(Events.ThreadCreate, async (thread) => {
  if (!thread.joined) {
    try {
      await thread.join();
      console.log(`[discord-cc-bot] auto-joined new thread: ${thread.name}`);
    } catch (err) {
      console.error(`[discord-cc-bot] failed to join thread ${thread.name}:`, err);
    }
  }
});

// Auto-join threads that get unarchived (user sends message in archived thread)
client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
  if (oldThread.archived && !newThread.archived && !newThread.joined) {
    try {
      await newThread.join();
      console.log(`[discord-cc-bot] auto-joined unarchived thread: ${newThread.name}`);
    } catch (err) {
      console.error(`[discord-cc-bot] failed to join unarchived thread ${newThread.name}:`, err);
    }
  }
});

// --- Engine passthrough (ADR-0028): !grok / !agy fuse, bypass CC pipeline ---
const PASSTHROUGH_ENABLED = resolveEnabledEngines(PERSONA);
console.log(
  `[discord-cc-bot] passthrough engines: ${[...PASSTHROUGH_ENABLED].join(",") || "(none)"} (persona=${PERSONA})`,
);

async function handlePassthroughMessage(
  message: Message,
  engine: PassthroughEngine,
  prompt: string,
): Promise<void> {
  if (!prompt) {
    await message.reply(
      `用法：\`!${engine} <你的問題>\`\n例：\`!${engine} 你好，報你的模型名\``,
    );
    logPassthrough(PERSONA, engine, null, false);
    return;
  }
  const preview = await message.reply(`⏳ *${engine} lane 直通中…*`);
  try {
    ensureWorkdir(PERSONA);
    const result = await runPassthrough(engine, prompt, { persona: PERSONA });
    logPassthrough(PERSONA, engine, result.exitCode, result.timedOut);
    const replyText = formatPassthroughReply(result);
    await preview.delete().catch(() => {});
    const chunks = chunkForDiscord(replyText, 1900);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply(chunks[i]);
      } else if ("send" in message.channel) {
        await message.channel.send(chunks[i]);
      }
    }
  } catch (err) {
    logPassthrough(PERSONA, engine, 1, false);
    const msg = `🔌 ${engine} lane（直通，非 Claude）：\n❌ 例外：${(err as Error).message}`;
    await preview.edit(msg).catch(async () => {
      await message.reply(msg).catch(() => {});
    });
  }
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    // Debug: log every non-bot message received
    console.log(`[discord-cc-bot] MSG from=${message.author.username} content="${message.content.slice(0, 80)}" mentions=${[...message.mentions.users.keys()].join(",")}`);

    // ADR-0028: early intercept in threads — !grok / !agy bypass CC (no mention required)
    if (message.channel.isThread() && PASSTHROUGH_ENABLED.size > 0) {
      const ptContent = message.content.replace(/<@[!&]?\d+>/g, "").trim();
      const ptMatch = parsePassthroughCommand(ptContent, PASSTHROUGH_ENABLED);
      if (ptMatch) {
        await handlePassthroughMessage(message, ptMatch.engine, ptMatch.prompt);
        return;
      }
    }

    // 收料入庫：DM 給 bot 或 #收料 頻道，有附件就自動入庫（免 @mention）。
    // DM 是 Message Content Limited 模式的例外，附件必達 → 零 portal 零登入路徑。
    // 2026-08-04 Charles 拍板：四隻 bot 都要能收料，且統一收在同一資料夾。
    // 同一資料夾本來就成立——fred_intake.py 的 DEST 寫死 D:\ai-memory\knowledge\fred-shared，
    // 且內建同內容重複偵測（回 duplicate 不重複入庫），故多 bot 共用不會打架。
    // 原本只有 iris 能收，是「先在一隻上驗證」的過渡設計，現解除。
    if (!message.channel.isThread()) {
      const isDM = message.channel.isDMBased();
      const isIntakeChannel = ((message.channel as any).name ?? "").includes(INTAKE_CHANNEL_NAME);
      const attCount = gatherAttachments(message).length;   // 含轉傳快照
      if ((isDM || isIntakeChannel) && attCount > 0) {
        await handleIntakeMessage(message);
        return;
      }
      // #收料 頻道收到「空內容+0附件」＝Discord 因 Message Content 未完整開啟把附件剝光了 → 給提示防靜默失敗
      if (isIntakeChannel && attCount === 0 && (message.content ?? "").trim() === "") {
        await message.reply("⚠️ 我收到訊息但沒拿到附件——因為 Discord 的 Message Content 權限沒完整開啟，非私訊的檔案會被剝掉。\n**最省事解法：直接把檔案私訊給我（DM），就會自動入庫。** 或到後台開啟 Message Content Intent 後這個頻道才會生效。").catch(() => {});
        return;
      }
    }

    // Respond when mentioned (in threads or regular channels)
    // Check direct user mention, role mention (via guild member cache), or raw content fallback
    const botId = client.user!.id;
    const directMention = message.mentions.has(botId, { ignoreEveryone: false, ignoreRoles: true });
    // Check if any mentioned role includes the bot as a member
    const roleMention = message.mentions.roles.some(role => role.members?.has(botId));
    // Fallback: check if the bot's guild member has any of the mentioned roles
    const guildMember = message.guild?.members.cache.get(botId);
    const roleFallback = guildMember
      ? message.mentions.roles.some(role => guildMember.roles.cache.has(role.id))
      : false;
    // Also respond to @everyone and @here
    const everyoneMention = message.mentions.everyone;
    // DM 視同「已對 bot 說話」：私訊每則都是給 bot 的，免 @mention（收料 DM 的追問對話）
    const isMentioned = directMention || roleMention || roleFallback || everyoneMention || message.channel.isDMBased();
    if (!isMentioned) return;

    // 檔案問答 thread：@bot 於「收料檔案 thread」→ 乾淨腦只讀那份檔回答（不走 Iris 完整脈絡，避免汙染）
    if (PERSONA === "iris" && message.channel.isThread()) {
      const qa = loadQaMap()[message.channelId];
      if (qa) { await handleFileQa(message, qa); return; }
    }

    // If mentioned in a regular channel, auto-create a thread and redirect.
    // DM 不能開 thread → 跳過，落到下方「直接處理」路徑原地回覆。
    if (!message.channel.isThread() && !message.channel.isDMBased()) {
      try {
        const fallbackName = PERSONA === "selina" ? "SelinaBot Chat" : PERSONA === "bockybot" ? "BockyBot Chat" : "IrisBot Chat";
        const content = message.content.replace(/<@[!&]?\d+>/g, "").trim() || "New chat";
        const threadName = content.slice(0, 50) || fallbackName;
        const thread = await message.startThread({ name: threadName });
        const entry = getOrCreate(threadMap, thread.id, DEFAULT_CWD);
        console.log(`[discord-cc-bot] auto-created thread: ${threadName}`);

        // Process the message in the new thread
        const previewState = createPreviewState();
        previewState.msg = await thread.send("⏳ *Thinking...*");

        const attachments = [...message.attachments.values()];
        const filePaths: string[] = [];
        for (const att of attachments) {
          if (att.size > ATTACH_MAX_BYTES) continue;
          const ext = att.name?.split(".").pop() ?? "bin";
          const filepath = path.join(ATTACH_TMP_DIR, `${message.id}_${att.id}.${ext}`);
          try {
            await downloadAttachment(att.url, filepath);
            filePaths.push(filepath);
          } catch {}
        }

        let userMessage = content;
        if (filePaths.length === 1) {
          userMessage = `${content}\n\nThe user attached a file: ${filePaths[0]}`.trim();
        } else if (filePaths.length > 1) {
          userMessage = `${content}\n\nThe user attached files:\n${filePaths.map((p) => `- ${p}`).join("\n")}`.trim();
        }
        userMessage = await expandUrlsWithJina(userMessage, previewState);

        let result: RunResult;
        let newThreadModelHint: string | null = null;

        if (IS_ONESHOT) {
          const username = message.member?.displayName ?? message.author.displayName ?? message.author.username;
          const oneshotPrompt = buildGeminiPrompt({
            systemPrompt: GEMINI_SYSTEM_PROMPT,
            history: "", // No history for a brand new thread
            username,
            userMessage,
          });
          result = await runOneshotStreaming({
            prompt: oneshotPrompt,
            callbacks: {
              onText: (fullText) => handleStreamText(previewState, fullText),
            },
          });
        } else {
          const newThreadOverride = applyModelOverride(userMessage, entry.model, thread.id);
          if (newThreadOverride.emptyPrompt) {
            if (previewState.timer) clearTimeout(previewState.timer);
            await previewState.msg!.delete().catch(() => {});
            await thread.send(`請在 ${newThreadOverride.overrideToken} 後加問題，例如：\`${newThreadOverride.overrideToken} 這個 IC 門檻怎麼設？\``);
            return;
          }
          newThreadModelHint = newThreadOverride.hint;
          result = await runClaudeStreaming({
            sessionId: entry.sessionId,
            prompt: newThreadOverride.prompt,
            cwd: entry.cwd,
            model: newThreadOverride.model,
            claudeBin: CLAUDE_BIN,
            resume: false,
            systemPrompt: SYSTEM_PROMPT,
            callbacks: {
              onText: (fullText) => handleStreamText(previewState, fullText),
              onToolUse: createToolUseHandler(previewState),
            },
          });
        }

        if (previewState.timer) clearTimeout(previewState.timer);

        const askDenial = result.permissionDenials?.find(d => d.tool_name === "AskUserQuestion");
        if (askDenial) {
          await previewState.msg!.delete().catch(() => {});
          entry.started = true;
          await sendAskButtons(thread, thread.id, entry, askDenial);
          return;
        }

        entry.started = true;
        saveEntry(thread.id, entry);

        const disclosure = buildBackendDisclosure({ isFirstReply: true });
        let finalText = result.text;
        let actionFootnote = "";
        if (SELINA_EXT_ENABLED) {
          const processed = postProcessSelinaOutput(finalText);
          finalText = processed.cleanedText;
          actionFootnote = formatActionFootnote(processed);
          if (result.exitCode !== 0 && IS_ONESHOT) {
            dmCharlesOnError(client, finalText, `${BACKEND} exit=${result.exitCode}`).catch(() => {});
          }
        }
        if (ATHENA_EXT_ENABLED) {
          const processed = postProcessAthenaOutput(finalText);
          finalText = processed.cleanedText;
          actionFootnote = formatAthenaActionFootnote(processed);
        }
        const responseText = newThreadModelHint
          ? `${newThreadModelHint}\n\n${disclosure}${finalText}${actionFootnote}`
          : `${disclosure}${finalText}${actionFootnote}`;

        let botReply: Message;
        try {
          await previewState.msg!.delete().catch(() => {});
          if (responseText.length <= DISCORD_MAX_LEN) {
            botReply = await thread.send(responseText);
          } else {
            botReply = await sendChunked(thread, responseText);
          }
        } catch (replyErr) {
          console.error("[discord-cc-bot] auto-thread reply failed:", (replyErr as Error).message);
          botReply = await thread.send(responseText.slice(0, DISCORD_MAX_LEN));
        }

        entry.lastBotMessageId = botReply.id;
        if (!IS_ONESHOT) {
          patchSessionEntrypoint(entry.sessionId, entry.cwd);
        }
        saveEntry(thread.id, entry);
        captureMemory(thread.id, message.content, finalText);
      } catch (err) {
        console.error("[discord-cc-bot] auto-thread error:", err);
        await message.reply("Failed to create thread. Please use `/chat` instead.").catch(() => {});
      }
      return;
    }

    const content = message.content.replace(/<@[!&]?\d+>/g, "").trim();
    const attachments = [...message.attachments.values()];
    if (!content && attachments.length === 0) return;

    const threadId = message.channelId;
    const entry = getOrCreate(threadMap, threadId, DEFAULT_CWD);

    if (running.has(entry.sessionId)) {
      await message.reply("Previous task still running. Use `/stop` first.");
      return;
    }

    // Send initial preview message
    const previewState = createPreviewState();
    previewState.msg = await message.reply("⏳ *Thinking...*");

    // Download all attachments — let Claude Code handle them via Read tool
    const filePaths: string[] = [];
    for (const att of attachments) {
      if (att.size > ATTACH_MAX_BYTES) {
        console.log(`[discord-cc-bot] skipping oversized attachment: ${att.name} (${att.size} bytes)`);
        continue;
      }
      const ext = att.name?.split(".").pop() ?? "bin";
      const filepath = path.join(ATTACH_TMP_DIR, `${message.id}_${att.id}.${ext}`);
      try {
        await downloadAttachment(att.url, filepath);
        filePaths.push(filepath);
      } catch (err) {
        console.error(`[discord-cc-bot] attachment download failed: ${(err as Error).message}`);
      }
    }

    try {
      const history = await fetchThreadHistory(message.channel, entry, client.user!.id, IS_ONESHOT, message.id);
      let userMessage = content;

      // 語音訊息：先轉錄，把「話的內容」當成使用者的指令，而不是丟一個 agent 讀不了的音檔路徑
      let voiceTranscript = "";
      if (isVoiceMessage(message) && filePaths.length > 0) {
        await previewState.msg?.edit("🎤 *轉錄語音中...*").catch(() => {});
        const r = await transcribeVoice(filePaths[0]);
        if (r.ok) {
          voiceTranscript = r.text;
          console.log(`[discord-cc-bot] voice transcribed (${r.text.length} chars) ${r.note}`);
        } else {
          console.error(`[discord-cc-bot] voice transcribe failed: ${r.note}`);
          await message.reply(`⚠️ 語音轉錄失敗，改用附件路徑處理：${r.note}`).catch(() => {});
        }
      }

      if (voiceTranscript) {
        // content 通常為空（語音訊息沒有文字）；有的話當補充說明
        userMessage = [content, `[使用者語音訊息，以下為轉錄稿]\n${voiceTranscript}`]
          .filter(Boolean).join("\n\n").trim();
      } else if (filePaths.length === 1) {
        userMessage = `${content}\n\nThe user attached a file: ${filePaths[0]}`.trim();
      } else if (filePaths.length > 1) {
        userMessage = `${content}\n\nThe user attached files:\n${filePaths.map((p) => `- ${p}`).join("\n")}`.trim();
      }
      userMessage = await expandUrlsWithJina(userMessage, previewState);

      let result: RunResult;
      let existingThreadModelHint: string | null = null;

      if (IS_ONESHOT) {
        // One-shot family: no session persistence — embed history + system prompt every call.
        const username = message.member?.displayName ?? message.author.displayName ?? message.author.username;
        const oneshotPrompt = buildGeminiPrompt({
          systemPrompt: GEMINI_SYSTEM_PROMPT,
          history,
          username,
          userMessage,
        });
        result = await runOneshotStreaming({
          prompt: oneshotPrompt,
          callbacks: {
            onText: (fullText) => handleStreamText(previewState, fullText),
          },
        });
      } else {
        // Default: CC backend
        // Apply model override from userMessage only (not history prefix)
        const existingThreadOverride = applyModelOverride(userMessage, entry.model, threadId);
        if (existingThreadOverride.emptyPrompt) {
          if (previewState.timer) clearTimeout(previewState.timer);
          await previewState.msg!.delete().catch(() => {});
          await message.reply(`請在 ${existingThreadOverride.overrideToken} 後加問題，例如：\`${existingThreadOverride.overrideToken} 這個 IC 門檻怎麼設？\``);
          return;
        }
        existingThreadModelHint = existingThreadOverride.hint;
        const prompt = history
          ? `${history}${existingThreadOverride.prompt}`
          : existingThreadOverride.prompt;
        result = await runClaudeStreaming({
          sessionId: entry.sessionId,
          prompt,
          cwd: entry.cwd,
          model: existingThreadOverride.model,
          claudeBin: CLAUDE_BIN,
          resume: entry.started,
          systemPrompt: entry.isLocalResume ? RESUME_SYSTEM_PROMPT : SYSTEM_PROMPT,
          callbacks: {
            onText: (fullText) => handleStreamText(previewState, fullText),
            onToolUse: createToolUseHandler(previewState),
          },
        });
      }

      // Cancel any pending throttle timer
      if (previewState.timer) clearTimeout(previewState.timer);

      // Check for AskUserQuestion denials — render as Discord buttons
      const askDenial = result.permissionDenials?.find(d => d.tool_name === "AskUserQuestion");
      if (askDenial) {
        await previewState.msg!.delete().catch(() => {});
        entry.started = true;
        await sendAskButtons(message.channel, threadId, entry, askDenial);
        return; // Wait for button click — handler will resume
      }

      const isFirstReply = !entry.started;
      if (isFirstReply) {
        entry.started = true;
      }

      const disclosure = IS_ONESHOT
        ? buildBackendDisclosure()
        : buildBackendDisclosure({ isFirstReply, isLocalResume: entry.isLocalResume });
      let finalText = result.text;
      let actionFootnote = "";
      if (SELINA_EXT_ENABLED) {
        const processed = postProcessSelinaOutput(finalText);
        finalText = processed.cleanedText;
        actionFootnote = formatActionFootnote(processed);
        if (result.exitCode !== 0 && IS_ONESHOT) {
          dmCharlesOnError(client, finalText, `${BACKEND} reply exit=${result.exitCode}`).catch(() => {});
        }
      }
      if (ATHENA_EXT_ENABLED) {
        const processed = postProcessAthenaOutput(finalText);
        finalText = processed.cleanedText;
        actionFootnote = formatAthenaActionFootnote(processed);
      }
      const responseText = existingThreadModelHint
        ? `${existingThreadModelHint}\n\n${disclosure}${finalText}${actionFootnote}`
        : `${disclosure}${finalText}${actionFootnote}`;

      // Final delivery — always delete preview and send new message
      // so Discord sends a push notification for the completed reply.
      let botReply: Message;
      try {
        await previewState.msg!.delete().catch(() => {});
        if (responseText.length <= DISCORD_MAX_LEN) {
          botReply = await message.reply(responseText);
        } else {
          botReply = await sendChunked(message.channel, responseText, message);
        }
      } catch (replyErr) {
        console.error("[discord-cc-bot] reply failed, trying fallback:", (replyErr as Error).message);
        botReply = await message.channel.send(responseText.slice(0, DISCORD_MAX_LEN));
      }

      entry.lastBotMessageId = botReply.id;
      if (!IS_ONESHOT) {
        patchSessionEntrypoint(entry.sessionId, entry.cwd);
      }
      saveEntry(threadId, entry);
      captureMemory(threadId, message.content, finalText);
    } catch (err) {
      if (previewState.timer) clearTimeout(previewState.timer);
      if (previewState.msg) {
        await previewState.msg.edit(`Error: ${(err as Error).message}`).catch(() => {});
      } else {
        await message.reply(`Error: ${(err as Error).message}`);
      }
    } finally {
      for (const p of filePaths) fs.unlink(p, () => {});
    }
  } catch (err) {
    console.error("[discord-cc-bot] handler error:", (err as Error).message);
  }
});

function shutdown() {
  for (const child of running.values()) child.kill("SIGTERM");
  db.close();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("uncaughtException", (err) => {
  console.error(`[discord-cc-bot] FATAL uncaughtException:`, err);
  shutdown();
});
process.on("unhandledRejection", (reason) => {
  console.error(`[discord-cc-bot] unhandledRejection:`, reason);
});

client.login(DISCORD_TOKEN);
