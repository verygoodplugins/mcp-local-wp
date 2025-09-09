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
