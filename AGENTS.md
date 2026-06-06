# AGENTS.md

This file provides guidance to coding agents (Claude Code, Cursor, Codex, and others) when working with code in this repository.

## Commands

### Build & Development
- **Build TypeScript**: `npm run build` - Compiles TypeScript to JavaScript in `dist/` (also runs `postbuild` to `chmod +x dist/index.js`)
- **Development mode**: `npm run dev` - Runs with tsx watch for hot reload
- **Start compiled**: `npm start` or `node dist/index.js` - Run the compiled server
- **Smoke test**: `npm test` - Prints a build-ok message (no real test suite yet)

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
   - Sets up StdioServerTransport for agent communication
   - Registers the MCP tools and routes `CallToolRequest`s
   - Auto-detects Local by Flywheel or falls back to environment variables
   - Reads `MYSQL_ALLOW_WRITES` at startup to decide whether to expose the write tool (`src/index.ts:18`)

2. **`src/local-detector.ts`** - Local by Flywheel auto-detection and site selection
   - `selectSite()` implements the 5-level priority order (`src/local-detector.ts:315`)
   - Loads/parses Local's `sites.json` for site metadata (name, path, domain, port)
   - Scans running processes for mysqld with Local paths; filesystem fallback by socket mtime
   - `listAvailableSites()` enumerates configured sites and running status (`src/local-detector.ts:413`)

3. **`src/mysql-client.ts`** - MySQL connection management
   - Wraps mysql2/promise for async operations
   - `executeReadOnlyQuery()` validates read-only statements (`src/mysql-client.ts:46`)
   - `executeWriteQuery()` validates gated write statements (`src/mysql-client.ts:76`)
   - Blocks multi-statement queries for security
   - Supports parameter binding with `?` placeholders

4. **`src/types.ts`** - TypeScript interfaces
   - `LocalSiteInfo`: socket path, port, site ID, config path
   - `MySQLConnectionConfig`: connection parameters
   - `WriteResult`: affectedRows, optional insertId/changedRows
   - `LocalSiteEntry` / `LocalSitesConfig` / `SiteSelectionResult`: site metadata + selection context

### MCP Tools

The server registers **4 tools by default**. A **5th tool, `mysql_write`, is registered only when `MYSQL_ALLOW_WRITES=true`** (`src/index.ts:134`).

**mysql_query**:
- Executes read-only SQL queries
- Parameters: `sql` (string), optional `params` (array)
- Enforces single statement, read-only operations (SELECT/SHOW/DESCRIBE/DESC/EXPLAIN)

**mysql_schema**:
- Inspects database structure via INFORMATION_SCHEMA
- No params: lists all tables with engine/row counts/sizes
- With `table` param: shows columns and indexes

**mysql_current_site**:
- Returns the currently connected Local site (name, ID, path, domain, socket, port) and the `selectionMethod` used

**mysql_list_sites**:
- Lists all configured Local sites and whether each is running

**mysql_write** (only when `MYSQL_ALLOW_WRITES=true`):
- Executes INSERT/UPDATE/DELETE; schema operations (CREATE/DROP/ALTER/TRUNCATE) are blocked
- UPDATE and DELETE require a non-empty `params` array (at least one bound parameter); the guard does not verify that a WHERE clause is present
- Subqueries (SELECT) are rejected inside write statements

### Security Model

- **Read path**: regex validates the first token is one of SELECT/SHOW/DESCRIBE/DESC/EXPLAIN (`src/mysql-client.ts:46`)
- **Gated write path**: writes are off unless `MYSQL_ALLOW_WRITES=true`. When enabled, only INSERT/UPDATE/DELETE are allowed; UPDATE/DELETE require a non-empty `params` array (at least one bound parameter; a WHERE clause is not verified); subqueries are blocked (`src/mysql-client.ts:76`)
- **Single statement only**: more than one non-empty statement (split on `;`) is rejected
- **Parameter binding**: uses mysql2's parameterized queries to prevent injection
- **Local-only design**: prioritizes Unix socket connections
- **Identifier safety**: table names used in schema introspection are restricted to `[A-Za-z0-9_]`

## Local by Flywheel Integration

The server solves Local's dynamic path problem where site IDs (like `lx97vbzE7`) change on restart.

### Site selection priority (`selectSite()`)

1. `SITE_ID` env var — direct site ID lookup in `sites.json`
2. `SITE_NAME` env var — case-insensitive site-name lookup
3. CWD detection — current working directory matched against a site's path
4. Process detection — running mysqld with a Local `--defaults-file` argument
5. Filesystem fallback — newest running socket under Local's run directory

If none of the above resolve, the server falls back to plain environment variables.

Typical Local paths:
- Config: `~/Library/Application Support/Local/run/{siteId}/conf/mysql/my.cnf`
- Socket: `~/Library/Application Support/Local/run/{siteId}/mysql/mysqld.sock`
- Sites metadata: `~/Library/Application Support/Local/sites.json`
- Database name: `local`
- Credentials: `root`/`root`

## Environment Variables

### Connection fallback (used when Local isn't detected or for custom setups)
- `MYSQL_HOST` - Default: localhost
- `MYSQL_PORT` - Default: 3306
- `MYSQL_USER` - Default: root
- `MYSQL_PASS` - Default: root
- `MYSQL_DB` - Default: local
- `MYSQL_SOCKET_PATH` - Unix socket path (optional)

### Behavior
- `MYSQL_ALLOW_WRITES` - Set to `true` to expose the `mysql_write` tool (default: writes disabled)
- `DEBUG` - Include `mcp-local-wp` to enable debug logging

### Site selection / Local paths
- `SITE_ID` - Explicit Local site ID (highest priority)
- `SITE_NAME` - Local site name for lookup
- `LOCAL_RUN_DIR` - Override Local's run directory
- `LOCAL_SITES_JSON` - Override path to Local's `sites.json`

On Windows, default Local paths resolve via `%LOCALAPPDATA%` / `%APPDATA%`.

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
