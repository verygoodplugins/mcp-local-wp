export const DEFAULT_PARENT_WATCHDOG_MS = 30_000;

export function parseWatchdogIntervalMs(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.max(100, value) : DEFAULT_PARENT_WATCHDOG_MS;
}

export function parentReparented(
  parentPid: number,
  platform: NodeJS.Platform = process.platform,
  probe: (pid: number, signal: 0) => unknown = process.kill,
): boolean {
  if (platform !== 'win32') return process.ppid !== parentPid;
  // Windows does not reparent children. Signal 0 checks existence without signaling.
  try {
    probe(parentPid, 0);
    return false;
  } catch (error) {
    // Access denied is not proof of death; only an absent process triggers shutdown.
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
  }
}

export function startParentWatchdog(
  parentPid: number,
  interval: number,
  onDead: () => void,
  isParentGone = parentReparented,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (!isParentGone(parentPid)) return;
    clearInterval(timer);
    onDead();
  }, interval);
  timer.unref();
  return timer;
}

/** Close transport and database once, awaiting cleanup with a bounded exit. */
export function installLifecycle(parentPid: number, close: () => Promise<void>, env = process.env) {
  let shuttingDown: Promise<void> | undefined;
  const shutdown = () =>
    (shuttingDown ??= (async () => {
      clearInterval(watchdog);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
        process.removeListener(signal, onSignal);
      process.stdin.removeListener('end', onSignal);
      process.stdin.removeListener('close', onSignal);
      const deadline = setTimeout(() => process.exit(1), 5_000);
      deadline.unref();
      try {
        await close();
        process.exitCode = 0;
      } catch (error) {
        console.error('Shutdown failed:', error);
        process.exitCode = 1;
      } finally {
        clearTimeout(deadline);
      }
    })());
  const watchdog = startParentWatchdog(
    parentPid,
    parseWatchdogIntervalMs(env.LOCALWP_PARENT_WATCHDOG_MS),
    () => {
      void shutdown();
    },
  );
  const onSignal = () => {
    void shutdown();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, onSignal);
  process.stdin.once('end', onSignal);
  process.stdin.once('close', onSignal);
  return shutdown;
}
