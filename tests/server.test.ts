import { test, expect, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer, resolveDatabaseConfig, type ServerOptions } from '../src/server.js';
import { MySQLClient } from '../src/mysql-client.js';

const selection = {
  siteName: 'Fixture',
  sitePath: '/fixture',
  domain: 'fixture.local',
  selectionMethod: 'env_site_id' as const,
  siteInfo: {
    siteId: 'fixture',
    socketPath: '/fixture/mysql.sock',
    configPath: '/fixture/my.cnf',
    port: '3306',
  },
};
async function session(options: ServerOptions, run: (client: Client) => Promise<void>) {
  const instance = createServer(options);
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    { supportedProtocolVersions: ['2025-11-25'] },
  );
  const [left, right] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(right);
  await client.connect(left);
  try {
    await run(client);
  } finally {
    await client.close();
    await instance.server.close();
    await instance.disconnect();
  }
}
function services() {
  const db = new MySQLClient({ user: 'fixture', password: 'fixture' });
  vi.spyOn(db, 'executeReadOnlyQuery').mockResolvedValue([{ ID: 1 }]);
  vi.spyOn(db, 'listTables').mockResolvedValue({
    tables: [{ table_name: 'wp_users' }],
    hasMore: false,
    nextAfter: null,
  });
  vi.spyOn(db, 'getTableColumns').mockResolvedValue([{ column_name: 'ID' }]);
  vi.spyOn(db, 'getTableIndexes').mockResolvedValue([{ index_name: 'PRIMARY' }]);
  vi.spyOn(db, 'executeWriteQuery').mockResolvedValue({ affectedRows: 1 });
  vi.spyOn(db, 'disconnect').mockResolvedValue();
  return db;
}
test('tool discovery is lazy, with output schemas and safety annotations', async () => {
  const resolveConfig = vi.fn(() => {
    throw new Error('no database');
  });
  const createClient = vi.fn();
  await session({ env: {}, resolveConfig, createClient }, async (client) => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'mysql_query',
      'mysql_schema',
      'mysql_current_site',
      'mysql_list_sites',
    ]);
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.outputSchema).toBeTruthy();
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });
});
test('read, schema, site and write contracts return identical structured/text objects', async () => {
  const db = services();
  await session(
    {
      env: { MYSQL_ALLOW_WRITES: 'true' },
      resolveConfig: () => ({ config: { user: 'fixture', password: 'fixture' }, selection }),
      createClient: () => db,
      listSites: () => [
        {
          id: 'fixture',
          name: 'Fixture',
          path: '/fixture',
          domain: 'fixture.local',
          running: true,
        },
      ],
    },
    async (client) => {
      const { tools } = await client.listTools();
      expect(tools.at(-1)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      for (const [name, args, expected] of [
        ['mysql_query', { sql: 'SELECT ?', params: [1] }, { rows: [{ ID: 1 }] }],
        [
          'mysql_schema',
          {},
          { tables: [{ table_name: 'wp_users' }], hasMore: false, nextAfter: null },
        ],
        [
          'mysql_schema',
          { table: 'wp_users' },
          {
            table: 'wp_users',
            columns: [{ column_name: 'ID' }],
            indexes: [{ index_name: 'PRIMARY' }],
          },
        ],
        ['mysql_current_site', {}, { siteName: 'Fixture', siteId: 'fixture' }],
        ['mysql_list_sites', {}, { currentSiteId: 'fixture' }],
        [
          'mysql_write',
          { sql: 'DELETE FROM wp_users WHERE ID=?', params: [1] },
          { affectedRows: 1 },
        ],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject(expected);
        expect(result.content[0].type).toBe('text');
        if (result.content[0].type === 'text')
          expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      }
    },
  );
});
test('site discovery never constructs a database client', async () => {
  const createClient = vi.fn();
  await session(
    {
      env: {},
      resolveConfig: () => ({ config: { user: 'fixture', password: 'fixture' }, selection }),
      createClient,
      listSites: () => [],
    },
    async (client) => {
      await client.callTool({ name: 'mysql_current_site', arguments: {} });
      await client.callTool({ name: 'mysql_list_sites', arguments: {} });
      expect(createClient).not.toHaveBeenCalled();
    },
  );
});
test('schema listing forwards filters, cursors and stats and rejects ambiguous inputs', async () => {
  const db = services();
  await session(
    {
      env: {},
      resolveConfig: () => ({ config: { user: 'fixture', password: 'fixture' } }),
      createClient: () => db,
    },
    async (client) => {
      const options = { prefix: 'wp_', after: 'wp_posts', limit: 25, includeStats: true };
      const result = await client.callTool({ name: 'mysql_schema', arguments: options });
      expect(result.isError).not.toBe(true);
      expect(db.listTables).toHaveBeenCalledWith(options);
      vi.mocked(db.listTables).mockClear();
      for (const args of [
        { limit: 0 },
        { limit: 201 },
        { limit: 1.5 },
        { prefix: 'x'.repeat(65) },
        { after: 'x'.repeat(65) },
        { table: 'wp_users', limit: 1 },
        { includeStats: 'true' },
      ]) {
        expect((await client.callTool({ name: 'mysql_schema', arguments: args })).isError).toBe(
          true,
        );
      }
      expect(db.listTables).not.toHaveBeenCalled();
    },
  );
});
test('tool failures and invalid scalar parameters are errors', async () => {
  await session(
    {
      env: {},
      resolveConfig: () => {
        throw new Error('fixture config failure');
      },
      listSites: () => {
        throw new Error('sites unavailable');
      },
    },
    async (client) => {
      for (const name of ['mysql_query', 'mysql_current_site', 'mysql_list_sites']) {
        const result = await client.callTool({
          name,
          arguments: name === 'mysql_query' ? { sql: 'SELECT 1' } : {},
        });
        expect(result.isError).toBe(true);
      }
      const bad = await client.callTool({
        name: 'mysql_query',
        arguments: { sql: 'SELECT ?', params: [{}] },
      });
      expect(bad.isError).toBe(true);
    },
  );
});
test('scalar parameters preserve numbers, booleans and null', async () => {
  const db = services();
  await session(
    {
      env: {},
      resolveConfig: () => ({ config: { user: 'fixture', password: 'fixture' } }),
      createClient: () => db,
    },
    async (client) => {
      await client.callTool({
        name: 'mysql_query',
        arguments: { sql: 'SELECT ?,?,?,?', params: ['text', 1, true, null] },
      });
      expect(db.executeReadOnlyQuery).toHaveBeenCalledWith('SELECT ?,?,?,?', [
        'text',
        1,
        true,
        null,
      ]);
      expect((await client.callTool({ name: 'mysql_current_site', arguments: {} })).isError).toBe(
        true,
      );
    },
  );
});
test('explicit connection configuration is authoritative and keeps empty passwords', () => {
  expect(
    resolveDatabaseConfig({
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '3307',
      MYSQL_USER: 'reader',
      MYSQL_PASS: '',
    }).config,
  ).toMatchObject({ host: '127.0.0.1', port: 3307, user: 'reader', password: '' });
});
