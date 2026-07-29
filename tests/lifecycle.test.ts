import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  DEFAULT_PARENT_WATCHDOG_MS,
  installStdioLifecycle,
  parseWatchdogIntervalMs,
  startParentWatchdog,
} from '../src/lifecycle.ts';

describe('parseWatchdogIntervalMs', () => {
  it('defaults on unset/invalid/non-positive', () => {
    assert.equal(parseWatchdogIntervalMs(undefined), DEFAULT_PARENT_WATCHDOG_MS);
    assert.equal(parseWatchdogIntervalMs(''), DEFAULT_PARENT_WATCHDOG_MS);
    assert.equal(parseWatchdogIntervalMs('nope'), DEFAULT_PARENT_WATCHDOG_MS);
    assert.equal(parseWatchdogIntervalMs('0'), DEFAULT_PARENT_WATCHDOG_MS);
    assert.equal(parseWatchdogIntervalMs('-1'), DEFAULT_PARENT_WATCHDOG_MS);
  });

  it('honours positive values floored at 100ms', () => {
    assert.equal(parseWatchdogIntervalMs('250'), 250);
    assert.equal(parseWatchdogIntervalMs('50'), 100);
  });
});

describe('startParentWatchdog', () => {
  it('fires once when the probe reports parent gone', async () => {
    let calls = 0;
    const timer = startParentWatchdog(1, 100, () => {
      calls += 1;
    }, () => true);
    assert.equal(calls, 0);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls, 1);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(calls, 1);
    clearInterval(timer);
  });
});

describe('installStdioLifecycle soft stdin EOF', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('does not close transport or exit on stdin end/close', () => {
    const transport = { close: mock.fn() };
    const exitMock = mock.method(process, 'exit', () => undefined as never);

    installStdioLifecycle({
      transport,
      parentPid: process.ppid,
      envName: 'LOCALWP_TEST_PARENT_WATCHDOG_MS',
    });

    process.stdin.emit('end');
    process.stdin.emit('close');

    assert.equal(transport.close.mock.callCount(), 0);
    assert.equal(exitMock.mock.callCount(), 0);
  });
});
