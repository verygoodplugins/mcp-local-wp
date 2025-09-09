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
    multipleStatements: true,
    timezone: 'Z'
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
    description: 'Execute SQL queries against the Local by Flywheel WordPress database',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL query to execute (SELECT statements only for safety)',
        },
      },
      required: ['sql'],
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
        const sql = args.sql as string;
        
        // Execute the query using our read-only query method for safety
        const result = await mysql.executeReadOnlyQuery(sql);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
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
