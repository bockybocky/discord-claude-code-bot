/**
 * Candidate #2 — session / run lifecycle.
 * Does not own the existing threads table (index.ts still does).
 * Adds runs, drafts, last-prompt, and the in-memory process map.
 */
import crypto from "node:crypto";
import type { ChildProcess } from "node:child_process";
import Database from "better-sqlite3";

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export type RunRecord = {
  runId: string;
  threadId: string;
  userId: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  model: string;
  promptPreview: string;
  responsePreview?: string;
  error?: string;
};

export type CapabilityDraft = {
  draftId: string;
  kind: string;
  userId: string;
  channelId: string;
  payload: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
};

export class SessionLifecycle {
  private readonly db: Database.Database;
  readonly running = new Map<string, ChildProcess>();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS athena_runs (
        runId TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        userId TEXT NOT NULL,
        status TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        finishedAt INTEGER,
        exitCode INTEGER,
        model TEXT NOT NULL,
        promptPreview TEXT NOT NULL,
        responsePreview TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_athena_runs_thread
        ON athena_runs(threadId, startedAt DESC);

      CREATE TABLE IF NOT EXISTS athena_turn_meta (
        threadId TEXT PRIMARY KEY,
        lastPrompt TEXT,
        lastUserId TEXT,
        lastRunId TEXT
      );

      CREATE TABLE IF NOT EXISTS athena_quota (
        userId TEXT NOT NULL,
        bucketStart INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (userId, bucketStart)
      );

      CREATE TABLE IF NOT EXISTS athena_drafts (
        draftId TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        userId TEXT NOT NULL,
        channelId TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
    `);
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  track(sessionId: string, child: ChildProcess): void {
    this.running.set(sessionId, child);
  }

  untrack(sessionId: string): void {
    this.running.delete(sessionId);
  }

  stop(sessionId: string): boolean {
    const child = this.running.get(sessionId);
    if (!child) return false;
    child.kill("SIGTERM");
    this.running.delete(sessionId);
    return true;
  }

  stopAll(): void {
    for (const child of this.running.values()) child.kill("SIGTERM");
    this.running.clear();
  }

  startRun(input: { threadId: string; userId: string; model: string; prompt: string }): string {
    const runId = `run-${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO athena_runs
        (runId, threadId, userId, status, startedAt, model, promptPreview)
      VALUES (?, ?, ?, 'running', ?, ?, ?)
    `).run(runId, input.threadId, input.userId, Date.now(), input.model, input.prompt.slice(0, 2000));
    this.db.prepare(`
      INSERT INTO athena_turn_meta (threadId, lastPrompt, lastUserId, lastRunId)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(threadId) DO UPDATE SET
        lastPrompt = excluded.lastPrompt,
        lastUserId = excluded.lastUserId,
        lastRunId = excluded.lastRunId
    `).run(input.threadId, input.prompt.slice(0, 20_000), input.userId, runId);
    return runId;
  }

  finishRun(runId: string, input: {
    status: Exclude<RunStatus, "running">;
    exitCode?: number;
    response?: string;
    error?: string;
  }): void {
    this.db.prepare(`
      UPDATE athena_runs
      SET status = ?, finishedAt = ?, exitCode = ?, responsePreview = ?, error = ?
      WHERE runId = ?
    `).run(
      input.status,
      Date.now(),
      input.exitCode ?? null,
      input.response?.slice(0, 4000) ?? null,
      input.error?.slice(0, 2000) ?? null,
      runId,
    );
  }

  latestRun(threadId: string): RunRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM athena_runs WHERE threadId = ? ORDER BY startedAt DESC LIMIT 1",
    ).get(threadId) as any;
    return row ? this.toRun(row) : undefined;
  }

  lastPrompt(threadId: string): { prompt: string; userId: string; runId: string } | undefined {
    const row = this.db.prepare(
      "SELECT lastPrompt, lastUserId, lastRunId FROM athena_turn_meta WHERE threadId = ?",
    ).get(threadId) as { lastPrompt: string | null; lastUserId: string | null; lastRunId: string | null } | undefined;
    if (!row?.lastPrompt) return undefined;
    return { prompt: row.lastPrompt, userId: row.lastUserId ?? "", runId: row.lastRunId ?? "" };
  }

  createDraft(input: {
    kind: string;
    userId: string;
    channelId: string;
    payload: Record<string, unknown>;
    ttlMs?: number;
  }): string {
    const draftId = `${input.kind.toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const createdAt = Date.now();
    this.db.prepare(`
      INSERT INTO athena_drafts
        (draftId, kind, userId, channelId, payloadJson, createdAt, expiresAt, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      draftId,
      input.kind,
      input.userId,
      input.channelId,
      JSON.stringify(input.payload),
      createdAt,
      createdAt + (input.ttlMs ?? 15 * 60 * 1000),
    );
    return draftId;
  }

  getDraft(draftId: string, userId: string, channelId: string): CapabilityDraft | undefined {
    const row = this.db.prepare(`
      SELECT draftId, kind, userId, channelId, payloadJson, createdAt, expiresAt
      FROM athena_drafts
      WHERE draftId = ? AND userId = ? AND channelId = ? AND status = 'pending' AND expiresAt > ?
    `).get(draftId, userId, channelId, Date.now()) as any;
    if (!row) return undefined;
    return {
      draftId: row.draftId,
      kind: row.kind,
      userId: row.userId,
      channelId: row.channelId,
      payload: JSON.parse(row.payloadJson),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  consumeDraft(draftId: string, userId: string, channelId: string): boolean {
    const result = this.db.prepare(`
      UPDATE athena_drafts
      SET status = 'consumed'
      WHERE draftId = ? AND userId = ? AND channelId = ? AND status = 'pending' AND expiresAt > ?
    `).run(draftId, userId, channelId, Date.now());
    return result.changes === 1;
  }

  claimDraft(draftId: string, userId: string, channelId: string): CapabilityDraft | undefined {
    const row = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE athena_drafts
        SET status = 'processing'
        WHERE draftId = ? AND userId = ? AND channelId = ? AND status = 'pending' AND expiresAt > ?
      `).run(draftId, userId, channelId, Date.now());
      if (result.changes !== 1) return undefined;
      return this.db.prepare(`
        SELECT draftId, kind, userId, channelId, payloadJson, createdAt, expiresAt
        FROM athena_drafts
        WHERE draftId = ? AND userId = ? AND channelId = ? AND status = 'processing'
      `).get(draftId, userId, channelId) as any;
    })();
    if (!row) return undefined;
    return {
      draftId: row.draftId,
      kind: row.kind,
      userId: row.userId,
      channelId: row.channelId,
      payload: JSON.parse(row.payloadJson),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  completeDraft(draftId: string, userId: string, channelId: string): boolean {
    const result = this.db.prepare(`
      UPDATE athena_drafts SET status = 'consumed'
      WHERE draftId = ? AND userId = ? AND channelId = ? AND status = 'processing'
    `).run(draftId, userId, channelId);
    return result.changes === 1;
  }

  releaseDraft(draftId: string, userId: string, channelId: string): boolean {
    const result = this.db.prepare(`
      UPDATE athena_drafts SET status = 'pending'
      WHERE draftId = ? AND userId = ? AND channelId = ? AND status = 'processing'
    `).run(draftId, userId, channelId);
    return result.changes === 1;
  }

  cancelDraft(draftId: string, userId: string, channelId: string): boolean {
    const result = this.db.prepare(`
      UPDATE athena_drafts SET status = 'cancelled'
      WHERE draftId = ? AND userId = ? AND channelId = ? AND status = 'pending' AND expiresAt > ?
    `).run(draftId, userId, channelId, Date.now());
    return result.changes === 1;
  }

  checkQuota(userId: string, limit = 40): { allowed: boolean; remaining: number; resetAt: number } {
    const bucketStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const row = this.db.prepare(
      "SELECT count FROM athena_quota WHERE userId = ? AND bucketStart = ?",
    ).get(userId, bucketStart) as { count: number } | undefined;
    const count = row?.count ?? 0;
    return {
      allowed: count < limit,
      remaining: Math.max(limit - count, 0),
      resetAt: bucketStart + 3_600_000,
    };
  }

  recordQuota(userId: string): void {
    const bucketStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    this.db.prepare(`
      INSERT INTO athena_quota (userId, bucketStart, count) VALUES (?, ?, 1)
      ON CONFLICT(userId, bucketStart) DO UPDATE SET count = count + 1
    `).run(userId, bucketStart);
  }

  close(): void {
    this.db.close();
  }

  private toRun(row: any): RunRecord {
    return {
      runId: row.runId,
      threadId: row.threadId,
      userId: row.userId,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? undefined,
      exitCode: row.exitCode ?? undefined,
      model: row.model,
      promptPreview: row.promptPreview,
      responsePreview: row.responsePreview ?? undefined,
      error: row.error ?? undefined,
    };
  }
}
