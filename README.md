# MCP Server Local WP

A Model Context Protocol (MCP) server that provides WordPress database access via Local by Flywheel. This server enables LLMs to inspect WordPress database schemas, query posts, users, options, and execute read-only queries on local WordPress development sites.

## Features

- **Auto-detection of Local by Flywheel sites**: Automatically detects and connects to active Local MySQL instances
- **WordPress-specific tools**: Purpose-built tools for common WordPress operations
- **Read-only safety**: All queries are restricted to SELECT operations for data safety
- **Schema inspection**: Explore WordPress database structure and table relationships
- **No hardcoded paths**: Works with any Local by Flywheel setup regardless of installation location

## WordPress Tools Available

### Content Management
- `wp_get_posts` - Get WordPress posts with filtering and pagination
- `wp_get_post` - Get a specific post by ID
- `wp_get_post_meta` - Get post meta data for a specific post

### User Management
- `wp_get_users` - Get WordPress users with optional filtering
- `wp_get_user` - Get a specific user by ID

### Site Configuration
- `wp_get_options` - Get WordPress options (settings)
- `wp_get_plugins` - Get information about installed plugins
- `wp_get_theme_info` - Get information about the active theme

### Database Operations
- `wp_execute_query` - Execute custom read-only SQL queries
- `wp_get_database_info` - Get WordPress database structure information

## Installation

### Prerequisites

- [Local by Flywheel](https://localwp.com/) installed and running
- Node.js 18+ installed
- An active Local site running

### Install via npm

```bash
npm install -g @verygoodplugins/mcp-local-wp
```

### Install from source

```bash
git clone https://github.com/verygoodplugins/mcp-local-wp.git
cd mcp-local-wp
npm install
npm run build
```

## Configuration

### Claude Desktop Configuration

Add this to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\\Claude\\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-local-wp": {
      "command": "mcp-local-wp"
    }
  }
}
```

### Advanced Configuration

For custom database settings or fallback configuration:

```json
{
  "mcpServers": {
    "mcp-local-wp": {
      "command": "mcp-local-wp",
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

This MCP server was specifically designed to work seamlessly with Local by Flywheel development environments. Here's how we made it work:

### 1. Auto-Detection Process

The server automatically detects active Local sites by:

1. **Process Detection**: Scans running processes to find active `mysqld` instances
2. **Config File Parsing**: Extracts the MySQL configuration file path from the process
3. **Socket Path Resolution**: Determines the MySQL socket path from the Local site structure
4. **Connection Setup**: Establishes connection using the detected socket

```typescript
// Example of the detection process
function findActiveLocalSocket(): LocalSiteInfo {
  const psOutput = execSync('ps aux | grep mysqld | grep -v grep');
  const configMatch = psOutput.match(/--defaults-file=(.+)$/m);
  const configPath = configMatch[1].trim();
  
  // Parse Local's directory structure
  const siteDir = path.dirname(path.dirname(path.dirname(configPath)));
  const socketPath = path.join(siteDir, 'mysql/mysqld.sock');
  
  return { socketPath, siteId, port };
}
```

### 2. Local Directory Structure Understanding

Local by Flywheel organizes sites in a specific structure:
```
~/Local Sites/
└── [site-name]/
    ├── app/
    │   └── public/          # WordPress files
    ├── conf/
    │   └── mysql/
    │       └── my.cnf       # MySQL configuration
    └── mysql/
        └── mysqld.sock      # MySQL socket
```

### 3. Connection Strategy

The server uses Unix sockets for optimal performance with Local:

```typescript
const mysqlConfig = {
  socketPath: '/path/to/local/site/mysql/mysqld.sock',
  user: 'root',
  password: 'root',
  database: 'local',
  multipleStatements: true
};
```

### 4. Fallback Mechanism

If Local detection fails, the server falls back to environment variables, making it compatible with other WordPress setups.

## Usage Examples

### Getting Recent Posts

```typescript
// Get the 5 most recent published posts
wp_get_posts({
  post_type: "post",
  post_status: "publish",
  limit: 5,
  offset: 0
})
```

### Searching Content

```typescript
// Search for posts containing "WordPress"
wp_get_posts({
  search: "WordPress",
  limit: 10
})
```

### Inspecting Database Structure

```typescript
// Get all WordPress tables
wp_get_database_info({})

// Get columns for a specific table
wp_get_database_info({
  table_name: "wp_posts"
})
```

### Custom Queries

```typescript
// Execute a custom query
wp_execute_query({
  query: "SELECT post_title, post_date FROM wp_posts WHERE post_type = ? ORDER BY post_date DESC LIMIT 5",
  params: ["post"]
})
```

### Plugin Information

```typescript
// Get active plugins
wp_get_plugins({
  active_only: true
})
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

Enable debug logging:

```bash
DEBUG=mcp-local-wp mcp-local-wp
```

## Security

- **Read-only operations**: All database operations are restricted to SELECT queries
- **Local development only**: Designed specifically for local development environments
- **No external connections**: Only connects to local MySQL instances via socket

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
