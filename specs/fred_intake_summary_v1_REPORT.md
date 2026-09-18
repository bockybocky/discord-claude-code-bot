# 收料線升級 v1 實作回報

日期：2026-09-07

## 改動的檔案

- `src/index.ts`
  - 甲：新增持股／觀察名單詞邊界命中、乾淨腦四行摘要、討論串貼文、Charles 私訊、frontmatter 寫回與 `_summaries.jsonl` 追加。
  - 丙：新增 `handleIntakeQuery()` 與 QMD BM25 搜尋；限縮 `fred-shared`、取最近三筆、摘要與討論串連結／路徑回覆；收料頻道及其討論串支援半形／全形空白的「查」指令。
  - 新增 `FRED_INTAKE_TEST=1` 測試閘門，不影響正常啟動。
- `tests/fred_summary.test.ts`
  - 驗證 frontmatter 寫入，以及 `BE` 不命中 `BEST`。
- `C:/Users/Charles/scripts/data_readiness/fred_intake_summary.py`
  - 甲的確定性代號命中 helper。
- `C:/Users/Charles/scripts/data_readiness/fred_weekly_digest.py`
  - 乙的七日／ISO 週讀取、週報產生、冪等落檔、Discord 分段發文／取消舊釘選／釘選新文與可選 QMD 更新。
- `C:/Users/Charles/scripts/fred_weekly_digest.bat`
  - 乙的 Windows 工作排程器包裝檔與指定 log 路徑。
- `D:/ai-memory/knowledge/fred-shared/_digests/2026-W36.md`
  - 乙 `--week 2026-W36` 實跑產物；本週無摘要條目時寫入「本週無新料」。
- `C:/Users/Charles/discord-claude-code-bot/specs/fred_intake_summary_v1_REPORT.md`
  - 本回報。

未修改：`C:/Users/Charles/scripts/data_readiness/fred_intake.py`。

## 驗證指令與實際輸出尾 10 行

### 1. TypeScript

指令：

```text
npx tsc --noEmit
```

實際輸出：

```text
EXIT=0
```

結果：PASS，零錯誤。

### 2. 既有測試

指令：

```text
npm test
```

實際輸出尾 10 行：

```text
npm error Missing script: "test"
npm error
npm error To see a list of scripts, run:
npm error   npm run
npm error A complete log of this run can be found in: D:\dev-cache\npm\_logs\2026-09-06T17_22_34_203Z-debug-0.log
```

結果：未執行；`package.json` 沒有 `test` script，故沒有既有測試可比較。

### 3. 甲：frontmatter 與詞邊界

指令：

```text
npx tsx tests/fred_summary.test.ts
```

實際輸出尾 10 行：

```text
[discord-cc-bot] execution policy: chat=claude-safe skipPermissions=false
[discord-cc-bot] prepended iris soul to SYSTEM_PROMPT (soul=5977 chars, total=7220 chars)
[discord-cc-bot] passthrough engines: grok,agy (persona=iris)
PASS frontmatter + ticker boundary (BE does not match BEST)
EXIT=0
```

結果：PASS。

補充 helper 自測：

```text
python C:\Users\Charles\scripts\data_readiness\fred_intake_summary.py --selftest
```

```text
selftest=PASS hits=['BE', 'GLW']
```

### 4. 乙：dry-run

指令：

```text
python C:\Users\Charles\scripts\data_readiness\fred_weekly_digest.py --dry-run
```

實際輸出尾 10 行：

```text
檔名：2026-W36.md
資料筆數：0
段落骨架：
1. 本週無新料
```

結果：PASS；真實 `_summaries.jsonl` 當時不存在，正確處理為零條目。

### 5. 乙：`--week 2026-W36` 實跑

指令：

```text
python C:\Users\Charles\scripts\data_readiness\fred_weekly_digest.py --week 2026-W36 --skip-qmd-update
```

實際輸出尾 10 行：

```text
ERROR：Discord API GET /users/@me 失敗（HTTP 403）：error code: 1010
落檔：D:\ai-memory\knowledge\fred-shared\_digests\2026-W36.md
EXIT=1
```

結果：週檔已落地；Discord 發文／釘選失敗，原樣記錄為 FAIL，未宣稱成功。

### 6. 丙：本地呼叫 `handleIntakeQuery("光通訊")`

指令：

```text
$env:FRED_INTAKE_TEST='1'; npx tsx -e '(async()=>{const m=await import("./src/index.ts"); const s=await m.handleIntakeQuery("光通訊"); console.log(s);})()'
```

實際輸出尾 10 行：

```text
1. 2026-09-04｜20260904.pdf
　2026/09/04 股票期貨日報 群益期貨 保羅哥趨勢選股 【盤勢】大盤震盪 櫃買偏空 聯準會理事Waller 週四晚間放鴿，強調8 月份CPI 數據對其利率
　討論串：D:\ai-memory\knowledge\fred-shared\2026-09-04_20260904_20260904-股票期貨日報.md

2. 2026-09-03｜20260903.pdf
　2026/09/03 股票期貨日報 群益期貨 保羅哥趨勢選股 【盤勢】大盤偏空 櫃買偏空 油價及10 年債殖利率居高不下氣氛不佳，引發獲利了結賣壓出籠。台股週三
　討論串：D:\ai-memory\knowledge\fred-shared\2026-09-03_20260903_20260903-股票期貨日報.md

3. 2026-09-02｜20260902.pdf
　2026/09/02 股票期貨日報 群益期貨 保羅哥趨勢選股 【盤勢】大盤震盪 櫃買偏多 美伊地緣風險升溫，推升油價及10 年債殖利率創高，引發獲利了結賣壓出籠
　討論串：D:\ai-memory\knowledge\fred-shared\2026-09-02_20260902_20260902-股票期貨日報.md
EXIT=0
```

結果：PASS；QMD 先搜尋後，因現有 QMD 索引沒有回傳 `fred-shared` 結果，由本地檔案補足三筆，避免索引落後時回空訊息。

### 7. 排程

指令：

```text
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\cmd.exe' -Argument '/d /c "C:\Users\Charles\scripts\fred_weekly_digest.bat"'; $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '20:00'; $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable; Register-ScheduledTask -TaskName 'Realpha_FredWeeklyDigest' -Action $action -Trigger $trigger -Settings $settings -Description 'Fred 收料每週整理文' -Force | Out-Null; Get-ScheduledTask -TaskName 'Realpha_FredWeeklyDigest' | Select-Object TaskName,State,TaskPath
```

實際輸出：

```text
TaskName                 State TaskPath
--------                 ----- --------
Realpha_FredWeeklyDigest Ready \
```

結果：PASS，狀態 `Ready`。

## 沒做到／風險與未竟事項

- 乙的 Discord 實際發文與釘選未完成：API `GET /users/@me` 回 HTTP 403、Cloudflare code 1010；需在排程環境修正 Discord API 可達性／憑證後重跑。
- 乙的本次驗證明確使用 `--skip-qmd-update`；依 `C:/Users/Charles/AGENTS.md` 的非 CC lane 治理規則，本次沒有執行 `qmd update`。腳本預設流程仍保留該步驟，排程正常執行時會嘗試更新。
- 甲尚未做真實 Discord 附件入庫與模型呼叫整合測試；本次沒有重啟機器人，符合規格要求。模型失敗 fallback、frontmatter、JSONL 與發文錯誤路徑已在程式中設計，但未以真實附件觸發。
- 丙對目前三筆本地結果找不到 `fred_qa_threads.json` 對應的討論串／guild metadata，因此依規格回檔案路徑；新入庫 thread 會保存 `guildId` 後產生 Discord 討論串連結。
- `npm test` 不存在，沒有既有測試套件可執行。
- 未修改或刪除任何非本次建立的檔案；未執行 Git 寫入指令；未執行 `qmd query`；未重啟機器人。
