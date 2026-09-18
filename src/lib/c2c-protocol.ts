/**
 * C2C / S2H (Selina-to-Harness) Agent Protocol & Task State Machine
 * Inspired by XiaoDuoYa/codex-with-chatgpt methodology:
 *   - Control plane: Tiny structured messages (< 1 KB) carrying state and intent.
 *   - Data plane: Decoupled, read-only pull on demand.
 *   - States: INIT -> PLAN -> EXECUTING -> EXECUTED -> REVIEW -> DONE | BLOCKED
 */

import type Database from "better-sqlite3";

export type C2CState =
  | "INIT"
  | "PLAN"
  | "EXECUTING"
  | "EXECUTED"
  | "REVIEW"
  | "DONE"
  | "BLOCKED"
  | "ERROR";

export interface C2CMessage {
  protocol: "C2C" | "S2H";
  state: C2CState;
  taskId: string;
  iteration: number;
  headers: Record<string, string>;
  sections: Record<string, string>;
  raw: string;
}

export interface C2CTaskRecord {
  taskId: string;
  channelId: string;
  threadId: string;
  goal: string;
  state: C2CState;
  iteration: number;
  planPayload?: string;
  resultPayload?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Parses a structured [C2C] or [S2H] message string.
 * Example:
 *   [S2H]
 *   STATE: PLAN
 *   TASK_ID: s2h_20260904_1234
 *   ITERATION: 1
 *
 *   GOAL:
 *   Re-evaluate CCJ fair value.
 *
 *   ACTIONS:
 *   1. Run roic audit
 *   2. Update thesis frontmatter
 *
 *   SUCCESS_CRITERIA:
 *   thesis.md updated with confirmed Westinghouse valuation.
 */
export function parseC2CMessage(text: string): C2CMessage | null {
  const trimmed = text.trim();
  const match = trimmed.match(/(?:^|\n)\s*\[(C2C|S2H)\]/i);
  if (!match || match.index === undefined) return null;

  const bracketIndex = match.index + match[0].indexOf("[");
  const protocol = match[1].toUpperCase() as "C2C" | "S2H";
  const bodyText = trimmed.slice(bracketIndex + match[1].length + 2);
  const lines = bodyText.split(/\r?\n/);

  const headers: Record<string, string> = {};
  const sections: Record<string, string> = {};

  let currentSection: string | null = null;
  const sectionBuffer: string[] = [];

  const flushSection = () => {
    if (currentSection) {
      sections[currentSection] = sectionBuffer.join("\n").trim();
      sectionBuffer.length = 0;
    }
  };

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Check for section header (ALL_CAPS followed by optional colon, standing alone or leading)
    const sectionHeaderMatch = trimmedLine.match(/^([A-Z0-9_]{3,}):?$/);
    if (sectionHeaderMatch && !trimmedLine.includes("STATE:") && !trimmedLine.includes("TASK_ID:") && !trimmedLine.includes("ITERATION:")) {
      flushSection();
      currentSection = sectionHeaderMatch[1];
      continue;
    }

    // Check for key-value headers before any section or inline
    const kvMatch = trimmedLine.match(/^([A-Z0-9_]+):\s*(.*)$/);
    if (!currentSection && kvMatch) {
      const key = kvMatch[1].toUpperCase();
      const val = kvMatch[2].trim();
      headers[key] = val;
      continue;
    }

    if (currentSection) {
      sectionBuffer.push(line);
    }
  }
  flushSection();

  const state = (headers["STATE"]?.toUpperCase() || "PLAN") as C2CState;
  const taskId = headers["TASK_ID"] || headers["TASK"] || `task_${Date.now()}`;
  const iteration = parseInt(headers["ITERATION"] || "1", 10) || 1;

  return {
    protocol,
    state,
    taskId,
    iteration,
    headers,
    sections,
    raw: trimmed,
  };
}

/**
 * Formats a clean, compact control plane message (< 1 KB).
 */
export function formatC2CMessage(opts: {
  protocol?: "C2C" | "S2H";
  state: C2CState;
  taskId: string;
  iteration: number;
  sections: Record<string, string>;
}): string {
  const proto = opts.protocol ?? "S2H";
  const headerLines = [
    `[${proto}]`,
    `STATE: ${opts.state}`,
    `TASK_ID: ${opts.taskId}`,
    `ITERATION: ${opts.iteration}`,
    "",
  ];

  const sectionBlocks = Object.entries(opts.sections)
    .filter(([_, content]) => Boolean(content && content.trim()))
    .map(([title, content]) => `${title.toUpperCase()}:\n${content.trim()}\n`);

  return headerLines.join("\n") + sectionBlocks.join("\n");
}

/**
 * Initializes the SQLite table for task tracking and event-sourced timeline in threads-*.db.
 */
export function initC2CTaskTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS c2c_tasks (
    task_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    state TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 1,
    plan_payload TEXT,
    result_payload TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS c2c_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL
  )`);
}

export interface C2CEventRecord {
  id: number;
  taskId: string;
  eventType: string;
  payload?: string;
  createdAt: number;
}

export function appendC2CEvent(
  db: Database.Database,
  taskId: string,
  eventType: string,
  payload?: string
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO c2c_events (task_id, event_type, payload, created_at)
    VALUES (?, ?, ?, ?)
  `).run(taskId, eventType, payload ?? null, now);
}

export function listC2CEvents(
  db: Database.Database,
  taskId: string,
  limit = 20
): C2CEventRecord[] {
  const rows = db
    .prepare("SELECT * FROM c2c_events WHERE task_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(taskId, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    eventType: r.event_type,
    payload: r.payload ?? undefined,
    createdAt: r.created_at,
  }));
}

/**
 * Creates or inserts a new task record with an event-sourced trace.
 */
export function createC2CTask(
  db: Database.Database,
  task: {
    taskId: string;
    channelId: string;
    threadId: string;
    goal: string;
    state: C2CState;
    iteration?: number;
    planPayload?: string;
  }
): void {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO c2c_tasks
      (task_id, channel_id, thread_id, goal, state, iteration, plan_payload, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    task.taskId,
    task.channelId,
    task.threadId,
    task.goal,
    task.state,
    task.iteration ?? 1,
    task.planPayload ?? null,
    now,
    now
  );

  appendC2CEvent(
    db,
    task.taskId,
    `TASK_CREATED`,
    task.planPayload ? task.planPayload.slice(0, 500) : task.goal
  );
}

/**
 * Updates the state and/or results of an existing task with an event-sourced trace.
 */
export function updateC2CTaskState(
  db: Database.Database,
  taskId: string,
  state: C2CState,
  iteration?: number,
  resultPayload?: string
): void {
  const now = Date.now();
  if (iteration !== undefined && resultPayload !== undefined) {
    db.prepare(`
      UPDATE c2c_tasks
      SET state = ?, iteration = ?, result_payload = ?, updated_at = ?
      WHERE task_id = ?
    `).run(state, iteration, resultPayload, now, taskId);
  } else if (resultPayload !== undefined) {
    db.prepare(`
      UPDATE c2c_tasks
      SET state = ?, result_payload = ?, updated_at = ?
      WHERE task_id = ?
    `).run(state, resultPayload, now, taskId);
  } else {
    db.prepare(`
      UPDATE c2c_tasks
      SET state = ?, updated_at = ?
      WHERE task_id = ?
    `).run(state, now, taskId);
  }

  appendC2CEvent(
    db,
    taskId,
    `STATE_${state}`,
    resultPayload ? resultPayload.slice(0, 500) : `State changed to ${state}`
  );
}

/**
 * Fetches a single task record by ID.
 */
export function getC2CTask(db: Database.Database, taskId: string): C2CTaskRecord | null {
  const row = db.prepare("SELECT * FROM c2c_tasks WHERE task_id = ?").get(taskId) as any;
  if (!row) return null;
  return {
    taskId: row.task_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    goal: row.goal,
    state: row.state as C2CState,
    iteration: row.iteration,
    planPayload: row.plan_payload ?? undefined,
    resultPayload: row.result_payload ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lists the most recent tasks.
 */
export function listRecentC2CTasks(db: Database.Database, limit = 5): C2CTaskRecord[] {
  const rows = db
    .prepare("SELECT * FROM c2c_tasks ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as any[];
  return rows.map((row) => ({
    taskId: row.task_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    goal: row.goal,
    state: row.state as C2CState,
    iteration: row.iteration,
    planPayload: row.plan_payload ?? undefined,
    resultPayload: row.result_payload ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
