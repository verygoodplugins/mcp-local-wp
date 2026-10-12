# Changelog

## [2.0.0](https://github.com/verygoodplugins/mcp-local-wp/compare/v1.1.0...v2.0.0) (2026-10-12)


### ⚠ BREAKING CHANGES

* **mcp:** adopt SDK v2 and require Node 24 ([#20](https://github.com/verygoodplugins/mcp-local-wp/issues/20))

### Security

- Fixed the read-only authorization bypass reported by **kta1kri**. Executable MySQL/MariaDB comments could perform writes through mysql_query; the original bypass was reproduced on MySQL 8.0.46 and MariaDB 11.8.9.
- Added SQL-mode-aware single-statement validation and dedicated database-enforced read-only transactions. Reject executable comments, file output, locking reads, advisory locks and EXPLAIN ANALYZE. Opt-in writes use a separate connection and require bound column predicates for UPDATE/DELETE.
- Added blocking security regression tests for both database engines and private vulnerability reporting. SELECT-only credentials remain recommended as additional protection.

### Dependency maintenance

- Updated dotenv to 18.0.7 and upgraded Vitest plus its coverage provider together to 5.0.3. Added .env precedence and clean stdio startup regression tests.
- Updated setup-node to 7.1.0 and pinned release-please v5 to its commit. Shared configuration comes from merged mcp-ecosystem main.
- Grouped future Vitest runner/coverage upgrades, including majors, while retaining manual review for major updates. Kept Node 24 declarations and TypeScript 6; unsupported proposed majors were closed.

### Migration notes

- Requires **Node.js 24+**, MCP SDK v2 and Zod 4.
- mysql_query returns `{rows}` and schema listing returns `{tables}`. Success includes matching structured and JSON-text objects; expected failures set `isError: true`.
- Clients must keep stdin open until responses arrive. Shutdown awaits transport/database cleanup; the parent watchdog handles orphaned wrappers.
- Tool names and SITE_ID/SITE_NAME selectors remain available. Explicit database credentials apply to Local auto-detection as well as manual connections.

### Features

* **mcp:** adopt SDK v2 and require Node 24 ([#20](https://github.com/verygoodplugins/mcp-local-wp/issues/20)) ([0fd8e9f](https://github.com/verygoodplugins/mcp-local-wp/commit/0fd8e9fae76c84cfe434aa3e6f2e52c355e4082e))


### Bug Fixes

* **sql:** enforce read-only transactions and tokenize queries ([#19](https://github.com/verygoodplugins/mcp-local-wp/issues/19)) ([bf8462d](https://github.com/verygoodplugins/mcp-local-wp/commit/bf8462debbd12ff164232cff0c685bd113c2ffbe))

## [1.1.0](https://github.com/verygoodplugins/mcp-local-wp/compare/v1.0.1...v1.1.0) (2026-01-04)


### ⚠ BREAKING CHANGES

* Requires ESLint 9+ for linting

### Features

* add CI/CD, MCP Registry, and standardization ([3b12ee8](https://github.com/verygoodplugins/mcp-local-wp/commit/3b12ee8972f855073326abe01ee317987c13f604))
* upgrade to ESLint 9 flat config and update all dependencies ([9a2edf9](https://github.com/verygoodplugins/mcp-local-wp/commit/9a2edf9d25cfd2e37f741136fd3a725e7360b1e6))


### Miscellaneous Chores

* override release version ([7049bdf](https://github.com/verygoodplugins/mcp-local-wp/commit/7049bdfe734595c22bf24a4149bf5f937d44af2a))

## 1.1.0 - 2026-01-04

### Site Context Detection
When multiple Local sites are running, the server now reliably connects to the correct database using priority-based site selection:

1. **SITE_ID env var** - Explicit site ID (e.g., `lx97vbzE7`)
2. **SITE_NAME env var** - Human-readable site name (e.g., `dev`)
3. **Working directory detection** - Auto-detects if cwd is within a Local site path
4. **Process detection** - Existing behavior (fallback)
5. **Filesystem fallback** - Most recently modified socket (last resort)

### New Tools
- **mysql_current_site** - Returns which site is connected and how it was selected
- **mysql_list_sites** - Lists all available Local sites with their running status

### New Environment Variables
- `SITE_ID` - Specify site by ID for explicit selection
- `SITE_NAME` - Specify site by human-readable name
- `LOCAL_SITES_JSON` - Override path to Local's sites.json

### Improvements
- Startup logging now shows which site was selected and the selection method
- Better error messages when specified site is not found or not running
- Sites.json parsing for site name/path/domain metadata

### Dependencies & Tooling
- Migrated from ESLint 8 to ESLint 9 flat config
- Updated MCP SDK to 1.25.1 (from 0.5.0)
- Updated TypeScript to 5.9.3
- Updated dotenv to 17.2.3
- Updated @typescript-eslint/* to 8.50.1
- Fixed npm audit vulnerability (qs package)

## 1.0.1 - 2025-11-20
- Added filesystem fallback for Local MySQL detection when `ps`/process scan is blocked
- Added platform-aware Local run directory resolution (uses `LOCAL_RUN_DIR` or OS defaults)
- Improved error messaging that combines process-scan and filesystem-scan failures

## 1.0.0 - 2024-12-15
- Initial release
