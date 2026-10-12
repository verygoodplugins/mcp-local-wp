import mysql from 'mysql2/promise';
import type { MySQLConnectionConfig, WriteResult } from './types.js';

import { validateReadSql, validateWriteSql, type SqlMode } from './sql-policy.js';

export interface TableListOptions {
  prefix?: string;
  after?: string;
  limit?: number;
  includeStats?: boolean;
}

export interface TablePage {
  tables: Record<string, unknown>[];
  hasMore: boolean;
  nextAfter: string | null;
}

export class MySQLClient {
  private readConnection: mysql.Connection | null = null;
  private writeConnection: mysql.Connection | null = null;
  private readConnect: Promise<mysql.Connection> | null = null;
  private writeConnect: Promise<mysql.Connection> | null = null;
  private readMode: SqlMode = {};
  private writeMode: SqlMode = {};
  private readQueue: Promise<unknown> = Promise.resolve();
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private config: MySQLConnectionConfig,
    private options: { allowWrites?: boolean } = {},
  ) {}

  private async open(readOnly: boolean): Promise<mysql.Connection> {
    const connection = await mysql.createConnection({ ...this.config, multipleStatements: false });
    try {
      if (readOnly) await connection.query('SET SESSION TRANSACTION READ ONLY');
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT @@SESSION.sql_mode AS sql_mode',
      );
      const modes = String(rows[0].sql_mode).split(',');
      const mode = {
        noBackslashEscapes: modes.includes('NO_BACKSLASH_ESCAPES'),
        ansiQuotes: modes.includes('ANSI_QUOTES'),
      };
      if (readOnly) this.readMode = mode;
      else this.writeMode = mode;
      return connection;
    } catch (error) {
      connection.destroy();
      throw error;
    }
  }

  private async getConnection(readOnly: boolean): Promise<mysql.Connection> {
    const existing = readOnly ? this.readConnection : this.writeConnection;
    if (existing) return existing;
    let pending = readOnly ? this.readConnect : this.writeConnect;
    if (!pending) {
      pending = this.open(readOnly)
        .then((connection) => {
          if (readOnly) this.readConnection = connection;
          else this.writeConnection = connection;
          return connection;
        })
        .finally(() => {
          if (readOnly) this.readConnect = null;
          else this.writeConnect = null;
        });
      if (readOnly) this.readConnect = pending;
      else this.writeConnect = pending;
    }
    return pending;
  }

  async connect(): Promise<void> {
    await this.getConnection(true);
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled([
      this.readQueue,
      this.writeQueue,
      this.readConnect,
      this.writeConnect,
    ]);
    const connections = [this.readConnection, this.writeConnection];
    this.readConnection = null;
    this.writeConnection = null;
    await Promise.all(connections.map((connection) => connection?.end()));
  }

  async executeReadOnlyQuery(
    sql: string,
    params?: Array<string | number | boolean | null>,
  ): Promise<Record<string, unknown>[]> {
    const run = async () => {
      const connection = await this.getConnection(true);
      validateReadSql(sql, params, this.readMode);
      try {
        await connection.query('START TRANSACTION READ ONLY');
      } catch (error) {
        connection.destroy();
        this.readConnection = null;
        throw error;
      }
      return connection
        .execute(sql, params)
        .then(([rows]) => {
          if (!Array.isArray(rows)) throw new Error('Read-only query did not return rows.');
          return rows as Record<string, unknown>[];
        })
        .finally(async () => {
          try {
            await connection.query('ROLLBACK AND NO CHAIN NO RELEASE');
          } catch (error) {
            connection.destroy();
            this.readConnection = null;
            throw error;
          }
        });
    };
    const result = this.readQueue.then(run);
    this.readQueue = result.catch(() => {});
    return result;
  }

  async executeWriteQuery(
    sql: string,
    params?: Array<string | number | boolean | null>,
  ): Promise<WriteResult> {
    if (!this.options.allowWrites) throw new Error('Write operations are disabled.');
    const run = async () => {
      const connection = await this.getConnection(false);
      validateWriteSql(sql, params, this.writeMode);
      const [result] = await connection.execute(sql, params);
      const info = result as mysql.ResultSetHeader;
      const output: WriteResult = { affectedRows: info.affectedRows };
      if (info.insertId) output.insertId = info.insertId;
      if ('changedRows' in info && info.changedRows !== undefined)
        output.changedRows = info.changedRows as number;
      return output;
    };
    const result = this.writeQueue.then(run);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async listTables(options: TableListOptions = {}): Promise<TablePage> {
    const { prefix = '', after = '', limit = 100, includeStats = false } = options;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      prefix.length > 64 ||
      after.length > 64
    )
      throw new Error('Table listing requires limit 1–200 and prefix/after up to 64 characters.');
    const sql = `
      SELECT
        TABLE_NAME AS table_name${
          includeStats
            ? `,
        ENGINE AS engine,
        TABLE_ROWS AS table_rows,
        DATA_LENGTH AS data_length,
        INDEX_LENGTH AS index_length`
            : ''
        }
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
        AND CAST(LEFT(TABLE_NAME, CHAR_LENGTH(?)) AS BINARY) = CAST(? AS BINARY)
        AND CAST(TABLE_NAME AS BINARY) > CAST(? AS BINARY)
      ORDER BY CAST(TABLE_NAME AS BINARY)
      LIMIT ?
    `;
    const rows = await this.executeReadOnlyQuery(sql, [prefix, prefix, after, limit + 1]);
    const hasMore = rows.length > limit;
    const tables = rows.slice(0, limit);
    return {
      tables,
      hasMore,
      nextAfter: hasMore ? String(tables.at(-1)!.table_name) : null,
    };
  }

  async getTableColumns(table: string): Promise<Record<string, unknown>[]> {
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

  async getTableIndexes(table: string): Promise<Record<string, unknown>[]> {
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
