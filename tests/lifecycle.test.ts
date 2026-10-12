import { test, expect, vi } from 'vitest';
import {
  parseWatchdogIntervalMs,
  startParentWatchdog,
  parentReparented,
  installLifecycle,
} from '../src/lifecycle.js';
test('watchdog interval is bounded and has no accidental disable value', () => {
  for (const value of [undefined, '0', '-1', 'NaN', 'Infinity'])
    expect(parseWatchdogIntervalMs(value)).toBe(30_000);
  expect(parseWatchdogIntervalMs('1')).toBe(100);
  expect(parseWatchdogIntervalMs('500')).toBe(500);
});
test('watchdog fires once and does not keep the process alive', () => {
  vi.useFakeTimers();
  const fire = vi.fn();
  const probe = vi.fn().mockReturnValue(false);
  const timer = startParentWatchdog(42, 100, fire, probe);
  expect(timer.hasRef()).toBe(false);
  vi.advanceTimersByTime(100);
  expect(fire).not.toHaveBeenCalled();
  probe.mockReturnValue(true);
  vi.advanceTimersByTime(1000);
  expect(fire).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
test('parent probe recognizes the original parent', () => {
  expect(parentReparented(process.ppid)).toBe(false);
  expect(parentReparented(-1, 'linux')).toBe(true);
});
test('shutdown awaits cleanup and is idempotent', async () => {
  const originalCode = process.exitCode;
  const cleanup = vi.fn(async () => {});
  const stop = installLifecycle(process.ppid, cleanup);
  await Promise.all([stop(), stop()]);
  expect(cleanup).toHaveBeenCalledTimes(1);
  process.exitCode = originalCode;
});

test('Windows parent liveness uses signal zero and distinguishes access denied from death', () => {
  const alive = vi.fn();
  expect(parentReparented(42, 'win32', alive)).toBe(false);
  expect(alive).toHaveBeenCalledWith(42, 0);
  for (const code of ['EPERM', 'EACCES', 'ESRCH']) {
    expect(
      parentReparented(42, 'win32', () => {
        throw Object.assign(new Error(code), { code });
      }),
    ).toBe(code === 'ESRCH');
  }
});
