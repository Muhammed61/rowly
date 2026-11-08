import type {
  Cell,
  ColumnInfo,
  FetchOptions,
  FetchResult,
  Filter,
  IndexInfo,
  QueryResult,
  RowChange,
  ServerInfo,
  TableInfo,
  TableRef,
  ForeignKeyInfo,
  FkAction
} from '@shared/types'

/** Satır satır gelen foreign key sütunlarını kısıt başına gruplar. */
export function groupFks(
  rows: { name: string; col: string; refSchema: string; refTable: string; refCol: string; onDelete: string; onUpdate: string }[]
): ForeignKeyInfo[] {
  const act = (s: string): FkAction => {
    const a = s.toUpperCase().replace(/_/g, ' ').trim()
    return (['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'].includes(a) ? a : 'NO ACTION') as FkAction
  }
  const out = new Map<string, ForeignKeyInfo>()
  for (const r of rows) {
    const fk = out.get(r.name) ?? { name: r.name, columns: [], refSchema: r.refSchema, refTable: r.refTable, refColumns: [], onDelete: act(r.onDelete), onUpdate: act(r.onUpdate) }
    fk.columns.push(r.col)
    fk.refColumns.push(r.refCol)
    out.set(r.name, fk)
  }
  return [...out.values()]
}

export type Params = unknown[]

/** Bir veritabanı türünün SQL lehçesi: tırnaklama, parametre, sayfalama. */
export interface Dialect {
  quote(name: string): string
  placeholder(index: number): string
  /** Tam nitelikli tablo adı */
  table(ref: TableRef): string
  paginate(sql: string, limit: number, offset: number, hasOrder: boolean): string
  castText(expr: string): string
  /** Değeri SQL betiğine yazılabilecek sabite çevirir (dışa aktarma) */
  literal(v: Cell): string
}

/** Tek bir işlem (transaction) içinde parametreli komut çalıştırır, etkilenen satır sayısını döner. */
export type Exec = (sql: string, params: Params) => Promise<number>

export abstract class Driver {
  abstract readonly dialect: Dialect

  abstract connect(): Promise<void>
  abstract close(): Promise<void>
  abstract serverInfo(): Promise<ServerInfo>
  abstract listDatabases(): Promise<string[]>
  abstract useDatabase(name: string): Promise<void>
  abstract listTables(): Promise<TableInfo[]>
  abstract getColumns(ref: TableRef): Promise<ColumnInfo[]>
  abstract getIndexes(ref: TableRef): Promise<IndexInfo[]>
  async getForeignKeys(_ref: TableRef): Promise<ForeignKeyInfo[]> {
    return []
  }
  abstract getDDL(ref: TableRef): Promise<string>
  /** Parametreli SELECT: sütun sırası korunmuş sonuç */
  abstract select(sql: string, params: Params): Promise<QueryResult>
  /** Kullanıcının yazdığı (çoklu ifade olabilen) SQL */
  abstract rawQuery(sql: string): Promise<QueryResult[]>
  abstract transaction(fn: (exec: Exec) => Promise<void>): Promise<void>

  protected buildWhere(filters: Filter[] | undefined, params: Params): string {
    if (!filters?.length) return ''
    const d = this.dialect
    const parts: string[] = []
    for (const f of filters) {
      if (!f.column) continue
      const col = d.quote(f.column)
      const ph = () => {
        params.push(f.value)
        return d.placeholder(params.length)
      }
      switch (f.op) {
        case 'IS NULL':
          parts.push(`${col} IS NULL`)
          break
        case 'IS NOT NULL':
          parts.push(`${col} IS NOT NULL`)
          break
        case 'CONTAINS':
          // Büyük/küçük harf ve Türkçe İ/ı duyarsız: iki taraf da aynı şekilde katlanır
          params.push(`%${foldText(f.value)}%`)
          parts.push(`${foldSql(d, d.castText(col))} LIKE ${d.placeholder(params.length)}`)
          break
        case 'LIKE':
        case 'NOT LIKE':
          parts.push(`${d.castText(col)} ${f.op} ${ph()}`)
          break
        case 'IN': {
          const items = f.value
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length)
          if (!items.length) break
          const phs = items.map((v) => {
            params.push(v)
            return d.placeholder(params.length)
          })
          parts.push(`${col} IN (${phs.join(', ')})`)
          break
        }
        default:
          parts.push(`${col} ${f.op} ${ph()}`)
      }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : ''
  }

  async fetchRows(opts: FetchOptions): Promise<FetchResult> {
    const d = this.dialect
    const params: Params = []
    const where = this.buildWhere(opts.filters, params)
    const order = opts.orderBy ? ` ORDER BY ${d.quote(opts.orderBy.column)} ${opts.orderBy.dir === 'DESC' ? 'DESC' : 'ASC'}` : ''
    const base = `SELECT * FROM ${d.table(opts.table)}${where}${order}`
    const sql = d.paginate(base, opts.limit, opts.offset, !!order)
    const started = Date.now()
    const result = await this.select(sql, params)
    result.durationMs = Date.now() - started
    if (opts.skipCount) return { result, total: -1 }
    const countRes = await this.select(`SELECT COUNT(*) FROM ${d.table(opts.table)}${where}`, [...params])
    const total = Number(countRes.rows[0]?.[0] ?? 0)
    return { result, total }
  }

  async applyChanges(ref: TableRef, changes: RowChange[]): Promise<number> {
    const d = this.dialect
    let affected = 0
    await this.transaction(async (exec) => {
      for (const ch of changes) {
        const params: Params = []
        const p = (v: Cell) => {
          params.push(v)
          return d.placeholder(params.length)
        }
        const whereOf = (pk: Record<string, Cell>) =>
          Object.entries(pk)
            .map(([k, v]) => (v === null ? `${d.quote(k)} IS NULL` : `${d.quote(k)} = ${p(v)}`))
            .join(' AND ')

        let sql: string
        if (ch.kind === 'insert') {
          const cols = Object.keys(ch.values)
          sql = cols.length
            ? `INSERT INTO ${d.table(ref)} (${cols.map((c) => d.quote(c)).join(', ')}) VALUES (${cols
                .map((c) => p(ch.values[c]))
                .join(', ')})`
            : `INSERT INTO ${d.table(ref)} DEFAULT VALUES`
        } else if (ch.kind === 'update') {
          const sets = Object.entries(ch.values)
            .map(([k, v]) => `${d.quote(k)} = ${p(v)}`)
            .join(', ')
          if (!sets) continue
          sql = `UPDATE ${d.table(ref)} SET ${sets} WHERE ${whereOf(ch.pk)}`
        } else {
          sql = `DELETE FROM ${d.table(ref)} WHERE ${whereOf(ch.pk)}`
        }
        affected += await exec(sql, params)
      }
    })
    return affected
  }

  /**
   * Tüm satırları parti parti dolaşır (dışa aktarma). Sıra kararlı olsun diye
   * birincil anahtara göre sıralar; sayım her partide tekrarlanmaz.
   */
  async *iterateRows(ref: TableRef, filters?: Filter[], orderBy?: FetchOptions['orderBy'], batch = 2000): AsyncGenerator<QueryResult> {
    let order = orderBy ?? null
    if (!order) {
      const pk = (await this.getColumns(ref).catch(() => [] as ColumnInfo[])).find((c) => c.primaryKey)
      if (pk) order = { column: pk.name, dir: 'ASC' }
    }
    for (let offset = 0; ; offset += batch) {
      const { result } = await this.fetchRows({ table: ref, limit: batch, offset, orderBy: order, filters, skipCount: true })
      if (!result.rows.length) return
      yield result
      if (result.rows.length < batch) return
    }
  }

  async countRows(ref: TableRef, filters?: Filter[]): Promise<number> {
    return (await this.fetchRows({ table: ref, limit: 1, offset: 0, filters })).total
  }

  /** NoSQL sürücüleri: tip kaybı olmadan JSON doküman akışı (her eleman bir JSON metni) */
  iterateDocuments?(ref: TableRef, filters?: Filter[]): AsyncGenerator<string[]>
  /** NoSQL sürücüleri: JSON dokümanlarını içe aktarır */
  importDocuments?(ref: TableRef, docs: string[], overwrite: boolean): Promise<{ n: number; errors: string[] }>

  /** Şema bilgisinden yaklaşık CREATE TABLE üretir (yerleşik DDL'i olmayan sürücüler için). */
  protected async synthesizeDDL(ref: TableRef): Promise<string> {
    const d = this.dialect
    const cols = await this.getColumns(ref)
    const idx = await this.getIndexes(ref)
    const lines = cols.map((c) => {
      let s = `  ${d.quote(c.name)} ${c.type}`
      if (!c.nullable) s += ' NOT NULL'
      if (c.defaultValue !== null && c.defaultValue !== undefined) s += ` DEFAULT ${c.defaultValue}`
      return s
    })
    const pk = cols.filter((c) => c.primaryKey).map((c) => d.quote(c.name))
    if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`)
    let ddl = `CREATE TABLE ${d.table(ref)} (\n${lines.join(',\n')}\n);`
    for (const i of idx.filter((i) => !i.primary)) {
      ddl += `\n\nCREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${d.quote(i.name)} ON ${d.table(ref)} (${i.columns});`
    }
    return ddl
  }
}

/** Sürücülerden gelen ham değeri arayüzde gösterilebilir sade tipe çevirir. */
export function normalizeCell(v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return String(v)
    return v.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '')
  }
  if (v instanceof Uint8Array) {
    if (v.length <= 64) return '0x' + Buffer.from(v).toString('hex')
    return `<BLOB ${v.length} bayt>`
  }
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const normalizeRow = (row: unknown[]): Cell[] => row.map(normalizeCell)

/** SQL'in kabaca satır döndüren bir sorgu olup olmadığı */
export const looksLikeRead = (sql: string): boolean =>
  /^\s*(\(?\s*select|with|show|pragma|explain|describe|desc|values|table)\b/i.test(sql.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*/g, ''))

/** SQL sabiti üretir: metinler tırnaklanır ve kaçış uygulanır. */
export function sqlLiteral(v: Cell, o: { backslash?: boolean; unicodePrefix?: boolean; bool: (b: boolean) => string }): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return o.bool(v)
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  let s = String(v).replace(/'/g, "''")
  if (o.backslash) s = s.replace(/\\/g, '\\\\').replace(/\0/g, '\\0')
  return `${o.unicodePrefix ? 'N' : ''}'${s}'`
}

/** Türkçe dahil büyük/küçük harf katlama (JS tarafı) */
export const foldText = (s: string) => s.replace(/[İIı]/g, 'i').toLowerCase()

/**
 * Aynı katlamanın SQL karşılığı. SQLite'ın LOWER'ı yalnızca ASCII harfleri çevirdiği için
 * Türkçe büyük harfler ayrıca REPLACE ile küçültülür.
 */
export function foldSql(d: Dialect, expr: string): string {
  let e = expr
  for (const [from, to] of [['İ', 'i'], ['I', 'i'], ['ı', 'i'], ['Ş', 'ş'], ['Ğ', 'ğ'], ['Ü', 'ü'], ['Ö', 'ö'], ['Ç', 'ç']])
    e = `REPLACE(${e}, ${d.literal(from)}, ${d.literal(to)})`
  return `LOWER(${e})`
}
