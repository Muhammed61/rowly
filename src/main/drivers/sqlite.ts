import fs from 'node:fs'
import path from 'node:path'
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js'
import type { ColumnInfo, ConnectionConfig, ForeignKeyInfo, IndexInfo, QueryResult, ServerInfo, TableInfo, TableRef } from '@shared/types'
import { Driver, groupFks, sqlLiteral, type Dialect, type Exec, type Params, looksLikeRead, normalizeRow } from './base'

let sqlJs: Promise<SqlJsStatic> | null = null
const loadSqlJs = () =>
  (sqlJs ??= initSqlJs({
    locateFile: (f: string) => path.join(path.dirname(require.resolve('sql.js')), f)
  }))

const q = (n: string) => '"' + n.replace(/"/g, '""') + '"'

export const sqliteDialect: Dialect = {
  quote: q,
  placeholder: () => '?',
  table: (r) => q(r.name),
  paginate: (sql, limit, offset) => `${sql} LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}`,
  castText: (e) => `CAST(${e} AS TEXT)`,
  literal: (v) => sqlLiteral(v, { bool: (b) => (b ? '1' : '0') })
}

const bindable = (params: Params): SqlValue[] =>
  params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : (v as SqlValue)))

/**
 * SQLite: sql.js (WebAssembly) ile çalışır, derleme gerektirmez.
 * Dosya belleğe yüklenir, her yazma işleminden sonra diske geri yazılır.
 */
export class SqliteDriver extends Driver {
  readonly dialect = sqliteDialect
  private db!: Database
  private file: string
  /** Betikteki açık BEGIN … COMMIT içindeyken diske yazmayı COMMIT'e ertele */
  private inTx = false

  constructor(cfg: ConnectionConfig) {
    super()
    this.file = cfg.file
  }

  async connect() {
    const SQL = await loadSqlJs()
    if (this.file && fs.existsSync(this.file)) {
      this.db = new SQL.Database(fs.readFileSync(this.file))
    } else {
      this.db = new SQL.Database()
      this.persist()
    }
    this.db.exec('SELECT count(*) FROM sqlite_master')
  }

  private persist() {
    if (this.file) fs.writeFileSync(this.file, Buffer.from(this.db.export()))
  }

  async close() {
    try {
      this.db?.close()
    } catch {
      /* zaten kapalı */
    }
  }

  async serverInfo(): Promise<ServerInfo> {
    const r = await this.select('SELECT sqlite_version()', [])
    return { version: 'SQLite ' + String(r.rows[0]?.[0] ?? ''), currentDatabase: 'main' }
  }

  async listDatabases() {
    return ['main']
  }

  async useDatabase() {}

  async listTables(): Promise<TableInfo[]> {
    const r = await this.select(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      []
    )
    return r.rows.map((x) => ({ schema: 'main', name: String(x[0]), kind: x[1] === 'view' ? 'view' : 'table' }))
  }

  async getColumns(ref: TableRef): Promise<ColumnInfo[]> {
    const r = await this.select(`PRAGMA table_info(${q(ref.name)})`, [])
    const ddl = (await this.getDDL(ref)).toLowerCase()
    const pkCount = r.rows.filter((x) => Number(x[5]) > 0).length
    return r.rows.map((x) => {
      const type = String(x[2] ?? '')
      const pk = Number(x[5]) > 0
      const auto = pk && pkCount === 1 && /^integer$/i.test(type)
      return {
        name: String(x[1]),
        type,
        nullable: Number(x[3]) === 0 && !pk,
        defaultValue: x[4] === null ? null : String(x[4]),
        primaryKey: pk,
        autoIncrement: auto,
        extra: auto ? (ddl.includes('autoincrement') ? 'autoincrement' : 'rowid') : '',
        comment: ''
      }
    })
  }

  async getIndexes(ref: TableRef): Promise<IndexInfo[]> {
    const list = await this.select(`PRAGMA index_list(${q(ref.name)})`, [])
    const out: IndexInfo[] = []
    for (const x of list.rows) {
      const name = String(x[1])
      const info = await this.select(`PRAGMA index_info(${q(name)})`, [])
      out.push({
        name,
        unique: Number(x[2]) === 1,
        primary: x[3] === 'pk',
        columns: info.rows.map((c) => String(c[2])).join(', '),
        // 'c' = CREATE INDEX ile oluşturulmuş; 'u'/'pk' = tablo tanımındaki kısıttan otomatik
        constraint: x[3] !== 'c'
      })
    }
    // INTEGER PRIMARY KEY rowid takma adıdır ve ayrı bir indeksi yoktur; yine de gösterelim.
    if (!out.some((i) => i.primary)) {
      const pk = (await this.getColumns(ref)).filter((c) => c.primaryKey).map((c) => c.name)
      if (pk.length) out.unshift({ name: 'PRIMARY', columns: pk.join(', '), unique: true, primary: true, constraint: true })
    }
    return out
  }

  async getForeignKeys(ref: TableRef): Promise<ForeignKeyInfo[]> {
    // id, seq, table, from, to, on_update, on_delete, match — SQLite'ta FK'lerin adı yoktur
    const r = await this.select(`PRAGMA foreign_key_list(${q(ref.name)})`, [])
    return groupFks(
      r.rows.map((x) => ({
        name: `fk_${ref.name}_${x[0]}`,
        col: String(x[3]),
        refSchema: 'main',
        refTable: String(x[2]),
        refCol: String(x[4] ?? ''),
        onDelete: String(x[6]),
        onUpdate: String(x[5])
      }))
    )
  }

  async getDDL(ref: TableRef) {
    const r = await this.select(`SELECT sql FROM sqlite_master WHERE name = ?`, [ref.name])
    return String(r.rows[0]?.[0] ?? '')
  }

  async select(sql: string, params: Params): Promise<QueryResult> {
    const t = Date.now()
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(bindable(params))
      const rows: unknown[][] = []
      while (stmt.step()) rows.push(stmt.get())
      const columns = stmt.getColumnNames().map((name) => ({ name }))
      return { columns, rows: rows.map(normalizeRow), rowsAffected: null, durationMs: Date.now() - t, isCommand: false }
    } finally {
      stmt.free()
    }
  }

  async rawQuery(sql: string): Promise<QueryResult[]> {
    const results: QueryResult[] = []
    let wrote = false
    for (const stmt of this.db.iterateStatements(sql)) {
      const t = Date.now()
      try {
        const rows: unknown[][] = []
        while (stmt.step()) rows.push(stmt.get())
        const cols = stmt.getColumnNames()
        if (cols.length) {
          results.push({ columns: cols.map((name) => ({ name })), rows: rows.map(normalizeRow), rowsAffected: null, durationMs: Date.now() - t, isCommand: false })
        } else {
          results.push({ columns: [], rows: [], rowsAffected: this.db.getRowsModified(), durationMs: Date.now() - t, isCommand: true })
        }
        const text = stmt.getSQL() ?? ''
        if (/^\s*BEGIN\b/i.test(text)) this.inTx = true
        else if (/^\s*(COMMIT|END|ROLLBACK)\b/i.test(text)) this.inTx = false
        if (!looksLikeRead(text)) wrote = true
      } finally {
        stmt.free()
      }
    }
    if (wrote && !this.inTx) this.persist()
    return results
  }

  async transaction(fn: (exec: Exec) => Promise<void>) {
    this.db.run('BEGIN')
    try {
      await fn(async (sql, params) => {
        this.db.run(sql, bindable(params))
        return this.db.getRowsModified()
      })
      this.db.run('COMMIT')
    } catch (e) {
      try {
        this.db.run('ROLLBACK')
      } catch {
        /* işlem zaten bitmiş */
      }
      throw e
    }
    this.persist()
  }
}
