#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';

// Function to find the active Local by Flywheel MySQL socket by checking running processes
function findActiveLocalSocket() {
  
  try {
    // Get the running mysqld process and extract the config file path
    const psOutput = execSync('ps aux | grep mysqld | grep -v grep', { encoding: 'utf8' });
    // Match everything after --defaults-file= until the end of the line (since it's the last argument)
    const configMatch = psOutput.match(/--defaults-file=(.+)$/m);
    
    if (!configMatch) {
      throw new Error('No active MySQL process found');
    }
    
    const configPath = configMatch[1].trim();
    // configPath is like: /Users/.../Local/run/SITEID/conf/mysql/my.cnf
    // We need to go up 3 levels: my.cnf -> mysql -> conf -> SITEID
    const siteDir = path.dirname(path.dirname(path.dirname(configPath)));
    const siteId = path.basename(siteDir);
    const socketPath = path.join(siteDir, 'mysql/mysqld.sock');
    
    // Read the config to get the port
    const configContent = fs.readFileSync(configPath, 'utf8');
    const portMatch = configContent.match(/port\s*=\s*(\d+)/);
    const port = portMatch ? portMatch[1] : '3306';
    
    console.log(`Found active Local site: ${siteId}`);
    console.log(`Socket: ${socketPath}`);
    console.log(`Port: ${port}`);
    
    return { socketPath, port, siteId };
  } catch (error) {
    console.error('Error finding active Local socket:', error.message);
    process.exit(1);
  }
}

// Get the active socket info
const { socketPath, port } = findActiveLocalSocket();

// Set environment variables
const env = {
  ...process.env,
  MYSQL_HOST: 'localhost',
  MYSQL_SOCKET_PATH: socketPath,
  MYSQL_USER: 'root',
  MYSQL_PASS: 'root',
  MYSQL_DB: 'local',
  ALLOW_INSERT_OPERATION: 'false',
  ALLOW_UPDATE_OPERATION: 'false',
  ALLOW_DELETE_OPERATION: 'false',
  PATH: '/opt/homebrew/bin/',
  NODE_PATH: '/opt/homebrew/lib/node_modules'
};

// Start the MCP server
console.log('Starting MCP server with dynamic Local configuration...');
const mcpServerPath = '/Users/jgarturo/Local Sites/dev/app/public/wp-content/plugins/wp-fusion/mcp-server-mysql/dist/index.js';
const mcpServer = spawn('/opt/homebrew/bin/node', [mcpServerPath], {
  env,
  stdio: 'inherit'
});

mcpServer.on('error', (error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});

mcpServer.on('exit', (code) => {
  console.log(`MCP server exited with code ${code}`);
  process.exit(code);
});
