import { beforeAll, afterAll, test, expect, vi } from 'vitest';
import mysql from 'mysql2/promise';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MySQLClient } from '../src/mysql-client.js';
import * as policy from '../src/sql-policy.js';

const port = Number(process.env.DB_TEST_PORT);
if (!port) throw new Error('DB_TEST_PORT must point to a disposable fixture database.');
const config = {
  host: '127.0.0.1',
  port,
  user: 'root',
  password: 'fixture',
  database: 'localwp_test',
};
let admin: mysql.Connection;
beforeAll(async () => {
  admin = await mysql.createConnection(config);
  await admin.query(
    'CREATE TABLE IF NOT EXISTS wp_users (ID INT PRIMARY KEY, user_pass VARCHAR(255))',
  );
  await admin.query(
    'CREATE TABLE IF NOT EXISTS wp_options (option_id INT PRIMARY KEY, option_value VARCHAR(255))',
  );
  await admin.query("REPLACE INTO wp_users VALUES (1,'original')");
  await admin.query("REPLACE INTO wp_options VALUES (1,'original')");
  await admin.query('SET GLOBAL log_bin_trust_function_creators=1');
  await admin.query('DROP FUNCTION IF EXISTS mutate_option');
  await admin.query(
    "CREATE FUNCTION mutate_option() RETURNS INT MODIFIES SQL DATA BEGIN UPDATE wp_options SET option_value='mutated' WHERE option_id=1; RETURN 1; END",
  );
});
afterAll(async () => {
  await admin?.end();
});
async function session(
  writes: boolean,
  run: (client: Client) => Promise<void>,
  entry = process.env.MCP_TEST_ENTRY || 'dist/index.js',
) {
  const client = new Client({ name: 'database-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: String(port),
      MYSQL_USER: 'root',
      MYSQL_PASS: 'fixture',
      MYSQL_DB: 'localwp_test',
      MYSQL_SOCKET_PATH: '',
      MYSQL_ALLOW_WRITES: writes ? 'true' : 'false',
      DOTENV_CONFIG_QUIET: 'true',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}
async function assertUnchanged() {
  const [users] = await admin.query<mysql.RowDataPacket[]>(
    'SELECT user_pass FROM wp_users WHERE ID=1',
  );
  const [options] = await admin.query<mysql.RowDataPacket[]>(
    'SELECT option_value FROM wp_options WHERE option_id=1',
  );
  expect(users[0].user_pass).toBe('original');
  expect(options[0].option_value).toBe('original');
}
test('compiled stdio rejects executable comments, file writes and mutating functions', async () => {
  await session(false, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('mysql_write');
    for (const sql of [
      "/*! UPDATE wp_users SET user_pass=( */ SELECT 'marker' /*! ) WHERE ID=1 */",
      "/*M! UPDATE wp_users SET user_pass=( */ SELECT 'marker' /*M! ) WHERE ID=1 */",
      "/*!00000 UPDATE wp_options SET option_value=( */ SELECT 'marker' /*!00000 ) WHERE option_id=1 */",
      "SELECT 'marker' INTO OUTFILE '/tmp/localwp-forbidden'",
      'SELECT mutate_option()',
      "UPDATE wp_users SET user_pass='marker' WHERE ID=1",
    ])
      expect(
        (await client.callTool({ name: 'mysql_query', arguments: { sql } })).isError,
        sql,
      ).toBe(true);
    const read = await client.callTool({
      name: 'mysql_query',
      arguments: {
        sql: "/* note */ SELECT ID, ';' AS marker FROM wp_users WHERE ID=?;",
        params: [1],
      },
    });
    expect(read.structuredContent).toEqual({ rows: [{ ID: 1, marker: ';' }] });
    for (const [name, args] of [
      ['mysql_schema', {}],
      ['mysql_schema', { table: 'wp_users' }],
    ] as const) {
      expect((await client.callTool({ name, arguments: args })).isError).not.toBe(true);
    }
    await assertUnchanged();
  });
});
test('database protection still rejects writes when tokenizer validation is bypassed', async () => {
  const client = new MySQLClient(config);
  const bypass = vi.spyOn(policy, 'validateReadSql').mockImplementation(() => {});
  try {
    for (const sql of [
      "UPDATE wp_users SET user_pass='marker' WHERE ID=1",
      'SELECT mutate_option()',
    ]) {
      await expect(client.executeReadOnlyQuery(sql)).rejects.toThrow(/READ ONLY/i);
    }
    await assertUnchanged();
    await expect(client.executeReadOnlyQuery('SELECT 1 AS value')).resolves.toEqual([{ value: 1 }]);
  } finally {
    bypass.mockRestore();
    await client.disconnect();
  }
});
test('opt-in writes work and concurrent reads remain protected', async () => {
  await session(true, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('mysql_write');
    const results = await Promise.all([
      client.callTool({
        name: 'mysql_write',
        arguments: {
          sql: 'UPDATE wp_users SET user_pass=? WHERE ID=?',
          params: ['intentional', 1],
        },
      }),
      client.callTool({
        name: 'mysql_query',
        arguments: {
          sql: "/*! UPDATE wp_users SET user_pass=( */ SELECT 'marker' /*! ) WHERE ID=1 */",
        },
      }),
      client.callTool({
        name: 'mysql_query',
        arguments: { sql: 'SELECT ID FROM wp_users WHERE ID=?', params: [1] },
      }),
    ]);
    expect(results[0].structuredContent).toMatchObject({ affectedRows: 1 });
    expect(results[1].isError).toBe(true);
    expect(results[2].isError).not.toBe(true);
    expect(
      (
        await client.callTool({
          name: 'mysql_write',
          arguments: { sql: 'DELETE FROM wp_users WHERE ?', params: [1] },
        })
      ).isError,
    ).toBe(true);
  });
  const [rows] = await admin.query<mysql.RowDataPacket[]>(
    'SELECT user_pass FROM wp_users WHERE ID=1',
  );
  expect(rows[0].user_pass).toBe('intentional');
  await admin.query("UPDATE wp_users SET user_pass='original' WHERE ID=1");
});
test('connection tokenization respects NO_BACKSLASH_ESCAPES and ANSI_QUOTES', async () => {
  const client = new MySQLClient({ ...config /* separate fixture session */ });
  const original = mysql.createConnection;
  const create = vi.spyOn(mysql, 'createConnection').mockImplementation(async (options) => {
    const connection = await original(options);
    await connection.query("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'");
    return connection;
  });
  try {
    await expect(client.executeReadOnlyQuery('SELECT "ID" FROM wp_users')).resolves.toEqual([
      { ID: 1 },
    ]);
    await expect(client.executeReadOnlyQuery("SELECT 'x\\'; SELECT 2'")).rejects.toThrow();
  } finally {
    create.mockRestore();
    await client.disconnect();
  }
});
