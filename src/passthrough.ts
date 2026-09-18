/**
 * Engine passthrough (ADR-0028) — bypass Claude Code pipeline, run Grok/agy CLI headless.
 * Minimal fuse: mobile Discord → Grok/agy when Claude is unavailable.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type PassthroughEngine = "grok" | "agy";

export type PassthroughMatch = {
  engine: PassthroughEngine;
  prompt: string;
};

export type PassthroughResult = {
  engine: PassthroughEngine;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncatedNote?: string;
};

const GROK_BIN = process.env.PASSTHROUGH_GROK_BIN
  ?? "C:\\Users\\Charles\\.grok\\bin\\grok";
const AGY_BIN = process.env.PASSTHROUGH_AGY_BIN
  ?? "C:\\Users\\Charles\\AppData\\Local\\agy\\bin\\agy";
const GROK_MODEL = process.env.PASSTHROUGH_GROK_MODEL ?? "grok-4.5";
const DEFAULT_TIMEOUT_MS = 600_000;
const AGY_PROMPT_MAX = 6000;
const WORKDIR_ROOT = "D:\\ai-memory\\Projects\\discord-passthrough-workdirs";
const DISCORD_CHUNK = 1900;

/** Resolve which engines are enabled for this bot process. */
export function resolveEnabledEngines(
  persona: string,
  overrideEnv?: string,
): Set<PassthroughEngine> {
  const raw = (overrideEnv ?? process.env.PASSTHROUGH_CMDS ?? "").trim();
  if (raw) {
    const set = new Set<PassthroughEngine>();
    for (const part of raw.split(",")) {
      const t = part.trim().toLowerCase();
      if (t === "grok" || t === "agy") set.add(t);
    }
    return set;
  }
  const p = (persona || "iris").toLowerCase();
  if (p === "athena") return new Set<PassthroughEngine>(["grok"]);
  if (p === "selina") return new Set<PassthroughEngine>(["agy"]);
  // iris / unset / anything else → both (master fuse)
  return new Set<PassthroughEngine>(["grok", "agy"]);
}

/**
 * Parse `!grok ...` / `!agy ...` at start of stripped message content.
 * Returns null if not a passthrough command or engine not enabled.
 */
export function parsePassthroughCommand(
  content: string,
  enabled: Set<PassthroughEngine>,
): PassthroughMatch | null {
  const trimmed = (content || "").trim();
  const m = trimmed.match(/^!(grok|agy)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const engine = m[1].toLowerCase() as PassthroughEngine;
  if (!enabled.has(engine)) return null;
  return { engine, prompt: (m[2] ?? "").trim() };
}

export function ensureWorkdir(persona: string): string {
  const dir = path.join(WORKDIR_ROOT, persona || "iris");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getTimeoutMs(): number {
  const n = Number(process.env.PASSTHROUGH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** Split text into ≤ maxLen chunks for Discord (simple, no code-block awareness). */
export function chunkForDiscord(text: string, maxLen = DISCORD_CHUNK): string[] {
  if (!text) return [""];
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

export function formatPassthroughReply(result: PassthroughResult): string {
  const header = `🔌 ${result.engine} lane（直通，非 Claude）：`;
  if (result.timedOut) {
    return `${header}\n⏱️ 逾時（${getTimeoutMs() / 1000}s），已終止子程序。\nexit code: ${result.exitCode ?? "null"}\n${tailLines(result.stderr, 10)}`;
  }
  if (result.exitCode !== 0) {
    const body = [
      `❌ 失敗 exit code: ${result.exitCode ?? "null"}`,
      result.truncatedNote ?? "",
      result.stdout?.trim() ? `--- stdout ---\n${result.stdout.trim()}` : "",
      `--- stderr（最後 10 行）---\n${tailLines(result.stderr, 10) || "(empty)"}`,
    ]
      .filter(Boolean)
      .join("\n");
    return `${header}\n${body}`;
  }
  const note = result.truncatedNote ? `\n${result.truncatedNote}\n` : "\n";
  const body = (result.stdout || "").trim() || "(empty stdout)";
  return `${header}${note}${body}`;
}

function tailLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.slice(-n).join("\n");
}

/**
 * Run the engine CLI. Kill only the spawned child on timeout (no global taskkill).
 * Exported for unit verification.
 */
export function runPassthrough(
  engine: PassthroughEngine,
  prompt: string,
  opts?: { persona?: string; cwd?: string; timeoutMs?: number },
): Promise<PassthroughResult> {
  const persona = opts?.persona ?? process.env.PERSONA ?? "iris";
  const cwd = opts?.cwd ?? ensureWorkdir(persona);
  const timeoutMs = opts?.timeoutMs ?? getTimeoutMs();

  if (engine === "grok") {
    return runGrok(prompt, cwd, timeoutMs);
  }
  return runAgy(prompt, cwd, timeoutMs);
}

function runGrok(prompt: string, cwd: string, timeoutMs: number): Promise<PassthroughResult> {
  const tmpFile = path.join(
    cwd,
    `passthrough-prompt-${Date.now()}-${process.pid}.txt`,
  );
  fs.writeFileSync(tmpFile, prompt, "utf8");

  const bin = GROK_BIN.endsWith(".exe") || !process.platform.startsWith("win")
    ? GROK_BIN
    : `${GROK_BIN}.exe`;

  return spawnCollect({
    engine: "grok",
    command: bin,
    args: ["--prompt-file", tmpFile, "-m", GROK_MODEL],
    cwd,
    timeoutMs,
    cleanup: () => {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    },
  });
}

function runAgy(prompt: string, cwd: string, timeoutMs: number): Promise<PassthroughResult> {
  let finalPrompt = prompt;
  let truncatedNote: string | undefined;
  if (finalPrompt.length > AGY_PROMPT_MAX) {
    finalPrompt = finalPrompt.slice(0, AGY_PROMPT_MAX);
    truncatedNote = `⚠️ prompt 超過 ${AGY_PROMPT_MAX} 字元，已截斷後送出。`;
  }

  const bin = AGY_BIN.endsWith(".exe") || !process.platform.startsWith("win")
    ? AGY_BIN
    : `${AGY_BIN}.exe`;

  return spawnCollect({
    engine: "agy",
    command: bin,
    args: ["--print", finalPrompt],
    cwd,
    timeoutMs,
    truncatedNote,
  });
}

function spawnCollect(opts: {
  engine: PassthroughEngine;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  truncatedNote?: string;
  cleanup?: () => void;
}): Promise<PassthroughResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;

    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: process.env,
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      opts.cleanup?.();
      resolve({
        engine: opts.engine,
        exitCode: 1,
        stdout: "",
        stderr: `spawn failed: ${(err as Error).message}`,
        timedOut: false,
        truncatedNote: opts.truncatedNote,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Kill only this spawn (and its process group if available) — no taskkill /IM
        if (child.pid && process.platform === "win32") {
          child.kill();
        } else if (child.pid) {
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        } else {
          child.kill("SIGTERM");
        }
        // Hard kill after grace if still alive
        setTimeout(() => {
          try { if (!child.killed) child.kill("SIGKILL"); } catch { /* ignore */ }
        }, 3000).unref?.();
      } catch { /* ignore */ }
    }, opts.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.cleanup?.();
      resolve({
        engine: opts.engine,
        exitCode,
        stdout,
        stderr,
        timedOut,
        truncatedNote: opts.truncatedNote,
      });
    };

    child.on("error", (err) => {
      stderr += (stderr ? "\n" : "") + err.message;
      finish(1);
    });

    child.on("close", (code) => {
      finish(timedOut ? 124 : code);
    });
  });
}

/** Console log line for ops (time / persona / cmd / exit). */
export function logPassthrough(
  persona: string,
  engine: PassthroughEngine,
  exitCode: number | null,
  timedOut: boolean,
): void {
  const ts = new Date().toISOString();
  console.log(
    `[passthrough] ${ts} persona=${persona} cmd=!${engine} exit=${exitCode ?? "null"}${timedOut ? " TIMED_OUT" : ""}`,
  );
}
