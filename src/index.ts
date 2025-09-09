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
import type { WordPressPost, WordPressUser, WordPressOption } from './types.js';

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

// Define tool schemas
const tools: Tool[] = [
  {
    name: 'wp_get_posts',
    description: 'Get WordPress posts with optional filtering and pagination',
    inputSchema: {
      type: 'object',
      properties: {
        post_type: {
          type: 'string',
          description: 'Post type (default: post)',
          default: 'post',
        },
        post_status: {
          type: 'string',
          description: 'Post status (publish, draft, private, etc.)',
          default: 'publish',
        },
        limit: {
          type: 'number',
          description: 'Number of posts to retrieve (default: 10)',
          default: 10,
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination (default: 0)',
          default: 0,
        },
        search: {
          type: 'string',
          description: 'Search in post title and content',
        },
        author_id: {
          type: 'number',
          description: 'Filter by author ID',
        },
      },
    },
  },
  {
    name: 'wp_get_post',
    description: 'Get a specific WordPress post by ID',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: {
          type: 'number',
          description: 'Post ID',
        },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'wp_get_users',
    description: 'Get WordPress users with optional filtering',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of users to retrieve (default: 10)',
          default: 10,
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination (default: 0)',
          default: 0,
        },
        search: {
          type: 'string',
          description: 'Search in user login, email, or display name',
        },
        role: {
          type: 'string',
          description: 'Filter by user role',
        },
      },
    },
  },
  {
    name: 'wp_get_user',
    description: 'Get a specific WordPress user by ID',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'number',
          description: 'User ID',
        },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'wp_get_options',
    description: 'Get WordPress options (settings)',
    inputSchema: {
      type: 'object',
      properties: {
        option_name: {
          type: 'string',
          description: 'Specific option name to retrieve',
        },
        search: {
          type: 'string',
          description: 'Search in option names',
        },
        limit: {
          type: 'number',
          description: 'Number of options to retrieve (default: 20)',
          default: 20,
        },
      },
    },
  },
  {
    name: 'wp_get_plugins',
    description: 'Get information about installed WordPress plugins',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: {
          type: 'boolean',
          description: 'Show only active plugins (default: false)',
          default: false,
        },
      },
    },
  },
  {
    name: 'wp_get_theme_info',
    description: 'Get information about the active WordPress theme',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wp_execute_query',
    description: 'Execute a custom read-only SQL query on the WordPress database',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'SQL query to execute (SELECT only)',
        },
        params: {
          type: 'array',
          description: 'Query parameters for prepared statements',
          items: {
            type: 'string',
          },
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'wp_get_database_info',
    description: 'Get information about the WordPress database structure',
    inputSchema: {
      type: 'object',
      properties: {
        table_name: {
          type: 'string',
          description: 'Get details for a specific table',
        },
      },
    },
  },
  {
    name: 'wp_get_post_meta',
    description: 'Get post meta data for a specific post',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: {
          type: 'number',
          description: 'Post ID',
        },
        meta_key: {
          type: 'string',
          description: 'Specific meta key to retrieve',
        },
      },
      required: ['post_id'],
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools,
  };
});

// Helper function to get table prefix
async function getTablePrefix(): Promise<string> {
  try {
    return await mysql.getTablePrefix();
  } catch {
    return 'wp_';
  }
}

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params || {};
  if (!args) {
    throw new Error('Arguments are missing');
  }

  try {
    await mysql.connect();
    const tablePrefix = await getTablePrefix();

    switch (name) {
      case 'wp_get_posts': {
        const postType = (args.post_type as string) || 'post';
        const postStatus = (args.post_status as string) || 'publish';
        const limit = (args.limit as number) || 10;
        const offset = (args.offset as number) || 0;
        const search = args.search as string;
        const authorId = args.author_id as number;

        let sql = `
          SELECT * FROM ${tablePrefix}posts 
          WHERE post_type = ? AND post_status = ?
        `;
        const params = [postType, postStatus];

        if (search) {
          sql += ` AND (post_title LIKE ? OR post_content LIKE ?)`;
          params.push(`%${search}%`, `%${search}%`);
        }

        if (authorId) {
          sql += ` AND post_author = ?`;
          params.push(authorId.toString());
        }

        sql += ` ORDER BY post_date DESC LIMIT ? OFFSET ?`;
        params.push(limit.toString(), offset.toString());

        const posts = await mysql.executeReadOnlyQuery(sql, params);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(posts, null, 2),
            },
          ],
        };
      }

      case 'wp_get_post': {
        const postId = args.post_id as number;
        const sql = `SELECT * FROM ${tablePrefix}posts WHERE ID = ?`;
        const posts = await mysql.executeReadOnlyQuery(sql, [postId.toString()]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(posts[0] || null, null, 2),
            },
          ],
        };
      }

      case 'wp_get_users': {
        const limit = (args.limit as number) || 10;
        const offset = (args.offset as number) || 0;
        const search = args.search as string;
        const role = args.role as string;

        let sql = `SELECT * FROM ${tablePrefix}users`;
        const params: string[] = [];
        const conditions: string[] = [];

        if (search) {
          conditions.push(`(user_login LIKE ? OR user_email LIKE ? OR display_name LIKE ?)`);
          params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        if (role) {
          sql = `
            SELECT u.* FROM ${tablePrefix}users u
            JOIN ${tablePrefix}usermeta um ON u.ID = um.user_id
            WHERE um.meta_key = '${tablePrefix}capabilities'
            AND um.meta_value LIKE ?
          `;
          params.push(`%${role}%`);
        }

        if (conditions.length > 0 && !role) {
          sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        sql += ` ORDER BY user_registered DESC LIMIT ? OFFSET ?`;
        params.push(limit.toString(), offset.toString());

        const users = await mysql.executeReadOnlyQuery(sql, params);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(users, null, 2),
            },
          ],
        };
      }

      case 'wp_get_user': {
        const userId = args.user_id as number;
        const sql = `SELECT * FROM ${tablePrefix}users WHERE ID = ?`;
        const users = await mysql.executeReadOnlyQuery(sql, [userId.toString()]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(users[0] || null, null, 2),
            },
          ],
        };
      }

      case 'wp_get_options': {
        const optionName = args.option_name as string;
        const search = args.search as string;
        const limit = (args.limit as number) || 20;

        let sql = `SELECT * FROM ${tablePrefix}options`;
        const params: string[] = [];
        const conditions: string[] = [];

        if (optionName) {
          conditions.push(`option_name = ?`);
          params.push(optionName);
        }

        if (search) {
          conditions.push(`option_name LIKE ?`);
          params.push(`%${search}%`);
        }

        if (conditions.length > 0) {
          sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        sql += ` ORDER BY option_name LIMIT ?`;
        params.push(limit.toString());

        const options = await mysql.executeReadOnlyQuery(sql, params);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(options, null, 2),
            },
          ],
        };
      }

      case 'wp_get_plugins': {
        const activeOnly = (args.active_only as boolean) || false;
        
        let sql = `SELECT option_value FROM ${tablePrefix}options WHERE option_name = 'active_plugins'`;
        const activePlugins = await mysql.executeReadOnlyQuery(sql);
        
        let allPluginsData: any = {};
        try {
          const allPluginsSql = `SELECT option_value FROM ${tablePrefix}options WHERE option_name = 'all_plugins'`;
          const allPluginsResult = await mysql.executeReadOnlyQuery(allPluginsSql);
          if (allPluginsResult.length > 0) {
            allPluginsData = JSON.parse(allPluginsResult[0].option_value || '{}');
          }
        } catch {
          // Fallback if all_plugins option doesn't exist
        }

        const result = {
          active_plugins: activePlugins.length > 0 ? JSON.parse(activePlugins[0].option_value || '[]') : [],
          all_plugins: allPluginsData,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'wp_get_theme_info': {
        const sql = `
          SELECT option_name, option_value 
          FROM ${tablePrefix}options 
          WHERE option_name IN ('stylesheet', 'template', 'current_theme')
        `;
        const themeOptions = await mysql.executeReadOnlyQuery(sql);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(themeOptions, null, 2),
            },
          ],
        };
      }

      case 'wp_get_post_meta': {
        const postId = args.post_id as number;
        const metaKey = args.meta_key as string;

        let sql = `SELECT * FROM ${tablePrefix}postmeta WHERE post_id = ?`;
        const params = [postId.toString()];

        if (metaKey) {
          sql += ` AND meta_key = ?`;
          params.push(metaKey);
        }

        sql += ` ORDER BY meta_key`;

        const postMeta = await mysql.executeReadOnlyQuery(sql, params);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(postMeta, null, 2),
            },
          ],
        };
      }

      case 'wp_execute_query': {
        const query = args.query as string;
        const params = (args.params as string[]) || [];

        const result = await mysql.executeReadOnlyQuery(query, params);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'wp_get_database_info': {
        const tableName = args.table_name as string;

        if (tableName) {
          const columns = await mysql.getTableColumns(tableName);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ table: tableName, columns }, null, 2),
              },
            ],
          };
        } else {
          const tables = await mysql.getWordPressTables();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ wordpress_tables: tables }, null, 2),
              },
            ],
          };
        }
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
