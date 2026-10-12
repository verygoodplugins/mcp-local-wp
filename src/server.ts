import { McpServer } from '@modelcontextprotocol/server';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { MySQLClient } from './mysql-client.js';
import { getLocalMySQLConfig, listAvailableSites } from './local-detector.js';
import type { MySQLConnectionConfig, SiteSelectionResult } from './types.js';

export interface ServerOptions {
  env?: NodeJS.ProcessEnv;
  resolveConfig?: () => { config: MySQLConnectionConfig; selection?: SiteSelectionResult };
  listSites?: typeof listAvailableSites;
  createClient?: (config: MySQLConnectionConfig, options: { allowWrites: boolean }) => MySQLClient;
}

const row = z.record(z.string(), z.unknown());
const parameters = z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]));
const sqlInput = z.object({
  sql: z.string().min(1).describe('One SQL statement; executable comments are forbidden.'),
  params: parameters.optional().describe('Values for SQL placeholders (?).'),
});
const siteOutput = z.object({
  siteName: z.string(),
  siteId: z.string(),
  sitePath: z.string(),
  domain: z.string(),
  selectionMethod: z.enum([
    'env_site_id',
    'env_site_name',
    'cwd_detection',
    'process_detection',
    'filesystem_fallback',
  ]),
  socketPath: z.string(),
  port: z.string(),
});
const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function resolveDatabaseConfig(env: NodeJS.ProcessEnv): {
  config: MySQLConnectionConfig;
  selection?: SiteSelectionResult;
} {
  const fallback: MySQLConnectionConfig = {
    host: env.MYSQL_HOST || 'localhost',
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER || 'root',
    password: env.MYSQL_PASS ?? 'root',
    database: env.MYSQL_DB || 'local',
    socketPath: env.MYSQL_SOCKET_PATH || undefined,
    multipleStatements: false,
    timezone: 'Z',
  };
  if (env.MYSQL_HOST || env.MYSQL_SOCKET_PATH) return { config: fallback };
  try {
    const { _siteSelection, ...config } = getLocalMySQLConfig(env.MYSQL_DB);
    return {
      config: { ...config, user: fallback.user, password: fallback.password },
      selection: _siteSelection,
    };
  } catch (error) {
    if (env.SITE_ID || env.SITE_NAME) throw error;
    return { config: fallback };
  }
}

function success(output: Record<string, unknown>) {
  // Normalize driver values once so structured and JSON-text results are identical.
  const json = JSON.stringify(output);
  return {
    content: [{ type: 'text' as const, text: json }],
    structuredContent: JSON.parse(json) as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: error instanceof Error ? error.message : 'Tool request failed.',
      },
    ],
    isError: true as const,
  };
}

export function createServer(options: ServerOptions = {}) {
  const env = options.env ?? process.env;
  const allowWrites = env.MYSQL_ALLOW_WRITES === 'true';
  const version = (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
  const server = new McpServer({ name: 'mcp-local-wp', version });
  let resolved: ReturnType<typeof resolveDatabaseConfig> | undefined;
  let client: MySQLClient | undefined;
  function getConfig() {
    return (resolved ??= (options.resolveConfig ?? (() => resolveDatabaseConfig(env)))());
  }
  function getClient() {
    return (client ??= (
      options.createClient ?? ((config, settings) => new MySQLClient(config, settings))
    )(getConfig().config, { allowWrites }));
  }

  server.registerTool(
    'mysql_query',
    {
      title: 'Query WordPress database',
      description:
        'Execute a single read-only SELECT/SHOW/DESCRIBE/EXPLAIN statement in a database-enforced read-only transaction.',
      inputSchema: sqlInput,
      outputSchema: z.object({ rows: z.array(row) }),
      annotations: readAnnotations,
    },
    async ({ sql, params }) => {
      try {
        return success({ rows: await getClient().executeReadOnlyQuery(sql, params) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'mysql_schema',
    {
      title: 'Inspect WordPress schema',
      description: 'List tables, or inspect columns and indexes for one table.',
      inputSchema: z.object({
        table: z
          .string()
          .regex(/^[A-Za-z0-9_]+$/)
          .optional(),
      }),
      outputSchema: z.union([
        z.object({ tables: z.array(row) }),
        z.object({ table: z.string(), columns: z.array(row), indexes: z.array(row) }),
      ]),
      annotations: readAnnotations,
    },
    async ({ table }) => {
      try {
        if (!table) return success({ tables: await getClient().listTables() });
        const [columns, indexes] = await Promise.all([
          getClient().getTableColumns(table),
          getClient().getTableIndexes(table),
        ]);
        return success({ table, columns, indexes });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'mysql_current_site',
    {
      title: 'Current Local site',
      description: 'Show the selected Local WordPress site without connecting to MySQL.',
      inputSchema: z.object({}),
      outputSchema: siteOutput,
      annotations: readAnnotations,
    },
    async () => {
      try {
        const site = getConfig().selection;
        if (!site)
          throw new Error(
            'No Local site selection information is available; using explicit or fallback database configuration.',
          );
        return success({
          siteName: site.siteName,
          siteId: site.siteInfo.siteId,
          sitePath: site.sitePath,
          domain: site.domain,
          selectionMethod: site.selectionMethod,
          socketPath: site.siteInfo.socketPath,
          port: site.siteInfo.port,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'mysql_list_sites',
    {
      title: 'List Local sites',
      description:
        'List available Local sites and their running status without connecting to MySQL.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        sites: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            path: z.string(),
            domain: z.string(),
            running: z.boolean(),
          }),
        ),
        currentSiteId: z.string().nullable(),
      }),
      annotations: readAnnotations,
    },
    async () => {
      try {
        return success({
          sites: (options.listSites ?? listAvailableSites)(),
          currentSiteId: getConfig().selection?.siteInfo.siteId ?? null,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  if (allowWrites)
    server.registerTool(
      'mysql_write',
      {
        title: 'Write WordPress data',
        description:
          'Execute INSERT/UPDATE/DELETE. UPDATE and DELETE require a parameterized WHERE predicate. Enabled only by MYSQL_ALLOW_WRITES=true.',
        inputSchema: sqlInput,
        outputSchema: z.object({
          affectedRows: z.number(),
          insertId: z.number().optional(),
          changedRows: z.number().optional(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ sql, params }) => {
        try {
          return success({ ...(await getClient().executeWriteQuery(sql, params)) });
        } catch (error) {
          return failure(error);
        }
      },
    );

  return {
    server,
    disconnect: async () => {
      await client?.disconnect();
    },
  };
}
