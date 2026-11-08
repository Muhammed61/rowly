import vm from 'node:vm'
import {
  Binary,
  Decimal128,
  Double,
  BSON,
  Int32,
  Long,
  MongoClient,
  ObjectId,
  type Collection,
  type Db,
  type Document,
  type Filter as MongoFilter,
  type Sort
} from 'mongodb'
import type {
  Cell,
  ColumnInfo,
  ConnectionConfig,
  FetchOptions,
  FetchResult,
  Filter,
  IndexInfo,
  QueryResult,
  RowChange,
  ServerInfo,
  TableInfo,
  TableRef
} from '@shared/types'
import { Driver, type Dialect } from './base'

const { EJSON } = BSON

const SAMPLE = 300
const SHELL_LIMIT = 1000
/** Okurken Int32/Long/Double'ı JS sayısına çevirme: düzenlerken orijinal tip korunsun. */
const RAW = { promoteValues: false } as const

const noSqlDialect: Dialect = {
  quote: (n) => n,
  placeholder: () => '?',
  table: (r) => r.name,
  paginate: (s) => s,
  castText: (e) => e,
  literal: (v) => JSON.stringify(v)
}

// ---------- Değer dönüşümleri ----------

const bsonType = (v: unknown): string | undefined => (v && typeof v === 'object' ? (v as { _bsontype?: string })._bsontype : undefined)

function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (v instanceof Date) return 'date'
  if (Array.isArray(v)) return 'array'
  const bt = bsonType(v)
  if (bt) return ({ ObjectId: 'objectId', Int32: 'int', Double: 'double', Long: 'long', Decimal128: 'decimal' } as Record<string, string>)[bt] ?? bt.toLowerCase()
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'string') return 'string'
  return 'object'
}

/** BSON değerini arayüzde gösterilecek (ve geri çevrilebilecek) sade değere çevirir. */
export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString()
  const bt = bsonType(v)
  if (bt === 'ObjectId') return (v as ObjectId).toHexString()
  if (bt === 'Decimal128' || bt === 'Long') return v.toString()
  if (bt === 'Int32' || bt === 'Double') return Number((v as Int32).valueOf())
  if (bt === 'Binary') {
    const b = v as Binary
    return b.sub_type === 4 ? b.toUUID().toString() : `<Binary ${b.length()} bayt>`
  }
  return EJSON.stringify(v, { relaxed: true })
}

/** Yeni bir alan için metinden makul bir tip çıkarır. */
function inferValue(text: string): unknown {
  const t = text.trim()
  if (/^[[{]/.test(t)) {
    try {
      return EJSON.parse(t, { relaxed: true })
    } catch {
      return text
    }
  }
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(t)) return Number(t)
  if (t === 'true' || t === 'false') return t === 'true'
  return text
}

/** Düzenlenen metni, alanın mevcut BSON tipine geri çevirir. */
function coerce(field: string, value: Cell, orig: unknown): unknown {
  if (value === null) return null
  if (typeof value !== 'string') return value
  const fail = (what: string) => {
    throw new Error(`"${field}" alanı ${what} olmalı: ${value}`)
  }
  if (orig === undefined || orig === null) return inferValue(value)
  if (orig instanceof Date) {
    const d = new Date(value)
    if (isNaN(d.getTime())) fail('geçerli bir tarih')
    return d
  }
  switch (bsonType(orig)) {
    case 'ObjectId':
      return ObjectId.isValid(value) && value.length === 24 ? new ObjectId(value) : fail('24 karakterlik bir ObjectId')
    case 'Long':
      return Long.fromString(value.trim())
    case 'Int32':
      return Number.isInteger(Number(value)) ? new Int32(Number(value)) : fail('tam sayı')
    case 'Double':
      return isNaN(Number(value)) ? fail('sayı') : new Double(Number(value))
    case 'Decimal128':
      return Decimal128.fromString(value.trim())
  }
  if (typeof orig === 'number') {
    const n = Number(value)
    if (value.trim() === '' || isNaN(n)) fail('sayı')
    return n
  }
  if (typeof orig === 'boolean') {
    if (/^(true|1)$/i.test(value.trim())) return true
    if (/^(false|0)$/i.test(value.trim())) return false
    fail('true/false')
  }
  if (typeof orig === 'object') {
    try {
      return EJSON.parse(value, { relaxed: true })
    } catch {
      fail('geçerli JSON')
    }
  }
  return value
}

/** Filtre değerini olası tiplerine açar: "5" hem sayı 5 hem metin "5" ile eşleşsin. */
function candidates(raw: string): unknown[] {
  const t = raw.trim()
  const out: unknown[] = [raw]
  if (/^-?\d+(\.\d+)?$/.test(t)) out.push(Number(t))
  if (t === 'true' || t === 'false') out.push(t === 'true')
  if (t.length === 24 && ObjectId.isValid(t)) out.push(new ObjectId(t))
  return out
}

function scalar(raw: string): unknown {
  const t = raw.trim()
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (/^\d{4}-\d{2}-\d{2}([ T][\d:.]+Z?)?$/.test(t)) return new Date(t)
  return raw
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Türkçe İ/I/ı/i harflerini eşdeğer sayar (MongoDB'nin i bayrağı bunu yapmaz). */
const trFold = (re: string) => re.replace(/[iIİı]/g, '[iIİı]')
const likeToRe = (s: string) => new RegExp('^' + trFold(escapeRe(s)).replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i')

function buildFilter(filters: Filter[] | undefined): Document {
  const and: Document[] = []
  for (const f of filters ?? []) {
    if (!f.column) continue
    const c = f.column
    switch (f.op) {
      case '=':
        and.push({ [c]: { $in: candidates(f.value) } })
        break
      case '!=':
        and.push({ [c]: { $nin: candidates(f.value) } })
        break
      case '<':
        and.push({ [c]: { $lt: scalar(f.value) } })
        break
      case '>':
        and.push({ [c]: { $gt: scalar(f.value) } })
        break
      case '<=':
        and.push({ [c]: { $lte: scalar(f.value) } })
        break
      case '>=':
        and.push({ [c]: { $gte: scalar(f.value) } })
        break
      case 'CONTAINS':
        and.push({ [c]: { $regex: trFold(escapeRe(f.value)), $options: 'i' } })
        break
      case 'LIKE':
        and.push({ [c]: { $regex: likeToRe(f.value) } })
        break
      case 'NOT LIKE':
        and.push({ [c]: { $not: likeToRe(f.value) } })
        break
      case 'IN':
        and.push({ [c]: { $in: f.value.split(',').flatMap((v) => candidates(v.trim())) } })
        break
      case 'IS NULL':
        and.push({ [c]: null })
        break
      case 'IS NOT NULL':
        and.push({ [c]: { $ne: null } })
        break
    }
  }
  return and.length === 0 ? {} : and.length === 1 ? and[0] : { $and: and }
}

/** Arayüzdeki _id değerini (genelde ObjectId hex) sorgu koşuluna çevirir. */
const idFilter = (id: Cell): Document => {
  if (id === null) return { _id: null }
  return { _id: { $in: candidates(String(id)) } }
}

function docsToResult(docs: Document[], ms: number, preferred: string[] = []): QueryResult {
  const cols: string[] = [...preferred]
  const seen = new Set(cols)
  for (const d of docs)
    for (const k of Object.keys(d))
      if (!seen.has(k)) {
        seen.add(k)
        cols.push(k)
      }
  if (seen.has('_id') && cols[0] !== '_id') cols.splice(cols.indexOf('_id'), 1), cols.unshift('_id')
  return {
    columns: cols.map((name) => ({ name })),
    rows: docs.map((d) => cols.map((c) => (c in d ? toCell(d[c]) : null))),
    rowsAffected: null,
    durationMs: ms,
    isCommand: false
  }
}

function valueToResult(v: unknown, ms: number): QueryResult {
  if (Array.isArray(v)) {
    if (v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && !bsonType(x) && !(x instanceof Date))) return docsToResult(v as Document[], ms)
    return { columns: [{ name: 'değer' }], rows: v.map((x) => [toCell(x)]), rowsAffected: null, durationMs: ms, isCommand: false }
  }
  if (v && typeof v === 'object' && !bsonType(v) && !(v instanceof Date)) return docsToResult([v as Document], ms)
  return { columns: [{ name: 'sonuç' }], rows: [[toCell(v)]], rowsAffected: null, durationMs: ms, isCommand: false }
}

const command = (n: number, ms: number): QueryResult => ({ columns: [], rows: [], rowsAffected: n, durationMs: ms, isCommand: true })

// ---------- mongosh benzeri sorgu çalıştırma ----------

interface Op {
  target: 'db' | 'coll'
  coll?: string
  method: string
  args: unknown[]
  mods: { name: string; args: unknown[] }[]
}

const DB_METHODS = new Set([
  'getCollection',
  'runCommand',
  'adminCommand',
  'getCollectionNames',
  'getCollectionInfos',
  'createCollection',
  'createView',
  'dropDatabase',
  'stats',
  'getName',
  'version',
  'serverStatus'
])

/** vm bağlamından gelen nesneleri ana bağlama taşır (Date/RegExp/dizi örnekleri farklı "realm"de oluşur). */
function toHost(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (bsonType(v)) return v
  const tag = Object.prototype.toString.call(v)
  if (tag === '[object Date]') return new Date((v as Date).getTime())
  if (tag === '[object RegExp]') return new RegExp((v as RegExp).source, (v as RegExp).flags)
  if (Array.isArray(v)) return v.map(toHost)
  const out: Document = {}
  for (const [k, x] of Object.entries(v)) out[k] = toHost(x)
  return out
}

/** Kullanıcının yazdığı mongosh sözdizimini çalıştırmadan, yapılacak işlemlerin listesine çevirir. */
function parseShell(script: string): Op[] {
  const ops: Op[] = []
  const chain = (op: Op): unknown =>
    new Proxy(function () {}, {
      get: (_t, name) => {
        if (name === 'then' || typeof name === 'symbol') return undefined
        return (...args: unknown[]) => {
          op.mods.push({ name: String(name), args })
          return chain(op)
        }
      }
    })
  const collProxy = (coll: string) =>
    new Proxy(
      {},
      {
        get: (_t, method) => {
          if (method === 'then' || typeof method === 'symbol') return undefined
          return (...args: unknown[]) => {
            const op: Op = { target: 'coll', coll, method: String(method), args, mods: [] }
            ops.push(op)
            return chain(op)
          }
        }
      }
    )
  const db = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'then' || typeof name === 'symbol') return undefined
        const n = String(name)
        if (n === 'getCollection' || n === 'getSiblingDB') return (c: string) => collProxy(String(c))
        if (DB_METHODS.has(n))
          return (...args: unknown[]) => {
            const op: Op = { target: 'db', method: n, args, mods: [] }
            ops.push(op)
            return chain(op)
          }
        return collProxy(n)
      }
    }
  )
  const ctx = vm.createContext({
    db,
    ObjectId: (h?: string) => (h === undefined ? new ObjectId() : new ObjectId(h)),
    ISODate: (s?: string) => (s === undefined ? new Date() : new Date(s)),
    Date,
    NumberLong: (v: string | number) => Long.fromString(String(v)),
    NumberInt: (v: number) => new Int32(Number(v)),
    NumberDecimal: (v: string) => Decimal128.fromString(String(v)),
    UUID: (s?: string) => (s ? Binary.createFromHexString(s.replace(/-/g, ''), 4) : new Binary(Buffer.from(crypto.randomUUID().replace(/-/g, ''), 'hex'), 4)),
    print: () => {},
    printjson: () => {}
  })
  vm.runInContext(script, ctx, { timeout: 2000, filename: 'sorgu.js' })
  for (const op of ops) {
    op.args = op.args.map(toHost)
    op.mods = op.mods.map((m) => ({ name: m.name, args: m.args.map(toHost) }))
  }
  return ops
}

export class MongoDriver extends Driver {
  readonly dialect = noSqlDialect
  private client!: MongoClient
  private dbName: string

  constructor(private cfg: ConnectionConfig) {
    super()
    this.dbName = cfg.database || ''
  }

  private uri(): string {
    if (this.cfg.uri?.trim()) return this.cfg.uri.trim()
    const auth = this.cfg.user ? `${encodeURIComponent(this.cfg.user)}:${encodeURIComponent(this.cfg.password)}@` : ''
    const params = new URLSearchParams()
    if (this.cfg.user) params.set('authSource', 'admin')
    if (this.cfg.ssl) params.set('tls', 'true')
    params.set('directConnection', 'true')
    return `mongodb://${auth}${this.cfg.host || '127.0.0.1'}:${this.cfg.port || 27017}/?${params}`
  }

  private get db(): Db {
    if (!this.dbName) throw new Error('Önce bir veritabanı seçin.')
    return this.client.db(this.dbName)
  }

  private coll(ref: TableRef): Collection {
    return this.db.collection(ref.name)
  }

  async connect() {
    this.client = new MongoClient(this.uri(), { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 })
    await this.client.connect()
    if (!this.dbName) {
      // URI içinde veritabanı adı varsa onu kullan
      const fromUri = this.client.db().databaseName
      if (fromUri && fromUri !== 'test') this.dbName = fromUri
    }
    await this.client.db(this.dbName || 'admin').command({ ping: 1 })
  }

  async close() {
    await this.client?.close().catch(() => {})
  }

  async serverInfo(): Promise<ServerInfo> {
    let version = ''
    try {
      version = String((await this.client.db('admin').command({ buildInfo: 1 })).version ?? '')
    } catch {
      /* yetki yoksa sürüm bilinmez */
    }
    return { version: `MongoDB ${version}`.trim(), currentDatabase: this.dbName }
  }

  async listDatabases() {
    try {
      const r = await this.client.db('admin').admin().listDatabases({ nameOnly: true })
      return r.databases.map((d) => d.name).sort()
    } catch {
      return this.dbName ? [this.dbName] : []
    }
  }

  async useDatabase(name: string) {
    this.dbName = name
  }

  async listTables(): Promise<TableInfo[]> {
    if (!this.dbName) return []
    const list = await this.db.listCollections({}, { nameOnly: false }).toArray()
    return list
      .filter((c) => !c.name.startsWith('system.'))
      .map((c) => ({ schema: this.dbName, name: c.name, kind: c.type === 'view' ? ('view' as const) : ('table' as const) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** MongoDB şemasızdır: alanları örnek dokümanlardan çıkarırız. */
  async getColumns(ref: TableRef): Promise<ColumnInfo[]> {
    const docs = await this.coll(ref).find({}, RAW).limit(SAMPLE).toArray()
    const order: string[] = []
    const types = new Map<string, Map<string, number>>()
    const present = new Map<string, number>()
    for (const d of docs) {
      for (const [k, v] of Object.entries(d)) {
        if (!types.has(k)) {
          types.set(k, new Map())
          order.push(k)
        }
        const t = typeName(v)
        const m = types.get(k)!
        m.set(t, (m.get(t) ?? 0) + 1)
        present.set(k, (present.get(k) ?? 0) + 1)
      }
    }
    if (!types.has('_id')) order.unshift('_id')
    else order.splice(order.indexOf('_id'), 1), order.unshift('_id')
    return order.map((name) => {
      const m = types.get(name) ?? new Map([['objectId', 1]])
      const ts = [...m.entries()].filter(([t]) => t !== 'null').sort((a, b) => b[1] - a[1]).map(([t]) => t)
      const missing = docs.length - (present.get(name) ?? 0)
      return {
        name,
        type: ts.length ? ts.slice(0, 3).join(' | ') : 'null',
        nullable: name !== '_id' && (missing > 0 || m.has('null')),
        defaultValue: null,
        primaryKey: name === '_id',
        autoIncrement: name === '_id',
        extra: name === '_id' ? 'otomatik' : missing > 0 ? `${docs.length - missing}/${docs.length} dokümanda` : '',
        comment: ''
      }
    })
  }

  async getIndexes(ref: TableRef): Promise<IndexInfo[]> {
    try {
      const idx = await this.coll(ref).indexes()
      return idx.map((i) => ({
        name: String(i.name),
        columns: Object.entries(i.key)
          .map(([k, v]) => (v === 1 ? k : `${k} (${v})`))
          .join(', '),
        unique: !!i.unique || i.name === '_id_',
        primary: i.name === '_id_'
      }))
    } catch {
      return []
    }
  }

  async getDDL(ref: TableRef) {
    const info = (await this.db.listCollections({ name: ref.name }).toArray())[0] as { type?: string; options?: Document } | undefined
    const name = JSON.stringify(ref.name)
    const opts = info?.options && Object.keys(info.options).length ? `, ${EJSON.stringify(info.options, undefined, 2, { relaxed: true })}` : ''
    let out = info?.type === 'view' ? `db.createView(${name}, ${JSON.stringify(info.options?.viewOn)}, ${EJSON.stringify(info.options?.pipeline ?? [], undefined, 2)})` : `db.createCollection(${name}${opts})`
    for (const i of (await this.coll(ref).indexes().catch(() => [])).filter((i) => i.name !== '_id_')) {
      const o: Document = { name: i.name }
      if (i.unique) o.unique = true
      if (i.sparse) o.sparse = true
      if (i.expireAfterSeconds !== undefined) o.expireAfterSeconds = i.expireAfterSeconds
      out += `\n\ndb.getCollection(${name}).createIndex(${JSON.stringify(i.key)}, ${JSON.stringify(o)})`
    }
    return out + '\n'
  }

  async fetchRows(opts: FetchOptions): Promise<FetchResult> {
    const coll = this.coll(opts.table)
    const filter = buildFilter(opts.filters) as MongoFilter<Document>
    const sort: Sort | undefined = opts.orderBy ? { [opts.orderBy.column]: opts.orderBy.dir === 'DESC' ? -1 : 1 } : undefined
    const started = Date.now()
    let cursor = coll.find(filter, RAW).skip(Math.floor(opts.offset)).limit(Math.floor(opts.limit))
    if (sort) cursor = cursor.sort(sort)
    const [docs, total, cols] = await Promise.all([
      cursor.toArray(),
      opts.skipCount
        ? Promise.resolve(-1)
        : Object.keys(filter).length
          ? coll.countDocuments(filter)
          : coll.estimatedDocumentCount().catch(() => coll.countDocuments({})),
      this.getColumns(opts.table).catch(() => [] as ColumnInfo[])
    ])
    return { result: docsToResult(docs, Date.now() - started, cols.map((c) => c.name)), total }
  }

  private cursorFor(ref: TableRef, filters?: Filter[], orderBy?: FetchOptions['orderBy'], batch = 2000) {
    const sort: Sort = orderBy ? { [orderBy.column]: orderBy.dir === 'DESC' ? -1 : 1 } : { _id: 1 }
    return this.coll(ref)
      .find(buildFilter(filters) as MongoFilter<Document>, { ...RAW, batchSize: batch })
      .sort(sort)
  }

  /** Dışa aktarma: atlama (skip) yerine tek imleçle parti parti gezer. */
  async *iterateRows(ref: TableRef, filters?: Filter[], orderBy?: FetchOptions['orderBy'], batch = 2000): AsyncGenerator<QueryResult> {
    const cols = (await this.getColumns(ref)).map((c) => c.name)
    let buf: Document[] = []
    for await (const d of this.cursorFor(ref, filters, orderBy, batch)) {
      buf.push(d)
      if (buf.length >= batch) {
        yield docsToResult(buf, 0, cols)
        buf = []
      }
    }
    if (buf.length) yield docsToResult(buf, 0, cols)
  }

  /** Tip bilgisini koruyan EJSON (mongoexport ile aynı "relaxed" biçim) */
  async *iterateDocuments(ref: TableRef, filters?: Filter[]): AsyncGenerator<string[]> {
    let buf: string[] = []
    for await (const d of this.cursorFor(ref, filters)) {
      buf.push(EJSON.stringify(d, { relaxed: true }))
      if (buf.length >= 2000) {
        yield buf
        buf = []
      }
    }
    if (buf.length) yield buf
  }

  async importDocuments(ref: TableRef, docs: string[], overwrite: boolean): Promise<{ n: number; errors: string[] }> {
    const errors: string[] = []
    const ops: Document[] = []
    for (const text of docs) {
      let d: unknown
      try {
        d = EJSON.parse(text, { relaxed: true })
      } catch {
        errors.push(`Geçersiz JSON: ${text.slice(0, 80)}`)
        continue
      }
      if (!d || typeof d !== 'object' || Array.isArray(d)) {
        errors.push(`Doküman bir JSON nesnesi olmalı: ${text.slice(0, 80)}`)
        continue
      }
      const doc = d as Document
      ops.push(
        overwrite && doc._id !== undefined
          ? { replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } }
          : { insertOne: { document: doc } }
      )
    }
    if (!ops.length) return { n: 0, errors }
    try {
      const r = await this.coll(ref).bulkWrite(ops as never, { ordered: false })
      return { n: r.insertedCount + r.upsertedCount + r.matchedCount, errors }
    } catch (e) {
      const err = e as { result?: { insertedCount?: number; upsertedCount?: number; matchedCount?: number }; writeErrors?: unknown; message: string }
      const we = err.writeErrors ? (Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors]) : []
      if (!err.result && !we.length) throw e
      errors.push(...we.map((w: { errmsg?: string }) => w?.errmsg ?? String(w)))
      const r = err.result ?? {}
      return { n: (r.insertedCount ?? 0) + (r.upsertedCount ?? 0) + (r.matchedCount ?? 0), errors }
    }
  }

  /** MongoDB tek sunucuda işlem (transaction) desteklemez; değişiklikler sırayla uygulanır. */
  async applyChanges(ref: TableRef, changes: RowChange[]): Promise<number> {
    const coll = this.coll(ref)
    let n = 0
    for (const ch of changes) {
      if (ch.kind === 'delete') {
        n += (await coll.deleteOne(idFilter(ch.pk._id ?? null))).deletedCount
      } else if (ch.kind === 'update') {
        const filter = idFilter(ch.pk._id ?? null)
        const orig = await coll.findOne(filter, RAW)
        if (!orig) throw new Error(`Doküman bulunamadı: ${ch.pk._id}`)
        const set: Document = {}
        for (const [k, v] of Object.entries(ch.values)) {
          if (k === '_id') throw new Error('_id alanı değiştirilemez.')
          set[k] = coerce(k, v, orig[k])
        }
        if (Object.keys(set).length) n += (await coll.updateOne({ _id: orig._id }, { $set: set })).matchedCount
      } else {
        const doc: Document = {}
        for (const [k, v] of Object.entries(ch.values)) {
          if (k === '_id' && typeof v === 'string' && v.length === 24 && ObjectId.isValid(v)) doc._id = new ObjectId(v)
          else doc[k] = v === null ? null : typeof v === 'string' ? inferValue(v) : v
        }
        await coll.insertOne(doc)
        n++
      }
    }
    return n
  }

  async rawQuery(script: string): Promise<QueryResult[]> {
    let ops: Op[]
    try {
      ops = parseShell(script)
    } catch (e) {
      throw new Error(`Sorgu çözümlenemedi: ${(e as Error).message}`)
    }
    if (!ops.length) throw new Error('Çalıştırılacak bir komut bulunamadı. Örnek: db.users.find({ age: { $gt: 18 } })')
    const out: QueryResult[] = []
    for (const op of ops) {
      const t = Date.now()
      out.push(await this.runOp(op, t))
    }
    return out
  }

  private async runOp(op: Op, t: number): Promise<QueryResult> {
    const ms = () => Date.now() - t
    const a = op.args as never[]
    if (op.target === 'db') {
      const db = this.db
      switch (op.method) {
        case 'getCollectionNames':
          return valueToResult((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort(), ms())
        case 'getCollectionInfos':
          return valueToResult(await db.listCollections(a[0] ?? {}).toArray(), ms())
        case 'createCollection':
          await db.createCollection(a[0], a[1])
          return command(0, ms())
        case 'createView':
          await db.createCollection(a[0], { viewOn: a[1], pipeline: a[2] ?? [] })
          return command(0, ms())
        case 'dropDatabase':
          await db.dropDatabase()
          return command(0, ms())
        case 'stats':
          return valueToResult(await db.stats(), ms())
        case 'getName':
          return valueToResult(db.databaseName, ms())
        case 'version':
          return valueToResult((await this.client.db('admin').command({ buildInfo: 1 })).version, ms())
        case 'serverStatus':
          return valueToResult(await this.client.db('admin').command({ serverStatus: 1 }), ms())
        case 'adminCommand':
          return valueToResult(await this.client.db('admin').command(a[0]), ms())
        default:
          return valueToResult(await db.command(a[0]), ms())
      }
    }

    const coll = this.db.collection(op.coll!)
    const mod = (name: string) => op.mods.find((m) => m.name === name)?.args[0] as never
    switch (op.method) {
      case 'find': {
        let c = coll.find(a[0] ?? {}, a[1] ? { projection: a[1], ...RAW } : RAW)
        for (const m of op.mods) {
          const v = m.args[0] as never
          if (m.name === 'sort') c = c.sort(v)
          else if (m.name === 'limit') c = c.limit(v)
          else if (m.name === 'skip') c = c.skip(v)
          else if (m.name === 'project' || m.name === 'projection') c = c.project(v)
          else if (m.name === 'hint') c = c.hint(v)
          else if (m.name === 'maxTimeMS') c = c.maxTimeMS(v)
          else if (m.name === 'collation') c = c.collation(v)
          else if (m.name === 'count' || m.name === 'itcount' || m.name === 'size') return valueToResult(await coll.countDocuments(a[0] ?? {}), ms())
        }
        if (!op.mods.some((m) => m.name === 'limit')) c = c.limit(SHELL_LIMIT)
        return docsToResult(await c.toArray(), ms())
      }
      case 'findOne': {
        const d = await coll.findOne(a[0] ?? {}, a[1] ? { projection: a[1], ...RAW } : RAW)
        return docsToResult(d ? [d] : [], ms())
      }
      case 'aggregate': {
        let c = coll.aggregate(a[0] ?? [], { ...RAW, ...(a[1] as object) })
        if (!(a[0] as Document[] | undefined)?.some((s) => '$out' in s || '$merge' in s) && !mod('limit')) c = c.limit(SHELL_LIMIT)
        return docsToResult(await c.toArray(), ms())
      }
      case 'count':
      case 'countDocuments':
        return valueToResult(await coll.countDocuments(a[0] ?? {}), ms())
      case 'estimatedDocumentCount':
        return valueToResult(await coll.estimatedDocumentCount(), ms())
      case 'distinct':
        return valueToResult(await coll.distinct(a[0], a[1] ?? {}), ms())
      case 'insertOne':
        await coll.insertOne(a[0])
        return command(1, ms())
      case 'insert':
      case 'insertMany': {
        const docs = Array.isArray(a[0]) ? (a[0] as Document[]) : [a[0] as Document]
        return command((await coll.insertMany(docs)).insertedCount, ms())
      }
      case 'updateOne':
        return command((await coll.updateOne(a[0], a[1], a[2])).modifiedCount, ms())
      case 'updateMany':
      case 'update':
        return command((await coll.updateMany(a[0], a[1], a[2])).modifiedCount, ms())
      case 'replaceOne':
        return command((await coll.replaceOne(a[0], a[1], a[2])).modifiedCount, ms())
      case 'deleteOne':
        return command((await coll.deleteOne(a[0] ?? {})).deletedCount, ms())
      case 'deleteMany':
      case 'remove':
        return command((await coll.deleteMany(a[0] ?? {})).deletedCount, ms())
      case 'drop':
        await coll.drop()
        return command(0, ms())
      case 'createIndex':
        return valueToResult(await coll.createIndex(a[0], a[1] ?? {}), ms())
      case 'dropIndex':
        await coll.dropIndex(a[0])
        return command(0, ms())
      case 'getIndexes':
      case 'indexes':
        return docsToResult((await coll.indexes()) as Document[], ms())
      case 'renameCollection':
        await coll.rename(a[0])
        return command(0, ms())
      case 'stats':
        return valueToResult(await this.db.command({ collStats: op.coll }), ms())
      default: {
        const fn = (coll as unknown as Record<string, unknown>)[op.method]
        if (typeof fn !== 'function') throw new Error(`Bilinmeyen koleksiyon komutu: ${op.method}`)
        let r = await (fn as (...x: unknown[]) => unknown).apply(coll, op.args)
        if (r && typeof (r as { toArray?: unknown }).toArray === 'function') r = await (r as { toArray(): Promise<unknown> }).toArray()
        return valueToResult(r, ms())
      }
    }
  }

  async select(): Promise<QueryResult> {
    throw new Error('MongoDB SQL desteklemez.')
  }

  async transaction(): Promise<void> {
    throw new Error('Desteklenmiyor.')
  }
}
