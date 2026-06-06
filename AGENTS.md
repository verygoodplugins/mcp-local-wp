# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Build & Development
- **Build TypeScript**: `npm run build` - Compiles TypeScript to JavaScript in `dist/`
- **Development mode**: `npm run dev` - Runs with tsx watch for hot reload
- **Start compiled**: `npm start` or `node dist/index.js` - Run the compiled server

### Code Quality
- **Lint**: `npm run lint` - Check ESLint issues
- **Fix lint**: `npm run lint:fix` - Auto-fix ESLint issues
- **Format**: `npm run format` - Format with Prettier
- **Check format**: `npm run format:check` - Verify Prettier formatting

### Testing & Debugging
- **Enable debug logs**: Set `DEBUG=mcp-local-wp` environment variable
- **Test connection**: After building, run `node dist/index.js` to verify MySQL connection

## Architecture

### Core Components

1. **`src/index.ts`** - MCP server entry point
   - Sets up StdioServerTransport for Claude/Cursor communication
   - Implements two tools: `mysql_query` and `mysql_schema`
   - Auto-detects Local by Flywheel or falls back to environment variables

2. **`src/local-detector.ts`** - Local by Flywheel auto-detection
   - Scans running processes for mysqld with Local paths
   - Extracts socket path from process arguments
   - Parses my.cnf for port configuration
   - Returns LocalSiteInfo with connection details

3. **`src/mysql-client.ts`** - MySQL connection management
   - Wraps mysql2/promise for async operations
   - Validates queries are read-only (SELECT/SHOW/DESCRIBE/EXPLAIN)
   - Blocks multi-statement queries for security
   - Supports parameter binding with `?` placeholders

4. **`src/types.ts`** - TypeScript interfaces
   - LocalSiteInfo: socket path, port, site ID, config path
   - MySQLConnectionConfig: connection parameters

### MCP Tools

**mysql_query**:
- Executes read-only SQL queries
- Parameters: `sql` (string), optional `params` (array)
- Enforces single statement, read-only operations

**mysql_schema**:
- Inspects database structure via INFORMATION_SCHEMA
- No params: lists all tables with row counts
- With `table` param: shows columns and indexes

### Security Model

- **Read-only enforcement**: Regex validates queries start with SELECT/SHOW/DESCRIBE/EXPLAIN
- **Single statement only**: Semicolons blocked except at end
- **Parameter binding**: Uses mysql2's parameterized queries to prevent injection
- **Local-only design**: Prioritizes Unix socket connections

## Local by Flywheel Integration

The server solves Local's dynamic path problem where site IDs (like `lx97vbzE7`) change on restart:

1. Process detection finds running mysqld with `--defaults-file` argument
2. Extracts site directory from config path (e.g., `/Users/.../Local/run/lx97vbzE7/`)
3. Constructs socket path: `{siteDir}/mysql/mysqld.sock`
4. Falls back to environment variables if Local isn't detected

Typical Local paths:
- Config: `~/Library/Application Support/Local/run/{siteId}/conf/mysql/my.cnf`
- Socket: `~/Library/Application Support/Local/run/{siteId}/mysql/mysqld.sock`
- Database name: `local`
- Credentials: `root`/`root`

## Environment Variables (Fallback)

When Local isn't detected or for custom setups:
- `MYSQL_HOST` - Default: localhost
- `MYSQL_PORT` - Default: 3306
- `MYSQL_USER` - Default: root
- `MYSQL_PASS` - Default: root
- `MYSQL_DB` - Default: local
- `MYSQL_SOCKET_PATH` - Unix socket path (optional)

## Development Workflow

1. Ensure Local by Flywheel is running with an active site
2. Make changes to TypeScript source files
3. Run `npm run dev` for development with hot reload
4. For production: `npm run build` then test with `npm start`
5. Use `npm run lint:fix` and `npm run format` before committing

## WordPress Database Patterns

Common WordPress tables and their purposes:
- `wp_posts` - Posts, pages, attachments, custom post types
- `wp_postmeta` - Custom fields and post metadata
- `wp_options` - Site settings and plugin options
- `wp_users` - User accounts
- `wp_usermeta` - User metadata and capabilities
- `wp_terms`, `wp_term_taxonomy`, `wp_term_relationships` - Taxonomies (categories, tags)
- `wp_comments`, `wp_commentmeta` - Comments and metadata

Note: Table prefix may vary (default is `wp_` but could be custom).