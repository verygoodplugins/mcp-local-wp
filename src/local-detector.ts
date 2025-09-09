import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type { LocalSiteInfo } from './types.js';

/**
 * Detects active Local by Flywheel MySQL socket by checking running processes
 */
export function findActiveLocalSocket(): LocalSiteInfo {
  try {
    // Get the running mysqld process and extract the config file path
    const psOutput = execSync('ps aux | grep mysqld | grep -v grep', { encoding: 'utf8' });
    
    // Match everything after --defaults-file= until the end of the line (since it's the last argument)
    const configMatch = psOutput.match(/--defaults-file=(.+)$/m);
    
    if (!configMatch) {
      throw new Error('No active MySQL process found. Please start a Local site first.');
    }
    
    const configPath = configMatch[1].trim();
    
    // configPath is like: /Users/.../Local/run/SITEID/conf/mysql/my.cnf
    // We need to go up 3 levels: my.cnf -> mysql -> conf -> SITEID
    const siteDir = path.dirname(path.dirname(path.dirname(configPath)));
    const siteId = path.basename(siteDir);
    const socketPath = path.join(siteDir, 'mysql/mysqld.sock');
    
    // Verify socket exists
    if (!fs.existsSync(socketPath)) {
      throw new Error(`MySQL socket not found at ${socketPath}`);
    }
    
    // Read the config to get the port
    const configContent = fs.readFileSync(configPath, 'utf8');
    const portMatch = configContent.match(/port\s*=\s*(\d+)/);
    const port = portMatch ? portMatch[1] : '3306';
    
    console.error(`Found active Local site: ${siteId}`);
    console.error(`Socket: ${socketPath}`);
    console.error(`Port: ${port}`);
    
    return { socketPath, port, siteId, configPath };
  } catch (error: any) {
    throw new Error(`Error finding active Local socket: ${error.message}`);
  }
}

/**
 * Gets MySQL connection configuration for Local by Flywheel
 */
export function getLocalMySQLConfig(database?: string): {
  host?: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  socketPath?: string;
  multipleStatements?: boolean;
  timezone?: string;
} {
  const localInfo = findActiveLocalSocket();
  
  return {
    socketPath: localInfo.socketPath,
    user: 'root',
    password: 'root',
    database: database || 'local',
    multipleStatements: true,
    timezone: 'Z'
  };
}
