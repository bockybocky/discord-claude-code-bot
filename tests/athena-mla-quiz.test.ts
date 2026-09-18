import assert from "node:assert/strict";
import { parseMlaQuizIntent, runMlaQuiz } from "../src/athena-mla-quiz.ts";
import { isMlaQuery, searchAthenaKnowledge } from "../src/athena-search.ts";

assert.deepEqual(parseMlaQuizIntent("出題"), ["next"]);
assert.deepEqual(parseMlaQuizIntent("答 B,AC,D"), ["answer", "B,AC,D"]);
assert.deepEqual(parseMlaQuizIntent("進度"), ["status"]);
assert.deepEqual(parseMlaQuizIntent("看 34"), ["show", "34"]);
assert.deepEqual(parseMlaQuizIntent("查庫 題庫"), ["next"]);
assert.deepEqual(parseMlaQuizIntent("查 Codex MLA-C01"), ["next"]);
assert.deepEqual(parseMlaQuizIntent("【使用者正在回覆下面這則訊息，他的問題是針對這則問的，請以它為準回答】\n內容：\n卡進來了\n【被回覆的訊息到此結束】\n\n查庫 題庫"), ["next"]);
assert.equal(isMlaQuery("MLA-C01"), true);
assert.equal(isMlaQuery("題庫"), true);
assert.equal(isMlaQuery("DEC-0490"), false);

const status = await runMlaQuiz(["status"]);
assert.match(status, /MLA-C01 進度/);

const vault = await searchAthenaKnowledge("題庫", "vault");
assert.ok(vault.vault.some((h) => /MLA-C01/i.test(h.loc)), vault.vault.map((h) => h.loc).join(" | "));

const fromCodexScope = await searchAthenaKnowledge("MLA-C01", "codex");
assert.ok(fromCodexScope.vault.some((h) => /MLA-C01/i.test(h.loc)), "MLA query must still hit vault even if asked as Codex");

console.log("PASS athena-mla-quiz", {
  status: status.split(/\n/)[0],
  vaultHits: vault.vault.map((h) => h.loc),
});
