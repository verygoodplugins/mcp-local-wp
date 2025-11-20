import fs from 'fs';
import os from 'os';
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
  let processScanError: Error | undefined;

  try {
    const configPath = findFromProcesses();
    if (configPath) {
      return buildSiteInfoFromConfig(configPath);
    }
  } catch (error: any) {
    processScanError = error;
  }

  debugLog(
    'Process detection failed or no Local mysqld found. Falling back to filesystem scan.'
  );

  try {
    return findFromFilesystem();
  } catch (fsError: any) {
    const messageParts = [];
    if (processScanError) {
      messageParts.push(`process scan: ${processScanError.message}`);
    }
    messageParts.push(`filesystem scan: ${fsError.message}`);
    throw new Error(`Error finding active Local socket (${messageParts.join(' | ')})`);
  }
}

function findFromProcesses(): string | undefined {
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

  return configPath;
}

function findFromFilesystem(): LocalSiteInfo {
  const runDir = getLocalRunDirectory();
  debugLog(`Scanning Local run directory: ${runDir}`);

  const entries = fs
    .readdirSync(runDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory());

  const candidates = entries
    .map((dirent) => path.join(runDir, dirent.name))
    .map((siteDir) => ({
      siteDir,
      siteId: path.basename(siteDir),
      socketPath: path.join(siteDir, 'mysql/mysqld.sock'),
      configPath: path.join(siteDir, 'conf/mysql/my.cnf'),
    }))
    .filter(
      (candidate) =>
        fs.existsSync(candidate.socketPath) && fs.existsSync(candidate.configPath)
    )
    .map((candidate) => ({
      ...candidate,
      mtime: fs.statSync(candidate.socketPath).mtimeMs,
    }));

  if (!candidates.length) {
    throw new Error('No running Local sites found via filesystem scan.');
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const chosen = candidates[0];
  debugLog(`Filesystem scan selected site: ${chosen.siteId}`);
  return buildSiteInfoFromConfig(chosen.configPath);
}

function buildSiteInfoFromConfig(configPath: string): LocalSiteInfo {
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
}

function getLocalRunDirectory(): string {
  const customPath = process.env.LOCAL_RUN_DIR;
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const candidates: string[] = [];
  const home = os.homedir();

  if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library/Application Support/Local/run'));
  } else if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Local', 'run'));
    }
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'Local', 'run'));
    }
  } else {
    candidates.push(path.join(home, '.config', 'Local', 'run'));
    candidates.push(path.join(home, '.local', 'share', 'Local', 'run'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Local run directory not found. Set LOCAL_RUN_DIR to override.');
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
