# 收料線升級 v1：入庫即摘要（甲）／每週整理文（乙）／查詢指令（丙）

Charles 2026-09-07 拍板：「甲乙丙都作，一周」。

## 一、目標（objective）
Charles 把 Fred 的文件轉發到 IrisBot（私訊或「收料」頻道）後：
- **甲**：入庫成功的當下，機器人在該檔的討論串貼一段固定格式摘要，並私訊 Charles 同一段。他不用打開檔就能決定要不要看、要不要動。
- **乙**：每週日 20:00 把過去七天收的料整理成一篇文章，落檔並貼到收料頻道。
- **丙**：在收料頻道打「查 <關鍵字>」，回最近相關的三份檔，各附一句摘要與討論串連結。

## 二、現況（files，先讀再改）
- `src/index.ts`：`handleIntakeMessage()`（約 1309 行）→ 下載附件 → 呼叫 `C:/Users/Charles/scripts/data_readiness/fred_intake.py` → 成功回 `r.path`（落在 `D:/ai-memory/knowledge/fred-shared/YYYY-MM-DD_標題.md`）→ `createFileThread()` 開討論串並記進 `fred_qa_threads.json` → `runQmdUpdate()`。
- `handleFileQa()`（約 2705 行）：在討論串 @Iris 時，用「乾淨腦、只讀那一份檔」回答。**甲的摘要就沿用這條呼叫方式**，不要另建一套呼叫模型的管道。
- 私訊 Charles 的既有函式：搜 `dmCharles`／`dmCharlesOnError`，沿用。
- 持股表：`D:/ai-memory/data/holdings.json`；觀察名單：`D:/ai-memory/data/watchlist.json`（若不存在就只比持股）。
- 收料頻道 ID 1528300306616684645。
- 排程慣例：Windows 工作排程器，包裝 `.bat` 純 ASCII 註解，Python 檔用 Write 建，見 `C:/Users/Charles/scripts/fred_clippings_daily.bat` 樣板。

## 三、介面（interfaces）

### 甲：入庫即摘要
1. 在 `handleIntakeMessage` 拿到 `r.path` 且 `createFileThread` 回傳討論串之後，呼叫新函式 `summarizeIntakeFile(mdPath, threadId, userId)`。
2. `summarizeIntakeFile` 先跑機械步驟（不呼叫模型）：讀 md，抓出持股／觀察名單代號命中（詞邊界比對，沿用 `fred_clippings_pull.py` 裡的比對法），得到 `hits: string[]`。
3. 再用 `handleFileQa` 同款乾淨腦呼叫，固定提問（繁體中文、禁簡體、不超過 180 字）：
   ```
   只讀這一份檔回答，四行，每行一句：
   1 這份在講什麼（一句）
   2 碰到哪些持股或觀察名單：<代號清單由程式帶入，模型只解釋為什麼碰到>；沒有就寫「無」
   3 Fred 的立場或結論是什麼（一句，沒有就寫「只是資料沒有立場」）
   4 行動訊號：只能三選一「無關／值得看／碰到持股要決策」
   ```
4. 貼到討論串（開頭一行「📌 入庫摘要」），同一段私訊 Charles。私訊失敗不可讓入庫流程失敗，只記 log。
5. 把摘要寫回 md 檔的 frontmatter（新增 `summary:`、`hits:`、`signal:` 三個欄位；若檔案沒有 frontmatter 就在檔頭加一段）。**這是丙的資料來源，也讓 qmd 搜得到摘要。**
6. 同時在 `D:/ai-memory/knowledge/fred-shared/_summaries.jsonl` 追加一行 `{date, path, thread_id, hits, signal, summary}`（只增不改）。

### 乙：每週整理文
新腳本 `C:/Users/Charles/scripts/data_readiness/fred_weekly_digest.py`：
1. 讀 `_summaries.jsonl` 過去 7 天（含當天）的條目；沒有條目就落一篇「本週無新料」並結束（回傳碼 0）。
2. 用 `claude -p --model opus`（釘 model，承 cron 規則）產一篇繁體中文整理文：按主題分段（模型自己歸類，段數 2–6）、每段列出該段引用的檔名並附討論串連結、最後一段「本週碰到持股的料」列 hits 非空者。禁簡體、禁英中夾雜、每個數字附出處檔名。
3. 落檔 `D:/ai-memory/knowledge/fred-shared/_digests/YYYY-Www.md`（ISO 週）；冪等：同週重跑覆寫同一檔。
4. 貼到收料頻道（沿用機器人既有的頻道發文函式或 webhook；超過 Discord 2000 字上限就切段）並釘選最新一篇（先取消上一篇釘選）。
5. 排程：`Realpha_FredWeeklyDigest` 每週日 20:00，包裝 bat 純 ASCII，log 落 `C:/Users/Charles/scripts/logs/schtask_runs/Realpha_FredWeeklyDigest.log`。
6. 跑完後跑 `qmd update`（同 `runQmdUpdate` 的做法，讓整理文可查）。

### 丙：查詢指令
在 `src/index.ts` 的 MessageCreate：收料頻道（或其討論串）內、訊息以「查 」開頭（全形或半形空白都接受）→ `handleIntakeQuery(keyword)`：
1. 先用 `qmd search "<關鍵字>"`（BM25，不用 query）限縮到 `knowledge/fred-shared/` 路徑，取前 3。
2. 每筆回：日期＋標題＋一句摘要（來自 frontmatter `summary:` 第一行；沒有就取檔案前 80 字）＋討論串連結（從 `fred_qa_threads.json` 反查；查不到就給檔案路徑）。
3. 查無回「沒有找到含『X』的收料；試試別的字」，不可回空訊息。

## 四、限制（constraints）
- 只改 `src/index.ts` 與新增的兩支 Python 腳本、一支 bat；`fred_intake.py` 不動。
- 禁止 git checkout／restore／reset／stash／clean；禁止刪除任何非本次建立的檔案；禁止 qmd update 以外的 qmd 寫入操作。
- 所有對外文字繁體中文，禁簡體字。
- 模型呼叫失敗（額度、逾時）時：甲改貼「摘要暫時產不出來（原因），檔已入庫」，不得讓入庫失敗；乙記 log 回傳碼 1。
- 不要動 description／觸發詞類的設定；不要改 bot 其他既有指令行為。

## 五、驗證（verification，全部要實跑並貼結果）
1. `npx tsc --noEmit` 零錯誤。
2. 既有測試：`npm test`（若有）不得比改前多紅。
3. 甲：寫一支 `tests/fred_summary.test.ts`（或同型既有測試框架）驗 frontmatter 寫入與 hits 詞邊界（BE 不命中 BEST）。
4. 乙：`python fred_weekly_digest.py --dry-run` 讀真實 `_summaries.jsonl`（今天可能是空的，要處理）印出會產的檔名與段落骨架，不貼 Discord；再 `--week 2026-W36` 實跑一次落檔（可用既有 69 份檔中最近 7 天有的就有）。
5. 丙：本地呼叫 `handleIntakeQuery("光通訊")` 的純函式部分印三筆結果。
6. 排程用 PowerShell `Register-ScheduledTask` 建好後 `Get-ScheduledTask Realpha_FredWeeklyDigest` 狀態 Ready。
7. 回報寫到 `C:/Users/Charles/discord-claude-code-bot/specs/fred_intake_summary_v1_REPORT.md`：改了哪些檔、每條驗證的實跑輸出尾 10 行、**沒做到的明列**。
8. 機器人重啟由主 session 做，你不要重啟。
