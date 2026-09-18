/**
 * MLA-C01 考古題手機捷徑。不經 Grok：直接跑 quiz_cli.py。
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const AI_MEMORY = process.env.AI_MEMORY_ROOT ?? "D:\\ai-memory";
const QUIZ = path.join(AI_MEMORY, "personal", "learning", "MLA-C01", "practice", "quiz_cli.py");

export function lastUserCommand(raw: string): string {
  const stripped = raw
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/【使用者正在回覆[\s\S]*?【被回覆的訊息到此結束】\s*/g, "")
    .trim();
  const lines = stripped.split(/\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || stripped;
}

export function parseMlaQuizIntent(raw: string): string[] | null {
  const t = lastUserCommand(raw);
  if (!t) return null;
  if (/^(出題|再來一批|MLA\s*出題|考古題|AWS\s*練習|出三題)$/i.test(t)) return ["next"];
  if (/^(?:查庫|查\s*vault|查\s*codex|查公司|知識庫)\s+(?:題庫|考古題|MLA-?C01|quiz_cli)$/i.test(t)) {
    return ["next"];
  }
  const n = t.match(/^(?:出題|再來一批)\s*(\d+)\s*題$/);
  if (n) return ["next", "--n", n[1]];
  const ans = t.match(/^(?:答|answer)\s+(.+)$/i);
  if (ans?.[1]) return ["answer", ans[1].trim()];
  if (/^(進度|考到哪|做了幾題|MLA\s*進度)$/i.test(t)) return ["status"];
  if (/^(錯題複習|複習錯題)$/i.test(t)) return ["review"];
  const show = t.match(/^(?:看|show)\s+(\d+)$/i);
  if (show) return ["show", show[1]];
  return null;
}

export async function runMlaQuiz(args: string[]): Promise<string> {
  const py = process.env.PYTHON_BIN ?? "python";
  try {
    const { stdout, stderr } = await execFileAsync(py, [QUIZ, ...args], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    const out = (stdout || stderr || "").trim();
    return out || "quiz_cli 沒有輸出。";
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const body = (e.stdout || e.stderr || e.message || "").toString().trim();
    return `考古題工具失敗：${body.slice(0, 1500)}`;
  }
}

export async function matchMlaQuizIntent(raw: string): Promise<string | null> {
  const args = parseMlaQuizIntent(raw);
  if (!args) return null;
  return runMlaQuiz(args);
}
