// Veritabanı ailesine (SQL / MongoDB / Redis) göre değişen arayüz davranışları.
import { dbTypeInfo, type ConnectionConfig, type DbFamily, type DbType, type TableInfo } from './types'

export const familyOf = (t: DbType): DbFamily => dbTypeInfo(t).family

export const FAMILY_LABELS: Record<DbFamily, { tables: string; views: string; row: string; rows: string; newRow: string }> = {
  sql: { tables: 'Tablolar', views: 'Görünümler', row: 'satır', rows: 'satır', newRow: 'Satır' },
  mongo: { tables: 'Koleksiyonlar', views: 'Görünümler', row: 'doküman', rows: 'doküman', newRow: 'Doküman' },
  redis: { tables: 'Anahtar grupları', views: '', row: 'anahtar', rows: 'anahtar', newRow: 'Anahtar' }
}

export function quoteIdent(type: DbType, n: string): string {
  if (type === 'mysql' || type === 'mariadb') return '`' + n.replace(/`/g, '``') + '`'
  if (type === 'mssql') return '[' + n.replace(/]/g, ']]') + ']'
  return '"' + n.replace(/"/g, '""') + '"'
}

/** Kenar çubuğunda gösterilecek ad */
export function tableLabel(type: DbType, t: TableInfo): string {
  if (familyOf(type) === 'redis' && t.name === '*') return 'Tüm anahtarlar'
  return t.name
}

interface Templates {
  select(t: TableInfo): string
  truncate?(t: TableInfo): string
  drop?(t: TableInfo): string
}

export function templates(type: DbType): Templates {
  const fam = familyOf(type)
  if (fam === 'mongo') {
    const coll = (t: TableInfo) => `db.getCollection(${JSON.stringify(t.name)})`
    return {
      select: (t) => `${coll(t)}.find({}).limit(100)`,
      truncate: (t) => `${coll(t)}.deleteMany({})`,
      drop: (t) => `${coll(t)}.drop()`
    }
  }
  if (fam === 'redis') {
    return { select: (t) => `SCAN 0 MATCH ${t.name} COUNT 100` }
  }
  const info = dbTypeInfo(type)
  const full = (t: TableInfo) => (info.hasSchemas ? `${quoteIdent(type, t.schema)}.${quoteIdent(type, t.name)}` : quoteIdent(type, t.name))
  return {
    select: (t) => (type === 'mssql' ? `SELECT TOP 100 * FROM ${full(t)};` : `SELECT * FROM ${full(t)} LIMIT 100;`),
    truncate: (t) => (type === 'sqlite' ? `DELETE FROM ${full(t)}` : `TRUNCATE TABLE ${full(t)}`),
    drop: (t) => `${t.kind === 'view' ? 'DROP VIEW' : 'DROP TABLE'} ${full(t)}`
  }
}

export interface Statement {
  from: number
  to: number
  text: string
}

/** ';' ile ayırır; tırnak, yorum ve $$ bloklarını atlar. */
function splitBySemicolon(src: string): Statement[] {
  const out: Statement[] = []
  let start = 0
  let i = 0
  const push = (end: number) => {
    const text = src.slice(start, end)
    if (text.trim()) {
      const lead = text.length - text.trimStart().length
      out.push({ from: start + lead, to: end, text: text.trim() })
    }
    start = end + 1
  }
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if ((ch === '-' && next === '-') || (ch === '/' && next === '/')) {
      const e = src.indexOf('\n', i)
      i = e < 0 ? src.length : e
    } else if (ch === '/' && next === '*') {
      const e = src.indexOf('*/', i + 2)
      i = e < 0 ? src.length : e + 2
      continue
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i++
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') i++
        i++
      }
    } else if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(src.slice(i))
      if (m) {
        const e = src.indexOf(m[0], i + m[0].length)
        i = e < 0 ? src.length : e + m[0].length
        continue
      }
    } else if (ch === ';') {
      push(i)
    }
    i++
  }
  push(src.length)
  return out
}

/** Sorgu metnini ifadelere böler; her ifadenin belge içindeki konumunu da döner. */
export function splitStatements(src: string, family: DbFamily = 'sql'): Statement[] {
  if (family === 'redis') {
    const out: Statement[] = []
    let pos = 0
    for (const line of src.split('\n')) {
      const t = line.trim()
      if (t && !t.startsWith('#') && !t.startsWith('//')) out.push({ from: pos, to: pos + line.length, text: t })
      pos += line.length + 1
    }
    return out
  }
  const parts = splitBySemicolon(src)
  if (family !== 'mongo') return parts
  // MongoDB'de ';' isteğe bağlı: satır başındaki her "db." yeni bir ifade başlatır.
  const out: Statement[] = []
  for (const p of parts) {
    const chunk = src.slice(p.from, p.to)
    const re = /\n(?=\s*db\.)/g
    let last = 0
    let m: RegExpExecArray | null
    const cut = (end: number) => {
      const t = chunk.slice(last, end)
      if (t.trim()) {
        const lead = t.length - t.trimStart().length
        out.push({ from: p.from + last + lead, to: p.from + end, text: t.trim() })
      }
    }
    while ((m = re.exec(chunk))) {
      cut(m.index)
      last = m.index + 1
    }
    cut(chunk.length)
  }
  return out
}

const stripComments = (s: string) => s.replace(/^(\s*(--[^\n]*\n|\/\/[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/))*/g, '')

const REDIS_READ = new Set(
  'GET MGET STRLEN GETRANGE EXISTS TYPE TTL PTTL KEYS SCAN HGET HMGET HGETALL HKEYS HVALS HLEN HEXISTS HSCAN LRANGE LLEN LINDEX SMEMBERS SCARD SISMEMBER SSCAN SRANDMEMBER ZRANGE ZREVRANGE ZRANGEBYSCORE ZCARD ZSCORE ZRANK ZSCAN ZCOUNT XRANGE XREVRANGE XLEN XINFO INFO DBSIZE PING TIME MEMORY OBJECT CLIENT CONFIG ECHO DUMP RANDOMKEY LASTSAVE ROLE COMMAND SLOWLOG'.split(' ')
)

const MONGO_WRITE = /\.(insert\w*|update\w*|replace\w*|delete\w*|remove|drop\w*|create\w*|rename\w*|bulkWrite|findOneAnd\w*|findAndModify|runCommand)\s*\(|\$out\b|\$merge\b/

/** İfade yalnızca okuma mı yapıyor? (production uyarısı için) */
export function isReadStatement(family: DbFamily, text: string): boolean {
  const s = stripComments(text).trim()
  if (family === 'redis') return REDIS_READ.has(s.split(/\s+/)[0]?.toUpperCase() ?? '')
  if (family === 'mongo') return !MONGO_WRITE.test(s)
  return /^\s*\(?\s*(select|with|show|pragma|explain|describe|desc|values)\b/i.test(s) && !/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(s.replace(/'[^']*'/g, ''))
}

/** Şema değiştirebilecek ifade mi? (kenar çubuğunu yenilemek için) */
export function changesSchema(family: DbFamily, text: string): boolean {
  if (family === 'sql') return /\b(create|drop|alter|rename|use)\b/i.test(text)
  return !splitStatements(text, family).every((s) => isReadStatement(family, s.text))
}

/** Bağlantı adresini şifre içermeyecek şekilde gösterir. */
export function connectionLocation(c: ConnectionConfig): string {
  const info = dbTypeInfo(c.type)
  if (info.fileBased) return c.file
  if (c.uri?.trim()) return c.uri.trim().replace(/\/\/[^@/]*@/, '//').replace(/\?.*$/, '')
  const db = c.database ? ` / ${info.family === 'redis' ? 'db' + c.database : c.database}` : ''
  const ssh = c.ssh?.enabled ? ` · SSH ${c.ssh.user}@${c.ssh.host}` : ''
  return `${c.user ? c.user + '@' : ''}${c.host}${c.port ? ':' + c.port : ''}${db}${ssh}`
}
