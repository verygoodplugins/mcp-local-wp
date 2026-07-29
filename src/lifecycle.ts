/**
 * Parent-liveness watchdog for the stdio MCP server.
 *
 * When an intermediate wrapper (npx → npm exec → node bin → server) keeps the
 * server's stdin write-end open, a dead client never delivers EOF, so the leaf
 * sits in the event loop forever and can thrash swap (multi-GB). Soft stdin
 * EOF alone is not enough to catch that orphan case. The watchdog catches it
 * by noticing the original parent is gone.
 *
 * Soft stdin EOF is intentional: do NOT call `transport.close()` and do NOT
 * `process.exit` on `end`/`close`. Closing the transport trips the MCP SDK
 * `onclose` → hard exit and breaks one-shot `echo … | npm start` flows.
 * Hard exit is reserved for parent-watchdog reparent + OS signals.
 *
 * Kept side-effect-free on import so unit tests can cover it without spawning
 * the full server.
 */

export type ParentLivenessProbe = (parentPid: number) => boolean;

/** Poll interval (ms) used when the env override is unset or invalid. */
export const DEFAULT_PARENT_WATCHDOG_MS = 30_000;

const MIN_PARENT_WATCHDOG_MS = 100;

/**
 * Parse LOCALWP_PARENT_WATCHDOG_MS into a safe poll interval.
 *
 * Non-finite / zero / negative → default. No disable value: an unparseable
 * knob must never silently turn orphan protection off. Floored at
 * MIN_PARENT_WATCHDOG_MS so tiny inputs can't spin the CPU.
 */
export function parseWatchdogIntervalMs(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PARENT_WATCHDOG_MS;
  return Math.max(n, MIN_PARENT_WATCHDOG_MS);
}

/**
 * Default probe: the server has been reparented away from its original parent.
 * POSIX only (Windows does not reparent orphans, so this is a no-op there).
 */
export function parentReparented(parentPid: number): boolean {
  return process.ppid !== parentPid;
}

/**
 * Poll for the original parent's death and invoke `onDead` exactly once.
 * Interval is unref'd so the watchdog alone never keeps the event loop alive.
 */
export function startParentWatchdog(
  parentPid: number,
  intervalMs: number,
  onDead: () => void,
  isParentGone: ParentLivenessProbe = parentReparented
): NodeJS.Timeout {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    if (isParentGone(parentPid)) {
      fired = true;
      onDead();
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

/**
 * Install stdin/transport/signal/parent-watchdog shutdown hooks.
 * Call before `server.connect(transport)`.
 *
 * If `main()` awaits anything before this call, pass `parentPid` captured
 * synchronously at the top of `main()` — `process.ppid` is dynamic, and a
 * late capture after reparent would make the watchdog a no-op (mcp-automem #137).
 */
export function installStdioLifecycle(options: {
  transport: { close?: () => unknown };
  onCloseAssignable?: { onclose?: (() => void) | null };
  envName?: string;
  onShutdown?: () => void;
  /** Prefer a pid captured before any `await` in `main()`. */
  parentPid?: number;
}): () => void {
  const parentPid = options.parentPid ?? process.ppid;
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      options.onShutdown?.();
    } catch {
      /* best effort */
    }
    try {
      void options.transport.close?.();
    } catch {
      /* best effort */
    }
    process.exit(code);
  };

  // Soft stdin EOF → no-op. Do not transport.close() (SDK onclose → hard exit)
  // and do not process.exit. One-shot pipes must drain in-flight handlers;
  // orphans that keep stdin open are killed by the parent watchdog / signals.
  process.stdin.on('end', () => {});
  process.stdin.on('close', () => {});
  if (options.onCloseAssignable) {
    options.onCloseAssignable.onclose = () => shutdown(0);
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => shutdown(0));
  }

  const envName = options.envName ?? 'LOCALWP_PARENT_WATCHDOG_MS';
  startParentWatchdog(
    parentPid,
    parseWatchdogIntervalMs(process.env[envName]),
    () => shutdown(0)
  );

  return shutdown;
}
