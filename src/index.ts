#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from 'dotenv';
import { MySQLClient } from './mysql-client.js';
import { getLocalMySQLConfig } from './local-detector.js';

// Load environment variables
config();

function debugLog(...args: any[]) {
  if (process.env.DEBUG && process.env.DEBUG.includes('mcp-local-wp')) {
    // eslint-disable-next-line no-console
    console.error('[mcp-local-wp]', ...args);
  }
}

// Get MySQL configuration (will auto-detect Local by Flywheel)
let mysqlConfig;
try {
  mysqlConfig = getLocalMySQLConfig(process.env.MYSQL_DB);
} catch (error: any) {
  console.error('Failed to detect Local by Flywheel configuration:', error.message);
  console.error('Falling back to environment variables...');
  
  // Fallback to environment variables
  mysqlConfig = {
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASS || 'root',
    database: process.env.MYSQL_DB || 'local',
    socketPath: process.env.MYSQL_SOCKET_PATH,
    multipleStatements: false,
    timezone: 'Z',
  };
}

// Initialize MySQL client
const mysql = new MySQLClient(mysqlConfig);

// Create MCP server
const server = new Server(
  {
    name: 'mcp-local-wp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tool schemas - keeping it simple with just mysql_query like the original
const tools: Tool[] = [
  {
    name: 'mysql_query',
    description: 'Execute a read-only SQL query against the Local WordPress database',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'Single read-only SQL statement (SELECT/SHOW/DESCRIBE/EXPLAIN).',
        },
        params: {
          type: 'array',
          description: 'Optional parameter values for placeholders (?).',
          items: { type: 'string' },
        },
      },
      required: ['sql'],
    },
  },
  {
    name: 'mysql_schema',
    description: 'Inspect database schema. Without args: lists tables. With table: shows columns and indexes.',
    inputSchema: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          description: 'Optional table name to inspect',
        },
      },
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools,
  };
});


// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params || {};
  if (!args) {
    throw new Error('Arguments are missing');
  }

  try {
    await mysql.connect();

    switch (name) {
      case 'mysql_query': {
        const sql = String(args.sql);
        const params = Array.isArray(args.params) ? args.params : undefined;
        debugLog('Executing mysql_query');
        const result = await mysql.executeReadOnlyQuery(sql, params);
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) },
          ],
        };
      }
      case 'mysql_schema': {
        const table = args.table as string | undefined;
        if (!table) {
          const tables = await mysql.listTables();
          return { content: [{ type: 'text', text: JSON.stringify(tables, null, 2) }] };
        }
        const [columns, indexes] = await Promise.all([
          mysql.getTableColumns(table),
          mysql.getTableIndexes(table),
        ]);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ table, columns, indexes }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('WordPress Local MCP Server running...');
}

// Cleanup on exit
process.on('SIGINT', async () => {
  await mysql.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await mysql.disconnect();
  process.exit(0);
});

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
