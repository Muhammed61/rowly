import Redis, { type ChainableCommander } from 'ioredis'
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

/** Bir koleksiyondan önizlemede gösterilecek en fazla eleman */
const PREVIEW = 500
/** Bir tablo görünümünde taranacak en fazla anahtar */
const KEY_CAP = 100_000
/** Kenar çubuğu gruplaması için taranacak anahtar */
const GROUP_SCAN = 20_000

const kvDialect: Dialect = {
  quote: (n) => n,
  placeholder: () => '?',
  table: (r) => r.name,
  paginate: (s) => s,
  castText: (e) => e,
  literal: (v) => JSON.stringify(v)
}

const COLUMNS: ColumnInfo[] = [
  { name: 'key', type: 'string', nullable: false, defaultValue: null, primaryKey: true, autoIncrement: false, extra: '', comment: 'Anahtar adı' },
  { name: 'type', type: 'string', nullable: false, defaultValue: 'string', primaryKey: false, autoIncrement: false, extra: '', comment: 'string, hash, list, set, zset, stream' },
  { name: 'size', type: 'int', nullable: false, defaultValue: null, primaryKey: false, autoIncrement: false, extra: 'salt okunur', comment: 'Uzunluk / eleman sayısı' },
  { name: 'ttl', type: 'int', nullable: false, defaultValue: '-1', primaryKey: false, autoIncrement: false, extra: '', comment: 'Saniye; -1 = süresiz' },
  { name: 'value', type: 'json', nullable: false, defaultValue: null, primaryKey: false, autoIncrement: false, extra: '', comment: 'Koleksiyonlar JSON olarak' }
]

const SIZE_CMD: Record<string, string> = { string: 'strlen', hash: 'hlen', list: 'llen', set: 'scard', zset: 'zcard', stream: 'xlen' }

/** Türkçe duyarsız karşılaştırma için katlama */
const fold = (s: string) => s.replace(/[İIı]/g, 'i').toLowerCase()

const likeToRe = (s: string) =>
  new RegExp('^' + fold(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i')

/** Tarayıcı tarafında süzme (anahtar, tip, ttl sütunları için) */
function matches(v: string | number | null, f: Filter): boolean {
  const s = v === null ? null : String(v)
  const num = (x: string) => (isNaN(Number(x)) ? x : Number(x))
  const cmp = () => {
    const a = typeof v === 'number' ? v : (s ?? '')
    const b = typeof v === 'number' ? num(f.value) : f.value
    return a < b ? -1 : a > b ? 1 : 0
  }
  switch (f.op) {
    case '=':
      return s === f.value
    case '!=':
      return s !== f.value
    case '<':
      return cmp() < 0
    case '>':
      return cmp() > 0
    case '<=':
      return cmp() <= 0
    case '>=':
      return cmp() >= 0
    case 'CONTAINS':
      return !!s && fold(s).includes(fold(f.value))
    case 'LIKE':
      return !!s && likeToRe(f.value).test(fold(s))
    case 'NOT LIKE':
      return !s || !likeToRe(f.value).test(fold(s))
    case 'IN':
      return f.value.split(',').map((x) => x.trim()).includes(s ?? '')
    case 'IS NULL':
      return s === null
    case 'IS NOT NULL':
      return s !== null
  }
}

/** redis-cli tarzı satırı parçalara ayırır: tırnaklar ve kaçış dizileri desteklenir. */
export function tokenize(line: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++
    if (i >= line.length) break
    const q = line[i]
    let tok = ''
    if (q === '"' || q === "'") {
      i++
      while (i < line.length && line[i] !== q) {
        if (line[i] === '\\' && q === '"' && i + 1 < line.length) {
          const n = line[++i]
          if (n === 'n') tok += '\n'
          else if (n === 't') tok += '\t'
          else if (n === 'r') tok += '\r'
          else if (n === 'x' && /^[0-9a-f]{2}$/i.test(line.slice(i + 1, i + 3))) {
            tok += String.fromCharCode(parseInt(line.slice(i + 1, i + 3), 16))
            i += 2
          } else tok += n
        } else tok += line[i]
        i++
      }
      if (i >= line.length) throw new Error(`Kapanmamış tırnak: ${line}`)
      i++
    } else {
      while (i < line.length && !/\s/.test(line[i])) tok += line[i++]
    }
    out.push(tok)
  }
  return out
}

const pairs = (arr: unknown[], a: string, b: string, numeric = false): QueryResult => {
  const rows: Cell[][] = []
  for (let i = 0; i + 1 < arr.length; i += 2) rows.push([String(arr[i]), numeric ? Number(arr[i + 1]) : (arr[i + 1] as Cell)])
  return { columns: [{ name: a }, { name: b }], rows, rowsAffected: null, durationMs: 0, isCommand: false }
}

const cellOf = (v: unknown): Cell =>
  v === null || v === undefined ? null : typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v)

function replyToResult(cmd: string, args: string[], reply: unknown, ms: number): QueryResult {
  const C = cmd.toUpperCase()
  let r: QueryResult
  if (C === 'INFO' && typeof reply === 'string') {
    const rows = reply
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes(':'))
      .map((l) => {
        const i = l.indexOf(':')
        return [l.slice(0, i), l.slice(i + 1)] as Cell[]
      })
    r = { columns: [{ name: 'alan' }, { name: 'değer' }], rows, rowsAffected: null, durationMs: 0, isCommand: false }
  } else if (Array.isArray(reply) && (C === 'HGETALL' || (C === 'CONFIG' && args[0]?.toUpperCase() === 'GET'))) {
    r = pairs(reply, 'alan', 'değer')
  } else if (Array.isArray(reply) && /^Z(REV)?RANGE/.test(C) && args.some((a) => a.toUpperCase() === 'WITHSCORES')) {
    r = pairs(reply, 'üye', 'skor', true)
  } else if (Array.isArray(reply) && /^[HSZ]?SCAN$/.test(C) && reply.length === 2 && Array.isArray(reply[1])) {
    const items = reply[1] as unknown[]
    r = C === 'HSCAN' ? pairs(items, 'alan', 'değer') : C === 'ZSCAN' ? pairs(items, 'üye', 'skor', true) : { columns: [{ name: 'değer' }], rows: items.map((x) => [cellOf(x)]), rowsAffected: null, durationMs: 0, isCommand: false }
    r.columns[0].name += ` (sonraki cursor: ${reply[0]})`
  } else if (reply && typeof reply === 'object' && !Array.isArray(reply) && !Buffer.isBuffer(reply)) {
    // RESP3 eşlemeleri (HGETALL, CONFIG GET…) nesne olarak gelir
    r = pairs(Object.entries(reply as Record<string, unknown>).flat(), 'alan', 'değer')
  } else if (Array.isArray(reply)) {
    r = { columns: [{ name: 'değer' }], rows: reply.map((x) => [cellOf(x)]), rowsAffected: null, durationMs: 0, isCommand: false }
  } else {
    r = { columns: [{ name: 'sonuç' }], rows: [[cellOf(reply)]], rowsAffected: null, durationMs: 0, isCommand: false }
  }
  r.durationMs = ms
  return r
}

export class RedisDriver extends Driver {
  readonly dialect = kvDialect
  private redis!: Redis
  private dbIndex: number

  constructor(private cfg: ConnectionConfig) {
    super()
    this.dbIndex = Number(String(cfg.database).replace(/^db/i, '')) || 0
  }

  async connect() {
    const opts = {
      lazyConnect: true,
      connectTimeout: 10000,
      maxRetriesPerRequest: 2,
      retryStrategy: (times: number) => (times > 3 ? null : 500)
    }
    this.redis = this.cfg.uri?.trim()
      ? new Redis(this.cfg.uri.trim(), opts)
      : new Redis({
          ...opts,
          host: this.cfg.host || '127.0.0.1',
          port: this.cfg.port || 6379,
          username: this.cfg.user || undefined,
          password: this.cfg.password || undefined,
          db: this.dbIndex,
          tls: this.cfg.ssl ? { rejectUnauthorized: false } : undefined
        })
    this.redis.on('error', () => {}) // bağlantı hataları komutlardan ayrıca bildirilir
    await this.redis.connect()
    await this.redis.ping()
    if (this.cfg.uri?.trim()) this.dbIndex = (this.redis.options.db as number) ?? 0
  }

  async close() {
    this.redis?.disconnect()
  }

  async serverInfo(): Promise<ServerInfo> {
    const info = await this.redis.info('server').catch(() => '')
    const v = /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? ''
    const valkey = /valkey_version:([^\r\n]+)/.exec(info)?.[1]
    return { version: valkey ? `Valkey ${valkey}` : `Redis ${v}`.trim(), currentDatabase: `db${this.dbIndex}` }
  }

  async listDatabases() {
    let n = 16
    try {
      const r = (await this.redis.config('GET', 'databases')) as string[]
      n = Number(r?.[1]) || 16
    } catch {
      /* yönetilen Redis'lerde CONFIG kapalı olabilir */
    }
    return Array.from({ length: n }, (_, i) => `db${i}`)
  }

  async useDatabase(name: string) {
    const n = Number(name.replace(/^db/i, ''))
    if (!Number.isInteger(n) || n < 0) throw new Error(`Geçersiz veritabanı: ${name}`)
    await this.redis.select(n)
    this.dbIndex = n
  }

  private async scanKeys(pattern: string, cap: number): Promise<{ keys: string[]; capped: boolean }> {
    const seen = new Set<string>()
    let cursor = '0'
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000)
      cursor = next
      for (const k of batch) seen.add(k)
    } while (cursor !== '0' && seen.size < cap)
    return { keys: [...seen], capped: cursor !== '0' }
  }

  /** "Tablo" yerine anahtar grupları: user:1, user:2 → user:* */
  async listTables(): Promise<TableInfo[]> {
    const total = await this.redis.dbsize()
    const { keys } = await this.scanKeys('*', GROUP_SCAN)
    const groups = new Map<string, number>()
    for (const k of keys) {
      const i = k.indexOf(':')
      if (i > 0) groups.set(k.slice(0, i), (groups.get(k.slice(0, i)) ?? 0) + 1)
    }
    const escapeGlob = (s: string) => s.replace(/[*?[\]\\]/g, '\\$&')
    return [
      { schema: '', name: '*', kind: 'table' as const, count: total },
      ...[...groups.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([g, c]) => ({ schema: '', name: `${escapeGlob(g)}:*`, kind: 'table' as const, count: c }))
    ]
  }

  async getColumns(): Promise<ColumnInfo[]> {
    return COLUMNS
  }

  async getIndexes(): Promise<IndexInfo[]> {
    return []
  }

  async getDDL(ref: TableRef) {
    const total = await this.redis.dbsize()
    return `# Redis anahtar deseni: ${ref.name}\n# Veritabanı: db${this.dbIndex} (${total} anahtar)\n\nSCAN 0 MATCH ${ref.name} COUNT 100\n`
  }

  private async pipelineMap<T>(keys: string[], fn: (p: ChainableCommander, k: string) => void): Promise<T[]> {
    const out: T[] = []
    for (let i = 0; i < keys.length; i += 5000) {
      const p = this.redis.pipeline()
      const chunk = keys.slice(i, i + 5000)
      chunk.forEach((k) => fn(p, k))
      const res = (await p.exec()) ?? []
      res.forEach(([err, v]) => {
        if (err) throw err
        out.push(v as T)
      })
    }
    return out
  }

  async fetchRows(opts: FetchOptions): Promise<FetchResult> {
    const started = Date.now()
    const keys = await this.matchingKeys(opts)
    const page = keys.slice(Math.floor(opts.offset), Math.floor(opts.offset + opts.limit))
    const rows = await this.rowsFor(page, false)
    return {
      result: { columns: COLUMNS.map((c) => ({ name: c.name })), rows, rowsAffected: null, durationMs: Date.now() - started, isCommand: false },
      total: keys.length
    }
  }

  /** Dışa aktarma: anahtarlar bir kez taranır, değerler önizleme sınırı olmadan tam okunur. */
  async *iterateRows(ref: TableRef, filters?: Filter[], orderBy?: FetchOptions['orderBy'], batch = 1000): AsyncGenerator<QueryResult> {
    const keys = await this.matchingKeys({ table: ref, filters, orderBy })
    for (let i = 0; i < keys.length; i += batch) {
      const rows = await this.rowsFor(keys.slice(i, i + batch), true)
      yield { columns: COLUMNS.map((c) => ({ name: c.name })), rows, rowsAffected: null, durationMs: 0, isCommand: false }
    }
  }

  async *iterateDocuments(ref: TableRef, filters?: Filter[]): AsyncGenerator<string[]> {
    for await (const r of this.iterateRows(ref, filters)) {
      yield r.rows.map(([key, type, , ttl, value]) =>
        JSON.stringify({ key, type, ttl, value: type === 'string' || typeof value !== 'string' ? value : JSON.parse(value) })
      )
    }
  }

  async countRows(ref: TableRef, filters?: Filter[]): Promise<number> {
    return (await this.matchingKeys({ table: ref, filters })).length
  }

  /** JSON dokümanları: { key, type, ttl, value } (dışa aktarmanın ürettiği biçim) */
  async importDocuments(_ref: TableRef, docs: string[], overwrite: boolean): Promise<{ n: number; errors: string[] }> {
    const errors: string[] = []
    let n = 0
    for (const text of docs) {
      try {
        const d = JSON.parse(text) as { key?: unknown; type?: string; ttl?: number; value?: unknown }
        if (typeof d?.key !== 'string' || !d.key) throw new Error('"key" alanı eksik')
        const type = String(d.type ?? (typeof d.value === 'string' ? 'string' : Array.isArray(d.value) ? 'list' : 'hash')).toLowerCase()
        if (!overwrite && (await this.redis.exists(d.key))) throw new Error(`"${d.key}" zaten var`)
        const m = this.redis.multi()
        if (type === 'stream') {
          m.del(d.key)
          for (const e of (d.value as Record<string, unknown>[]) ?? []) {
            const { id, ...fields } = e
            const flat = Object.entries(fields).flatMap(([f, v]) => [f, String(v)])
            if (flat.length) m.xadd(d.key, String(id ?? '*'), ...flat)
          }
        } else {
          this.writeValue(m, d.key, type, type === 'string' ? String(d.value ?? '') : JSON.stringify(d.value ?? null))
        }
        if (Number(d.ttl) > 0) m.expire(d.key, Number(d.ttl))
        const res = (await m.exec()) ?? []
        const err = res.find(([e]) => e)?.[0]
        if (err) throw err
        n++
      } catch (e) {
        errors.push(`${(e as Error).message} · ${text.slice(0, 80)}`)
      }
    }
    return { n, errors }
  }

  /** Desen, filtre ve sıralamaya uyan anahtarlar */
  private async matchingKeys(opts: Pick<FetchOptions, 'table' | 'filters' | 'orderBy'>): Promise<string[]> {
    const filters = opts.filters ?? []
    for (const f of filters)
      if (!['key', 'type', 'ttl'].includes(f.column)) throw new Error(`Redis'te yalnızca key, type ve ttl sütunlarına göre filtrelenebilir ("${f.column}" değil).`)

    let { keys } = await this.scanKeys(opts.table.name || '*', KEY_CAP)
    keys = keys.filter((k) => filters.filter((f) => f.column === 'key').every((f) => matches(k, f)))

    const sortCol = opts.orderBy?.column
    const needType = filters.some((f) => f.column === 'type') || sortCol === 'type'
    const needTtl = filters.some((f) => f.column === 'ttl') || sortCol === 'ttl'
    const typeOf = new Map<string, string>()
    const ttlOf = new Map<string, number>()
    if (needType) (await this.pipelineMap<string>(keys, (p, k) => p.type(k))).forEach((t, i) => typeOf.set(keys[i], t))
    if (needTtl) (await this.pipelineMap<number>(keys, (p, k) => p.ttl(k))).forEach((t, i) => ttlOf.set(keys[i], t))
    keys = keys.filter(
      (k) =>
        filters.filter((f) => f.column === 'type').every((f) => matches(typeOf.get(k) ?? null, f)) &&
        filters.filter((f) => f.column === 'ttl').every((f) => matches(ttlOf.get(k) ?? null, f))
    )

    const dir = opts.orderBy?.dir === 'DESC' ? -1 : 1
    if (sortCol === 'type') keys.sort((a, b) => dir * ((typeOf.get(a) ?? '').localeCompare(typeOf.get(b) ?? '') || a.localeCompare(b)))
    else if (sortCol === 'ttl') keys.sort((a, b) => dir * ((ttlOf.get(a) ?? 0) - (ttlOf.get(b) ?? 0)))
    else {
      const collator = new Intl.Collator(undefined, { numeric: true })
      keys.sort((a, b) => (sortCol === 'key' ? dir : 1) * collator.compare(a, b))
    }

    return keys
  }

  /** Anahtarların tip, boyut, TTL ve değerlerini okur. full=false iken koleksiyonlar önizleme kadar okunur. */
  private async rowsFor(page: string[], full: boolean): Promise<Cell[][]> {
    const types = await this.pipelineMap<string>(page, (p, k) => p.type(k))
    const ttls = await this.pipelineMap<number>(page, (p, k) => p.ttl(k))
    const sizes = await this.pipelineMap<number>(page, (p, k) => {
      const t = types[page.indexOf(k)]
      const cmd = SIZE_CMD[t]
      if (cmd) p.call(cmd, [k])
      else p.exists(k)
    })
    const values = await this.pipelineMap<unknown>(page, (p, k) => {
      const i = page.indexOf(k)
      switch (types[i]) {
        case 'string':
          p.get(k)
          break
        case 'hash':
          if (full || sizes[i] <= PREVIEW) p.hgetall(k)
          else p.hscan(k, 0, 'COUNT', PREVIEW)
          break
        case 'list':
          p.lrange(k, 0, full ? -1 : PREVIEW - 1)
          break
        case 'set':
          if (full || sizes[i] <= PREVIEW) p.smembers(k)
          else p.sscan(k, 0, 'COUNT', PREVIEW)
          break
        case 'zset':
          p.call('zrange', [k, 0, full ? -1 : PREVIEW - 1, 'WITHSCORES'])
          break
        case 'stream':
          if (full) p.xrange(k, '-', '+')
          else p.xrange(k, '-', '+', 'COUNT', 50)
          break
        default:
          p.exists(k)
      }
    })

    return page.map((k, i) => {
      const t = types[i]
      let v: unknown = values[i]
      if (t === 'hash' && Array.isArray(v)) v = Object.fromEntries(pairsOf(v[1] as string[]))
      if (t === 'set' && Array.isArray(v) && !full && sizes[i] > PREVIEW) v = v[1]
      if (t === 'zset') v = pairsOf(v as string[]).map(([m, s]) => [m, Number(s)])
      if (t === 'stream') v = (v as [string, string[]][]).map(([id, f]) => ({ id, ...Object.fromEntries(pairsOf(f)) }))
      const value: Cell = t === 'string' ? (v as string) : SIZE_CMD[t] ? JSON.stringify(v) : `<${t}>`
      return [k, t, sizes[i], ttls[i], value] as Cell[]
    })
  }

  /** Değer metnini tipine göre yazar (eski içerik silinip yeniden oluşturulur). */
  private writeValue(m: ChainableCommander, key: string, type: string, text: Cell) {
    const s = text === null ? '' : String(text)
    if (type === 'string') {
      m.set(key, s)
      return
    }
    let data: unknown
    try {
      data = JSON.parse(s || (type === 'hash' ? '{}' : '[]'))
    } catch {
      throw new Error(`"${key}" (${type}) için geçerli JSON gerekli. Örnek: ${type === 'hash' ? '{"alan": "değer"}' : type === 'zset' ? '[["üye", 1]]' : '["a", "b"]'}`)
    }
    const str = (x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x))
    m.del(key)
    if (type === 'hash') {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`"${key}" hash değeri bir JSON nesnesi olmalı.`)
      const flat = Object.entries(data).flatMap(([f, v]) => [f, str(v)])
      if (flat.length) m.hset(key, ...flat)
    } else if (type === 'list' || type === 'set') {
      if (!Array.isArray(data)) throw new Error(`"${key}" ${type} değeri bir JSON dizisi olmalı.`)
      if (data.length) (type === 'list' ? m.rpush(key, ...data.map(str)) : m.sadd(key, ...data.map(str)))
    } else if (type === 'zset') {
      const entries: [string, number][] = Array.isArray(data)
        ? data.map((e) => (Array.isArray(e) ? [str(e[0]), Number(e[1])] : [str((e as { member: unknown }).member), Number((e as { score: unknown }).score)]))
        : Object.entries(data as Record<string, unknown>).map(([mm, sc]) => [mm, Number(sc)])
      if (entries.some(([, sc]) => isNaN(sc))) throw new Error(`"${key}" zset skorları sayı olmalı.`)
      if (entries.length) m.zadd(key, ...entries.flatMap(([mm, sc]) => [String(sc), mm]))
    } else {
      throw new Error(`${type} tipindeki anahtarlar tablodan düzenlenemez; Redis komutlarını kullanın.`)
    }
  }

  async applyChanges(_ref: TableRef, changes: RowChange[]): Promise<number> {
    // Önce tüm kontroller (okuma), sonra tek bir MULTI içinde yazma.
    const m = this.redis.multi()
    for (const ch of changes) {
      if (ch.kind === 'delete') {
        m.del(String(ch.pk.key))
        continue
      }
      if (ch.kind === 'insert') {
        const key = ch.values.key
        if (key === null || key === undefined || key === '') throw new Error('Yeni anahtar için "key" alanı zorunlu.')
        const type = String(ch.values.type ?? 'string').toLowerCase()
        if (!SIZE_CMD[type] || type === 'stream') throw new Error(`Desteklenmeyen tip: ${type} (string, hash, list, set, zset)`)
        if (await this.redis.exists(String(key))) throw new Error(`"${key}" anahtarı zaten var.`)
        this.writeValue(m, String(key), type, ch.values.value ?? '')
        const ttl = Number(ch.values.ttl ?? -1)
        if (ttl > 0) m.expire(String(key), ttl)
        continue
      }
      const key = String(ch.pk.key)
      const type = await this.redis.type(key)
      if (type === 'none') throw new Error(`"${key}" anahtarı artık yok.`)
      const v = ch.values
      if ('type' in v && v.type !== type) throw new Error('Anahtarın tipi değiştirilemez. Silip yeni anahtar ekleyin.')
      if ('size' in v) throw new Error('"size" sütunu salt okunur.')
      if ('value' in v) {
        const cmd = SIZE_CMD[type]
        if (type !== 'string' && cmd) {
          const size = (await this.redis.call(cmd, [key])) as number
          if (size > PREVIEW) throw new Error(`"${key}" ${size} eleman içeriyor; tabloda yalnızca ilk ${PREVIEW} gösterildiği için buradan düzenlenemez. Redis komutlarını kullanın.`)
        }
        const pttl = await this.redis.pttl(key)
        this.writeValue(m, key, type, v.value)
        if (pttl > 0 && !('ttl' in v)) m.pexpire(key, pttl)
      }
      if ('ttl' in v) {
        const t = v.ttl === null || v.ttl === '' ? -1 : Number(v.ttl)
        if (isNaN(t)) throw new Error('ttl bir sayı olmalı (saniye, -1 = süresiz).')
        if (t > 0) m.expire(key, t)
        else m.persist(key)
      }
      if ('key' in v && v.key !== key) {
        if (!v.key) throw new Error('Anahtar adı boş olamaz.')
        if (await this.redis.exists(String(v.key))) throw new Error(`"${v.key}" anahtarı zaten var.`)
        m.rename(key, String(v.key))
      }
    }
    const res = (await m.exec()) ?? []
    const err = res.find(([e]) => e)?.[0]
    if (err) throw err
    return changes.length
  }

  async rawQuery(script: string): Promise<QueryResult[]> {
    const lines = script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'))
    if (!lines.length) throw new Error('Çalıştırılacak komut yok. Örnek: GET kullanici:1')
    const out: QueryResult[] = []
    for (const line of lines) {
      const [cmd, ...args] = tokenize(line.replace(/;$/, ''))
      if (!cmd) continue
      if (/^(SUBSCRIBE|PSUBSCRIBE|MONITOR|SYNC|PSYNC)$/i.test(cmd)) throw new Error(`${cmd.toUpperCase()} bu ekranda desteklenmez.`)
      const t = Date.now()
      // Küçük harf: ioredis RESP3 yanıtlarını yalnızca tanıdığı (küçük harfli) komutlarda düzleştirir
      const reply = await this.redis.call(cmd.toLowerCase(), args)
      if (/^select$/i.test(cmd)) this.dbIndex = Number(args[0]) || 0
      out.push(replyToResult(cmd, args, reply, Date.now() - t))
    }
    return out
  }

  async select(): Promise<QueryResult> {
    throw new Error('Redis SQL desteklemez.')
  }

  async transaction(): Promise<void> {
    throw new Error('Desteklenmiyor.')
  }
}

function pairsOf(arr: string[]): [string, string][] {
  const out: [string, string][] = []
  for (let i = 0; i + 1 < arr.length; i += 2) out.push([arr[i], arr[i + 1]])
  return out
}
