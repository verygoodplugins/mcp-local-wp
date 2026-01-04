import mysql from 'mysql2/promise';
import type { MySQLConnectionConfig, WriteResult } from './types.js';

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
    const trimmed = sql.trim();
    if (!trimmed) {
      throw new Error('SQL is empty');
    }

    // Disallow multiple statements entirely for safety
    if (trimmed.includes(';')) {
      // Allow a trailing semicolon only
      const statements = trimmed.split(';').filter(s => s.trim().length > 0);
      if (statements.length > 1) {
        throw new Error('Multiple statements are not allowed. Submit a single read-only query.');
      }
    }

    const firstToken = trimmed
      .replace(/^\/\*[\s\S]*?\*\//g, '') // strip block comments
      .replace(/^--.*$/gm, '') // strip line comments
      .trim()
      .toLowerCase()
      .split(/\s+/)[0];

    const allowed = new Set(['select', 'show', 'describe', 'desc', 'explain']);
    if (!allowed.has(firstToken)) {
      throw new Error('Only read-only queries are permitted (SELECT/SHOW/DESCRIBE/EXPLAIN).');
    }

    return await this.query(sql, params);
  }

  async executeWriteQuery(sql: string, params?: any[]): Promise<WriteResult> {
    const trimmed = sql.trim();
    if (!trimmed) {
      throw new Error('SQL is empty');
    }

    // Disallow multiple statements
    if (trimmed.includes(';')) {
      const statements = trimmed.split(';').filter(s => s.trim().length > 0);
      if (statements.length > 1) {
        throw new Error('Multiple statements are not allowed. Submit a single write query.');
      }
    }

    // Strip comments and get first token
    const stripped = trimmed
      .replace(/^\/\*[\s\S]*?\*\//g, '')
      .replace(/^--.*$/gm, '')
      .trim();

    const firstToken = stripped.toLowerCase().split(/\s+/)[0];

    // Only allow INSERT, UPDATE, DELETE
    const allowed = new Set(['insert', 'update', 'delete']);
    if (!allowed.has(firstToken)) {
      throw new Error('Only INSERT, UPDATE, and DELETE are permitted. Schema operations (CREATE/DROP/ALTER/TRUNCATE) are blocked.');
    }

    // UPDATE and DELETE require parameterized WHERE clauses
    if ((firstToken === 'update' || firstToken === 'delete') && (!params || params.length === 0)) {
      throw new Error(`${firstToken.toUpperCase()} requires parameterized WHERE clause. Provide params array with at least one value.`);
    }

    // Block subqueries for safety
    if (/\bselect\b/i.test(stripped)) {
      throw new Error('Subqueries (SELECT) are not allowed in write operations.');
    }

    if (!this.connection) {
      throw new Error('Not connected to database');
    }

    try {
      const [result] = await this.connection.execute(sql, params);
      const resultInfo = result as mysql.ResultSetHeader;
      const writeResult: WriteResult = {
        affectedRows: resultInfo.affectedRows,
      };
      if (resultInfo.insertId) {
        writeResult.insertId = resultInfo.insertId;
      }
      // changedRows is deprecated in mysql2 types but still returned by MySQL
      if ('changedRows' in resultInfo && resultInfo.changedRows !== undefined) {
        writeResult.changedRows = resultInfo.changedRows as number;
      }
      return writeResult;
    } catch (error: any) {
      throw new Error(`Write query failed: ${error.message}`);
    }
  }

  async listTables(): Promise<any[]> {
    const sql = `
      SELECT
        TABLE_NAME AS table_name,
        ENGINE AS engine,
        TABLE_ROWS AS table_rows,
        DATA_LENGTH AS data_length,
        INDEX_LENGTH AS index_length
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `;
    return this.executeReadOnlyQuery(sql);
  }

  async getTableColumns(table: string): Promise<any[]> {
    this.ensureSafeIdentifier(table);
    const sql = `
      SELECT
        COLUMN_NAME AS column_name,
        COLUMN_TYPE AS column_type,
        DATA_TYPE AS data_type,
        IS_NULLABLE AS is_nullable,
        COLUMN_DEFAULT AS column_default,
        COLUMN_KEY AS column_key,
        EXTRA AS extra
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `;
    return this.executeReadOnlyQuery(sql, [table]);
  }

  async getTableIndexes(table: string): Promise<any[]> {
    this.ensureSafeIdentifier(table);
    const sql = `
      SELECT
        INDEX_NAME AS index_name,
        NON_UNIQUE AS non_unique,
        SEQ_IN_INDEX AS seq_in_index,
        COLUMN_NAME AS column_name,
        INDEX_TYPE AS index_type
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY index_name, seq_in_index
    `;
    return this.executeReadOnlyQuery(sql, [table]);
  }

  private ensureSafeIdentifier(id: string) {
    if (!/^[A-Za-z0-9_]+$/.test(id)) {
      throw new Error('Invalid identifier. Use alphanumeric and underscore only.');
    }
  }
}
