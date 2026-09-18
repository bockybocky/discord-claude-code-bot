/**
 * One-shot CLI backends for ADR-0029 (BACKEND=grok | agy).
 * Mirrors runGeminiOnce shape: prompt in → text/exitCode out; kill only own child on timeout.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

export type OneshotResult = { text: string; exitCode: number };

export type OneshotCallbacks = {
  onText?: (fullText: string) => void;
};

const GROK_BIN =
  process.env.GROK_BIN ??
  process.env.PASSTHROUGH_GROK_BIN ??
  "C:\\Users\\Charles\\.grok\\bin\\grok";
const AGY_BIN =
  process.env.AGY_BIN ??
  process.env.PASSTHROUGH_AGY_BIN ??
  "C:\\Users\\Charles\\AppData\\Local\\agy\\bin\\agy";
// 2026-08-16 Charles 拍板 4.6 → 4.5：訂閱 proxy（CLIProxyAPI）的模型清單最高只到 4.5，
// 用 4.6 會回 502「unknown provider」→ 靜默改燒 API key（8/13～8/16 一直如此）。
export const GROK_MODEL =
  process.env.GROK_MODEL ?? process.env.PASSTHROUGH_GROK_MODEL ?? "grok-4.5";

/** agy CLI arg length safety — truncate old history, keep persona prefix + newest tail. */
export const AGY_PROMPT_MAX = 6000;

function defaultTimeoutMs(): number {
  return Number(process.env.GEMINI_TIMEOUT_MS ?? 300_000);
}

function resolveCliBin(bin: string): string {
  if (bin.endsWith(".exe") || process.platform !== "win32") return bin;
  return `${bin}.exe`;
}

/**
 * 截舊留新：保留 [System: …] 人格前置 + 字串尾端（最近歷史／Current Message）。
 */
export function truncateAgyPrompt(prompt: string, maxLen = AGY_PROMPT_MAX): string {
  if (prompt.length <= maxLen) return prompt;
  const sysMatch = prompt.match(/^(\[System:[\s\S]*?\])(?:\n\n|$)/);
  const head = sysMatch ? sysMatch[0] : "";
  const body = prompt.slice(head.length);
  const budget = maxLen - head.length;
  if (budget <= 0) return prompt.slice(-maxLen);
  if (body.length <= budget) return prompt;
  return head + body.slice(-budget);
}

function spawnOnce(opts: {
  command: string;
  args: string[];
  timeoutMs: number;
  callbacks?: OneshotCallbacks;
  label: string;
  cleanup?: () => void;
  env?: NodeJS.ProcessEnv;
  stdinFile?: string;
}): Promise<OneshotResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let stdinFd: number | undefined;
    try {
      const stdin = opts.stdinFile
        ? (stdinFd = fs.openSync(opts.stdinFile, "r"))
        : "ignore";
      child = spawn(opts.command, opts.args, {
        stdio: [stdin, "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: opts.env,
      });
    } catch (err) {
      if (stdinFd !== undefined) {
        try {
          fs.closeSync(stdinFd);
        } catch {
          /* ignore */
        }
      }
      opts.cleanup?.();
      reject(err);
      return;
    }

    let stdout = "";
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      opts.callbacks?.onText?.(stdout);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[${opts.label}-stderr] ${chunk.toString().trim()}`);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Kill only this spawn — no global taskkill
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5000);
      opts.cleanup?.();
      const partial = stdout.trim();
      if (partial) {
        resolve({
          text: partial + `\n\n⚠️ *${opts.label} timed out — partial result above.*`,
          exitCode: 124,
        });
      } else {
        resolve({
          text: `⚠️ ${opts.label} 目前沒有回應，請稍後再試。`,
          exitCode: 124,
        });
      }
    }, opts.timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.cleanup?.();
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.cleanup?.();
      const text = stdout.trim() || `(no output from ${opts.label})`;
      resolve({ text, exitCode: code ?? 1 });
    });
  });
}

/** grok oneshot: company grok_call.py (proxy then API). CLI headless hangs. */
export function runGrokOnce(opts: {
  prompt: string;
  timeoutMs?: number;
  callbacks?: OneshotCallbacks;
}): Promise<OneshotResult> {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  const tmpFile = path.join(
    os.tmpdir(),
    `discord-cc-bot-grok-${Date.now()}-${process.pid}.txt`,
  );
  fs.writeFileSync(tmpFile, opts.prompt, "utf8");
  const timeoutSec = Math.max(30, Math.floor(timeoutMs / 1000));
  // 2026-08-14: `grok --prompt-file` 120s+ empty stdout/stderr on this
  // machine (Discord then shows「目前沒有回應」). grok_call.py is the
  // working oneshot path; --x-search lets it read X links.
  // 2026-08-16 更正該結論：CLI 其實有寫 stdout，當初是被 9 支連不上的 MCP 拖到人先放棄；
  // 真正還在的問題是 CLI 答完不自己結束（另見 ~/scripts/grok_lane.sh）。此處維持走 grok_call.py。
  //
  // 2026-08-16 拿掉 `--api`：原本強制計費，理由是「proxy 做不到 x_search」。
  // 實測推翻——x_search 走 proxy 的 /v1/chat/completions（OpenAI 格式）可正常回傳並附
  // x.com 來源連結，且不燒 API key（舊結論只對 /v1/messages 那條 Anthropic 格式成立）。
  // grok_call.py 內部若訂閱失敗仍會自動 fallback 到 API key，功能不會因此掉。
  return spawnOnce({
    command: "python",
    args: [
      "C:\\Users\\Charles\\scripts\\grok_call.py",
      "回覆下列 Discord 對話。一律繁體中文，禁簡體。",
      "--timeout",
      String(timeoutSec),
      "--model",
      GROK_MODEL,
      "--x-search",
    ],
    timeoutMs,
    callbacks: opts.callbacks,
    label: "grok",
    stdinFile: tmpFile,
    cleanup: () => {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    },
  });
}

/** agy headless: `agy --print <prompt>` (truncate >6000, keep system + newest). */
export function runAgyOnce(opts: {
  prompt: string;
  timeoutMs?: number;
  callbacks?: OneshotCallbacks;
}): Promise<OneshotResult> {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  const finalPrompt = truncateAgyPrompt(opts.prompt);
  const bin = resolveCliBin(AGY_BIN);
  return spawnOnce({
    command: bin,
    args: ["--print", finalPrompt],
    timeoutMs,
    callbacks: opts.callbacks,
    label: "agy",
  });
}

/**
 * Open-Higgsfield Dynamic Engine Capability Matrix (wide-trace/open-higgsfield)
 */
export interface EngineCapability {
  label: string;
  maxChars: number;
  hasWebSearch: boolean;
  hasToolUse: boolean;
  costModel: string;
  preferredRole: string;
}

export const ENGINE_CAPABILITIES: Record<string, EngineCapability> = {
  agy: {
    label: "Antigravity (Gemini 3.8)",
    maxChars: 6000,
    hasWebSearch: false,
    hasToolUse: false,
    costModel: "Included Subscription (Free)",
    preferredRole: "Deep Deduction & Strategic Planning",
  },
  grok: {
    label: "Grok 4.5 (xAI)",
    maxChars: 12000,
    hasWebSearch: true,
    hasToolUse: false,
    costModel: "Company Proxy / Fallback",
    preferredRole: "Real-time X Telemetry & Resilient Fallback",
  },
  cc: {
    label: "Claude Code (Sonnet/Opus)",
    maxChars: 100000,
    hasWebSearch: true,
    hasToolUse: true,
    costModel: "Anthropic Token / Subscription",
    preferredRole: "Full Execution Harness & Shell Tooling",
  },
};

/**
 * My Free Code Resilient Ordered Fallback Router (hkqr/my-free-code)
 * Attempts primary backend (agy). On timeout (120s) or failure, seamless circuit-breaker
 * falls back to Grok 4.5 to ensure 100% availability.
 */
export async function runResilientOneshot(opts: {
  prompt: string;
  timeoutMs?: number;
  primaryBackend?: "agy" | "grok";
  callbacks?: OneshotCallbacks;
}): Promise<OneshotResult & { usedBackend: string; fallbackTriggered: boolean }> {
  const primary = opts.primaryBackend ?? "agy";
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();

  if (primary === "agy") {
    try {
      const agyResult = await runAgyOnce({
        prompt: opts.prompt,
        timeoutMs,
        callbacks: opts.callbacks,
      });
      // Check if agy completed successfully without timeout or empty crash
      if (
        agyResult.exitCode === 0 &&
        !agyResult.text.includes("timed out") &&
        !agyResult.text.includes("目前沒有回應")
      ) {
        return { ...agyResult, usedBackend: "agy", fallbackTriggered: false };
      }
      console.warn(`[backends] agy returned exitCode=${agyResult.exitCode}, triggering ordered fallback to Grok`);
    } catch (err) {
      console.warn(`[backends] agy crashed, triggering ordered fallback to Grok:`, err);
    }

    // Circuit breaker fallback to Grok
    const grokResult = await runGrokOnce({
      prompt: opts.prompt,
      timeoutMs: Math.min(timeoutMs, 120_000),
      callbacks: opts.callbacks,
    });
    return {
      text: grokResult.text + `\n\n*(⚡ my-free-code 有序降級：主力 agy 逾時，已自動無縫切換 Grok 4.5 備援線)*`,
      exitCode: grokResult.exitCode,
      usedBackend: "grok",
      fallbackTriggered: true,
    };
  }

  const grokResult = await runGrokOnce({
    prompt: opts.prompt,
    timeoutMs,
    callbacks: opts.callbacks,
  });
  return { ...grokResult, usedBackend: "grok", fallbackTriggered: false };
}
