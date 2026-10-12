import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
const entry = path.resolve('dist/index.js');
function start() {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '1', DOTENV_CONFIG_QUIET: 'true' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  return { child, output: () => output, ready: () => errors.includes('running on stdio') };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for stdio fixture');
}
test('compiled discovery has clean JSON stdout and EOF exits promptly', async () => {
  const { child, output } = start();
  const exit = once(child, 'exit');
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'fixture', version: '1.0.0' },
        },
      }) + '\n',
    );
    await until(() => output().includes('"id":1'));
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
    );
    await until(() => output().includes('"id":2'));
    const messages = output()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(messages.find((message) => message.id === 2).result.tools).toHaveLength(4);
    child.stdin.end();
    expect((await exit)[0]).toBe(0);
  } finally {
    child.kill('SIGKILL');
  }
}, 5000);
test('signals cleanly stop a server with an open stdin', async () => {
  const { child, ready } = start();
  const exit = once(child, 'exit');
  try {
    await until(ready);
    child.kill('SIGTERM');
    expect((await exit)[0]).toBe(0);
  } finally {
    child.kill('SIGKILL');
  }
}, 5000);
test.skipIf(process.platform === 'win32')(
  'parent death exits even while another process keeps stdin open',
  async () => {
    const wrapper = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {spawn} from 'node:child_process'; const server=spawn(process.execPath,[${JSON.stringify(entry)}],{stdio:['inherit','ignore','pipe'],env:{...process.env,LOCALWP_PARENT_WATCHDOG_MS:'100'}}); console.log(server.pid); server.stderr.on('data',d=>{if(d.toString().includes('running on stdio'))console.log('READY')}); setInterval(()=>{},1000);`,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    wrapper.stderr.resume();
    let output = '';
    wrapper.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const [data] = await once(wrapper.stdout, 'data');
    const pid = Number(String(data).trim().split('\n')[0]);
    await until(() => output.includes('READY'));
    const gone = once(wrapper, 'exit');
    wrapper.kill('SIGKILL');
    await gone;
    try {
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      wrapper.stdin.end();
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
  },
  5000,
);
