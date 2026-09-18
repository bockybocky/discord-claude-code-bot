/**
 * IrisBot concurrency gate — v0.1.
 *
 * Per spec §4 (~/.agents/iris/iris_slash_commands_spec.md):
 *   - HEAVY_LIMIT = 1 concurrent heavy task (audit / kaigong)
 *   - LIGHT_LIMIT = 3 concurrent light tasks
 *   - Ticker-level lock file under ~/.agents/iris/locks/{TICKER}.lock
 */
import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
const LOCK_DIR = path.join(HOME, ".agents", "iris", "locks");

export const HEAVY_LIMIT = 1;
export const LIGHT_LIMIT = 3;
export const QUEUE_MAX = 3;

export type TaskKind = "heavy" | "light";

interface HeavySlot {
  id: string;
  label: string;
  ticker?: string;
  startedAt: number;
}

interface QueueEntry {
  id: string;
  label: string;
  ticker?: string;
  enqueuedAt: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

const heavyRunning = new Map<string, HeavySlot>();
const lightRunning = new Map<string, { label: string; startedAt: number }>();
const heavyQueue: QueueEntry[] = [];

function ensureLockDir(): void {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
}

export interface AcquireLightResult {
  ok: boolean;
  message?: string;
  release?: () => void;
}

export function tryAcquireLight(id: string, label: string): AcquireLightResult {
  if (lightRunning.size >= LIGHT_LIMIT) {
    return { ok: false, message: `🚦 Iris 忙線中（light=${lightRunning.size}/${LIGHT_LIMIT}），稍後再試` };
  }
  lightRunning.set(id, { label, startedAt: Date.now() });
  const release = () => { lightRunning.delete(id); };
  return { ok: true, release };
}

export interface AcquireHeavyResult {
  ok: boolean;
  queued?: boolean;
  message?: string;
  release?: () => void;
  waitFor?: Promise<void>;
}

/**
 * Acquire a heavy slot. If full and queue not full, returns a promise to wait.
 * If queue also full, rejects immediately.
 */
export function tryAcquireHeavy(id: string, label: string, ticker?: string): AcquireHeavyResult {
  if (heavyRunning.size < HEAVY_LIMIT) {
    heavyRunning.set(id, { id, label, ticker, startedAt: Date.now() });
    const release = () => {
      heavyRunning.delete(id);
      pumpQueue();
    };
    return { ok: true, release };
  }
  if (heavyQueue.length >= QUEUE_MAX) {
    return { ok: false, message: `🚫 Heavy queue 已滿（${QUEUE_MAX} 個在排），拒絕新任務` };
  }
  const current = Array.from(heavyRunning.values())[0];
  const elapsed = Math.round((Date.now() - current.startedAt) / 1000);
  const queuePos = heavyQueue.length + 1;
  const waitFor = new Promise<void>((resolve, reject) => {
    heavyQueue.push({ id, label, ticker, enqueuedAt: Date.now(), resolve, reject });
  });
  return {
    ok: true,
    queued: true,
    waitFor,
    message: `🚦 Iris 正在跑 ${current.label}（${elapsed}s），你的 ${label} 已排隊（位置 #${queuePos}）`,
    release: () => {
      heavyRunning.delete(id);
      pumpQueue();
    },
  };
}

function pumpQueue(): void {
  while (heavyRunning.size < HEAVY_LIMIT && heavyQueue.length > 0) {
    const next = heavyQueue.shift()!;
    heavyRunning.set(next.id, { id: next.id, label: next.label, ticker: next.ticker, startedAt: Date.now() });
    next.resolve();
  }
}

export interface StatusSnapshot {
  heavy: Array<{ id: string; label: string; ticker?: string; elapsedSec: number }>;
  light: Array<{ id: string; label: string; elapsedSec: number }>;
  queue: Array<{ id: string; label: string; ticker?: string; waitedSec: number }>;
  heavyLimit: number;
  lightLimit: number;
}

export function snapshot(): StatusSnapshot {
  const now = Date.now();
  return {
    heavy: Array.from(heavyRunning.values()).map(v => ({
      id: v.id, label: v.label, ticker: v.ticker,
      elapsedSec: Math.round((now - v.startedAt) / 1000),
    })),
    light: Array.from(lightRunning.entries()).map(([id, v]) => ({
      id, label: v.label, elapsedSec: Math.round((now - v.startedAt) / 1000),
    })),
    queue: heavyQueue.map(q => ({
      id: q.id, label: q.label, ticker: q.ticker,
      waitedSec: Math.round((now - q.enqueuedAt) / 1000),
    })),
    heavyLimit: HEAVY_LIMIT,
    lightLimit: LIGHT_LIMIT,
  };
}

export function renderStatus(): string {
  const s = snapshot();
  const lines: string[] = [`🟢 **IrisBot 並發狀態**`, `────────────────`];
  if (s.heavy.length === 0) {
    lines.push(`Heavy (0/${s.heavyLimit}): *(idle)*`);
  } else {
    lines.push(`Heavy (${s.heavy.length}/${s.heavyLimit}):`);
    for (const h of s.heavy) {
      lines.push(`  • ${h.label}${h.ticker ? ` [${h.ticker}]` : ""} — ${h.elapsedSec}s`);
    }
  }
  if (s.light.length === 0) {
    lines.push(`Light (0/${s.lightLimit}): *(idle)*`);
  } else {
    lines.push(`Light (${s.light.length}/${s.lightLimit}):`);
    for (const l of s.light) {
      lines.push(`  • ${l.label} — ${l.elapsedSec}s`);
    }
  }
  if (s.queue.length > 0) {
    lines.push(`Queue:`);
    for (const q of s.queue) {
      lines.push(`  • ${q.label}${q.ticker ? ` [${q.ticker}]` : ""} — waited ${q.waitedSec}s`);
    }
  }
  return lines.join("\n");
}

// ─── Ticker lock (for /iris-audit) ───────────────────────────────────────

export interface TickerLockInfo {
  ticker: string;
  pid: number;
  startedAt: number;
  label: string;
  etaMs?: number;
}

export function acquireTickerLock(ticker: string, label: string, etaMs?: number): boolean {
  ensureLockDir();
  const file = path.join(LOCK_DIR, `${ticker.toUpperCase()}.lock`);
  if (fs.existsSync(file)) {
    // Check if lock is stale (>30 min)
    try {
      const info = JSON.parse(fs.readFileSync(file, "utf-8")) as TickerLockInfo;
      if (Date.now() - info.startedAt > 30 * 60 * 1000) {
        fs.unlinkSync(file); // stale, drop it
      } else {
        return false;
      }
    } catch {
      fs.unlinkSync(file); // corrupt, drop it
    }
  }
  const info: TickerLockInfo = {
    ticker: ticker.toUpperCase(),
    pid: process.pid,
    startedAt: Date.now(),
    label,
    etaMs,
  };
  fs.writeFileSync(file, JSON.stringify(info, null, 2), "utf-8");
  return true;
}

export function releaseTickerLock(ticker: string): void {
  const file = path.join(LOCK_DIR, `${ticker.toUpperCase()}.lock`);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

export function getTickerLock(ticker: string): TickerLockInfo | null {
  const file = path.join(LOCK_DIR, `${ticker.toUpperCase()}.lock`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as TickerLockInfo;
  } catch {
    return null;
  }
}
