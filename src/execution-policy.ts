/**
 * Candidate #3 — execution policy seam.
 * Athena chat defaults to Grok oneshot (no local shell).
 * Claude --dangerously-skip-permissions is privileged and must be explicit.
 */
export type EngineKind = "grok-oneshot" | "claude-safe" | "claude-privileged";

export type AthenaExecutionPolicy = {
  chatEngine: EngineKind;
  slashEngine: EngineKind;
  allowSkipPermissions: boolean;
  timeoutMs: number;
};

export class ExecutionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionPolicyError";
  }
}

const DANGEROUS_CONFIRM = "I_UNDERSTAND_ATHENA_CC_RISK";

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function readAthenaExecutionPolicy(env: NodeJS.ProcessEnv = process.env): AthenaExecutionPolicy {
  const persona = (env.PERSONA ?? "iris").toLowerCase();
  const backend = (env.BACKEND ?? "cc").toLowerCase();
  const allowSkip = truthy(env.CLAUDE_ALLOW_SKIP_PERMISSIONS)
    && env.CLAUDE_DANGEROUS_CONFIRM === DANGEROUS_CONFIRM;

  let chatEngine: EngineKind = "claude-privileged";
  let slashEngine: EngineKind = "claude-privileged";

  if (persona === "athena" && backend === "grok") {
    chatEngine = "grok-oneshot";
    slashEngine = "grok-oneshot";
  } else if (!allowSkip) {
    chatEngine = "claude-safe";
    slashEngine = "claude-safe";
  }

  const timeoutMs = Number(env.GEMINI_TIMEOUT_MS ?? env.CLAUDE_TIMEOUT_MS ?? 600_000);
  return {
    chatEngine,
    slashEngine,
    allowSkipPermissions: allowSkip,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 10_000 ? timeoutMs : 600_000,
  };
}

export function buildClaudeSpawnArgs(input: {
  prompt: string;
  sessionId: string;
  model: string;
  resume: boolean;
  systemPrompt?: string;
}, policy: AthenaExecutionPolicy): string[] {
  if (policy.chatEngine === "grok-oneshot" && !policy.allowSkipPermissions) {
    throw new ExecutionPolicyError(
      "Athena 預設不准開 Claude 略過權限。真要開，需 CLAUDE_ALLOW_SKIP_PERMISSIONS=true 且確認字串齊全。",
    );
  }
  const args = [
    "-p", input.prompt,
    ...(input.resume ? ["--resume", input.sessionId] : ["--session-id", input.sessionId]),
    "--model", input.model,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(input.systemPrompt ? ["--system-prompt", input.systemPrompt] : []),
  ];
  if (policy.allowSkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}

export function describeAthenaPolicy(policy: AthenaExecutionPolicy): string {
  return [
    `聊天引擎 ${policy.chatEngine}`,
    `斜線引擎 ${policy.slashEngine}`,
    policy.allowSkipPermissions ? "Claude 略過權限：開（已確認）" : "Claude 略過權限：關",
    `逾時 ${Math.round(policy.timeoutMs / 1000)} 秒`,
  ].join("／");
}
