// Dışa / içe aktarma motoru: CSV, JSON ve SQL. Büyük tablolar parti parti işlenir.
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import type { WebContents } from 'electron'
import type {
  Cell,
  DbType,
  ExportOptions,
  ImportOptions,
  ImportPreview,
  QueryResult,
  RowChange,
  TableInfo,
  TransferProgress,
  TransferSummary
} from '@shared/types'
import { dbTypeInfo } from '@shared/types'
import { familyOf, splitStatements, templates } from '@shared/dialects'
import type { Driver } from './drivers/base'

const MAX_IMPORT_BYTES = 512 * 1024 * 1024
const INSERT_BATCH = 500
const SQL_ROWS_PER_INSERT = 100

// ---------- İş takibi ve ilerleme ----------

const jobs = new Map<string, { cancelled: boolean }>()

export function cancelJob(id: string) {
  const j = jobs.get(id)
  if (j) j.cancelled = true
}

class Reporter {
  private last = 0
  constructor(
    private sender: WebContents | null,
    private jobId: string
  ) {}
  send(done: number, total: number | null, message: string, force = false) {
    const now = Date.now()
    if (!force && now - this.last < 120) return
    this.last = now
    if (this.sender && !this.sender.isDestroyed()) {
      const p: TransferProgress = { jobId: this.jobId, done, total, message }
      this.sender.send('transfer:progress', p)
    }
  }
}

class FileWriter {
  private stream: fs.WriteStream
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.stream = fs.createWriteStream(file, { encoding: 'utf8' })
  }
  async write(s: string) {
    if (!this.stream.write(s)) await once(this.stream, 'drain')
  }
  async close() {
    await new Promise<void>((res, rej) => this.stream.end((e?: Error | null) => (e ? rej(e) : res())))
  }
}

// ---------- CSV ----------

export function csvField(v: Cell | undefined, d: string): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return s.includes(d) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** RFC 4180 uyumlu CSV ayrıştırıcı: tırnaklı alanlar, kaçışlı tırnak ("") ve alan içi satır sonları. */
export function parseCsv(text: string, d: string, limit = Infinity): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let quoted = false
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
      i++
    } else if (text.startsWith(d, i)) {
      row.push(field)
      field = ''
      i += d.length
    } else if (ch === '\r' || ch === '\n') {
      row.push(field)
      field = ''
      if (!(row.length === 1 && row[0] === '')) rows.push(row)
      row = []
      if (rows.length >= limit) return rows
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
    } else {
      field += ch
      i++
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** İlk satırlardaki (tırnak dışı) ayraç sıklığına göre ayracı tahmin eder. */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 20000)
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 }
  let quoted = false
  let lines = 0
  for (const ch of sample) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch in counts) counts[ch]++
    else if (!quoted && ch === '\n' && ++lines >= 20) break
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ','
}

/**
 * SQL betiğini çalıştırılacak parçalara böler. Betikte tek başına "GO" satırları varsa
 * (SQL Server / SSMS biçimi) her paket bir bütün olarak çalışır; yoksa ';' ile bölünür.
 */
export function splitScript(text: string): { from: number; to: number; text: string }[] {
  const goLine = /^[ \t]*GO[ \t]*(\d+)?[ \t]*$/gim
  if (!goLine.test(text)) return splitStatements(text, 'sql')
  goLine.lastIndex = 0
  const out: { from: number; to: number; text: string }[] = []
  let start = 0
  let m: RegExpExecArray | null
  const push = (end: number) => {
    const chunk = text.slice(start, end)
    // Yalnızca yorumdan oluşan paketleri atla
    if (chunk.replace(/--[^\n]*/g, '').trim()) {
      const lead = chunk.length - chunk.trimStart().length
      out.push({ from: start + lead, to: end, text: chunk.trim() })
    }
  }
  while ((m = goLine.exec(text))) {
    push(m.index)
    start = m.index + m[0].length
  }
  push(text.length)
  return out
}

const readText = (file: string) => {
  const size = fs.statSync(file).size
  if (size > MAX_IMPORT_BYTES) throw new Error(`Dosya çok büyük (${Math.round(size / 1048576)} MB). Şimdilik en fazla 512 MB desteklenir.`)
  return { text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), size }
}

// ---------- JSON ----------

/** JSON dizisi, tek nesne ya da satır başına bir nesne (NDJSON) okur. */
function parseJsonItems(text: string): unknown[] {
  const t = text.trim()
  if (!t) return []
  try {
    const v = JSON.parse(t)
    return Array.isArray(v) ? v : [v]
  } catch (e) {
    const lines = t.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length < 2) throw new Error(`Geçersiz JSON: ${(e as Error).message}`)
    return lines.map((l, i) => {
      try {
        return JSON.parse(l)
      } catch (err) {
        throw new Error(`Geçersiz JSON (satır ${i + 1}): ${(err as Error).message}`)
      }
    })
  }
}

const toCell = (v: unknown): Cell => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : (v as Cell))

const kindOf = (file: string): ImportPreview['kind'] => {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.sql') return 'sql'
  if (['.json', '.ndjson', '.jsonl'].includes(ext)) return 'json'
  return 'csv'
}

// ---------- Önizleme ----------

export function previewImport(file: string, forcedDelimiter?: string): ImportPreview {
  const { text, size } = readText(file)
  const kind = kindOf(file)
  if (kind === 'sql') {
    const statements = splitScript(text).length
    return { kind, size, columns: [], rows: [], statements, sample: text.split(/\r?\n/).slice(0, 40).join('\n') }
  }
  if (kind === 'json') {
    const items = parseJsonItems(text)
    const cols: string[] = []
    for (const it of items.slice(0, 500))
      if (it && typeof it === 'object' && !Array.isArray(it)) for (const k of Object.keys(it)) if (!cols.includes(k)) cols.push(k)
    const rows = items.slice(0, 20).map((it) => cols.map((c) => toCell((it as Record<string, unknown>)?.[c])))
    return { kind, size, columns: cols, rows, totalRows: items.length }
  }
  const delimiter = forcedDelimiter || detectDelimiter(text)
  const all = parseCsv(text, delimiter)
  const header = all[0] ?? []
  return { kind, size, delimiter, columns: header, rows: all.slice(1, 21), totalRows: Math.max(0, all.length - 1) }
}

// ---------- Dışa aktarma ----------

/** Tablo adından güvenli dosya adı (şemalı veritabanlarında varsayılan şema dışındakiler önek alır) */
const safeName = (t: TableInfo, type: DbType) =>
  (dbTypeInfo(type).hasSchemas && t.schema && !['public', 'dbo'].includes(t.schema) ? `${t.schema}.${t.name}` : t.name)
    .replace(/^\*$/, 'tum_anahtarlar')
    .replace(/[\\/:*?"<>|]+/g, '_')

export async function exportData(driver: Driver, type: DbType, opts: ExportOptions, sender: WebContents | null): Promise<TransferSummary> {
  const started = Date.now()
  const job = { cancelled: false }
  jobs.set(opts.jobId, job)
  const rep = new Reporter(sender, opts.jobId)
  const family = familyOf(type)
  const files: string[] = []
  const errors: string[] = []
  let rows = 0
  const single = opts.tables.length === 1
  const filters = single ? opts.filters : undefined
  const orderBy = single ? opts.orderBy : undefined

  try {
    if (opts.format === 'sql' && family !== 'sql') throw new Error('SQL biçimi yalnızca SQL veritabanları için kullanılabilir.')
    if (!opts.tables.length) throw new Error('Dışa aktarılacak tablo seçilmedi.')

    // Toplam satır (ilerleme çubuğu için; başarısız olursa belirsiz kalır)
    let total: number | null = 0
    rep.send(0, null, 'Satırlar sayılıyor…', true)
    for (const t of opts.tables) {
      if (opts.format === 'sql' && (t.kind === 'view' || !opts.sql.data)) continue
      try {
        total! += await driver.countRows(t, filters)
      } catch {
        total = null
        break
      }
    }

    const tick = (t: TableInfo) => rep.send(rows, total, `${t.name} · ${rows.toLocaleString('tr-TR')} satır`)

    if (opts.format === 'sql') {
      const w = new FileWriter(opts.target)
      files.push(opts.target)
      const d = driver.dialect
      /** SQL Server betikleri paketlere (batch) GO satırlarıyla ayrılır */
      const GO = type === 'mssql' ? 'GO\n' : ''
      const info = await driver.serverInfo().catch(() => ({ version: '', currentDatabase: '' }))
      await w.write(`-- Rowly ile dışa aktarıldı · ${info.version} · ${info.currentDatabase}\n-- ${new Date().toISOString()}\n\n`)
      if (type === 'mysql' || type === 'mariadb') await w.write('SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n')
      if (type === 'sqlite') await w.write('PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;\n\n')
      // Görünümler tablolara bağlı olabilir: önce tablolar
      const ordered = [...opts.tables.filter((t) => t.kind === 'table'), ...opts.tables.filter((t) => t.kind === 'view')]
      for (const t of ordered) {
        if (job.cancelled) break
        // Şemasız veritabanlarında (MySQL, SQLite) ad nitelenmez: döküm başka bir veritabanına yüklenebilsin
        const full = dbTypeInfo(type).hasSchemas ? d.table(t) : d.quote(t.name)
        await w.write(`-- ----------------------------\n-- ${t.kind === 'view' ? 'Görünüm' : 'Tablo'}: ${t.name}\n-- ----------------------------\n`)
        if (opts.sql.structure) {
          if (opts.sql.drop) await w.write(`DROP ${t.kind === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS ${full};\n${GO}`)
          let ddl = (await driver.getDDL(t)).trim()
          if (type === 'mysql' || type === 'mariadb') {
            // Görünüm tanımlarındaki kaynak veritabanı adı ve DEFINER kullanıcısı taşınabilirliği bozar
            ddl = ddl.replace(/\s*DEFINER=`[^`]*`@`[^`]*`/g, '')
            if (t.schema) ddl = ddl.split('`' + t.schema.replace(/`/g, '``') + '`.').join('')
          }
          await w.write(ddl.endsWith(';') ? `${ddl}\n${GO}\n` : `${ddl};\n${GO}\n`)
        }
        if (!opts.sql.data || t.kind === 'view') continue
        const cols = await driver.getColumns(t)
        // SQL Server: IDENTITY_INSERT oturum ayarıdır; INSERT ile aynı pakette (GO arası) olmalı
        const identity = type === 'mssql' && cols.some((c) => c.autoIncrement)
        const idOn = identity ? `SET IDENTITY_INSERT ${full} ON;\n` : ''
        const idOff = identity ? `SET IDENTITY_INSERT ${full} OFF;\n` : ''
        let colList = ''
        for await (const batch of driver.iterateRows(t, filters, orderBy)) {
          if (job.cancelled) break
          colList ||= batch.columns.map((c) => d.quote(c.name)).join(', ')
          for (let i = 0; i < batch.rows.length; i += SQL_ROWS_PER_INSERT) {
            const values = batch.rows
              .slice(i, i + SQL_ROWS_PER_INSERT)
              .map((r) => `(${r.map((v) => d.literal(v)).join(', ')})`)
              .join(',\n  ')
            await w.write(`${idOn}INSERT INTO ${full} (${colList}) VALUES\n  ${values};\n${idOff}${GO}`)
          }
          rows += batch.rows.length
          tick(t)
        }
        // Postgres: açık id'lerle eklenen satırlardan sonra sequence'i ilerlet
        if (type === 'postgres') {
          for (const c of cols.filter((c) => c.autoIncrement)) {
            const lit = d.literal(full)
            await w.write(`SELECT setval(pg_get_serial_sequence(${lit}, ${d.literal(c.name)}), COALESCE((SELECT MAX(${d.quote(c.name)}) FROM ${full}), 0) + 1, false);\n`)
          }
        }
        await w.write('\n')
      }
      if (type === 'mysql' || type === 'mariadb') await w.write('SET FOREIGN_KEY_CHECKS = 1;\n')
      if (type === 'sqlite') await w.write('COMMIT;\n')
      await w.close()
    } else {
      const ext = opts.format
      for (const t of opts.tables) {
        if (job.cancelled) break
        const file = single ? opts.target : path.join(opts.target, `${safeName(t, type)}.${ext}`)
        const w = new FileWriter(file)
        files.push(file)
        if (opts.format === 'csv') {
          if (opts.csv.bom) await w.write('\uFEFF')
          let header: string[] | null = null
          for await (const batch of driver.iterateRows(t, filters, orderBy)) {
            if (job.cancelled) break
            if (!header) {
              header = batch.columns.map((c) => c.name)
              if (opts.csv.header) await w.write(header.map((h) => csvField(h, opts.csv.delimiter)).join(opts.csv.delimiter) + '\r\n')
            }
            const idx = header.map((h) => batch.columns.findIndex((c) => c.name === h))
            let out = ''
            for (const r of batch.rows) out += idx.map((j) => csvField(j < 0 ? null : r[j], opts.csv.delimiter)).join(opts.csv.delimiter) + '\r\n'
            await w.write(out)
            rows += batch.rows.length
            tick(t)
          }
        } else {
          await w.write('[\n')
          let first = true
          const emit = async (items: string[]) => {
            if (!items.length) return
            await w.write((first ? '  ' : ',\n  ') + items.join(',\n  '))
            first = false
          }
          if (driver.iterateDocuments) {
            for await (const docs of driver.iterateDocuments(t, filters)) {
              if (job.cancelled) break
              await emit(docs)
              rows += docs.length
              tick(t)
            }
          } else {
            for await (const batch of driver.iterateRows(t, filters, orderBy)) {
              if (job.cancelled) break
              await emit(batch.rows.map((r) => JSON.stringify(Object.fromEntries(batch.columns.map((c, i) => [c.name, r[i]])))))
              rows += batch.rows.length
              tick(t)
            }
          }
          await w.write('\n]\n')
        }
        await w.close()
      }
    }
  } catch (e) {
    errors.push((e as Error).message)
  } finally {
    jobs.delete(opts.jobId)
  }
  // İptal edilen işin yarım dosyalarını bırakma
  if (job.cancelled) for (const f of files) fs.rmSync(f, { force: true })
  rep.send(rows, rows, 'Bitti', true)
  return { rows, files: job.cancelled ? [] : files, errors, ms: Date.now() - started, cancelled: job.cancelled }
}

// ---------- İçe aktarma ----------

export async function importData(driver: Driver, type: DbType, opts: ImportOptions, sender: WebContents | null): Promise<TransferSummary> {
  const started = Date.now()
  const job = { cancelled: false }
  jobs.set(opts.jobId, job)
  const rep = new Reporter(sender, opts.jobId)
  const family = familyOf(type)
  const errors: string[] = []
  let rows = 0
  const addError = (m: string) => {
    if (errors.length < 200) errors.push(m)
  }

  try {
    const { text } = readText(opts.file)

    // --- SQL betiği ---
    if (opts.kind === 'sql') {
      if (family !== 'sql') throw new Error('SQL betikleri yalnızca SQL veritabanlarında çalıştırılabilir.')
      const stmts = splitScript(text)
      for (let i = 0; i < stmts.length; i++) {
        if (job.cancelled) break
        try {
          await driver.rawQuery(stmts[i].text)
          rows++
        } catch (e) {
          const line = text.slice(0, stmts[i].from).split('\n').length
          const msg = `İfade ${i + 1} (satır ${line}): ${(e as Error).message}`
          if (opts.stopOnError !== false) throw new Error(`${msg}\n\n${stmts[i].text.slice(0, 300)}`)
          addError(msg)
        }
        rep.send(i + 1, stmts.length, `İfade ${i + 1} / ${stmts.length}`)
      }
      return { rows, files: [], errors, ms: Date.now() - started, cancelled: job.cancelled }
    }

    if (!opts.table) throw new Error('Hedef tablo seçilmedi.')
    const table = opts.table

    // --- Kaynağı kayıtlara çevir ---
    let records: Record<string, unknown>[]
    if (opts.kind === 'json') {
      records = parseJsonItems(text).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    } else {
      const delimiter = opts.delimiter || detectDelimiter(text)
      const all = parseCsv(text, delimiter)
      const header = opts.header !== false ? (all.shift() ?? []) : (all[0] ?? []).map((_, i) => `sütun${i + 1}`)
      records = all.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
    }
    const total = records.length

    if (opts.truncate) {
      const sql = templates(type).truncate?.(table)
      if (!sql) throw new Error('Bu veritabanında içe aktarmadan önce boşaltma desteklenmiyor.')
      await driver.rawQuery(sql)
    }

    // --- NoSQL JSON: tipleri koruyarak doğrudan dokümanlar ---
    if (opts.kind === 'json' && driver.importDocuments) {
      for (let i = 0; i < records.length; i += 1000) {
        if (job.cancelled) break
        const r = await driver.importDocuments(table, records.slice(i, i + 1000).map((x) => JSON.stringify(x)), !!opts.overwrite)
        rows += r.n
        r.errors.forEach(addError)
        if (r.errors.length && opts.stopOnError) break
        rep.send(Math.min(i + 1000, total), total, `${rows.toLocaleString('tr-TR')} kayıt eklendi`)
      }
      return { rows, files: [], errors, ms: Date.now() - started, cancelled: job.cancelled }
    }

    // --- Satır satır eşleme ve toplu ekleme ---
    const mapping = (opts.mapping ?? Object.keys(records[0] ?? {}).map((s) => ({ source: s, target: s }))).filter((m) => m.target)
    if (!mapping.length) throw new Error('En az bir sütun eşlenmeli.')
    // Türkçe Excel CSV'lerinde ondalık ayırıcı virgüldür (120,5 · 1.234,56). Ayraç virgül değilse,
    // sayısal hedef sütunlarda bu biçimi noktalı biçime çevir (aksi halde veritabanı değeri kırpabilir).
    const delim = opts.kind === 'csv' ? opts.delimiter || detectDelimiter(text) : ','
    const numericCols = new Set<string>()
    if (opts.kind === 'csv' && delim !== ',' && family === 'sql')
      for (const c of await driver.getColumns(table).catch(() => [])) if (/int|dec|num|float|double|real|money/i.test(c.type)) numericCols.add(c.name)

    const toChange = (rec: Record<string, unknown>): RowChange => {
      const values: Record<string, Cell> = {}
      for (const m of mapping) {
        let v = toCell(rec[m.source])
        if (opts.kind === 'csv' && v === '' && opts.emptyAsNull) v = null
        if (opts.kind === 'csv' && v === '\\N') v = null
        if (typeof v === 'string' && numericCols.has(m.target!)) v = commaDecimal(v)
        values[m.target!] = v
      }
      return { kind: 'insert', values }
    }

    for (let i = 0; i < records.length; i += INSERT_BATCH) {
      if (job.cancelled) break
      const batch = records.slice(i, i + INSERT_BATCH).map(toChange)
      try {
        await driver.applyChanges(table, batch)
        rows += batch.length
      } catch (e) {
        if (opts.stopOnError !== false) throw new Error(`${i + 1}–${i + batch.length}. satırlar eklenemedi: ${(e as Error).message}`)
        // Parti başarısız: hatalı satırları bulmak için tek tek dene
        for (let j = 0; j < batch.length; j++) {
          try {
            await driver.applyChanges(table, [batch[j]])
            rows++
          } catch (err) {
            addError(`Satır ${i + j + 1}: ${(err as Error).message}`)
          }
        }
      }
      rep.send(Math.min(i + INSERT_BATCH, total), total, `${rows.toLocaleString('tr-TR')} / ${total.toLocaleString('tr-TR')} satır`)
    }
  } catch (e) {
    errors.unshift((e as Error).message)
  } finally {
    jobs.delete(opts.jobId)
  }
  rep.send(rows, rows, 'Bitti', true)
  return { rows, files: [], errors, ms: Date.now() - started, cancelled: job.cancelled }
}

// ---------- Sorgu sonucunu kaydetme ----------

export function writeResult(file: string, result: QueryResult, format: 'csv' | 'json') {
  if (format === 'csv') {
    const d = ','
    const lines = [result.columns.map((c) => csvField(c.name, d)).join(d), ...result.rows.map((r) => r.map((v) => csvField(v, d)).join(d))]
    fs.writeFileSync(file, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8')
  } else {
    const items = result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c.name, r[i]])))
    fs.writeFileSync(file, JSON.stringify(items, null, 2) + '\n', 'utf8')
  }
}

/** "1.234,56" → "1234.56", "120,5" → "120.5"; başka biçimlere dokunmaz */
export function commaDecimal(s: string): string {
  const t = s.trim()
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) return t.replace(/\./g, '').replace(',', '.')
  if (/^-?\d+,\d+$/.test(t)) return t.replace(',', '.')
  return s
}
