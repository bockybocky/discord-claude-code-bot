/**
 * SelinaBot 每日一則法說會排程與隨叫隨到模組
 *
 * 呼叫既有 Python 管線：
 *   python C:/Users/Charles/scripts/agy_jobs/run_agy_job.py interesting_call [--force]
 *
 * 本模組職責：
 *   1. 每日排程：依 EARNINGS_CARD_SCHEDULE（時區 Asia/Taipei）觸發一次。
 *   2. 隨叫隨到：收到 !法說 或 !earnings 時立即執行並回覆收據摘要。
 *   3. 逾時監控與錯誤私訊回報（dmCharlesOnError）。
 *   4. 不負責卡片發送（Python 端已具備發送與防編造邏輯）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import cron from "node-cron";
import { Events, type Client, type Message } from "discord.js";
import { dmCharlesOnError } from "./selina-extensions.js";

const TIMEOUT_MS = 15 * 60 * 1000; // 15 分鐘
const SCRIPT_PATH = "C:/Users/Charles/scripts/agy_jobs/run_agy_job.py";
const SCRIPT_CWD = "C:/Users/Charles/scripts/agy_jobs";

let _client: Client | null = null;
let _isRunning = false;

function isSelina(): boolean {
  return (process.env.PERSONA ?? "").toLowerCase() === "selina";
}

/**
 * 執行一次法說會卡片生成管線
 * @param force 是否強制重跑（繞過當日冪等快取）
 */
// 2026-09-06：排程重試中的失敗不要各自私訊——Charles 12:00 收到一則像「掛了」的通知，
// 其實 15:00 第三次就成功了。重試中的失敗改由 runCronAttempt 發一則含「幾點重試」的私訊。
export async function runEarningsCardOnce(
  force: boolean,
  opts: { quietFailure?: boolean } = {}
): Promise<{ ok: boolean; summary: string }> {
  if (_isRunning) {
    const summary = "法說會卡片工作正在執行中，請稍候再試。";
    return { ok: false, summary };
  }

  _isRunning = true;
  const args = [SCRIPT_PATH, "interesting_call"];
  if (force) {
    args.push("--force");
  }

  return new Promise<{ ok: boolean; summary: string }>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("python", args, {
        cwd: SCRIPT_CWD,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      _isRunning = false;
      const errMsg = `無法啟動 Python 管線: ${(err as Error).message}`;
      console.error(`[selina-earnings] ${errMsg}`);
      if (_client) {
        dmCharlesOnError(_client, errMsg, "runEarningsCardOnce:spawn").catch(() => {});
      }
      resolve({ ok: false, summary: errMsg });
      return;
    }

    let stdout = "";
    let stderrBuf = "";
    let settled = false;
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderrBuf += text;
      console.error(`[selina-earnings-stderr] ${text.trim()}`);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
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
    }, TIMEOUT_MS);

    child.on("error", async (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _isRunning = false;
      const errMsg = `Python 程序錯誤: ${err.message}`;
      console.error(`[selina-earnings] ${errMsg}`);
      if (_client) {
        await dmCharlesOnError(_client, errMsg, "runEarningsCardOnce:error").catch(() => {});
      }
      resolve({ ok: false, summary: errMsg });
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _isRunning = false;

      // 解析收據行：[agy收據] job=interesting_call｜...
      const receiptMatch = stdout.match(/^\[agy收據\].*$/m);
      const receiptLine = receiptMatch ? receiptMatch[0].trim() : "";

      if (timedOut) {
        const timeoutMsg = receiptLine || "法說會卡片執行逾時（超過 15 分鐘）";
        console.error(`[selina-earnings] ${timeoutMsg}`);
        if (_client) {
          await dmCharlesOnError(_client, timeoutMsg, "runEarningsCardOnce:timeout").catch(() => {});
        }
        resolve({ ok: false, summary: timeoutMsg });
        return;
      }

      const passed = code === 0 && stdout.includes("驗收=通過");

      if (passed) {
        const summary = receiptLine || "[agy收據] 驗收=通過 (code 0)";
        console.log(`[selina-earnings] ✅ 成功: ${summary}`);
        resolve({ ok: true, summary });
      } else {
        const stderrSnippet = stderrBuf.trim().slice(0, 300);
        const summary = receiptLine || (stderrSnippet ? `stderr: ${stderrSnippet}` : `執行失敗 (結束碼 ${code ?? 1})`);
        console.error(`[selina-earnings] ❌ 失敗 (code ${code}): ${summary}`);
        if (_client && !opts.quietFailure) {
          await dmCharlesOnError(_client, summary, "runEarningsCardOnce:failed").catch(() => {});
        }
        resolve({ ok: false, summary });
      }
    });
  });
}

/**
 * 註冊每日排程與隨叫隨到訊息處理
 */
/** 這則訊息是不是法說會指令（剝掉開頭的 @標註後再判）。index.ts 用它早退避免雙重處理。 */
export function isEarningsCommand(content: string): boolean {
  const raw = (content ?? "").replace(/^(?:<@!?\d+>\s*)+/, "").trim();
  const lower = raw.toLowerCase();
  return raw === "!法說" || raw === "！法說" || raw === "!法說會"
      || raw === "法說" || lower === "!earnings";
}


// 2026-09-05：排程跑失敗時原本只寫 console.log，沒有重試也沒有通知。
// 當天 09:53 agy 回「個人額度用完，2h26m 後重置」，9 秒就失敗，整天沒有卡片，
// 而 Charles 是自己發現的。額度中午就恢復了，只是沒有東西回頭再試一次。
const RETRY_DELAY_MS = 3 * 60 * 60 * 1000; // 額度重置約 2.5 小時，留一點餘裕
const MAX_ATTEMPTS = 3;

function retryClock(): string {
  return new Date(Date.now() + RETRY_DELAY_MS).toLocaleTimeString("zh-TW", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Taipei",
  });
}

async function runCronAttempt(attempt: number): Promise<void> {
  try {
    const willRetry = attempt < MAX_ATTEMPTS;
    const res = await runEarningsCardOnce(false, { quietFailure: willRetry });
    console.log(
      `[discord-cc-bot] 📞 Selina earnings card cron finished: attempt=${attempt} ok=${res.ok} summary="${res.summary}"`
    );
    if (res.ok) return;

    if (willRetry) {
      const at = retryClock();
      console.log(
        `[discord-cc-bot] 📞 Selina earnings card 第 ${attempt} 次失敗，${RETRY_DELAY_MS / 3600000} 小時後（${at}）重試`
      );
      if (_client) {
        dmCharlesOnError(
          _client,
          `今日一則法說會第 ${attempt}／${MAX_ATTEMPTS} 次沒跑成功，${at} 會自動重試，不用動手。原因：${res.summary}`,
          "earningsCard:cron:retry"
        ).catch(() => {});
      }
      setTimeout(() => {
        void runCronAttempt(attempt + 1);
      }, RETRY_DELAY_MS).unref?.();
      return;
    }

    if (_client) {
      dmCharlesOnError(
        _client,
        `今日一則法說會連續 ${MAX_ATTEMPTS} 次都沒跑成功，今天不會有卡片。最後一次的原因：${res.summary}`,
        "earningsCard:cron"
      ).catch(() => {});
    }
  } catch (err) {
    console.error(`[discord-cc-bot] 📞 Selina earnings card cron uncaught error (attempt=${attempt}):`, err);
    if (_client) {
      dmCharlesOnError(
        _client,
        `今日一則法說會排程炸了（第 ${attempt} 次）：${(err as Error).message}`,
        "earningsCard:cron:uncaught"
      ).catch(() => {});
    }
  }
}

export function registerEarningsCard(client: Client): void {
  _client = client;

  if (!isSelina()) {
    return;
  }

  const schedule = process.env.EARNINGS_CARD_SCHEDULE;
  const channelId = process.env.EARNINGS_CARD_CHANNEL_ID ?? "";

  // 1. 每日排程註冊
  if (schedule) {
    cron.schedule(
      schedule,
      async () => {
        console.log(`[discord-cc-bot] 📞 Selina earnings card cron triggered (channel: ${channelId})`);
        await runCronAttempt(1);
      },
      { timezone: "Asia/Taipei" }
    );
    console.log(`[discord-cc-bot] 📞 Selina earnings card scheduled: "${schedule}" → channel ${channelId} (Asia/Taipei)`);
  }

  // 2. 隨叫隨到訊息處理 (!法說 / !earnings)
  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author.bot) return;
      if (!isSelina()) return;

      // 2026-09-04 實測：Charles 手機是打「@SelinaBot !法說」，
      // message.content 實際是「<@機器人編號> !法說」，完全相等比對對不上，
      // 於是掉進一般對話那條路，agy 收到「!法說」回空的。先剝掉開頭的標註再比。
      const raw = message.content.replace(/^(?:<@!?\d+>\s*)+/, "").trim();
      const lower = raw.toLowerCase();
      if (raw === "!法說" || lower === "!earnings" || raw === "!法說會"
          || raw === "！法說" || raw === "法說") {
        // 使用者授權檢查（若環境有設定 ALLOWED_USER_IDS）
        const allowedConfigured = (process.env.ALLOWED_USER_IDS ?? "").trim().length > 0;
        const allowed = (process.env.ALLOWED_USER_IDS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (allowedConfigured && !allowed.includes(message.author.id)) {
          console.warn(`[selina-earnings] 未授權使用者被擋: ${message.author.username} (${message.author.id})`);
          return;
        }

        console.log(`[selina-earnings] 隨叫隨到觸發: user=${message.author.username} command="${raw}"`);
        await message.reply("我去挑一則，大約要幾分鐘～💕").catch((err: unknown) => {
          console.error("[selina-earnings] 回覆初始訊息失敗:", err);
        });

        const res = await runEarningsCardOnce(true);
        const replySummary = res.summary || (res.ok ? "法說會卡片已產出！" : "法說會卡片執行失敗。");
        if ("send" in message.channel) {
          await (message.channel as any).send(replySummary).catch((err: unknown) => {
            console.error("[selina-earnings] 回傳收據失敗:", err);
          });
        }
      }
    } catch (err) {
      console.error("[selina-earnings] 處理隨叫隨到訊息例外:", err);
    }
  });
}
