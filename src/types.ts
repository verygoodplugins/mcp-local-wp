export interface LocalSiteInfo {
  socketPath: string;
  port: string;
  siteId: string;
  configPath: string;
}

export interface MySQLConnectionConfig {
  host?: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  socketPath?: string;
  multipleStatements?: boolean;
  timezone?: string;
}

export interface WriteResult {
  affectedRows: number;
  insertId?: number;
  changedRows?: number;
}

/**
 * Site entry from Local's sites.json configuration file
 */
export interface LocalSiteEntry {
  id: string;
  name: string;
  path: string;
  domain: string;
  services?: {
    mysql?: {
      ports?: {
        MYSQL?: number[];
      };
    };
  };
}

/**
 * All sites from sites.json, keyed by site ID
 */
export interface LocalSitesConfig {
  [siteId: string]: Omit<LocalSiteEntry, 'id'> & Record<string, unknown>;
}

/**
 * Result of site selection with context about how the site was chosen
 */
export interface SiteSelectionResult {
  siteInfo: LocalSiteInfo;
  siteName: string;
  sitePath: string;
  domain: string;
  selectionMethod:
    | 'env_site_id'
    | 'env_site_name'
    | 'cwd_detection'
    | 'process_detection'
    | 'filesystem_fallback';
}
