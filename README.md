# MCP Server Local WP

A simplified Model Context Protocol (MCP) server that provides MySQL database access specifically designed for Local by Flywheel WordPress development environments. This server solves the "difficult to get working" problem of connecting MCP servers to Local's dynamic MySQL configurations.

## The Problem We Solved

When using the original [mcp-server-mysql](https://github.com/benborla/mcp-server-mysql) with Local by Flywheel, developers face several challenges:

1. **Dynamic Paths**: Local by Flywheel generates unique identifiers for each site (like `lx97vbzE7`) that change when sites are restarted
2. **Socket vs Port Confusion**: Local uses both Unix sockets and TCP ports, but the configuration can be tricky
3. **Hardcoded Configurations**: Most setups require manual path updates every time Local restarts

Before:
![Very Good Plugins  Cursor+Diagnose LearnDash quiz field syncing issue — wp-fusion (Workspace)  2025-09-09 at 12 34 38](https://github.com/user-attachments/assets/65da669d-8515-49ed-942c-0dd43aa29bae)

```php
$quiz_activities = $wpdb->get_results( 
  $wpdb->prepare( 
    'SELECT post_id, activity_meta FROM ' . esc_sql( LDLMS_DB::get_table_name( 'user_activity' ) ) . ' 
     WHERE user_id=%d AND activity_type=%s AND activity_status=1 AND activity_completed IS NOT NULL',
    $user_id, 
    'quiz' 
  ), 
  ARRAY_A 
);
```
👎

After:
![Very Good Plugins  Cursor+Diagnose LearnDash quiz field syncing issue — wp-fusion (Workspace)  2025-09-09 at 12 54 07](https://github.com/user-attachments/assets/d266d9a4-a098-4ce5-9564-0db5f8e160bd)

```php
$quiz_activities = $wpdb->get_results(
  $wpdb->prepare(
    'SELECT ua.post_id, ua.activity_id, uam.activity_meta_key, uam.activity_meta_value 
     FROM ' . esc_sql( LDLMS_DB::get_table_name( 'user_activity' ) ) . ' ua
     LEFT JOIN ' . esc_sql( LDLMS_DB::get_table_name( 'user_activity_meta' ) ) . ' uam 
     ON ua.activity_id = uam.activity_id 
     WHERE ua.user_id=%d AND ua.activity_type=%s AND ua.activity_completed IS NOT NULL
     AND uam.activity_meta_key IN (%s, %s, %s)',
    $user_id,
    'quiz',
    'percentage',
    'points',
    'total_points'
  ),
  ARRAY_A
);
```
## Our Solution

This MCP server **automatically detects** your active Local by Flywheel MySQL instance by:

1. **Process Detection**: Scans running processes to find active `mysqld` instances
2. **Config Parsing**: Extracts MySQL configuration from the active Local site
3. **Dynamic Connection**: Connects using the correct socket path or port automatically
4. **Fallback Support**: Falls back to environment variables for non-Local setups

## Tools Available

### mysql_query
Execute read-only SQL against your Local WordPress database.

Input fields:
- `sql` (string): Single read-only statement (SELECT/SHOW/DESCRIBE/EXPLAIN)
- `params` (string[]): Optional parameter values for `?` placeholders

**Example Usage:**
```sql
-- With parameters
SELECT * FROM wp_posts WHERE post_status = ? ORDER BY post_date DESC LIMIT ?;
-- params: ["publish", "5"]

-- Direct queries
SELECT option_name, option_value FROM wp_options WHERE option_name LIKE '%theme%';
SHOW TABLES;
DESCRIBE wp_users;
```

### mysql_schema
Inspect database schema using INFORMATION_SCHEMA.

- No args: lists tables with basic stats
- With `table`: returns columns and indexes for that table

Examples:

```jsonc
// List all tables
{
  "tool": "mysql_schema",
  "args": {}
}

// Inspect a specific table
{
  "tool": "mysql_schema",
  "args": { "table": "wp_posts" }
}
```

## Installation

### Prerequisites

- [Local by Flywheel](https://localwp.com/) installed and running
- An active Local site running
- Node.js 18+ (for local development only)

## Quick Setup (Recommended)

The easiest way to get started - no installation required:

### Cursor IDE Configuration

Add this to your Cursor MCP configuration file (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mcp-local-wp": {
      "command": "npx",
      "args": [
        "-y",
        "@verygoodplugins/mcp-local-wp@latest"
      ]
    }
  }
}
```

### Claude Desktop Configuration

Add this to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\\Claude\\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-local-wp": {
      "command": "npx",
      "args": [
        "-y",
        "@verygoodplugins/mcp-local-wp@latest"
      ]
    }
  }
}
```

## Advanced Setup (Local Development)

For customization or local development:

### Install from Source

```bash
git clone https://github.com/verygoodplugins/mcp-local-wp.git
cd mcp-local-wp
npm install
npm run build
```

### Local Configuration

```json
{
  "mcpServers": {
    "mcp-local-wp": {
      "command": "node",
      "args": [
        "/full/path/to/mcp-local-wp/dist/index.js"
      ]
    }
  }
}
```

### Custom Environment Variables

For non-Local setups or custom configurations:

```json
{
  "mcpServers": {
    "mcp-local-wp": {
      "command": "npx",
      "args": [
        "-y",
        "@verygoodplugins/mcp-local-wp@latest"
      ],
      "env": {
        "MYSQL_DB": "local",
        "MYSQL_HOST": "localhost",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "root",
        "MYSQL_PASS": "root"
      }
    }
  }
}
```

## How It Works with Local by Flywheel

This MCP server was created because connecting to Local by Flywheel MySQL was **"kind of difficult to get working"** with existing MCP servers. Here's the story of what we solved:

### The Original Problem

When we first tried to use [mcp-server-mysql](https://github.com/benborla/mcp-server-mysql) with Local by Flywheel, we encountered several issues:

1. **Dynamic Socket Paths**: Local generates paths like `/Users/.../Local/run/lx97vbzE7/mysql/mysqld.sock` where `lx97vbzE7` changes each time you restart Local
2. **Configuration Complexity**: The original server required hardcoded paths that would break every time Local restarted
3. **Host/Port Confusion**: Local's MySQL configuration can be tricky with both socket and TCP connections available

### Our Solution Process

We solved this step by step:

#### 1. Process-Based Detection
Instead of guessing paths, we scan for the actual running MySQL process:

```bash
ps aux | grep mysqld | grep -v grep
```

This finds the active MySQL instance and extracts its configuration file path.

#### 2. Dynamic Path Resolution
```typescript
// From the process args: --defaults-file=/Users/.../Local/run/lx97vbzE7/conf/mysql/my.cnf
// We extract the site directory and build the socket path
const configPath = extractFromProcess();
const siteDir = path.dirname(path.dirname(path.dirname(configPath)));
const socketPath = path.join(siteDir, 'mysql/mysqld.sock');
```

#### 3. Automatic Configuration
The server automatically configures itself with:
- Correct socket path for the active Local site
- Proper database name (`local`)
- Default credentials (`root`/`root`)
- Fallback to environment variables if needed

### Why This Approach Works

✅ **Restart Resilient**: Works every time you restart Local by Flywheel  
✅ **Site Switching**: Automatically adapts if you switch between Local sites  
✅ **Zero Maintenance**: No need to manually update paths ever again  
✅ **Error Handling**: Provides clear error messages if MySQL isn't running  

### Local Directory Structure We Handle

```
~/Library/Application Support/Local/run/
├── lx97vbzE7/                    # Dynamic site ID (changes on restart)
│   ├── conf/mysql/my.cnf        # We read this for port info
│   └── mysql/mysqld.sock        # We connect via this socket
└── WP7lolWDi/                   # Another site (if multiple running)
    ├── conf/mysql/my.cnf
    └── mysql/mysqld.sock
```

The server intelligently finds the active site and connects to the right MySQL instance.

## Usage Examples

Once connected, you can use the `mysql_query` tool to execute any SQL query against your Local WordPress database:

### Getting Recent Posts

```sql
SELECT ID, post_title, post_date, post_status 
FROM wp_posts 
WHERE post_type = 'post' AND post_status = 'publish' 
ORDER BY post_date DESC 
LIMIT 5;
```

### Exploring Database Structure

```sql
-- See all tables
SHOW TABLES;

-- Examine a table structure
DESCRIBE wp_posts;

-- Get table info
SHOW TABLE STATUS LIKE 'wp_%';
```

### WordPress-Specific Queries

```sql
-- Get site options
SELECT option_name, option_value 
FROM wp_options 
WHERE option_name IN ('blogname', 'blogdescription', 'admin_email');

-- Find active plugins
SELECT option_value 
FROM wp_options 
WHERE option_name = 'active_plugins';

-- Get user information
SELECT user_login, user_email, display_name 
FROM wp_users 
LIMIT 10;

-- Post meta data
SELECT p.post_title, pm.meta_key, pm.meta_value
FROM wp_posts p
JOIN wp_postmeta pm ON p.ID = pm.post_id
WHERE p.post_type = 'post' AND pm.meta_key = '_edit_last';
```

## Development Setup

### Running from Source

1. **Start a Local site**: Make sure you have an active Local by Flywheel site running
2. **Clone and build**:
   ```bash
   git clone https://github.com/verygoodplugins/mcp-local-wp.git
   cd mcp-local-wp
   npm install
   npm run build
   ```

3. **Test the connection**:
   ```bash
   node dist/index.js
   ```

### Development Mode

```bash
npm run dev
```

This runs the server with TypeScript watching for changes.

### Linting & Formatting

- Lint: `npm run lint`
- Fix lint: `npm run lint:fix`
- Format: `npm run format`
- Check formatting: `npm run format:check`

Standards are unified across MCP servers via ESLint + Prettier.

## Troubleshooting

### Common Issues

1. **"No active MySQL process found"**
   - Ensure Local by Flywheel is running
   - Make sure at least one site is started in Local
   - Check that the site's database is running

2. **"MySQL socket not found"**
   - Verify the Local site is fully started
   - Try stopping and restarting the site in Local
   - Check Local's logs for MySQL startup issues

3. **Connection refused**
   - Ensure the Local site's MySQL service is running
   - Check if another process is using the MySQL port
   - Try restarting Local by Flywheel

4. **Permission denied**
   - Make sure the MySQL socket file has correct permissions
   - Check if your user has access to Local's directories

### Manual Configuration

If auto-detection fails, you can manually configure the connection:

```bash
export MYSQL_SOCKET_PATH="/path/to/your/local/site/mysql/mysqld.sock"
export MYSQL_DB="local"
export MYSQL_USER="root"
export MYSQL_PASS="root"
```

### Debugging

Enable debug logging by setting `DEBUG`:

```bash
DEBUG=mcp-local-wp mcp-local-wp
```

## Security

- **Read-only operations**: Only SELECT/SHOW/DESCRIBE/EXPLAIN are allowed
- **Single statement**: Multiple statements in one call are blocked
- **Local development**: Designed for local environments (Local by Flywheel)
- **No external connections**: Prioritizes Unix socket connections when available

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Guidelines

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes and add tests
4. Ensure TypeScript compiles: `npm run build`
5. Submit a pull request

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/verygoodplugins/mcp-local-wp/issues)
- **Documentation**: This README and inline code documentation
- **Community**: Join the Model Context Protocol community discussions

## Related Projects

- [mcp-server-mysql](https://github.com/benborla/mcp-server-mysql) - The original MySQL MCP server that inspired this WordPress-specific version
- [Local by Flywheel](https://localwp.com/) - The local WordPress development environment this server is designed for
- [Model Context Protocol](https://modelcontextprotocol.io/) - The protocol specification

---

Built with ❤️ by [Very Good Plugins](https://github.com/verygoodplugins) for the WordPress development community.
