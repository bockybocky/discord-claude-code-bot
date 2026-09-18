/**
 * Phone-first Athena helpers. Charles mostly talks to Athena from Discord
 * on a phone — these paths must return real vault numbers without waiting
 * on Claude Code or a hung Grok CLI.
 */
import fs from "node:fs";
import path from "node:path";
import { GROK_MODEL } from "./backends.js";
import { parseSearchIntent, searchBothForDiscord } from "./athena-search.js";
import { matchMlaQuizIntent } from "./athena-mla-quiz.js";

const AI_MEMORY = process.env.AI_MEMORY_ROOT ?? "D:\\ai-memory";
const HOLDINGS_PATH = path.join(AI_MEMORY, "data", "holdings.json");
const SNAPSHOT_PATH = path.join(AI_MEMORY, "data", "portfolio_snapshot.json");
const CORE_DIR = path.join(AI_MEMORY, "core");
const SCOUT_DIR = path.join(AI_MEMORY, "research", "athena_insights");

type Position = {
  symbol?: string;
  shares?: number;
  price?: number;
  market_value?: number;
  pnl?: number;
  pnl_pct?: number;
};

type HoldingsFile = {
  last_updated?: string;
  total_market_value_usd?: number;
  unrealized_pnl_usd?: number;
  unrealized_pnl_pct?: number;
  positions?: Position[];
};

type SnapRow = {
  ticker?: string;
  current_price?: number;
  drawdown_from_52w_high_pct?: number;
};

function taipeiNow(): string {
  return new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
}

function pct(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  const v = Math.abs(n) <= 2 ? n * 100 : n;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function usd(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function renderAthenaHoldings(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(HOLDINGS_PATH, "utf8")) as HoldingsFile;
    const snap = fs.existsSync(SNAPSHOT_PATH)
      ? (JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as { last_updated?: string; holdings?: SnapRow[] })
      : {};
    const dd = new Map(
      (snap.holdings || []).map((h) => [String(h.ticker || "").toUpperCase(), h]),
    );
    const rows = (raw.positions || [])
      .slice()
      .sort((a, b) => (b.market_value || 0) - (a.market_value || 0))
      .map((p) => {
        const t = String(p.symbol || "").toUpperCase();
        const d = dd.get(t);
        const extra = d?.drawdown_from_52w_high_pct !== undefined
          ? ` / 距高 ${pct(d.drawdown_from_52w_high_pct)}`
          : "";
        return `• **${t}** ${p.shares ?? "?"} 股 / ${usd(p.price)} / 損益 ${pct(p.pnl_pct)}${extra}`;
      });
    return [
      `持倉快照　資料 ${raw.last_updated ?? "?"}　市價 ${usd(raw.total_market_value_usd)}　未實現 ${usd(raw.unrealized_pnl_usd)}（${pct(raw.unrealized_pnl_pct)}）`,
      `報價快照 ${snap.last_updated ?? "無"}　${taipeiNow()}`,
      "",
      ...rows,
      "",
      "數字以 holdings.json 為準。暫定，不是下單建議。",
    ].join("\n").slice(0, 1900);
  } catch (err) {
    return `讀持股失敗：${(err as Error).message}`;
  }
}

export function renderAthenaToday(): string {
  try {
    const files = fs.readdirSync(CORE_DIR)
      .filter((f) => /^TODAY_SUMMARY_\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();
    if (!files.length) return "找不到今日開工卡。";
    const latest = files[files.length - 1];
    const text = fs.readFileSync(path.join(CORE_DIR, latest), "utf8");
    const body = text.length > 1600 ? `${text.slice(0, 1600)}\n…（後面請用查庫）` : text;
    return `開工卡　${latest}\n\n${body}`.slice(0, 1900);
  } catch (err) {
    return `讀開工卡失敗：${(err as Error).message}`;
  }
}

export function renderAthenaScout(): string {
  try {
    const files = fs.readdirSync(SCOUT_DIR)
      .filter((f) => f.includes("daily_lib_scout") && f.endsWith(".md"))
      .sort();
    if (!files.length) return "還沒有開源偵察底稿。";
    const latest = files[files.length - 1];
    const text = fs.readFileSync(path.join(SCOUT_DIR, latest), "utf8");
    return `最近一則開源偵察　${latest}\n\n${text.slice(0, 1700)}`.slice(0, 1900);
  } catch (err) {
    return `讀偵察失敗：${(err as Error).message}`;
  }
}

export function renderAthenaStatus(): string {
  const backend = process.env.BACKEND ?? "?";
  let scout = "無";
  try {
    const files = fs.readdirSync(SCOUT_DIR)
      .filter((f) => f.includes("daily_lib_scout") && f.endsWith(".md"))
      .sort();
    if (files.length) scout = files[files.length - 1];
  } catch { /* ignore */ }
  let asOf = "?";
  try {
    asOf = (JSON.parse(fs.readFileSync(HOLDINGS_PATH, "utf8")) as HoldingsFile).last_updated ?? "?";
  } catch { /* ignore */ }
  return [
    `Athena 活著　${taipeiNow()}`,
    `後端 ${backend}　模型 ${GROK_MODEL}`,
    `持股資料 ${asOf}`,
    `最近偵察 ${scout}`,
    "",
    "手機捷徑：/athena-holdings　/athena-today　/athena-scout　/athena-ask-brain　/athena-health",
    "或直接跟我說：持倉、開工、偵察、出題、查庫 關鍵字。",
  ].join("\n");
}

export function compactCompanyBrief(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(HOLDINGS_PATH, "utf8")) as HoldingsFile;
    const tickers = (raw.positions || [])
      .map((p) => String(p.symbol || "").toUpperCase())
      .filter(Boolean)
      .join(" ");
    return [
      "【手機公司卡，回覆前先信這段，不要憑印象編持倉】",
      `持股 as-of ${raw.last_updated ?? "?"}：${tickers}`,
      `市值 ${usd(raw.total_market_value_usd)}　未實現 ${usd(raw.unrealized_pnl_usd)}`,
      "被問持倉／開工／偵察時，優先用系統已算好的數字，不要假裝去跑不存在的 Claude 工具。",
    ].join("\n");
  } catch {
    return "【公司卡讀不到 holdings.json，持倉問題要誠實說沒讀到。】";
  }
}

export async function runAthenaQmd(query: string): Promise<string> {
  return searchBothForDiscord(query, "all");
}

/** Fast path for short phone phrases. Null = fall through to Grok. */
export async function matchAthenaPhoneIntent(raw: string): Promise<string | null> {
  const t = raw.replace(/<@[!&]?\d+>/g, "").trim();
  if (!t) return null;
  if (/^(持倉|持股|倉位|我的股|holdings|倉怎麼樣|持股怎樣|持倉怎樣)$/i.test(t)) {
    return renderAthenaHoldings();
  }
  if (/^(開工|今日|今天怎樣|today|handoff|今日摘要)$/i.test(t)) {
    return renderAthenaToday();
  }
  if (/^(偵察|開源|scout|今日偵察|推文)$/i.test(t)) {
    return renderAthenaScout();
  }
  if (/^(狀態|活著嗎|在嗎|ping|status)$/i.test(t)) {
    return renderAthenaStatus();
  }
  const quiz = await matchMlaQuizIntent(t);
  if (quiz) return quiz;
  const intent = parseSearchIntent(t);
  if (intent) return searchBothForDiscord(intent.query, intent.scope);
  return null;
}

export const ATHENA_PHONE_HELP = [
  "**手機入口（點這些，不用等十分鐘）**",
  "`/athena-holdings` — 真持股快照",
  "`/athena-today` — 今日開工卡",
  "`/athena-scout` — 最近開源偵察",
  "`/athena-status` — 我活著嗎",
  "`/athena-ask-brain 關鍵字` — 同時查 D:\\ai-memory、公司記憶、Codex",
  "出題／答 B,AC,D／進度 — MLA-C01 考古題（不經 Grok）",
  "`/athena-insight` — 最近一筆實相歸檔",
  "",
  "**直接打字（記得 @Athena）**",
  "持倉　開工　偵察　狀態　出題　答 B,AC,D　進度　查庫 某檔",
  "貼 X 連結或長問題，我會用 Grok 回。",
  "",
  "**重的法證（會較久）**",
  "`/athena-forensic` `/athena-mega` `/athena-daily-audit` `/athena-buddha`",
].join("\n");
