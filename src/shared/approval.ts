/** Privileged operation categories used for local tool capability actions and cron profile rules. */
export type ApprovalOperation =
  | "read"
  | "write"
  | "edit"
  | "list"
  | "find"
  | "grep"
  | "skill"
  | "todo"
  | "session"
  | "shell"
  | "network"
  | "mcp";

/** Coarse risk label shown to the approving user. */
export type ApprovalRisk = "low" | "medium" | "high";

/** Default timeout for operation capability requests. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
