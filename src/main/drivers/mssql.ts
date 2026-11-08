import sql from 'mssql'
import type { ColumnInfo, ConnectionConfig, ForeignKeyInfo, IndexInfo, QueryResult, RowChange, ServerInfo, TableInfo, TableRef } from '@shared/types'
import { Driver, groupFks, sqlLiteral, type Dialect, type Exec, type Params, normalizeRow } from './base'

const q = (n: string) => '[' + n.replace(/]/g, ']]') + ']'

export const mssqlDialect: Dialect = {
  quote: q,
  placeholder: (i) => `@p${i}`,
  table: (r) => (r.schema ? `${q(r.schema)}.${q(r.name)}` : q(r.name)),
  paginate: (s, limit, offset, hasOrder) =>
    `${s}${hasOrder ? '' : ' ORDER BY (SELECT NULL)'} OFFSET ${Math.floor(offset)} ROWS FETCH NEXT ${Math.floor(limit)} ROWS ONLY`,
  castText: (e) => `CAST(${e} AS NVARCHAR(MAX))`,
  literal: (v) => sqlLiteral(v, { unicodePrefix: true, bool: (b) => (b ? '1' : '0') })
}

type ArrayResult = sql.IResult<unknown> & { columns?: { name: string }[][] }

function bind(req: sql.Request, params: Params) {
  params.forEach((v, i) => req.input(`p${i + 1}`, v as never))
  return req
}

export class MsSqlDriver extends Driver {
  readonly dialect = mssqlDialect
  private pool!: sql.ConnectionPool
  private db: string

  constructor(private cfg: ConnectionConfig) {
    super()
    this.db = cfg.database
  }

  private async makePool() {
    const pool = new sql.ConnectionPool({
      server: this.cfg.host || '127.0.0.1',
      port: this.cfg.port || 1433,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.db || undefined,
      connectionTimeout: 10000,
      requestTimeout: 0,
      pool: { max: 1, min: 0 },
      options: { encrypt: this.cfg.ssl, trustServerCertificate: true }
    })
    pool.on('error', () => {})
    await pool.connect()
    return pool
  }

  async connect() {
    this.pool = await this.makePool()
  }

  async close() {
    await this.pool?.close().catch(() => {})
  }

  async serverInfo(): Promise<ServerInfo> {
    const r = await this.select('SELECT @@VERSION, DB_NAME()', [])
    return { version: String(r.rows[0]?.[0] ?? '').split('\n')[0].split(' (')[0], currentDatabase: String(r.rows[0]?.[1] ?? '') }
  }

  async listDatabases() {
    const r = await this.select('SELECT name FROM sys.databases ORDER BY name', [])
    return r.rows.map((x) => String(x[0]))
  }

  async useDatabase(name: string) {
    const old = this.pool
    this.db = name
    try {
      this.pool = await this.makePool()
      await old.close().catch(() => {})
    } catch (e) {
      this.pool = old
      throw e
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const r = await this.select(
      'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME',
      []
    )
    return r.rows.map((x) => ({ schema: String(x[0]), name: String(x[1]), kind: /view/i.test(String(x[2])) ? 'view' : 'table' }))
  }

  async getColumns(ref: TableRef): Promise<ColumnInfo[]> {
    const r = await this.select(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE,
              c.IS_NULLABLE, c.COLUMN_DEFAULT,
              CASE WHEN EXISTS (
                SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
                  ON tc.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = k.TABLE_SCHEMA
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = c.TABLE_SCHEMA
                  AND tc.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME) THEN 1 ELSE 0 END,
              COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity')
       FROM INFORMATION_SCHEMA.COLUMNS c
       WHERE c.TABLE_SCHEMA = @p1 AND c.TABLE_NAME = @p2 ORDER BY c.ORDINAL_POSITION`,
      [ref.schema || 'dbo', ref.name]
    )
    return r.rows.map((x) => {
      let type = String(x[1])
      if (x[2] !== null && x[2] !== undefined) type += `(${Number(x[2]) === -1 ? 'max' : x[2]})`
      else if (/^(decimal|numeric)$/i.test(type)) type += `(${x[3]},${x[4]})`
      const identity = Number(x[8]) === 1
      return {
        name: String(x[0]),
        type,
        nullable: x[5] === 'YES',
        defaultValue: x[6] === null ? null : String(x[6]),
        primaryKey: Number(x[7]) === 1,
        autoIncrement: identity,
        extra: identity ? 'identity' : '',
        comment: ''
      }
    })
  }

  async getIndexes(ref: TableRef): Promise<IndexInfo[]> {
    const r = await this.select(
      `SELECT i.name, i.is_unique, i.is_primary_key,
              STUFF((SELECT ', ' + c.name FROM sys.index_columns ic
                     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                     WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
                     ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, ''),
              i.is_unique_constraint
       FROM sys.indexes i WHERE i.object_id = OBJECT_ID(@p1) AND i.name IS NOT NULL
       ORDER BY i.is_primary_key DESC, i.name`,
      [this.dialect.table({ schema: ref.schema || 'dbo', name: ref.name })]
    )
    return r.rows.map((x) => ({
      name: String(x[0]),
      unique: x[1] === true,
      primary: x[2] === true,
      columns: String(x[3] ?? ''),
      constraint: x[2] === true || x[4] === true
    }))
  }

  async getForeignKeys(ref: TableRef): Promise<ForeignKeyInfo[]> {
    const r = await this.select(
      `SELECT fk.name, pc.name, rs.name, rt.name, rc.name, fk.delete_referential_action_desc, fk.update_referential_action_desc
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
       JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
       WHERE fk.parent_object_id = OBJECT_ID(@p1)
       ORDER BY fk.name, fkc.constraint_column_id`,
      [this.dialect.table({ schema: ref.schema || 'dbo', name: ref.name })]
    )
    return groupFks(
      r.rows.map((x) => ({ name: String(x[0]), col: String(x[1]), refSchema: String(x[2]), refTable: String(x[3]), refCol: String(x[4]), onDelete: String(x[5]), onUpdate: String(x[6]) }))
    )
  }

  async getDDL(ref: TableRef) {
    const v = await this.select(`SELECT OBJECT_DEFINITION(OBJECT_ID(@p1))`, [this.dialect.table(ref)])
    const def = v.rows[0]?.[0]
    if (def) return String(def)
    // Tablolar için SQL Server tanım döndürmez: IDENTITY, varsayılanlar ve kısıtlarla birlikte üret
    const t = this.dialect.table(ref)
    const [cols, idx] = await Promise.all([this.getColumns(ref), this.getIndexes(ref)])
    const lines = cols.map(
      (c) =>
        `  ${q(c.name)} ${c.type}${c.autoIncrement ? ' IDENTITY(1,1)' : ''}${c.nullable ? ' NULL' : ' NOT NULL'}${c.defaultValue !== null ? ` DEFAULT ${c.defaultValue}` : ''}`
    )
    const cl = (s: string) => s.split(', ').map(q).join(', ')
    for (const i of idx.filter((i) => i.constraint))
      lines.push(`  CONSTRAINT ${q(i.name)} ${i.primary ? 'PRIMARY KEY' : 'UNIQUE'} (${cl(i.columns)})`)
    let out = `CREATE TABLE ${t} (\n${lines.join(',\n')}\n)`
    for (const i of idx.filter((i) => !i.constraint)) out += `;\n\nCREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${t} (${cl(i.columns)})`
    return out
  }

  async select(text: string, params: Params): Promise<QueryResult> {
    const t = Date.now()
    const req = bind(this.pool.request(), params)
    req.arrayRowMode = true
    const r = (await req.query(text)) as ArrayResult
    const cols = r.columns?.[0] ?? []
    return {
      columns: cols.map((c) => ({ name: c.name })),
      rows: ((r.recordset ?? []) as unknown as unknown[][]).map(normalizeRow),
      rowsAffected: null,
      durationMs: Date.now() - t,
      isCommand: false
    }
  }

  async rawQuery(text: string): Promise<QueryResult[]> {
    const t = Date.now()
    const req = this.pool.request()
    req.arrayRowMode = true
    const r = (await req.query(text)) as ArrayResult
    const ms = Date.now() - t
    const sets = (r.recordsets ?? []) as unknown as unknown[][][]
    if (!sets.length) {
      const n = (r.rowsAffected ?? []).reduce((a, b) => a + b, 0)
      return [{ columns: [], rows: [], rowsAffected: n, durationMs: ms, isCommand: true }]
    }
    return sets.map((rows, i) => ({
      columns: (r.columns?.[i] ?? []).map((c) => ({ name: c.name })),
      rows: rows.map(normalizeRow),
      rowsAffected: null,
      durationMs: ms,
      isCommand: false
    }))
  }

  /** Açık id değeri yazılacak tablo (IDENTITY_INSERT bu işlem boyunca açılır) */
  private identityInsert: string | null = null

  /** Eklenen satırlarda IDENTITY sütununa değer verilmişse IDENTITY_INSERT'i işlem içinde aç / kapat. */
  async applyChanges(ref: TableRef, changes: RowChange[]): Promise<number> {
    const ident = (await this.getColumns(ref)).filter((c) => c.autoIncrement).map((c) => c.name)
    const explicit = ident.length > 0 && changes.some((ch) => ch.kind === 'insert' && ident.some((n) => ch.values[n] !== undefined && ch.values[n] !== null))
    if (!explicit) return super.applyChanges(ref, changes)
    this.identityInsert = this.dialect.table(ref)
    try {
      return await super.applyChanges(ref, changes)
    } finally {
      this.identityInsert = null
    }
  }

  async transaction(fn: (exec: Exec) => Promise<void>) {
    const tx = new sql.Transaction(this.pool)
    await tx.begin()
    const identity = this.identityInsert
    try {
      await fn(async (text, params) => {
        // Parametreli sorgular sp_executesql kapsamında çalışır; ayar aynı metinde olmalı
        const t = identity && /^\s*INSERT\b/i.test(text) ? `SET IDENTITY_INSERT ${identity} ON; ${text}; SET IDENTITY_INSERT ${identity} OFF` : text
        const r = await bind(new sql.Request(tx), params).query(t)
        return (r.rowsAffected ?? []).reduce((a, b) => a + b, 0)
      })
      await tx.commit()
    } catch (e) {
      await tx.rollback().catch(() => {})
      throw e
    }
  }
}
