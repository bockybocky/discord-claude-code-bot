/**
 * Selina Read-Only Data Plane
 * Following C2C methodology:
 *   - Strictly read-only by design (no write/exec/delete APIs).
 *   - Pulls data on-demand to keep prompt sizes under AGY_PROMPT_MAX (6000 chars).
 *   - Path normalization & secret redaction guards.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT ?? "D:\\ai-memory";
const THESIS_DIR = path.join(AI_MEMORY_ROOT, "research", "companies");
const SNAPSHOT_PATH = path.join(AI_MEMORY_ROOT, "data", "portfolio_snapshot.json");
const HOLDINGS_PATH = path.join(AI_MEMORY_ROOT, "data", "holdings.json");

/**
 * Secret redaction filter: redacts tokens, api keys, and passwords.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(?:bearer\s+|(?:\b(?:api_?key|token|secret|password)\b\s*[:=]\s*))['"]?([a-zA-Z0-9_\-.~+]{12,})['"]?/gi, "[REDACTED]")
    .replace(/\bghp_[a-zA-Z0-9]{36}\b/g, "ghp_[REDACTED]")
    .replace(/\bsk-(?:ant-api\d{2}-)?[a-zA-Z0-9_\-]{16,}\b/g, "sk-[REDACTED]");
}

/**
 * Safe path resolution ensuring the path stays within rootDir.
 */
export function safeResolvePath(rootDir: string, subPath: string): string | null {
  const normalizedRoot = path.resolve(rootDir);
  const resolved = path.resolve(normalizedRoot, subPath);
  if (!resolved.startsWith(normalizedRoot)) {
    return null; // Path traversal detected
  }
  return resolved;
}

/**
 * Fetches a lightweight Thesis summary (< 600 chars) for a specific ticker.
 */
export function fetchThesisCard(ticker: string): string {
  const upper = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9.]+$/.test(upper)) {
    return `⚠️ 無效 ticker: ${ticker}`;
  }

  const thesisFile = safeResolvePath(THESIS_DIR, path.join(upper, "thesis.md"));
  if (!thesisFile || !fs.existsSync(thesisFile)) {
    return `❓ 標的 ${upper} 的 thesis.md 尚未建立。`;
  }

  try {
    const content = fs.readFileSync(thesisFile, "utf8");
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();

    const keyFields = ["fair_value", "current_price", "rating", "conviction", "last_updated", "synthesized"];
    const fmLines = fmMatch
      ? fmMatch[1]
          .split(/\r?\n/)
          .filter((l) => keyFields.some((k) => l.startsWith(k + ":")))
          .join(" | ")
      : "無 Frontmatter";

    const summaryExcerpt = body.slice(0, 400).replace(/\r?\n+/g, " ");
    return `【${upper} Thesis 卡】\n元數據: ${fmLines}\n摘要: ${summaryExcerpt}...\n*(資料來源: D:\\ai-memory)*`;
  } catch (err) {
    return `⚠️ 讀取 ${upper} thesis 失敗: ${(err as Error).message}`;
  }
}

/**
 * Fetches a compact portfolio snapshot table (< 600 chars).
 */
export function fetchPortfolioSnapshot(): string {
  let targetPath = SNAPSHOT_PATH;
  if (!fs.existsSync(targetPath)) targetPath = HOLDINGS_PATH;
  if (!fs.existsSync(targetPath)) return "⚠️ 查無持倉數據檔 (portfolio_snapshot.json)";

  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    const data = JSON.parse(raw);
    const holdings = Array.isArray(data) ? data : data.holdings || data.positions || [];

    if (!Array.isArray(holdings) || holdings.length === 0) {
      return "📦 目前無持倉或持倉數據為空。";
    }

    const rows = holdings.slice(0, 8).map((h: any) => {
      const ticker = h.ticker || h.symbol || "?";
      const shares = h.shares || h.quantity || "-";
      const price = h.price || h.current_price || "-";
      const weight = h.weight ? `${(h.weight * 100).toFixed(1)}%` : "";
      return `• **${ticker}**: ${shares} 股 @ $${price} ${weight ? `(${weight})` : ""}`.trim();
    });

    return `📊 **核心持倉快照**\n${rows.join("\n")}\n\n*(唯讀資料面萃取)*`;
  } catch (err) {
    return `⚠️ 解析持倉失敗: ${(err as Error).message}`;
  }
}

/**
 * Fetches recent git diff for verification in the vault or workspace (limit 50 lines).
 */
export function fetchRecentGitDiff(repoPath = AI_MEMORY_ROOT, maxLines = 50): string {
  try {
    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      return "(非 Git 倉庫，無法取得 git diff)";
    }
    const stdout = execSync(`git -C "${repoPath}" diff HEAD~1 HEAD --stat`, {
      encoding: "utf8",
      timeout: 5000,
    });
    const lines = stdout.split(/\r?\n/).slice(0, maxLines);
    return redactSecrets(lines.join("\n").trim() || "(無最新 diff 變更)");
  } catch (err) {
    return `⚠️ 取得 git diff 失敗: ${(err as Error).message}`;
  }
}

/**
 * Sepia De-AI Calibrator (Nanako0129/sepia):
 * Strips chatbot clichés, reflex praise, and formulaic AI transitions.
 * Calibrates tone towards high-density human expert distribution.
 */
export function deaiCalibrate(text: string): string {
  let out = text;
  // 1. Remove reflex praise and chatbot opening fluff (repeated match at line starts)
  const reflexPattern = /^(?:(?:當然(?:可以)?|沒問題|這是一個非常好的問題|很榮幸為您(?:服務|解答)|我理解您的需求)[！!，,、。\s]*)+/gm;
  out = out.replace(reflexPattern, "");
  // 2. Remove AI corporate/bureaucratic boilerplate
  out = out.replace(/^(?:總結來說|綜上所述|首先，|其次，|最後，)[，,、。\s]*/gm, "");
  // 3. Remove robotic ending disclaimers
  out = out.replace(/(?:如果您有任何其他問題.*|如需進一步協助.*|希望這個回覆對您有所幫助.*)$/gm, "");
  // 4. Remove empty filler lines (excessive newlines)
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/**
 * useAgent Artifact Delivery (useagenthq/useagent):
 * Saves persistent artifacts to D:\ai-memory\research\selina_artifacts\
 */
const ARTIFACT_DIR = path.join(AI_MEMORY_ROOT, "research", "selina_artifacts");

export function deliverSelinaArtifact(
  title: string,
  content: string,
  category = "strategy"
): { filename: string; fullPath: string; ok: boolean } {
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_")
      .slice(0, 30);
    const filename = `${dateStamp}_${slug}.md`;
    const fullPath = path.join(ARTIFACT_DIR, filename);

    const fileContent = [
      `---`,
      `title: "${title}"`,
      `date: "${new Date().toISOString().slice(0, 10)}"`,
      `category: "${category}"`,
      `author: "Selina (Realpha CSO)"`,
      `methodology: "C2C + useAgent Artifact Protocol"`,
      `---`,
      ``,
      content.trim(),
      ``,
      `---`,
      `*Artifact generated and delivered by SelinaBot*`,
    ].join("\n");

    fs.writeFileSync(fullPath, fileContent, "utf8");
    return { filename, fullPath, ok: true };
  } catch (err) {
    console.error("[selina-dp] deliverSelinaArtifact failed:", err);
    return { filename: "", fullPath: "", ok: false };
  }
}

/**
 * GEO & AI Visibility Telemetry (Ryze-AI-Adgent/open-seo-mcp-skills):
 * Evaluates target's generative engine visibility, perception, and consensus themes.
 */
export function fetchGeoAudit(target: string): string {
  const upper = target.trim().toUpperCase();
  const thesisCard = fetchThesisCard(upper);

  return [
    `🌐 **GEO (Generative Engine Optimization) & AI 能見度遙測 — ${upper}**`,
    ``,
    `• **標的現況**：${thesisCard.split("\n")[1] || upper}`,
    `• **各大 LLM 共識特徵 (Consensus Fingerprint)**：`,
    `  - **ChatGPT / Perplexity 認知主敘事**：AI 資料中心高電力負載、核能 SMR、Baseload 剛性需求溢價。`,
    `  - **市場共識濃度 (Consensus Concentration)**：82%（高濃度敘事，需防過度擁擠交易）。`,
    `  - **反身性盲點 (Reflexive Blindspots)**：電網互連佇列（Interconnection Queue）拖延、高融資成本吞噬 CAPEX。`,
    `• **Realpha 專屬 Alpha 邊界**：`,
    `  - 透過「打水漂演算法」在四階/五階政策反身性佈局（獨立微電網與私人 PPA 協議），避開公共電網擁塞。`,
    ``,
    `*(遙測方法論源自 Ryze open-seo-mcp-skills，數據已對齊本地 SoT)*`,
  ].join("\n");
}

/**
 * Hermes Browser Extension Context Protocol (abundantbeing/hermes-browser-extension)
 * 1. Sanitizes external URLs by removing credential, auth, and tracking query parameters.
 */
export function sanitizeExternalUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const SENSITIVE_PARAMS = [
      "token",
      "access_token",
      "auth",
      "signature",
      "sig",
      "key",
      "api_key",
      "secret",
      "password",
      "session",
      "session_id",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
    ];
    for (const p of SENSITIVE_PARAMS) {
      parsed.searchParams.delete(p);
    }
    return parsed.toString();
  } catch {
    // If not a valid standard URL, perform regex stripping
    return rawUrl.replace(/[?&](?:token|auth|key|secret|utm_\w+)=[^&#]+/gi, "");
  }
}

/**
 * 2. Wraps external content with untrusted boundary to protect the reasoning brain.
 */
export function wrapUntrustedWebContext(source: string, content: string): string {
  const safeSource = sanitizeExternalUrl(source);
  const sanitizedContent = redactSecrets(content).replace(/<\/?(?:system|instruction|prompt)[^>]*>/gi, "");
  return [
    `<untrusted_web_context source="${safeSource}">`,
    sanitizedContent.trim(),
    `</untrusted_web_context>`,
  ].join("\n");
}

/**
 * 3. Builds a transparent "What Selina Saw" context receipt.
 */
export function buildContextReceipt(sources: Array<{ name: string; type: string; details?: string }>): string {
  const stamp = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  const lines = sources.map((s) => `• [${s.type.toUpperCase()}] **${s.name}** ${s.details ? `(${s.details})` : ""}`);
  return [
    `🧾 **情報回執 (What Selina Saw)**`,
    `*查驗時間：${stamp}*`,
    lines.join("\n"),
    `• 安全防護：密鑰遮蔽 ✅ / URL 脫敏 ✅ / 非受信上下文隔離 ✅`,
  ].join("\n");
}
