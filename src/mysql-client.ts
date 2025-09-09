import mysql from 'mysql2/promise';
import type { MySQLConnectionConfig } from './types.js';

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
