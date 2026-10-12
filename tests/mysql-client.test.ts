import { test } from 'vitest';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { MySQLClient } from '../src/mysql-client.js';

const config = { user: 'fixture', password: 'fixture', multipleStatements: true };

async function fixture(
  run: (
    events: string[],
    client: MySQLClient,
    state: { fail?: string; opens: number; destroyed: number },
  ) => Promise<void>,
  allowWrites = false,
) {
  const original = mysql.createConnection;
  const events: string[] = [];
  const state = { fail: undefined as string | undefined, opens: 0, destroyed: 0 };
  mysql.createConnection = (async (options) => {
    assert.equal(options.multipleStatements, false);
    const id = ++state.opens;
    await new Promise((resolve) => setTimeout(resolve, 1));
    return {
      query: async (sql: string) => {
        events.push(`${id}:${sql}`);
        if (state.fail === sql) throw new Error('fixture failure');
        return [[{ sql_mode: '' }]];
      },
      execute: async (sql: string) => {
        events.push(`${id}:${sql}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (state.fail === sql) throw new Error('fixture failure');
        return [sql.startsWith('SELECT') ? [{ ok: 1 }] : { affectedRows: 1, insertId: 0 }];
      },
      end: async () => {
        events.push(`${id}:END`);
      },
      destroy: () => {
        state.destroyed++;
      },
    };
  }) as typeof mysql.createConnection;
  const client = new MySQLClient(config, { allowWrites });
  try {
    await run(events, client, state);
  } finally {
    await client.disconnect();
    mysql.createConnection = original;
  }
}

test('concurrent connection attempts share initialization and reads are serialized', async () => {
  await fixture(async (events, client, state) => {
    await Promise.all([client.connect(), client.connect()]);
    assert.equal(state.opens, 1);
    await Promise.all([
      client.executeReadOnlyQuery('SELECT 1'),
      client.executeReadOnlyQuery('SELECT 2'),
    ]);
    assert.deepEqual(events.slice(2), [
      '1:START TRANSACTION READ ONLY',
      '1:SELECT 1',
      '1:ROLLBACK AND NO CHAIN NO RELEASE',
      '1:START TRANSACTION READ ONLY',
      '1:SELECT 2',
      '1:ROLLBACK AND NO CHAIN NO RELEASE',
    ]);
  });
});
test('read-only initialization failure never executes caller SQL and retries on a fresh connection', async () => {
  await fixture(async (events, client, state) => {
    state.fail = 'SET SESSION TRANSACTION READ ONLY';
    await assert.rejects(client.executeReadOnlyQuery('SELECT 1'));
    assert.equal(state.destroyed, 1);
    assert.ok(!events.some((e) => e.endsWith(':SELECT 1')));
    state.fail = undefined;
    await client.executeReadOnlyQuery('SELECT 1');
    assert.equal(state.opens, 2);
  });
});
test('transaction startup and rollback failures discard the connection', async () => {
  for (const fail of ['START TRANSACTION READ ONLY', 'ROLLBACK AND NO CHAIN NO RELEASE']) {
    await fixture(async (_events, client, state) => {
      state.fail = fail;
      await assert.rejects(client.executeReadOnlyQuery('SELECT 1'));
      assert.equal(state.destroyed, 1);
      state.fail = undefined;
      await client.executeReadOnlyQuery('SELECT 2');
      assert.equal(state.opens, 2);
    });
  }
});
test('query failures rollback and do not poison the queue', async () => {
  await fixture(async (events, client, state) => {
    state.fail = 'SELECT 1';
    await assert.rejects(client.executeReadOnlyQuery('SELECT 1'));
    assert.equal(events.at(-1), '1:ROLLBACK AND NO CHAIN NO RELEASE');
    state.fail = undefined;
    await client.executeReadOnlyQuery('SELECT 2');
  });
});
test('disabled writes do not create a write connection', async () => {
  await fixture(async (_events, client, state) => {
    await assert.rejects(client.executeWriteQuery('DELETE FROM wp_users WHERE ID=?', [1]));
    assert.equal(state.opens, 0);
  });
});
test('opt-in writes use a different connection from protected reads', async () => {
  await fixture(async (events, client, state) => {
    await Promise.all([
      client.executeReadOnlyQuery('SELECT 1'),
      client.executeWriteQuery('UPDATE wp_users SET user_pass=? WHERE ID=?', ['marker', 1]),
    ]);
    assert.equal(state.opens, 2);
    assert.equal(events.filter((e) => e.includes('SET SESSION TRANSACTION READ ONLY')).length, 1);
    assert.ok(events.some((e) => e.includes('START TRANSACTION READ ONLY')));
  }, true);
});
test('malicious input is never sent to execute', async () => {
  await fixture(async (events, client) => {
    await assert.rejects(
      client.executeReadOnlyQuery('/*!UPDATE wp_users SET ID=(*/ SELECT 2 /*! ) */'),
    );
    assert.ok(!events.some((e) => e.includes('/*!')));
    await assert.rejects(client.getTableColumns('wp_users;DROP'));
  });
});
