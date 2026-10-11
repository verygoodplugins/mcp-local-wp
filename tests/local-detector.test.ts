import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'child_process';
import {
  findActiveLocalSocket,
  findSiteByName,
  findSiteByPath,
  buildSiteInfoFromEntry,
  selectSite,
  listAvailableSites,
  getLocalMySQLConfig,
} from '../src/local-detector.js';
vi.mock('child_process', () => ({ execSync: vi.fn() }));
let root: string;
const sites = {
  one: {
    name: 'Alpha',
    path: '~/Sites/Alpha',
    domain: 'alpha.local',
    services: { mysql: { ports: { MYSQL: [3307] } } },
  },
  two: { name: 'Beta', path: '/fixture/Beta', domain: 'beta.local' },
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'localwp-detector-'));
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.spyOn(process, 'cwd').mockReturnValue('/unrelated');
  vi.stubEnv('LOCAL_RUN_DIR', path.join(root, 'run'));
  vi.stubEnv('LOCAL_SITES_JSON', path.join(root, 'sites.json'));
  vi.stubEnv('SITE_ID', '');
  vi.stubEnv('SITE_NAME', '');
  vi.stubEnv('DEBUG', '');
  fs.writeFileSync(path.join(root, 'sites.json'), JSON.stringify(sites));
  for (const id of ['one', 'two']) {
    const dir = path.join(root, 'run', id);
    fs.mkdirSync(path.join(dir, 'mysql'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'conf/mysql'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mysql/mysqld.sock'), 'fixture');
    fs.writeFileSync(path.join(dir, 'conf/mysql/my.cnf'), 'port = 3310');
  }
  vi.mocked(execSync).mockImplementation(() => {
    throw new Error('no processes');
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
test('names are case insensitive and paths respect directory boundaries', () => {
  expect(findSiteByName('ALPHA')?.id).toBe('one');
  expect(findSiteByName('missing')).toBeUndefined();
  expect(findSiteByPath(path.join(root, 'Sites/Alpha/app/public'))?.id).toBe('one');
  expect(findSiteByPath(path.join(root, 'Sites/Alphabet'))).toBeUndefined();
});
test('explicit selection has priority and invalid selectors fail', () => {
  vi.stubEnv('SITE_ID', 'one');
  vi.stubEnv('SITE_NAME', 'Beta');
  expect(selectSite()).toMatchObject({ siteName: 'Alpha', selectionMethod: 'env_site_id' });
  vi.stubEnv('SITE_ID', 'missing');
  expect(() => selectSite()).toThrow('not found');
  vi.stubEnv('SITE_ID', '');
  expect(selectSite().selectionMethod).toBe('env_site_name');
  vi.stubEnv('SITE_NAME', 'missing');
  expect(() => selectSite()).toThrow('not found');
});
test('CWD selection and filesystem fallback identify the site', () => {
  vi.spyOn(process, 'cwd').mockReturnValue('/fixture/Beta/app/public');
  expect(selectSite().selectionMethod).toBe('cwd_detection');
  vi.spyOn(process, 'cwd').mockReturnValue('/unrelated');
  const socket = path.join(root, 'run/two/mysql/mysqld.sock');
  fs.utimesSync(socket, new Date('2030-01-01'), new Date('2030-01-01'));
  expect(findActiveLocalSocket()).toMatchObject({
    siteInfo: { siteId: 'two', port: '3310' },
    detectionMethod: 'filesystem_fallback',
  });
  expect(selectSite().siteName).toBe('Beta');
});
test('process detection reads the active config and missing sockets fail safely', () => {
  const config = path.join(root, 'run/one/conf/mysql/my.cnf');
  vi.mocked(execSync).mockReturnValue(`mysql --defaults-file=${config}`);
  expect(findActiveLocalSocket().detectionMethod).toBe('process_detection');
  fs.unlinkSync(path.join(root, 'run/one/mysql/mysqld.sock'));
  expect(() => buildSiteInfoFromEntry({ ...sites.one, id: 'one' })).toThrow('not running');
});
test('discovery reports running status and configured ports, credentials override defaults', () => {
  fs.unlinkSync(path.join(root, 'run/two/mysql/mysqld.sock'));
  expect(listAvailableSites().map((site) => site.running)).toEqual([true, false]);
  vi.stubEnv('SITE_ID', 'one');
  vi.stubEnv('MYSQL_USER', 'reader');
  vi.stubEnv('MYSQL_PASS', '');
  expect(getLocalMySQLConfig('fixture_db')).toMatchObject({
    user: 'reader',
    password: '',
    database: 'fixture_db',
    multipleStatements: false,
  });
  expect(buildSiteInfoFromEntry({ ...sites.one, id: 'one' }).port).toBe('3307');
});
