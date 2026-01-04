import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import type {
  LocalSiteInfo,
  LocalSiteEntry,
  LocalSitesConfig,
  SiteSelectionResult,
} from './types.js';

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
 * Gets the path to Local's sites.json configuration file
 */
function getSitesJsonPath(): string {
  const customPath = process.env.LOCAL_SITES_JSON;
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library/Application Support/Local/sites.json'));
  } else if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Local', 'sites.json'));
    }
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'Local', 'sites.json'));
    }
  } else {
    candidates.push(path.join(home, '.config', 'Local', 'sites.json'));
    candidates.push(path.join(home, '.local', 'share', 'Local', 'sites.json'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Local sites.json not found. Set LOCAL_SITES_JSON env var to specify the path.'
  );
}

/**
 * Loads and parses Local's sites.json configuration
 */
export function loadLocalSitesConfig(): LocalSitesConfig {
  const sitesJsonPath = getSitesJsonPath();
  debugLog(`Loading sites.json from: ${sitesJsonPath}`);

  const content = fs.readFileSync(sitesJsonPath, 'utf8');
  return JSON.parse(content) as LocalSitesConfig;
}

/**
 * Normalizes a site path by expanding ~ and resolving to absolute path
 */
function normalizeSitePath(sitePath: string): string {
  const home = os.homedir();
  const normalized = sitePath.startsWith('~') ? sitePath.replace(/^~/, home) : sitePath;
  return path.resolve(normalized);
}

/**
 * Finds a site by its human-readable name (case-insensitive)
 */
export function findSiteByName(siteName: string): (LocalSiteEntry & { id: string }) | undefined {
  const sites = loadLocalSitesConfig();
  const lowerName = siteName.toLowerCase();

  for (const [id, site] of Object.entries(sites)) {
    if (site.name.toLowerCase() === lowerName) {
      return { ...site, id } as LocalSiteEntry & { id: string };
    }
  }
  return undefined;
}

/**
 * Finds a site by checking if the given path is within a site's directory
 */
export function findSiteByPath(cwdPath: string): (LocalSiteEntry & { id: string }) | undefined {
  const sites = loadLocalSitesConfig();
  const normalizedCwd = path.resolve(cwdPath);

  for (const [id, site] of Object.entries(sites)) {
    const sitePath = normalizeSitePath(site.path);
    // Check if cwd is the site path or a subdirectory of it
    if (normalizedCwd === sitePath || normalizedCwd.startsWith(sitePath + path.sep)) {
      debugLog(`CWD matches site: ${site.name} at ${sitePath}`);
      return { ...site, id } as LocalSiteEntry & { id: string };
    }
  }
  return undefined;
}

/**
 * Builds LocalSiteInfo from a site entry, verifying the site is running
 */
export function buildSiteInfoFromEntry(site: LocalSiteEntry & { id: string }): LocalSiteInfo {
  const runDir = getLocalRunDirectory();
  const siteDir = path.join(runDir, site.id);
  const socketPath = path.join(siteDir, 'mysql/mysqld.sock');
  const configPath = path.join(siteDir, 'conf/mysql/my.cnf');

  // Verify the site is running (socket exists)
  if (!fs.existsSync(socketPath)) {
    throw new Error(
      `Site "${site.name}" (${site.id}) is not running. ` +
        `Expected socket at: ${socketPath}. ` +
        `Please start the site in Local by Flywheel.`
    );
  }

  // Get port from services config or my.cnf
  let port = '3306';
  if (site.services?.mysql?.ports?.MYSQL?.[0]) {
    port = String(site.services.mysql.ports.MYSQL[0]);
  } else if (fs.existsSync(configPath)) {
    const configContent = fs.readFileSync(configPath, 'utf8');
    const portMatch = configContent.match(/port\s*=\s*(\d+)/);
    if (portMatch) port = portMatch[1];
  }

  return {
    socketPath,
    port,
    siteId: site.id,
    configPath,
  };
}

/**
 * Main site selection function with priority order:
 * 1. SITE_ID env var
 * 2. SITE_NAME env var
 * 3. CWD detection
 * 4. Process detection (existing behavior)
 * 5. Filesystem fallback (existing behavior)
 */
export function selectSite(): SiteSelectionResult {
  // Priority 1: SITE_ID env var
  const siteIdEnv = process.env.SITE_ID;
  if (siteIdEnv) {
    debugLog(`Checking SITE_ID env var: ${siteIdEnv}`);
    const sites = loadLocalSitesConfig();
    const site = sites[siteIdEnv];
    if (!site) {
      const availableIds = Object.keys(sites).join(', ');
      throw new Error(
        `Site ID "${siteIdEnv}" not found in Local configuration. Available IDs: ${availableIds}`
      );
    }
    const siteWithId = { ...site, id: siteIdEnv } as LocalSiteEntry & { id: string };
    return {
      siteInfo: buildSiteInfoFromEntry(siteWithId),
      siteName: site.name,
      sitePath: normalizeSitePath(site.path),
      domain: site.domain,
      selectionMethod: 'env_site_id',
    };
  }

  // Priority 2: SITE_NAME env var
  const siteNameEnv = process.env.SITE_NAME;
  if (siteNameEnv) {
    debugLog(`Checking SITE_NAME env var: ${siteNameEnv}`);
    const site = findSiteByName(siteNameEnv);
    if (!site) {
      const sites = loadLocalSitesConfig();
      const availableNames = Object.values(sites)
        .map((s) => s.name)
        .join(', ');
      throw new Error(
        `Site name "${siteNameEnv}" not found. Available sites: ${availableNames}`
      );
    }
    return {
      siteInfo: buildSiteInfoFromEntry(site),
      siteName: site.name,
      sitePath: normalizeSitePath(site.path),
      domain: site.domain,
      selectionMethod: 'env_site_name',
    };
  }

  // Priority 3: CWD detection
  const cwd = process.cwd();
  debugLog(`Checking CWD for site match: ${cwd}`);
  try {
    const cwdSite = findSiteByPath(cwd);
    if (cwdSite) {
      return {
        siteInfo: buildSiteInfoFromEntry(cwdSite),
        siteName: cwdSite.name,
        sitePath: normalizeSitePath(cwdSite.path),
        domain: cwdSite.domain,
        selectionMethod: 'cwd_detection',
      };
    }
  } catch {
    // sites.json not found or invalid, fall through to legacy detection
    debugLog('CWD detection failed, falling back to process/filesystem detection');
  }

  // Priority 4 & 5: Fall back to existing detection (process or filesystem)
  debugLog('No explicit site selection, falling back to auto-detection');
  const siteInfo = findActiveLocalSocket();

  // Try to look up site metadata from sites.json
  let siteName = siteInfo.siteId;
  let sitePath = 'unknown';
  let domain = 'unknown';
  let selectionMethod: SiteSelectionResult['selectionMethod'] = 'filesystem_fallback';

  try {
    const sites = loadLocalSitesConfig();
    const site = sites[siteInfo.siteId];
    if (site) {
      siteName = site.name;
      sitePath = normalizeSitePath(site.path);
      domain = site.domain;
      selectionMethod = 'process_detection';
    }
  } catch {
    // sites.json not available, use defaults
  }

  return {
    siteInfo,
    siteName,
    sitePath,
    domain,
    selectionMethod,
  };
}

/**
 * Lists all available Local sites with their running status
 */
export function listAvailableSites(): Array<{
  id: string;
  name: string;
  path: string;
  domain: string;
  running: boolean;
}> {
  const sites = loadLocalSitesConfig();
  const runDir = getLocalRunDirectory();

  return Object.entries(sites).map(([id, site]) => {
    const socketPath = path.join(runDir, id, 'mysql/mysqld.sock');
    return {
      id,
      name: site.name,
      path: normalizeSitePath(site.path),
      domain: site.domain,
      running: fs.existsSync(socketPath),
    };
  });
}

/**
 * Gets MySQL connection configuration for Local by Flywheel
 * Uses selectSite() for priority-based site selection
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
  _siteSelection?: SiteSelectionResult;
} {
  const selection = selectSite();

  debugLog(`Selected site: ${selection.siteName} via ${selection.selectionMethod}`);
  debugLog(`  Path: ${selection.sitePath}`);
  debugLog(`  Domain: ${selection.domain}`);
  debugLog(`  Socket: ${selection.siteInfo.socketPath}`);

  return {
    socketPath: selection.siteInfo.socketPath,
    user: 'root',
    password: 'root',
    database: database || 'local',
    multipleStatements: false,
    timezone: 'Z',
    _siteSelection: selection,
  };
}
