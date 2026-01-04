# Changelog

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
