import assert from "node:assert/strict";
import {
  collapse,
  formatSearchBundle,
  isVaultPath,
  likeEscape,
  looksLikeKnowledgeQuery,
  sanitizeQuery,
  parseQmdJson,
  parseSearchIntent,
  redactSecrets,
  searchAthenaKnowledge,
  searchCodexDb,
  searchCompanyQmd,
  searchVault,
  shortPath,
} from "../src/athena-search.ts";

assert.equal(parseSearchIntent("查庫 AAOI")?.scope, "all");
assert.equal(parseSearchIntent("查庫 AAOI")?.query, "AAOI");
assert.equal(parseSearchIntent("查公司 掌天瓶")?.scope, "company");
assert.equal(parseSearchIntent("查 vault DEC-0490")?.scope, "vault");
assert.equal(parseSearchIntent("查 ai-memory 持倉")?.scope, "vault");
assert.equal(parseSearchIntent("查記憶庫 掌天瓶")?.scope, "vault");
assert.equal(parseSearchIntent("查 Codex start verabot")?.scope, "codex");
assert.equal(parseSearchIntent("持倉"), null);
assert.equal(parseSearchIntent("【使用者正在回覆下面這則訊息，他的問題是針對這則問的，請以它為準回答】\n內容：\n舊卡\n【被回覆的訊息到此結束】\n\n查庫 DEC-0490")?.query, "DEC-0490");

assert.equal(looksLikeKnowledgeQuery("嗨"), false);
assert.equal(looksLikeKnowledgeQuery("查庫 AAOI"), true);
assert.equal(looksLikeKnowledgeQuery("當初 DEC-0490 怎麼拍板的"), true);
assert.equal(looksLikeKnowledgeQuery("想你"), false);

assert.equal(redactSecrets("key sk-abcdefghijk token"), "key <redacted> token");
assert.equal(likeEscape("50%_off"), "50\\%\\_off");
assert.equal(sanitizeQuery("DEC-0490 & dir"), "DEC-0490 dir");
assert.equal(shortPath("qmd://D:\\ai-memory\\core\\DECISIONS.md"), "D:/ai-memory/core/DECISIONS.md");
assert.equal(shortPath("C:\\Users\\Charles\\ai-memory\\data\\holdings.json"), "D:/ai-memory/data/holdings.json");
assert.equal(isVaultPath("D:\\ai-memory\\core\\DECISIONS.md"), true);
assert.equal(isVaultPath("D:\\claude-data\\agents-memory\\x.md"), false);
assert.equal(collapse("aa\n\nbb   cc", 7), "aa bb c…");

const parsed = parseQmdJson(`noise\n[{"file":"D:\\\\ai-memory\\\\core\\\\DECISIONS.md","title":"DECISIONS","snippet":"DEC-0490 Athena 定位"}]\n`);
assert.equal(parsed[0]?.title, "DECISIONS");

const company = await searchCompanyQmd("DEC-0490", async () => JSON.stringify([
  { file: "D:\\\\claude-data\\\\agents-memory\\\\reference-discord-bots.md", title: "discord bots", snippet: "Athena 手機主入口" },
  { file: "D:\\\\ai-memory\\\\core\\\\DECISIONS.md", title: "DECISIONS", snippet: "應被 vault 過濾掉" },
]));
assert.equal(company.length, 1);
assert.match(company[0].loc, /reference-discord-bots\.md$/);

const vaultMock = await searchVault("DEC-0490", async () => JSON.stringify([
  { file: "D:\\\\ai-memory\\\\core\\\\DECISIONS.md", title: "DECISIONS", snippet: "Athena 定位為手機主入口" },
]));
assert.equal(vaultMock.length, 1);
assert.match(vaultMock[0].loc, /ai-memory\/core\/DECISIONS\.md/i);

const formatted = formatSearchBundle({
  query: "AAOI",
  vault: vaultMock,
  vaultNote: "",
  company,
  companyNote: "",
  codex: [],
  codexNote: "沒查到",
});
assert.match(formatted, /D:\\ai-memory/);
assert.match(formatted, /公司記憶/);
assert.match(formatted, /Codex 庫：沒查到/);
assert.ok(formatted.length <= 1900);

const live = searchCodexDb("start verabot");
assert.ok(live.length >= 1, `expected Codex hits for start verabot, got ${live.length}`);
assert.ok(live.every((h) => h.snippet.length <= 160), "Codex snippet too long");
assert.ok(live.every((h) => !/sk-[A-Za-z0-9]{10,}/.test(h.snippet)), "secret leaked");
assert.ok(live.some((h) => /verabot/i.test(`${h.title} ${h.snippet}`)), "hit should mention verabot");

const vaultLive = await searchAthenaKnowledge("DEC-0490", "vault");
assert.ok(vaultLive.vault.length >= 1, "D:\\ai-memory should hit DEC-0490");
assert.ok(vaultLive.vault.some((h) => /ai-memory/i.test(h.loc)), vaultLive.vault.map((h) => h.loc).join(","));
assert.equal(vaultLive.company.length, 0);

const both = await searchAthenaKnowledge("DEC-0490", "all");
assert.ok(both.vault.length >= 1, "all-scope should include D:\\ai-memory");

console.log("PASS athena-search", {
  liveCodexHits: live.length,
  firstTitle: live[0]?.title,
  vaultHits: vaultLive.vault.length,
  vaultLoc: vaultLive.vault[0]?.loc,
  allVaultHits: both.vault.length,
  allCompanyHits: both.company.length,
});
