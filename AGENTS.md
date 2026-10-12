# Coding agent guide

This repository implements a local WordPress database MCP server. Node.js 24+ is required; stdout belongs exclusively to the MCP protocol.

## Commands

- `npm ci --ignore-scripts`: install the locked dependencies.
- `npm run build`: compile TypeScript and make the CLI executable.
- `npm run lint`, `npm test`, `npm run test:coverage`: lint and run the Vitest suite. Coverage must remain at least 50% in all configured metrics.
- `DB_TEST_PORT=<fixture-port> npm run test:integration`: verify the compiled server against a disposable MySQL 8.0 or MariaDB 11.8 database named `localwp_test`, with the test fixture credentials. Never run this suite against real site data.
- `npm run format:check`: check source and test formatting.

## Architecture and contracts

`src/index.ts` serves stdio through MCP SDK v2. `src/server.ts` registers five tools, with `mysql_write` present only when MYSQL_ALLOW_WRITES=true. Tool discovery never detects sites or connects to the database. All tools declare output schemas and accurate safety annotations. Success returns identical structured and JSON-text objects; expected failures use isError=true.

`src/mysql-client.ts` owns isolated read and write connections. Reads serialize read-only transaction startup, execution and rollback; setup fails closed and failed cleanup destroys the connection. Never expose a raw SQL execution path to tool handlers or disable read protection for write-enabled sessions.

`src/sql-policy.ts` tokenizes SQL with session SQL-mode awareness, rejecting executable comments and side-effectful read forms. UPDATE/DELETE require bound column predicates in a top-level WHERE. Add security regression cases when changing this boundary.

`src/local-detector.ts` preserves SITE_ID, SITE_NAME, CWD, process and filesystem selection. LOCAL_RUN_DIR and LOCAL_SITES_JSON support explicit fixture paths. Explicit MYSQL_HOST/MYSQL_SOCKET_PATH takes precedence over auto-detection; credentials apply in both modes. Invalid explicit site selectors must fail instead of silently selecting another site.

`src/lifecycle.ts` awaits bounded, idempotent transport/database cleanup on EOF, signals and original-parent death. Capture the parent PID before asynchronous work. EOF follows SDK v2 semantics; clients must keep stdin open until responses arrive.

## Delivery

Preserve GPL-3.0-or-later. Keep registry authentication files ignored and outside packages. Create regular PRs, use conventional titles, and use release-please for versions/tags. Shared workflows/configuration come from merged mcp-ecosystem main; change the source of truth first rather than introducing permanent downstream drift.

The organization requires CI context `test`. The active repository ruleset `Database security checks` also requires `Database Security (mysql:8.0)` and `Database Security (mariadb:11.8)`. All three checks must pass before merging implementation or release PRs; do not remove or bypass these gates.

Creating release tags, publishing packages, or merging a release-please PR requires explicit user approval for that release. Prepare and verify the release PR first, then leave it unmerged for review. Ordinary implementation PRs may be merged within the approved task scope.
