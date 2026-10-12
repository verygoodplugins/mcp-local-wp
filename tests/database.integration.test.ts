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
test('compiled stdio supports CTE reads while rejecting CTE writes and side effects', async () => {
  await session(false, async (client) => {
    for (const [sql, params, rows] of [
      ['WITH t AS (SELECT ? AS value) SELECT value FROM t', [7], [{ value: 7 }]],
      ['WITH t(n) AS (SELECT 1), u AS (SELECT n+1 AS n FROM t) SELECT n FROM u', [], [{ n: 2 }]],
      [
        'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<3) SELECT n FROM t ORDER BY n',
        [],
        [{ n: 1 }, { n: 2 }, { n: 3 }],
      ],
      [
        "WITH t AS (SELECT '; /*! UPDATE' AS value) SELECT value FROM t",
        [],
        [{ value: '; /*! UPDATE' }],
      ],
      ['WITH t AS (WITH u AS (SELECT 1 AS n) SELECT n FROM u) SELECT n FROM t', [], [{ n: 1 }]],
      ['WITH t AS ((SELECT 1 AS n)) SELECT n FROM t', [], [{ n: 1 }]],
      ['WITH t AS (SELECT 1 AS n) (SELECT n FROM t)', [], [{ n: 1 }]],
      [
        'WITH t AS ((SELECT 1 AS n) UNION ALL (SELECT 2)) (SELECT n FROM t) ORDER BY n LIMIT 2',
        [],
        [{ n: 1 }, { n: 2 }],
      ],
    ] as const) {
      const result = await client.callTool({ name: 'mysql_query', arguments: { sql, params } });
      expect(result.isError, sql).not.toBe(true);
      expect(result.structuredContent).toEqual({ rows });
      if (result.content[0].type === 'text')
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    }
    for (const sql of [
      "WITH t AS (SELECT 1) UPDATE wp_users SET user_pass='marker' WHERE ID=1",
      'WITH t AS (SELECT 1) DELETE FROM wp_options WHERE option_id=1',
      'WITH t AS (SELECT mutate_option() AS n) SELECT * FROM t',
      "WITH t AS (SELECT 1) SELECT * FROM t INTO OUTFILE '/tmp/localwp-cte-forbidden'",
      'WITH t AS (SELECT * FROM wp_users FOR UPDATE) SELECT * FROM t',
      "WITH t AS (SELECT GET_LOCK('localwp-cte-forbidden', 0)) SELECT * FROM t",
      'WITH t AS (SELECT /*!80000 1 */ 1) SELECT * FROM t',
      'WITH t AS (SELECT 1) /*M! DELETE FROM wp_options */ SELECT * FROM t',
      'WITH t AS (SELECT 1) SELECT * FROM t; DELETE FROM wp_options',
      'WITH t AS (SELECT ?) SELECT * FROM t',
    ])
      expect(
        (await client.callTool({ name: 'mysql_query', arguments: { sql } })).isError,
        sql,
      ).toBe(true);
    await assertUnchanged();
  });
});
test('compiled stdio bounds large schema listings, paginates and treats prefixes literally', async () => {
  const names = Array.from(
    { length: 225 },
    (_, i) => `schema_fixture_${String(i).padStart(3, '0')}`,
  );
  const special = ['schema_%_literal', 'schema_X_literal', 'schema_case_A', 'schema_case_a'];
  try {
    for (const name of [...names, ...special])
      await admin.query(`CREATE TABLE IF NOT EXISTS \`${name}\` (id INT)`);
    await session(false, async (client) => {
      const list = async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: 'mysql_schema', arguments: args });
        expect(result.isError).not.toBe(true);
        const page = result.structuredContent as {
          tables: { table_name: string; engine?: string }[];
          hasMore: boolean;
          nextAfter: string | null;
        };
        if (result.content[0].type === 'text') {
          expect(JSON.parse(result.content[0].text)).toEqual(page);
          expect(result.content[0].text.length).toBeLessThan(25000);
        }
        return page;
      };
      const first = await list({});
      expect(first.tables).toHaveLength(100);
      expect(first.hasMore).toBe(true);
      expect(first.tables.every((row) => Object.keys(row).join() === 'table_name')).toBe(true);
      const collected: string[] = [];
      let after: string | undefined;
      do {
        const page = await list({
          prefix: 'schema_fixture_',
          limit: 80,
          ...(after ? { after } : {}),
        });
        collected.push(...page.tables.map((row) => row.table_name));
        expect(page.hasMore).toBe(page.nextAfter !== null);
        after = page.nextAfter ?? undefined;
      } while (after);
      expect(collected).toEqual(names);
      const stats = await list({ prefix: 'schema_fixture_', limit: 200, includeStats: true });
      expect(stats.tables).toHaveLength(200);
      expect(stats.tables[0].engine).toBeTruthy();
      expect((await list({ prefix: 'schema_%' })).tables).toEqual([
        { table_name: 'schema_%_literal' },
      ]);
      expect((await list({ prefix: 'SCHEMA_fixture_' })).tables).toEqual([]);
      const casePage = await list({ prefix: 'schema_case_', limit: 1 });
      const caseNext = await list({ prefix: 'schema_case_', limit: 1, after: casePage.nextAfter });
      expect([...casePage.tables, ...caseNext.tables].map((row) => row.table_name)).toEqual([
        'schema_case_A',
        'schema_case_a',
      ]);
      expect(await list({ prefix: 'absent_fixture_' })).toEqual({
        tables: [],
        hasMore: false,
        nextAfter: null,
      });
      expect(
        (await client.callTool({ name: 'mysql_schema', arguments: { table: 'wp_users' } }))
          .structuredContent,
      ).toMatchObject({
        table: 'wp_users',
        columns: expect.any(Array),
        indexes: expect.any(Array),
      });
    });
  } finally {
    for (const name of [...names, ...special])
      await admin.query(`DROP TABLE IF EXISTS \`${name}\``);
  }
}, 60_000);
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
    await expect(
      client.executeReadOnlyQuery('WITH "t" AS (SELECT "ID" FROM wp_users) SELECT "ID" FROM "t"'),
    ).resolves.toEqual([{ ID: 1 }]);
    await expect(
      client.executeReadOnlyQuery("WITH t AS (SELECT 'x\\' AS value) SELECT value FROM t"),
    ).resolves.toEqual([{ value: 'x\\' }]);
    await expect(client.executeReadOnlyQuery("SELECT 'x\\'; SELECT 2'")).rejects.toThrow();
  } finally {
    create.mockRestore();
    await client.disconnect();
  }
});
