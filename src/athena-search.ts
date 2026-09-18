/**
 * Athena 雙庫搜尋：公司 QMD（唯讀 BM25）＋ Codex 討論串 sqlite（唯讀）。
 * 不跑 qmd update／embed；不讀 .env；輸出只留短摘要。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export type SearchHit = {
  source: "vault" | "company" | "codex";
  title: string;
  snippet: string;
  loc: string;
};

export type SearchScope = "all" | "vault" | "company" | "codex";

export type SearchBundle = {
  query: string;
  vault: SearchHit[];
  vaultNote: string;
  company: SearchHit[];
  companyNote: string;
  codex: SearchHit[];
  codexNote: string;
};

const QMD_TIMEOUT_MS = 12_000;
const VAULT_LIMIT = 4;
const COMPANY_LIMIT = 3;
const CODEX_LIMIT = 3;
const SNIPPET = 120;
const VAULT_ROOT = process.env.AI_MEMORY_ROOT ?? "D:\\ai-memory";
const VAULT_COLLECTION = process.env.QMD_VAULT_COLLECTION ?? "C:\\Users\\Charles\\ai-memory";
const SKIP_DIRS = new Set(["archive", "logs", "cache", ".git", "node_modules", ".sasuke", "tmp", "dist", ".cache"]);

const SECRET_RE = /sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi;
const REVIEW_NOISE_RE = /the following is the (?:codex )?agent history|>>> transcript|planned action json/i;

export function redactSecrets(text: string): string {
  return (text || "").replace(SECRET_RE, "<redacted>");
}

export function likeEscape(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function sanitizeQuery(raw: string): string {
  return raw.replace(/[&|<>^"`$;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function collapse(text: string, max = SNIPPET): string {
  const one = redactSecrets(text).replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

export function normalizePath(file: string): string {
  return file
    .replace(/^qmd:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^([A-Za-z]):\//, "$1:/");
}

export function isVaultPath(file: string): boolean {
  const n = normalizePath(file).toLowerCase();
  return n.includes("/ai-memory/") || /(^|\/)d:\/ai-memory(\/|$)/i.test(n);
}

export function shortPath(file: string): string {
  return normalizePath(file)
    .replace(/^C:\/Users\/Charles\/ai-memory\//i, "D:/ai-memory/")
    .replace(/^D:\/ai-memory\//i, "D:/ai-memory/")
    .replace(/^C:\/Users\/Charles\/\.agents\/memory\//i, "memory/")
    .replace(/^D:\/claude-data\/agents-memory\//i, "memory/");
}

export function parseSearchIntent(raw: string): { scope: SearchScope; query: string } | null {
  const t = raw
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/【使用者正在回覆[\s\S]*?【被回覆的訊息到此結束】\s*/g, "")
    .trim();
  if (!t) return null;
  const line = t.split(/\n/).map((l) => l.trim()).filter(Boolean).at(-1) || t;
  const all = line.match(/^(?:查庫|知識庫|搜庫|qmd)\s+(.+)$/i);
  if (all?.[1]) return { scope: "all", query: all[1].trim() };
  const vault = line.match(/^(?:查\s*vault|查記憶庫|搜記憶庫|查\s*ai-?memory|搜\s*ai-?memory)\s+(.+)$/i);
  if (vault?.[1]) return { scope: "vault", query: vault[1].trim() };
  const company = line.match(/^(?:查公司|搜公司)\s+(.+)$/i);
  if (company?.[1]) return { scope: "company", query: company[1].trim() };
  const codex = line.match(/^(?:查\s*codex|搜\s*codex)\s+(.+)$/i);
  if (codex?.[1]) return { scope: "codex", query: codex[1].trim() };
  return null;
}

export function looksLikeKnowledgeQuery(raw: string): boolean {
  const t = raw.replace(/<@[!&]?\d+>/g, "").trim();
  if (t.length < 6) return false;
  if (/^(嗨+|你好|早安|午安|晚安|在嗎|想你|親一個|愛你|抱抱|嗯+|好+|謝謝)/.test(t)) return false;
  if (/撒嬌|想我|親一下|抱抱/.test(t) && t.length < 20) return false;
  if (parseSearchIntent(t)) return true;
  return /記得|之前|當初|決策|thesis|DEC-\d+|知識庫|Codex|公司庫|ai-memory|記憶庫|有沒有做過|怎麼決定|handoff|紅隊|法證|結論|財報|估值|MLA-?C01|考古題|quiz_cli/.test(t)
    || (t.length >= 10 && /[?？]|為什麼|怎麼|哪裡|什麼時候/.test(t) && !/想不想|愛不愛/.test(t));
}

export function parseQmdJson(stdout: string): Array<{ file?: string; title?: string; snippet?: string; score?: number }> {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is { file?: string; title?: string; snippet?: string; score?: number } =>
      typeof item === "object" && item !== null);
  } catch {
    return [];
  }
}

function runQmdSearch(query: string, opts?: { collection?: string; limit?: number; timeoutMs?: number }): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? QMD_TIMEOUT_MS;
  const limit = opts?.limit ?? COMPANY_LIMIT;
  const args = ["search", query, "-n", String(limit), "--format", "json", "--full-path", "--no-rerank"];
  if (opts?.collection) args.push("-c", opts.collection);
  return new Promise((resolve) => {
    const child = spawn("qmd", args, {
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("");
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout : stderr);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

function extractItemText(itemJson: string, itemType: string): string {
  try {
    const obj = JSON.parse(itemJson) as {
      text?: string;
      content?: Array<{ text?: string }>;
    };
    if (itemType === "agentMessage" && typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.content)) {
      return obj.content.map((c) => c.text || "").filter(Boolean).join(" ");
    }
    return typeof obj.text === "string" ? obj.text : "";
  } catch {
    return "";
  }
}

function shortThreadTitle(title: string, firstUser: string): string {
  const t = (title || "").trim();
  if (REVIEW_NOISE_RE.test(t)) {
    const u = (firstUser || "").trim().split(/\n/)[0];
    return collapse(u || "Codex 討論", 80);
  }
  const first = t.split(/\n/)[0].trim();
  if (first && first.length <= 80) return first;
  return collapse(first || firstUser || "未命名討論", 80);
}

function openReadonly(dbPath: string): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 3_000 });
  } catch {
    return null;
  }
}

export function searchCodexDb(query: string, opts?: { stateDb?: string; histDb?: string }): SearchHit[] {
  const needle = query.trim().slice(0, 80);
  if (needle.length < 2) return [];
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const statePath = opts?.stateDb ?? path.join(home, "state_5.sqlite");
  const histPath = opts?.histDb ?? path.join(home, "thread_history_1.sqlite");
  const like = `%${likeEscape(needle)}%`;
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  const state = openReadonly(statePath);
  if (state) {
    try {
      const rows = state.prepare(
        `SELECT id, title, first_user_message, preview, updated_at
         FROM threads
         WHERE ifnull(archived, 0) = 0
           AND (
             ifnull(title,'') LIKE ? ESCAPE '\\'
             OR ifnull(preview,'') LIKE ? ESCAPE '\\'
             OR ifnull(first_user_message,'') LIKE ? ESCAPE '\\'
           )
         ORDER BY ifnull(recency_at_ms, updated_at) DESC
         LIMIT 12`,
      ).all(like, like, like) as Array<{
        id: string;
        title: string | null;
        first_user_message: string | null;
        preview: string | null;
        updated_at: number | null;
      }>;
      for (const row of rows) {
        if (REVIEW_NOISE_RE.test(row.title || "") && REVIEW_NOISE_RE.test(row.preview || "")) continue;
        const title = shortThreadTitle(row.title || "", row.first_user_message || "");
        const snippet = collapse(row.preview || row.first_user_message || title);
        const key = row.id;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ source: "codex", title, snippet, loc: `thread ${row.id.slice(0, 8)}` });
        if (hits.length >= CODEX_LIMIT) break;
      }
    } finally {
      state.close();
    }
  }

  if (hits.length >= CODEX_LIMIT) return hits.slice(0, CODEX_LIMIT);

  const hist = openReadonly(histPath);
  if (hist) {
    try {
      const rows = hist.prepare(
        `SELECT thread_id, item_type, item_json, created_at_ms
         FROM thread_items
         WHERE item_type IN ('userMessage', 'agentMessage')
           AND item_json LIKE ? ESCAPE '\\'
         ORDER BY created_at_ms DESC
         LIMIT 20`,
      ).all(like) as Array<{ thread_id: string; item_type: string; item_json: string; created_at_ms: number }>;
      for (const row of rows) {
        if (seen.has(row.thread_id)) continue;
        const text = extractItemText(row.item_json, row.item_type);
        if (!text) continue;
        seen.add(row.thread_id);
        const who = row.item_type === "userMessage" ? "你" : "Codex";
        hits.push({
          source: "codex",
          title: `${who}｜thread ${row.thread_id.slice(0, 8)}`,
          snippet: collapse(text),
          loc: `thread ${row.thread_id.slice(0, 8)}`,
        });
        if (hits.length >= CODEX_LIMIT) break;
      }
    } finally {
      hist.close();
    }
  }
  return hits.slice(0, CODEX_LIMIT);
}

function hitsFromQmd(
  raw: string,
  source: "vault" | "company",
  limit: number,
  filter?: (file: string) => boolean,
): SearchHit[] {
  if (!raw.trim()) return [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const row of parseQmdJson(raw)) {
    const file = shortPath(row.file || "");
    if (!file || seen.has(file)) continue;
    if (filter && !filter(row.file || file)) continue;
    seen.add(file);
    hits.push({
      source,
      title: collapse(row.title || path.basename(file), 80),
      snippet: collapse(row.snippet || ""),
      loc: file,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export async function searchCompanyQmd(query: string, runner?: (q: string) => Promise<string>): Promise<SearchHit[]> {
  const raw = await (runner ?? ((q: string) => runQmdSearch(q, { limit: 8 })))(query);
  return hitsFromQmd(raw, "company", COMPANY_LIMIT, (file) => !isVaultPath(file));
}

function snippetFromFile(filePath: string, needle: string): string {
  try {
    const st = fs.statSync(filePath);
    if (st.size > 2_000_000) return "";
    const text = fs.readFileSync(filePath, "utf8");
    const lower = needle.toLowerCase();
    const line = text.split(/\r?\n/).find((row) => row.toLowerCase().includes(lower));
    return collapse(line || text.slice(0, 200));
  } catch {
    return "";
  }
}

function walkVaultFiles(root: string, needle: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const stack = [root];
  let seen = 0;
  const lower = needle.toLowerCase();
  while (stack.length && hits.length < limit && seen < 800) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (hits.length >= limit) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name.toLowerCase())) stack.push(full);
        continue;
      }
      if (!/\.(md|json|txt)$/i.test(ent.name)) continue;
      seen += 1;
      if (ent.name.toLowerCase().includes(lower) || snippetFromFile(full, needle)) {
        const snip = snippetFromFile(full, needle);
        if (!snip && !ent.name.toLowerCase().includes(lower)) continue;
        hits.push({
          source: "vault",
          title: collapse(ent.name.replace(/\.(md|json|txt)$/i, ""), 80),
          snippet: snip,
          loc: shortPath(full),
        });
      }
    }
  }
  return hits;
}

export function isMlaQuery(query: string): boolean {
  return /mla-?c01|考古題|quiz_cli|real_bank|^題庫$/i.test(query.trim());
}

function searchVaultRg(query: string, root = VAULT_ROOT): SearchHit[] {
  if (!fs.existsSync(root)) return [];
  try {
    const r = spawnSync("rg", [
      "-i", "-n", "--max-count", "1", "--no-heading",
      "-g", "*.md", "-g", "*.json", "-g", "*.txt",
      "-g", "!**/archive/**", "-g", "!**/logs/**", "-g", "!**/cache/**",
      "-g", "!**/.git/**", "-g", "!**/node_modules/**", "-g", "!**/.sasuke/**",
      query, root,
    ], { encoding: "utf8", timeout: 8_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    if (r.error || (r.status !== 0 && !r.stdout)) {
      return walkVaultFiles(root, query, VAULT_LIMIT);
    }
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const line of (r.stdout || "").split(/\r?\n/)) {
      const m = line.match(/^(.*?):(\d+):(.*)$/);
      if (!m) continue;
      const file = m[1];
      if (seen.has(file)) continue;
      seen.add(file);
      hits.push({
        source: "vault",
        title: collapse(path.basename(file).replace(/\.(md|json|txt)$/i, ""), 80),
        snippet: collapse(m[3] || ""),
        loc: shortPath(file),
      });
      if (hits.length >= VAULT_LIMIT) break;
    }
    return hits;
  } catch {
    return walkVaultFiles(root, query, VAULT_LIMIT);
  }
}

export async function searchVault(query: string, runner?: (q: string) => Promise<string>): Promise<SearchHit[]> {
  const raw = await (runner ?? ((q: string) => runQmdSearch(q, { collection: VAULT_COLLECTION, limit: VAULT_LIMIT })))(query);
  const hits = hitsFromQmd(raw, "vault", VAULT_LIMIT, isVaultPath);
  if (runner) return hits;
  const prefer = isMlaQuery(query)
    ? searchVaultRg(query, path.join(VAULT_ROOT, "personal", "learning", "MLA-C01"))
    : [];
  const extra = hits.length >= 2 && !prefer.length ? [] : searchVaultRg(query);
  const merged: SearchHit[] = [];
  const seen = new Set<string>();
  for (const hit of [...prefer, ...hits, ...extra]) {
    const key = hit.loc.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
    if (merged.length >= VAULT_LIMIT) break;
  }
  return merged;
}

function linesFor(label: string, hits: SearchHit[], note: string): string[] {
  if (!hits.length) return [`${label}：${note || "沒查到"}`];
  const out = [`${label}`];
  for (const hit of hits) {
    out.push(`• ${hit.title}`);
    out.push(`　${hit.loc}`);
    if (hit.snippet) out.push(`　${hit.snippet}`);
  }
  return out;
}

export function formatSearchBundle(bundle: SearchBundle, maxChars = 1900): string {
  const parts = [
    `查庫：${bundle.query}`,
    "",
    ...linesFor("D:\\ai-memory", bundle.vault ?? [], bundle.vaultNote ?? ""),
    "",
    ...linesFor("公司記憶", bundle.company, bundle.companyNote),
    "",
    ...linesFor("Codex 庫", bundle.codex, bundle.codexNote),
  ];
  const text = parts.join("\n").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

export async function searchAthenaKnowledge(
  query: string,
  scope: SearchScope = "all",
): Promise<SearchBundle> {
  const q = sanitizeQuery(query);
  const bundle: SearchBundle = {
    query: q,
    vault: [],
    vaultNote: "",
    company: [],
    companyNote: "",
    codex: [],
    codexNote: "",
  };
  if (q.length < 2) {
    bundle.vaultNote = "關鍵字太短";
    bundle.companyNote = "關鍵字太短";
    bundle.codexNote = "關鍵字太短";
    return bundle;
  }

  const jobs: Array<Promise<void>> = [];
  const wantVault = scope === "all" || scope === "vault" || scope === "company" || isMlaQuery(q);
  if (wantVault) {
    jobs.push((async () => {
      try {
        bundle.vault = await searchVault(q);
        bundle.vaultNote = bundle.vault.length ? "" : "沒查到";
      } catch (err) {
        bundle.vaultNote = `查 D:\\ai-memory 失敗：${(err as Error).message}`;
      }
    })());
  } else {
    bundle.vaultNote = "這次不查 D:\\ai-memory";
  }
  if (scope === "all" || scope === "company") {
    jobs.push((async () => {
      try {
        bundle.company = await searchCompanyQmd(q);
        bundle.companyNote = bundle.company.length ? "" : "沒查到";
      } catch (err) {
        bundle.companyNote = `查公司記憶失敗：${(err as Error).message}`;
      }
    })());
  } else {
    bundle.companyNote = scope === "vault" ? "這次只查 D:\\ai-memory" : "這次只查 Codex";
  }
  if (scope === "all" || scope === "codex") {
    jobs.push((async () => {
      try {
        bundle.codex = searchCodexDb(q);
        bundle.codexNote = bundle.codex.length ? "" : "沒查到";
      } catch (err) {
        bundle.codexNote = `查 Codex 庫失敗：${(err as Error).message}`;
      }
    })());
  } else {
    bundle.codexNote = "這次不查 Codex";
  }
  await Promise.all(jobs);
  return bundle;
}

export async function searchBothForDiscord(query: string, scope: SearchScope = "all"): Promise<string> {
  return formatSearchBundle(await searchAthenaKnowledge(query, scope));
}

export async function maybeKnowledgeCard(userMessage: string): Promise<string> {
  const cleaned = userMessage.replace(/【使用者正在回覆[\s\S]*?【被回覆的訊息到此結束】\s*/g, "").trim();
  if (!looksLikeKnowledgeQuery(cleaned) && !looksLikeKnowledgeQuery(userMessage)) return "";
  const intent = parseSearchIntent(cleaned) ?? parseSearchIntent(userMessage);
  const query = intent?.query ?? cleaned.split(/\n/).map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 120) ?? "";
  if (query.length < 2) return "";
  const bundle = await searchAthenaKnowledge(query, intent?.scope ?? "all");
  if (!bundle.vault.length && !bundle.company.length && !bundle.codex.length) return "";
  return [
    "【知識庫卡】系統剛查的 D:\\ai-memory、公司記憶、Codex。只准用這裡有的；沒寫的標「索引沒有」，不要編。",
    formatSearchBundle(bundle, 1600),
    "【Charles 的問題在下面】",
  ].join("\n");
}
