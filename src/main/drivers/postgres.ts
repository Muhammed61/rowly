import pg from 'pg'
import type { ColumnInfo, ConnectionConfig, ForeignKeyInfo, IndexInfo, QueryResult, ServerInfo, TableInfo, TableRef } from '@shared/types'
import { Driver, groupFks, sqlLiteral, type Dialect, type Exec, type Params, normalizeRow } from './base'

// Tarih/saat ve JSON tiplerini ham metin olarak al: düzenlerken kayıp olmasın.
const raw = (v: string) => v
for (const oid of [1082, 1083, 1114, 1184, 1186, 1266, 114, 3802]) pg.types.setTypeParser(oid, raw)

const q = (n: string) => '"' + n.replace(/"/g, '""') + '"'

export const pgDialect: Dialect = {
  quote: q,
  placeholder: (i) => `$${i}`,
  table: (r) => (r.schema ? `${q(r.schema)}.${q(r.name)}` : q(r.name)),
  paginate: (sql, limit, offset) => `${sql} LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}`,
  castText: (e) => `CAST(${e} AS TEXT)`,
  literal: (v) => sqlLiteral(v, { bool: (b) => (b ? 'TRUE' : 'FALSE') })
}

function toResult(r: pg.QueryResult, ms: number): QueryResult {
  const isCommand = !r.fields || r.fields.length === 0
  return {
    columns: (r.fields ?? []).map((f) => ({ name: f.name })),
    rows: ((r.rows ?? []) as unknown[][]).map(normalizeRow),
    rowsAffected: isCommand ? (r.rowCount ?? 0) : null,
    durationMs: ms,
    isCommand
  }
}

export class PostgresDriver extends Driver {
  readonly dialect = pgDialect
  private pool!: pg.Pool
  private db: string

  constructor(private cfg: ConnectionConfig) {
    super()
    this.db = cfg.database || (cfg.type === 'redshift' ? 'dev' : 'postgres')
  }

  private makePool() {
    const pool = new pg.Pool({
      host: this.cfg.host || '127.0.0.1',
      port: this.cfg.port || 5432,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.db,
      max: 1,
      connectionTimeoutMillis: 10000,
      ssl: this.cfg.ssl ? { rejectUnauthorized: false } : undefined
    })
    pool.on('error', () => {}) // boşta kopan bağlantı uygulamayı düşürmesin
    return pool
  }

  async connect() {
    this.pool = this.makePool()
    await this.pool.query('SELECT 1')
  }

  async close() {
    await this.pool?.end().catch(() => {})
  }

  async serverInfo(): Promise<ServerInfo> {
    const r = await this.select('SELECT version(), current_database()', [])
    const v = String(r.rows[0]?.[0] ?? '')
    return { version: v.split(' on ')[0].split(',')[0], currentDatabase: String(r.rows[0]?.[1] ?? '') }
  }

  async listDatabases() {
    const r = await this.select('SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname', [])
    return r.rows.map((x) => String(x[0]))
  }

  async useDatabase(name: string) {
    // PostgreSQL'de veritabanı değiştirmek yeni bağlantı demek.
    const old = this.pool
    this.db = name
    this.pool = this.makePool()
    try {
      await this.pool.query('SELECT 1')
      await old.end().catch(() => {})
    } catch (e) {
      await this.pool.end().catch(() => {})
      this.pool = old
      throw e
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const r = await this.select(
      `SELECT table_schema, table_name, table_type FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'crdb_internal', 'pg_extension')
         AND table_schema NOT LIKE 'pg_toast%' AND table_schema NOT LIKE 'pg_temp%'
       ORDER BY table_schema, table_name`,
      []
    )
    return r.rows.map((x) => ({
      schema: String(x[0]),
      name: String(x[1]),
      kind: /view/i.test(String(x[2])) ? 'view' : 'table'
    }))
  }

  async getColumns(ref: TableRef): Promise<ColumnInfo[]> {
    const r = await this.select(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
              pg_get_expr(d.adbin, d.adrelid),
              COALESCE((SELECT true FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary
                        AND a.attnum = ANY(i.indkey)), false),
              col_description(a.attrelid, a.attnum)
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [ref.schema || 'public', ref.name]
    )
    return r.rows.map((x) => {
      const def = x[3] === null ? null : String(x[3])
      const auto = !!def && /^nextval\(/i.test(def)
      return {
        name: String(x[0]),
        type: String(x[1]),
        nullable: x[2] === true,
        defaultValue: def,
        primaryKey: x[4] === true,
        autoIncrement: auto,
        extra: auto ? 'auto increment' : '',
        comment: String(x[5] ?? '')
      }
    })
  }

  async getIndexes(ref: TableRef): Promise<IndexInfo[]> {
    try {
      const r = await this.select(
        `SELECT i.relname, ix.indisunique, ix.indisprimary,
                array_to_string(array_agg(a.attname ORDER BY array_position(ix.indkey::int2[], a.attnum)), ', '),
                EXISTS (SELECT 1 FROM pg_constraint pc WHERE pc.conindid = ix.indexrelid AND pc.contype IN ('p', 'u', 'x'))
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_index ix ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
         WHERE n.nspname = $1 AND t.relname = $2
         GROUP BY i.relname, ix.indisunique, ix.indisprimary, ix.indexrelid
         ORDER BY ix.indisprimary DESC, i.relname`,
        [ref.schema || 'public', ref.name]
      )
      return r.rows.map((x) => ({ name: String(x[0]), unique: x[1] === true, primary: x[2] === true, columns: String(x[3] ?? ''), constraint: x[4] === true }))
    } catch {
      return []
    }
  }

  async getForeignKeys(ref: TableRef): Promise<ForeignKeyInfo[]> {
    const act: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }
    try {
      const r = await this.select(
        `SELECT c.conname, a.attname, fn.nspname, ft.relname, fa.attname, c.confdeltype, c.confupdtype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_class ft ON ft.oid = c.confrelid
         JOIN pg_namespace fn ON fn.oid = ft.relnamespace
         CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(col, fcol, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.col
         JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fcol
         WHERE c.contype = 'f' AND n.nspname = $1 AND t.relname = $2
         ORDER BY c.conname, k.ord`,
        [ref.schema || 'public', ref.name]
      )
      return groupFks(
        r.rows.map((x) => ({
          name: String(x[0]),
          col: String(x[1]),
          refSchema: String(x[2]),
          refTable: String(x[3]),
          refCol: String(x[4]),
          onDelete: act[String(x[5])] ?? 'NO ACTION',
          onUpdate: act[String(x[6])] ?? 'NO ACTION'
        }))
      )
    } catch {
      return []
    }
  }

  async getDDL(ref: TableRef) {
    const v = await this.select(
      `SELECT pg_get_viewdef(c.oid, true) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')`,
      [ref.schema || 'public', ref.name]
    ).catch(() => null)
    const viewDef = v?.rows[0]?.[0]
    if (viewDef) return `CREATE VIEW ${this.dialect.table(ref)} AS\n${viewDef}`
    // nextval(...) varsayılanını serial'a çevir: betik, sequence'i olmayan boş bir veritabanında da çalışsın
    const serial: Record<string, string> = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' }
    return (await this.synthesizeDDL(ref)).replace(
      /("(?:[^"]|"")+") (integer|bigint|smallint) NOT NULL DEFAULT nextval\('[^']+'(?:::regclass)?\)/g,
      (_m, col: string, t: string) => `${col} ${serial[t]} NOT NULL`
    )
  }

  async select(sql: string, params: Params): Promise<QueryResult> {
    const t = Date.now()
    const r = await this.pool.query({ text: sql, values: params, rowMode: 'array' })
    return toResult(r, Date.now() - t)
  }

  async rawQuery(sql: string): Promise<QueryResult[]> {
    const t = Date.now()
    const r = (await this.pool.query({ text: sql, rowMode: 'array' })) as unknown as pg.QueryResult | pg.QueryResult[]
    const ms = Date.now() - t
    return (Array.isArray(r) ? r : [r]).map((x) => toResult(x, ms))
  }

  async transaction(fn: (exec: Exec) => Promise<void>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await fn(async (sql, params) => (await client.query(sql, params)).rowCount ?? 0)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }
}
