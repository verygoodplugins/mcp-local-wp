import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type { LocalSiteInfo } from './types.js';

function debugLog(...args: any[]) {
  if (process.env.DEBUG && process.env.DEBUG.includes('mcp-local-wp')) {
    // eslint-disable-next-line no-console
    console.error('[mcp-local-wp]', ...args);
  }
}

/**
 * Detects active Local by Flywheel MySQL socket by checking running processes
 */
export function findActiveLocalSocket(): LocalSiteInfo {
  try {
    // Get the running mysqld processes and prefer those launched by Local
    const psOutput = execSync('ps aux | grep mysqld | grep -v grep', { encoding: 'utf8' });
    const lines = psOutput.split('\n').filter(Boolean);
    debugLog('ps mysqld lines:', lines.length);

    let configPath: string | undefined;
    for (const line of lines) {
      // Prefer a process with Local's run directory in args
      if (!/Local\/run\//.test(line)) continue;
      const m = line.match(/--defaults-file=(.+)$/m);
      if (m) {
        configPath = m[1].trim();
        break;
      }
    }
    // Fallback: take the first mysqld with a defaults-file
    if (!configPath) {
      const any = psOutput.match(/--defaults-file=(.+)$/m);
      if (any) configPath = any[1].trim();
    }
    
    if (!configPath) {
      throw new Error('No active MySQL process found. Please start a Local site first.');
    }
    
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
    
    debugLog(`Found active Local site: ${siteId}`);
    debugLog(`Socket: ${socketPath}`);
    debugLog(`Port: ${port}`);
    
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
    multipleStatements: false,
    timezone: 'Z',
  };
}
