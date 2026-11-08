import mysql from 'mysql2/promise'
import type { ColumnInfo, ConnectionConfig, ForeignKeyInfo, IndexInfo, QueryResult, ServerInfo, TableInfo, TableRef } from '@shared/types'
import { Driver, groupFks, sqlLiteral, type Dialect, type Exec, type Params, normalizeRow } from './base'

const q = (n: string) => '`' + n.replace(/`/g, '``') + '`'

export const mysqlDialect: Dialect = {
  quote: q,
  placeholder: () => '?',
  table: (r) => (r.schema ? `${q(r.schema)}.${q(r.name)}` : q(r.name)),
  paginate: (sql, limit, offset) => `${sql} LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}`,
  castText: (e) => `CAST(${e} AS CHAR)`,
  // MySQL varsayılan olarak ters bölüyü de kaçış karakteri sayar
  literal: (v) => sqlLiteral(v, { backslash: true, bool: (b) => (b ? '1' : '0') })
}

type Fields = mysql.FieldPacket[] | undefined

function toResult(rows: unknown, fields: Fields, durationMs: number): QueryResult {
  if (fields && Array.isArray(rows)) {
    return {
      columns: fields.map((f) => ({ name: f.name })),
      rows: (rows as unknown[][]).map(normalizeRow),
      rowsAffected: null,
      durationMs,
      isCommand: false
    }
  }
  const h = rows as mysql.ResultSetHeader
  return { columns: [], rows: [], rowsAffected: h?.affectedRows ?? 0, durationMs, isCommand: true }
}

export class MySqlDriver extends Driver {
  readonly dialect = mysqlDialect
  private pool!: mysql.Pool
  private db: string

  constructor(private cfg: ConnectionConfig) {
    super()
    this.db = cfg.database
  }

  private makePool() {
    // Tek bağlantı: editörde SET/USE/geçici tablo gibi oturum durumları korunur.
    return mysql.createPool({
      host: this.cfg.host || '127.0.0.1',
      port: this.cfg.port || 3306,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.db || undefined,
      connectionLimit: 1,
      multipleStatements: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: 'utf8mb4',
      connectTimeout: 10000,
      ssl: this.cfg.ssl ? { rejectUnauthorized: false } : undefined
    })
  }

  async connect() {
    this.pool = this.makePool()
    await this.pool.query('SELECT 1')
  }

  async close() {
    await this.pool?.end().catch(() => {})
  }

  async serverInfo(): Promise<ServerInfo> {
    const r = await this.select('SELECT VERSION(), DATABASE()', [])
    const v = String(r.rows[0]?.[0] ?? '')
    return { version: (/mariadb/i.test(v) ? 'MariaDB ' : 'MySQL ') + v, currentDatabase: String(r.rows[0]?.[1] ?? '') }
  }

  async listDatabases() {
    const r = await this.select('SHOW DATABASES', [])
    return r.rows.map((x) => String(x[0]))
  }

  async useDatabase(name: string) {
    await this.pool.query(`USE ${q(name)}`)
    this.db = name
  }

  async listTables(): Promise<TableInfo[]> {
    const r = await this.select('SELECT DATABASE()', [])
    const db = (r.rows[0]?.[0] as string) || ''
    this.db = db
    if (!db) return []
    const t = await this.select(
      'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [db]
    )
    return t.rows.map((x) => ({ schema: db, name: String(x[0]), kind: /view/i.test(String(x[1])) ? 'view' : 'table' }))
  }

  async getColumns(ref: TableRef): Promise<ColumnInfo[]> {
    const maria = await this.isMariaDb()
    const r = await this.select(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT, DATA_TYPE, COLLATION_NAME
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [ref.schema || this.db, ref.name]
    )
    return r.rows.map((x) => {
      const extra = String(x[5] ?? '')
      return {
        name: String(x[0]),
        type: String(x[1]),
        nullable: x[2] === 'YES',
        defaultValue: mysqlDefaultExpr(x[3] === null ? null : String(x[3]), extra, String(x[7] ?? ''), maria),
        primaryKey: x[4] === 'PRI',
        autoIncrement: /auto_increment/i.test(extra),
        extra,
        comment: String(x[6] ?? ''),
        collation: x[8] ? String(x[8]) : undefined,
        onUpdate: /on update\s+(.+)$/i.exec(extra)?.[1],
        generated: /\b(VIRTUAL|STORED) GENERATED\b|\bPERSISTENT\b|^VIRTUAL$/i.test(extra)
      }
    })
  }

  private maria: boolean | null = null
  private async isMariaDb() {
    if (this.maria === null) this.maria = /mariadb/i.test(String((await this.select('SELECT VERSION()', [])).rows[0]?.[0] ?? ''))
    return this.maria
  }

  async getForeignKeys(ref: TableRef): Promise<ForeignKeyInfo[]> {
    const r = await this.select(
      `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
              rc.DELETE_RULE, rc.UPDATE_RULE
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND rc.TABLE_NAME = k.TABLE_NAME
       WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [ref.schema || this.db, ref.name]
    )
    return groupFks(r.rows.map((x) => ({ name: String(x[0]), col: String(x[1]), refSchema: String(x[2]), refTable: String(x[3]), refCol: String(x[4]), onDelete: String(x[5]), onUpdate: String(x[6]) })))
  }

  async getIndexes(ref: TableRef): Promise<IndexInfo[]> {
    const r = await this.select(
      `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '), MIN(NON_UNIQUE)
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME`,
      [ref.schema || this.db, ref.name]
    )
    return r.rows.map((x) => ({
      name: String(x[0]),
      columns: String(x[1] ?? ''),
      unique: Number(x[2]) === 0,
      primary: x[0] === 'PRIMARY'
    }))
  }

  async getDDL(ref: TableRef) {
    const r = await this.select(`SHOW CREATE TABLE ${this.dialect.table(ref)}`, [])
    return String(r.rows[0]?.[1] ?? '')
  }

  async select(sql: string, params: Params): Promise<QueryResult> {
    const t = Date.now()
    const [rows, fields] = await this.pool.query({ sql, values: params, rowsAsArray: true })
    return toResult(rows, fields as Fields, Date.now() - t)
  }

  async rawQuery(sql: string): Promise<QueryResult[]> {
    const t = Date.now()
    const [rows, fields] = await this.pool.query({ sql, rowsAsArray: true })
    const ms = Date.now() - t
    const f = fields as unknown
    // Çoklu ifade: fields dizisinin elemanları dizi ya da undefined olur.
    const multi = Array.isArray(f) && f.length > 0 && f.every((x) => x === undefined || Array.isArray(x))
    if (multi || (f === undefined && Array.isArray(rows))) {
      const all = rows as unknown[]
      const fs = (Array.isArray(f) ? f : []) as Fields[]
      return all.map((r, i) => toResult(r, fs[i], ms))
    }
    return [toResult(rows, f as Fields, ms)]
  }

  async transaction(fn: (exec: Exec) => Promise<void>) {
    const conn = await this.pool.getConnection()
    try {
      await conn.beginTransaction()
      await fn(async (sql, params) => {
        const [res] = await conn.query(sql, params)
        return (res as mysql.ResultSetHeader).affectedRows ?? 0
      })
      await conn.commit()
    } catch (e) {
      await conn.rollback().catch(() => {})
      throw e
    } finally {
      conn.release()
    }
  }
}

/**
 * information_schema'daki varsayılanı, sütun tanımına doğrudan yazılabilecek SQL ifadesine çevirir.
 * MariaDB zaten ifade döndürür ('abc', 0, current_timestamp(), NULL). MySQL ise metin
 * varsayılanlarını tırnaksız verir; ifade varsayılanları EXTRA'da DEFAULT_GENERATED ile işaretlenir.
 */
export function mysqlDefaultExpr(raw: string | null, extra: string, dataType: string, maria: boolean): string | null {
  if (raw === null) return null
  if (maria) return raw === 'NULL' ? null : raw
  if (/^(current_timestamp|now|localtimestamp)(\(\d*\))?$/i.test(raw)) return raw
  if (/DEFAULT_GENERATED/i.test(extra)) return `(${raw})`
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)$/i.test(dataType) && /^-?[\d.e+-]+$/i.test(raw)) return raw
  return `'${raw.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}
