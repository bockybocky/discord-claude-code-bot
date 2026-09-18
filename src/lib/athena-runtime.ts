import type { SessionLifecycle } from "../session-lifecycle.js";
import type { createAthenaCapabilities } from "../capabilities.js";

export type AthenaRuntime = {
  life: SessionLifecycle;
  caps: ReturnType<typeof createAthenaCapabilities>;
  retry: (prompt: string, userId: string, channelId: string, username: string) => Promise<void>;
};

let runtime: AthenaRuntime | undefined;

export function setAthenaRuntime(next: AthenaRuntime): void {
  runtime = next;
}

export function getAthenaRuntime(): AthenaRuntime {
  if (!runtime) throw new Error("Athena runtime 尚未就緒");
  return runtime;
}

export const SAPPHIRE_ATHENA_COMMANDS = new Set([
  "athena-holdings",
  "athena-today",
  "athena-scout",
  "athena-status",
  "athena-health",
  "athena-insight",
  "athena-ask-brain",
  "athena-retry",
  "athena-calendar",
  "athena-calendar-confirm",
  "athena-mail",
  "athena-mail-confirm",
]);
