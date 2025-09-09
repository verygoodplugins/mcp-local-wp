import mysql from 'mysql2/promise';
import type { MySQLConnectionConfig, TableInfo, ColumnInfo } from './types.js';

export class MySQLClient {
  private connection: mysql.Connection | null = null;
  private config: MySQLConnectionConfig;

  constructor(config: MySQLConnectionConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connection) {
      return;
    }

    try {
      this.connection = await mysql.createConnection(this.config);
      console.error('Connected to MySQL database');
    } catch (error: any) {
      throw new Error(`Failed to connect to MySQL: ${error.message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
      console.error('Disconnected from MySQL database');
    }
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    if (!this.connection) {
      throw new Error('Not connected to database');
    }

    try {
      const [rows] = await this.connection.execute(sql, params);
      return rows as T[];
    } catch (error: any) {
      throw new Error(`Query failed: ${error.message}`);
    }
  }

  async getDatabases(): Promise<string[]> {
    const rows = await this.query<{ Database: string }>('SHOW DATABASES');
    return rows.map(row => row.Database);
  }

  async getTables(database?: string): Promise<TableInfo[]> {
    let sql = `
      SELECT 
        TABLE_NAME as table_name,
        TABLE_TYPE as table_type,
        ENGINE as engine,
        TABLE_ROWS as table_rows,
        DATA_LENGTH as data_length,
        INDEX_LENGTH as index_length,
        TABLE_COMMENT as table_comment
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `;
    
    const dbName = database || this.config.database;
    if (!dbName) {
      throw new Error('No database specified');
    }
    
    return await this.query<TableInfo>(sql, [dbName]);
  }

  async getTableColumns(tableName: string, database?: string): Promise<ColumnInfo[]> {
    let sql = `
      SELECT 
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        IS_NULLABLE as is_nullable,
        COLUMN_DEFAULT as column_default,
        CHARACTER_MAXIMUM_LENGTH as character_maximum_length,
        COLUMN_KEY as column_key,
        EXTRA as extra,
        COLUMN_COMMENT as column_comment
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `;
    
    const dbName = database || this.config.database;
    if (!dbName) {
      throw new Error('No database specified');
    }
    
    return await this.query<ColumnInfo>(sql, [dbName, tableName]);
  }

  async getWordPressTables(database?: string): Promise<TableInfo[]> {
    const tables = await this.getTables(database);
    
    // Filter for WordPress tables (wp_ prefix or common WP table patterns)
    return tables.filter(table => {
      const name = table.table_name.toLowerCase();
      return name.startsWith('wp_') || 
             name.includes('_wp_') ||
             ['posts', 'users', 'options', 'comments', 'terms', 'postmeta', 'usermeta'].some(wp => name.includes(wp));
    });
  }

  async getTablePrefix(database?: string): Promise<string> {
    const tables = await this.getTables(database);
    
    // Look for common WordPress tables to determine prefix
    const commonTables = ['posts', 'users', 'options', 'comments'];
    
    for (const table of tables) {
      for (const commonTable of commonTables) {
        if (table.table_name.endsWith(`_${commonTable}`)) {
          return table.table_name.replace(`_${commonTable}`, '_');
        }
      }
    }
    
    return 'wp_'; // Default WordPress prefix
  }

  async executeReadOnlyQuery(sql: string, params?: any[]): Promise<any[]> {
    // Basic safety check for read-only operations
    const normalizedSql = sql.trim().toLowerCase();
    const writeOperations = ['insert', 'update', 'delete', 'drop', 'create', 'alter', 'truncate'];
    
    if (writeOperations.some(op => normalizedSql.startsWith(op))) {
      throw new Error('Write operations are not allowed. Only SELECT queries are permitted.');
    }

    return await this.query(sql, params);
  }
}
