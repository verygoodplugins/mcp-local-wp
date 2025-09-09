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

export interface WordPressPost {
  ID: number;
  post_author: number;
  post_date: string;
  post_date_gmt: string;
  post_content: string;
  post_title: string;
  post_excerpt: string;
  post_status: string;
  comment_status: string;
  ping_status: string;
  post_password: string;
  post_name: string;
  to_ping: string;
  pinged: string;
  post_modified: string;
  post_modified_gmt: string;
  post_content_filtered: string;
  post_parent: number;
  guid: string;
  menu_order: number;
  post_type: string;
  post_mime_type: string;
  comment_count: number;
}

export interface WordPressUser {
  ID: number;
  user_login: string;
  user_pass: string;
  user_nicename: string;
  user_email: string;
  user_url: string;
  user_registered: string;
  user_activation_key: string;
  user_status: number;
  display_name: string;
}

export interface WordPressOption {
  option_id: number;
  option_name: string;
  option_value: string;
  autoload: string;
}

export interface TableInfo {
  table_name: string;
  table_type: string;
  engine: string;
  table_rows: number;
  data_length: number;
  index_length: number;
  table_comment: string;
}

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  column_key: string;
  extra: string;
  column_comment: string;
}
