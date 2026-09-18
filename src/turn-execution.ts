/**
 * Conversation turn execution — architecture review candidate #1
 * (2026-08-15, learn from VeraBot review).
 *
 * Discord event adapters only decide *where* the turn lives
 * (new thread vs existing thread / DM). This module owns:
 * attachments, voice, preview, model call, reply, memory, cleanup.
 */
import fs from "node:fs";
import path from "node:path";
import type { Message } from "discord.js";

export type PreviewState = {
  msg: Message | null;
  lastText: string;
  lastEditTime: number;
  timer: NodeJS.Timeout | null;
  pendingText: string;
  startTime: number;
  toolsUsed: string[];
};

export type ThreadEntry = {
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: number;
  started: boolean;
  lastBotMessageId?: string;
  isLocalResume?: boolean;
};

export type TurnResult = {
  text: string;
  exitCode: number;
  permissionDenials?: Array<{ tool_name: string; tool_input?: any }>;
};

export type TurnDeps = {
  attachMaxBytes: number;
  attachTmpDir: string;
  discordMaxLen: number;
  isOneshot: boolean;
  thinkingText: string;
  isVoiceMessage: (message: Message) => boolean;
  downloadAttachment: (url: string, filepath: string) => Promise<void>;
  transcribeVoice: (filepath: string) => Promise<{ ok: boolean; text: string; note: string }>;
  convertToMarkdown: (filepath: string) => Promise<string | null>;
  expandUrls: (text: string, preview: PreviewState) => Promise<string>;
  createPreviewState: () => PreviewState;
  handleStreamText: (preview: PreviewState, fullText: string) => void;
  fetchHistory: (
    channel: any,
    entry: ThreadEntry,
    botId: string,
    oneshot: boolean,
    excludeMessageId: string,
  ) => Promise<string>;
  botId: string;
  runOneshot: (opts: {
    userMessage: string;
    history: string;
    username: string;
    preview: PreviewState;
  }) => Promise<TurnResult>;
  runClaude: (opts: {
    userMessage: string;
    history: string;
    entry: ThreadEntry;
    threadId: string;
    preview: PreviewState;
    resume: boolean;
  }) => Promise<
    | { kind: "empty-override"; token: string }
    | { kind: "ok"; result: TurnResult; hint: string | null }
  >;
  formatFinal: (opts: {
    result: TurnResult;
    entry: ThreadEntry;
    hint: string | null;
    isFirst: boolean;
  }) => string;
  sendAskButtons: (channel: any, threadId: string, entry: ThreadEntry, denial: any) => Promise<void>;
  sendChunked: (channel: any, text: string, replyTo?: Message) => Promise<Message>;
  saveEntry: (threadId: string, entry: ThreadEntry) => void;
  captureMemory: (threadId: string, userText: string, replyText: string) => void;
  patchSession: (sessionId: string, cwd: string) => void;
  onTurnStart?: (input: { threadId: string; userId: string; prompt: string; model: string }) => string;
  onTurnEnd?: (runId: string, input: { status: "succeeded" | "failed"; exitCode?: number; response?: string; error?: string }) => void;
};

export type ConversationTurnInput = {
  message: Message;
  content: string;
  destChannel: any;
  threadId: string;
  entry: ThreadEntry;
  /** "send" = destChannel.send (new thread). "reply" = message.reply (existing). */
  sendMode: "send" | "reply";
  loadHistory: boolean;
  resumeClaude: boolean;
  deps: TurnDeps;
};

function composeUserMessage(content: string, voiceTranscript: string, filePaths: string[]): string {
  if (voiceTranscript) {
    return [
      "（以下是使用者用語音對你說的話，已轉成文字。請直接當成他本人對你說的話來回應或動手做——"
        + "不要複誦、不要回「你說的是……」、不要先確認你聽到了什麼。）",
      voiceTranscript,
      content ? `（使用者另外補充的文字：${content}）` : "",
    ].filter(Boolean).join("\n\n").trim();
  }
  if (filePaths.length === 1) {
    return `${content}\n\nThe user attached a file: ${filePaths[0]}`.trim();
  }
  if (filePaths.length > 1) {
    return `${content}\n\nThe user attached files:\n${filePaths.map((p) => `- ${p}`).join("\n")}`.trim();
  }
  return content;
}

export async function executeConversationTurn(input: ConversationTurnInput): Promise<void> {
  const { message, content, destChannel, threadId, entry, sendMode, loadHistory, resumeClaude, deps } = input;
  const preview = deps.createPreviewState();
  preview.msg = sendMode === "send"
    ? await destChannel.send(deps.thinkingText)
    : await message.reply(deps.thinkingText);

  const attachments = [...message.attachments.values()];
  const filePaths: string[] = [];
  for (const att of attachments) {
    if (att.size > deps.attachMaxBytes) {
      console.log(`[turn] skip oversized attachment: ${att.name} (${att.size})`);
      continue;
    }
    const ext = att.name?.split(".").pop() ?? "bin";
    const filepath = path.join(deps.attachTmpDir, `${message.id}_${att.id}.${ext}`);
    try {
      await deps.downloadAttachment(att.url, filepath);
      filePaths.push(filepath);
    } catch (err) {
      console.error(`[turn] attachment download failed: ${(err as Error).message}`);
    }
  }

  const abortPreview = async (notice: string) => {
    if (preview.timer) clearTimeout(preview.timer);
    await preview.msg?.edit(notice).catch(() => {});
  };

  let runId: string | undefined;
  try {
    let voiceTranscript = "";
    if (deps.isVoiceMessage(message)) {
      if (filePaths.length === 0) {
        await abortPreview("⚠️ *語音訊息下載失敗，已停止（沒有把音檔路徑丟給模型）。請再錄一次。*");
        return;
      }
      await preview.msg?.edit("🎤 *轉錄語音中...*").catch(() => {});
      const r = await deps.transcribeVoice(filePaths[0]);
      if (!r.ok) {
        console.error(`[turn] voice transcribe failed: ${r.note}`);
        await abortPreview(`⚠️ *語音轉錄失敗，已停止（未交給模型，避免它對聽不到的內容瞎猜）：${String(r.note).slice(0, 200)}*`);
        return;
      }
      voiceTranscript = r.text;
      console.log(`[turn] voice transcribed (${r.text.length} chars) ${r.note}`);
    }

    let userMessage = composeUserMessage(content, voiceTranscript, filePaths);
    const officePaths = deps.isVoiceMessage(message) ? filePaths.slice(1) : filePaths;
    if (officePaths.length > 0) {
      await preview.msg?.edit("⏳ *正在把附件轉成給模型看的 markdown…*").catch(() => {});
      const cards: string[] = [];
      for (const p of officePaths) {
        const card = await deps.convertToMarkdown(p);
        if (card) {
          cards.push(`--- Doc card from ${p} ---\n${card}\n--- End of ${p} ---`);
        }
      }
      if (cards.length) {
        userMessage = composeUserMessage(content, voiceTranscript, []) + "\n\n" + cards.join("\n\n");
      }
    }
    userMessage = await deps.expandUrls(userMessage, preview);

    runId = deps.onTurnStart?.({
      threadId,
      userId: message.author.id,
      prompt: userMessage,
      model: deps.isOneshot ? "grok-oneshot" : entry.model,
    });

    const history = loadHistory
      ? await deps.fetchHistory(destChannel, entry, deps.botId, deps.isOneshot, message.id)
      : "";

    const username = message.member?.displayName ?? message.author.displayName ?? message.author.username;

    let result: TurnResult;
    let modelHint: string | null = null;

    if (deps.isOneshot) {
      result = await deps.runOneshot({ userMessage, history, username, preview });
    } else {
      const claude = await deps.runClaude({
        userMessage,
        history,
        entry,
        threadId,
        preview,
        resume: resumeClaude,
      });
      if (claude.kind === "empty-override") {
        if (preview.timer) clearTimeout(preview.timer);
        await preview.msg!.delete().catch(() => {});
        const hint = `請在 ${claude.token} 後加問題，例如：\`${claude.token} 這個 IC 門檻怎麼設？\``;
        if (sendMode === "send") await destChannel.send(hint);
        else await message.reply(hint);
        return;
      }
      result = claude.result;
      modelHint = claude.hint;
    }

    if (preview.timer) clearTimeout(preview.timer);

    const askDenial = result.permissionDenials?.find((d) => d.tool_name === "AskUserQuestion");
    if (askDenial) {
      await preview.msg!.delete().catch(() => {});
      entry.started = true;
      await deps.sendAskButtons(destChannel, threadId, entry, askDenial);
      deps.saveEntry(threadId, entry);
      return;
    }

    const isFirst = !entry.started;
    entry.started = true;
    const responseText = deps.formatFinal({ result, entry, hint: modelHint, isFirst });

    let botReply: Message;
    try {
      await preview.msg!.delete().catch(() => {});
      if (responseText.length <= deps.discordMaxLen) {
        botReply = sendMode === "send"
          ? await destChannel.send(responseText)
          : await message.reply(responseText);
      } else {
        botReply = await deps.sendChunked(
          destChannel,
          responseText,
          sendMode === "reply" ? message : undefined,
        );
      }
    } catch (replyErr) {
      console.error(`[turn] reply failed: ${(replyErr as Error).message}`);
      botReply = await destChannel.send(responseText.slice(0, deps.discordMaxLen));
    }

    entry.lastBotMessageId = botReply.id;
    if (!deps.isOneshot) deps.patchSession(entry.sessionId, entry.cwd);
    deps.saveEntry(threadId, entry);
    deps.captureMemory(threadId, message.content, result.text);
    if (runId) {
      deps.onTurnEnd?.(runId, {
        status: result.exitCode === 0 ? "succeeded" : "failed",
        exitCode: result.exitCode,
        response: result.text,
      });
    }
  } catch (err) {
    if (preview.timer) clearTimeout(preview.timer);
    const msg = `Error: ${(err as Error).message}`;
    if (preview.msg) await preview.msg.edit(msg).catch(() => {});
    else if (sendMode === "reply") await message.reply(msg).catch(() => {});
    else await destChannel.send(msg).catch(() => {});
    if (runId) {
      deps.onTurnEnd?.(runId, { status: "failed", error: (err as Error).message });
    }
  } finally {
    for (const p of filePaths) fs.unlink(p, () => {});
  }
}
