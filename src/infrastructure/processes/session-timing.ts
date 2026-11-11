// One second keeps the pipe active without frequent wakeups on an idle host.
export const SESSION_HEARTBEAT_PERIOD_MS = 1_000;
// Ten missed heartbeats tolerate ordinary scheduling stalls; sleep/resume needs host evidence.
export const SESSION_HEARTBEAT_TIMEOUT_MS = 10_000;
// Reuse ADR-0023's worker default to allow CLIs time to flush interrupted work.
export const SESSION_WORKER_GRACE_MS = 15_000;
// Exceeds heartbeat timeout plus worker grace; renew each heartbeat period.
export const SESSION_LEASE_MS = 60_000;
// Leave time for graceful runtime teardown beyond the worker grace.
export const SESSION_STOP_TIMEOUT_MS = 30_000;
