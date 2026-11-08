// Tablo yapısı düzenleme: arayüzdeki taslağı her veritabanının ALTER / CREATE söz dizimine çevirir.
import { dbTypeInfo, type ColumnInfo, type DbType, type FkAction, type ForeignKeyInfo, type IndexInfo } from './types'
import { quoteIdent } from './dialects'

export interface EditColumn {
  key: string
  /** Veritabanındaki hâli; yeni sütunlarda null */
  orig: ColumnInfo | null
  name: string
  type: string
  nullable: boolean
  /** SQL ifadesi ('abc', 0, CURRENT_TIMESTAMP…); null = varsayılan yok */
  defaultValue: string | null
  autoIncrement: boolean
  primaryKey: boolean
  comment: string
  dropped: boolean
}

export interface EditIndex {
  key: string
  orig: IndexInfo | null
  name: string
  columns: string[]
  unique: boolean
  dropped: boolean
}

export interface EditFk {
  key: string
  orig: ForeignKeyInfo | null
  name: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete: FkAction
  onUpdate: FkAction
  dropped: boolean
}

export interface TableDraft {
  schema: string
  name: string
  /** Mevcut tablonun adı; yeni tabloda null */
  origName: string | null
  /** Mevcut birincil anahtar kısıtının adı (PostgreSQL / SQL Server için) */
  pkName: string | null
  columns: EditColumn[]
  indexes: EditIndex[]
  fks: EditFk[]
}

export interface DdlResult {
  statements: string[]
  warnings: string[]
}

export const FK_ACTIONS: FkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']

/** Tip kutusu için öneriler */
export function typeSuggestions(type: DbType): string[] {
  switch (type) {
    case 'mysql':
    case 'mariadb':
      return ['INT', 'BIGINT', 'TINYINT(1)', 'SMALLINT', 'DECIMAL(10,2)', 'DOUBLE', 'VARCHAR(255)', 'CHAR(36)', 'TEXT', 'LONGTEXT', 'JSON', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'BLOB', "ENUM('a','b')"]
    case 'postgres':
    case 'cockroach':
    case 'redshift':
      return ['integer', 'bigint', 'smallint', 'numeric(10,2)', 'double precision', 'boolean', 'varchar(255)', 'text', 'uuid', 'jsonb', 'date', 'timestamp', 'timestamptz', 'time', 'bytea']
    case 'mssql':
      return ['int', 'bigint', 'smallint', 'bit', 'decimal(10,2)', 'float', 'nvarchar(255)', 'nvarchar(max)', 'varchar(255)', 'uniqueidentifier', 'date', 'datetime2', 'time', 'varbinary(max)']
    case 'sqlite':
      return ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB']
    default:
      return []
  }
}

/** Bu veritabanında sütun açıklaması desteklenir mi? */
export const supportsComments = (type: DbType) => type === 'mysql' || type === 'mariadb' || type === 'postgres' || type === 'cockroach'

let seq = 0
export const newKey = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`

const splitCols = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim().replace(/\s*\((asc|desc|-?1)\)$/i, ''))
    .filter(Boolean)

export function draftFrom(schema: string, name: string, cols: ColumnInfo[], idx: IndexInfo[], fks: ForeignKeyInfo[]): TableDraft {
  return {
    schema,
    name,
    origName: name,
    pkName: idx.find((i) => i.primary)?.name ?? null,
    columns: cols.map((c) => ({
      key: newKey(),
      orig: c,
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      defaultValue: c.defaultValue,
      autoIncrement: c.autoIncrement,
      primaryKey: c.primaryKey,
      comment: c.comment,
      dropped: false
    })),
    indexes: idx
      .filter((i) => !i.primary)
      .map((i) => ({ key: newKey(), orig: i, name: i.name, columns: splitCols(i.columns), unique: i.unique, dropped: false })),
    fks: fks.map((f) => ({ key: newKey(), orig: f, name: f.name, columns: [...f.columns], refTable: f.refTable, refColumns: [...f.refColumns], onDelete: f.onDelete, onUpdate: f.onUpdate, dropped: false }))
  }
}

export function newTableDraft(type: DbType, schema: string): TableDraft {
  const idType = type === 'mssql' ? 'int' : type === 'sqlite' ? 'INTEGER' : type === 'postgres' || type === 'cockroach' || type === 'redshift' ? 'integer' : 'INT'
  return {
    schema,
    name: '',
    origName: null,
    pkName: null,
    columns: [
      { key: newKey(), orig: null, name: 'id', type: idType, nullable: false, defaultValue: null, autoIncrement: true, primaryKey: true, comment: '', dropped: false }
    ],
    indexes: [],
    fks: []
  }
}

export const newColumn = (type: DbType, name: string): EditColumn => ({
  key: newKey(),
  orig: null,
  name,
  type: typeSuggestions(type).find((t) => /varchar|^text$/i.test(t)) ?? 'TEXT',
  nullable: true,
  defaultValue: null,
  autoIncrement: false,
  primaryKey: false,
  comment: '',
  dropped: false
})

// ---------- Değişiklik tespiti ----------

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

export const colChanged = (c: EditColumn) =>
  !!c.orig &&
  (c.name !== c.orig.name ||
    c.type !== c.orig.type ||
    c.nullable !== c.orig.nullable ||
    (c.defaultValue ?? null) !== (c.orig.defaultValue ?? null) ||
    c.autoIncrement !== c.orig.autoIncrement ||
    c.primaryKey !== c.orig.primaryKey ||
    (c.comment ?? '') !== (c.orig.comment ?? ''))

/** Eski sütun adı → yeni ad (yeniden adlandırmalar) */
const renameMap = (d: TableDraft) => {
  const m = new Map<string, string>()
  for (const c of d.columns) if (c.orig && !c.dropped) m.set(c.orig.name, c.name)
  return m
}

export const idxChanged = (i: EditIndex, ren: Map<string, string>) =>
  !!i.orig && (i.name !== i.orig.name || i.unique !== i.orig.unique || !same(i.columns, splitCols(i.orig.columns).map((c) => ren.get(c) ?? c)))

export const fkChanged = (f: EditFk, ren: Map<string, string>) =>
  !!f.orig &&
  (f.name !== f.orig.name ||
    f.refTable !== f.orig.refTable ||
    f.onDelete !== f.orig.onDelete ||
    f.onUpdate !== f.orig.onUpdate ||
    !same(f.columns, f.orig.columns.map((c) => ren.get(c) ?? c)) ||
    !same(f.refColumns, f.orig.refColumns))

export function countChanges(d: TableDraft): number {
  const ren = renameMap(d)
  let n = d.origName !== null && d.name !== d.origName ? 1 : 0
  for (const c of d.columns) if ((c.orig && (c.dropped || colChanged(c))) || (!c.orig && !c.dropped)) n++
  for (const i of d.indexes) if ((i.orig && (i.dropped || idxChanged(i, ren))) || (!i.orig && !i.dropped)) n++
  for (const f of d.fks) if ((f.orig && (f.dropped || fkChanged(f, ren))) || (!f.orig && !f.dropped)) n++
  return n
}

// ---------- Üretim ----------

const PG_FAMILY = new Set<DbType>(['postgres', 'cockroach', 'redshift'])

export function generateDDL(type: DbType, d: TableDraft, originalDDL = ''): DdlResult {
  const isMy = type === 'mysql' || type === 'mariadb'
  const isPg = PG_FAMILY.has(type)
  const isMs = type === 'mssql'
  const isLite = type === 'sqlite'
  const q = (n: string) => quoteIdent(type, n)
  const hasSchemas = !!dbTypeInfo(type).hasSchemas
  const tblOf = (name: string) => (hasSchemas && d.schema ? `${q(d.schema)}.${q(name)}` : q(name))
  const str = (s: string) => {
    let v = s.replace(/'/g, "''")
    if (isMy) v = v.replace(/\\/g, '\\\\')
    return `${isMs ? 'N' : ''}'${v}'`
  }
  const warnings: string[] = []
  const live = d.columns.filter((c) => !c.dropped)
  const name = d.name.trim()

  // --- Doğrulama ---
  if (!name) throw new Error('Tablo adı boş olamaz.')
  if (!live.length) throw new Error('Tabloda en az bir sütun olmalı.')
  const names = new Set<string>()
  for (const c of live) {
    if (!c.name.trim()) throw new Error('Sütun adı boş olamaz.')
    if (!c.type.trim()) throw new Error(`"${c.name}" sütununun tipi boş.`)
    const k = c.name.toLowerCase()
    if (names.has(k)) throw new Error(`"${c.name}" adında iki sütun var.`)
    names.add(k)
  }
  for (const i of d.indexes.filter((x) => !x.dropped)) {
    if (!i.name.trim()) throw new Error('İndeks adı boş olamaz.')
    if (!i.columns.length) throw new Error(`"${i.name}" indeksinde sütun seçilmedi.`)
    for (const c of i.columns) if (!names.has(c.toLowerCase())) throw new Error(`"${i.name}" indeksindeki "${c}" sütunu tabloda yok.`)
  }
  for (const f of d.fks.filter((x) => !x.dropped)) {
    if (!f.columns.length || !f.refTable || f.columns.length !== f.refColumns.length)
      throw new Error(`"${f.name || 'yeni'}" ilişkisinde sütunlar ve hedef sütunlar eşleşmeli.`)
    for (const c of f.columns) if (!names.has(c.toLowerCase())) throw new Error(`"${f.name}" ilişkisindeki "${c}" sütunu tabloda yok.`)
  }

  const pk = live.filter((c) => c.primaryKey).map((c) => c.name)
  const origPk = d.columns.filter((c) => c.orig?.primaryKey).map((c) => c.orig!.name)
  const sqliteInlinePk = isLite && pk.length === 1 && live.find((c) => c.primaryKey)!.autoIncrement && /^integer$/i.test(live.find((c) => c.primaryKey)!.type.trim())

  const typeFor = (c: EditColumn, fresh: boolean) => {
    if (isPg && c.autoIncrement && fresh) {
      const serial: Record<string, string> = { integer: 'serial', int: 'serial', int4: 'serial', bigint: 'bigserial', int8: 'bigserial', smallint: 'smallserial', int2: 'smallserial' }
      return serial[c.type.trim().toLowerCase()] ?? `${c.type} GENERATED BY DEFAULT AS IDENTITY`
    }
    return c.type.trim()
  }

  /** Sütun tanımı. fresh = sütun yeni oluşturuluyor (CREATE TABLE ya da ADD COLUMN) */
  const colDef = (c: EditColumn, fresh: boolean): string => {
    let s = `${q(c.name)} ${typeFor(c, fresh)}`
    if (isMy) {
      if (c.orig?.collation && c.type === c.orig.type && /char|text|enum|set/i.test(c.type)) s += ` COLLATE ${c.orig.collation}`
      s += c.nullable ? ' NULL' : ' NOT NULL'
      if (c.defaultValue !== null && c.defaultValue !== '') s += ` DEFAULT ${c.defaultValue}`
      if (c.orig?.onUpdate) s += ` ON UPDATE ${c.orig.onUpdate}`
      if (c.autoIncrement) s += ' AUTO_INCREMENT'
      if (c.comment) s += ` COMMENT ${str(c.comment)}`
    } else if (isMs) {
      if (c.autoIncrement) s += ' IDENTITY(1,1)'
      s += c.nullable ? ' NULL' : ' NOT NULL'
      if (c.defaultValue !== null && c.defaultValue !== '') s += ` DEFAULT ${c.defaultValue}`
    } else if (isLite) {
      if (sqliteInlinePk && c.primaryKey) s += c.orig?.extra === 'rowid' ? ' PRIMARY KEY' : ' PRIMARY KEY AUTOINCREMENT'
      else if (!c.nullable) s += ' NOT NULL'
      if (c.defaultValue !== null && c.defaultValue !== '') s += ` DEFAULT ${c.defaultValue}`
    } else {
      if (!c.nullable) s += ' NOT NULL'
      if (c.defaultValue !== null && c.defaultValue !== '' && !(c.autoIncrement && fresh)) s += ` DEFAULT ${c.defaultValue}`
    }
    return s
  }

  const refTbl = (t: string) => (hasSchemas && d.schema ? `${q(d.schema)}.${q(t)}` : q(t))
  const fkClause = (f: EditFk) =>
    `FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${refTbl(f.refTable)} (${f.refColumns.map(q).join(', ')})` +
    (f.onDelete !== 'NO ACTION' ? ` ON DELETE ${f.onDelete}` : '') +
    (f.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${f.onUpdate}` : '')
  const createIndex = (i: EditIndex, table: string) =>
    `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${tblOf(table)} (${i.columns.map(q).join(', ')})`
  const pgComments = (cols: EditColumn[], table: string) =>
    cols.filter((c) => c.comment).map((c) => `COMMENT ON COLUMN ${tblOf(table)}.${q(c.name)} IS ${str(c.comment)}`)

  const createTable = (table: string, withIndexes: boolean): string[] => {
    const lines = live.map((c) => '  ' + colDef(c, true))
    if (pk.length && !sqliteInlinePk) lines.push(`  ${isMs ? `CONSTRAINT ${q(`PK_${table}`)} ` : ''}PRIMARY KEY (${pk.map(q).join(', ')})`)
    for (const f of d.fks.filter((x) => !x.dropped)) lines.push(`  ${f.name ? `CONSTRAINT ${q(f.name)} ` : ''}${fkClause(f)}`)
    const out = [`CREATE TABLE ${tblOf(table)} (\n${lines.join(',\n')}\n)`]
    if (withIndexes) for (const i of d.indexes.filter((x) => !x.dropped)) out.push(createIndex(i, table))
    if (isPg) out.push(...pgComments(live, table))
    return out
  }

  // ---------- Yeni tablo ----------
  if (d.origName === null) return { statements: createTable(name, true), warnings }

  const ren = renameMap(d)
  const T = tblOf(d.origName)
  const added = d.columns.filter((c) => !c.orig && !c.dropped)
  const dropped = d.columns.filter((c) => c.orig && c.dropped)
  const changed = d.columns.filter((c) => !c.dropped && colChanged(c))
  const pkChanged = !same([...pk].sort(), [...origPk].map((n) => ren.get(n) ?? n).sort()) || origPk.some((n) => !ren.has(n))
  const idxDrop = d.indexes.filter((i) => i.orig && (i.dropped || idxChanged(i, ren)))
  const idxAdd = d.indexes.filter((i) => !i.dropped && (!i.orig || idxChanged(i, ren)))
  const fkDrop = d.fks.filter((f) => f.orig && (f.dropped || fkChanged(f, ren)))
  const fkAdd = d.fks.filter((f) => !f.dropped && (!f.orig || fkChanged(f, ren)))
  const renamedTable = name !== d.origName
  const st: string[] = []

  // ---------- SQLite ----------
  if (isLite) {
    const inIndexOrKey = (n: string) =>
      origPk.includes(n) || d.indexes.some((i) => i.orig && splitCols(i.orig.columns).includes(n)) || d.fks.some((f) => f.orig?.columns.includes(n))
    const needsRebuild =
      pkChanged ||
      fkDrop.length > 0 ||
      fkAdd.length > 0 ||
      changed.some((c) => c.type !== c.orig!.type || c.nullable !== c.orig!.nullable || (c.defaultValue ?? null) !== (c.orig!.defaultValue ?? null) || c.autoIncrement !== c.orig!.autoIncrement) ||
      dropped.some((c) => inIndexOrKey(c.orig!.name)) ||
      idxDrop.some((i) => i.orig!.constraint) ||
      added.some((c) => c.primaryKey || (!c.nullable && (c.defaultValue === null || c.defaultValue === '')) || /^\(|current_/i.test(c.defaultValue ?? ''))

    if (!needsRebuild) {
      for (const i of idxDrop) st.push(`DROP INDEX ${q(i.orig!.name)}`)
      for (const c of changed) if (c.name !== c.orig!.name) st.push(`ALTER TABLE ${T} RENAME COLUMN ${q(c.orig!.name)} TO ${q(c.name)}`)
      for (const c of dropped) st.push(`ALTER TABLE ${T} DROP COLUMN ${q(c.orig!.name)}`)
      for (const c of added) st.push(`ALTER TABLE ${T} ADD COLUMN ${colDef(c, true)}`)
      for (const i of idxAdd) st.push(createIndex(i, d.origName))
      if (renamedTable) st.push(`ALTER TABLE ${T} RENAME TO ${q(name)}`)
      return { statements: st, warnings }
    }

    // Tabloyu yeniden kur: SQLite tip / NOT NULL / anahtar değişikliklerini doğrudan desteklemez
    warnings.push('SQLite bu değişikliği doğrudan desteklemiyor: tablo yeni tanımla yeniden oluşturulup veriler kopyalanacak.')
    if (/\bCHECK\s*\(/i.test(originalDDL)) warnings.push('Tablodaki CHECK kısıtları yeni tanıma taşınmaz.')
    warnings.push('Bu tabloya bağlı tetikleyiciler (trigger) varsa yeniden oluşturulmaz.')
    const tmp = `_rowly_yeni_${name}`
    st.push(...createTable(tmp, false))
    const copy = live.filter((c) => c.orig)
    if (copy.length)
      st.push(`INSERT INTO ${q(tmp)} (${copy.map((c) => q(c.name)).join(', ')}) SELECT ${copy.map((c) => q(c.orig!.name)).join(', ')} FROM ${T}`)
    st.push(`DROP TABLE ${T}`)
    // Tabloya bağlı görünümler (view) yeniden adlandırma sırasında hata vermesin (SQLite belgelerindeki yöntem)
    st.push('PRAGMA legacy_alter_table = ON')
    st.push(`ALTER TABLE ${q(tmp)} RENAME TO ${q(name)}`)
    st.push('PRAGMA legacy_alter_table = OFF')
    for (const i of d.indexes.filter((x) => !x.dropped)) {
      const idx = i.orig?.constraint && i.name.startsWith('sqlite_autoindex') ? { ...i, name: `uq_${name}_${i.columns.join('_')}`, unique: true } : i
      st.push(createIndex(idx, name))
    }
    return { statements: st, warnings }
  }

  // ---------- MySQL / MariaDB: tek ALTER TABLE içinde ----------
  if (isMy) {
    if (fkDrop.length) st.push(`ALTER TABLE ${T}\n  ${fkDrop.map((f) => `DROP FOREIGN KEY ${q(f.orig!.name)}`).join(',\n  ')}`)
    const parts: string[] = []
    for (const i of idxDrop) parts.push(`DROP INDEX ${q(i.orig!.name)}`)
    if (pkChanged && origPk.length) parts.push('DROP PRIMARY KEY')
    for (const c of dropped) parts.push(`DROP COLUMN ${q(c.orig!.name)}`)
    for (const c of changed) parts.push(`CHANGE COLUMN ${q(c.orig!.name)} ${colDef(c, false)}`)
    for (const c of added) {
      const pos = live.indexOf(c)
      const prev = live.slice(0, pos).reverse()[0]
      parts.push(`ADD COLUMN ${colDef(c, true)}${prev ? ` AFTER ${q(prev.name)}` : ' FIRST'}`)
    }
    if (pkChanged && pk.length) parts.push(`ADD PRIMARY KEY (${pk.map(q).join(', ')})`)
    for (const i of idxAdd) parts.push(`ADD ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} (${i.columns.map(q).join(', ')})`)
    if (parts.length) st.push(`ALTER TABLE ${T}\n  ${parts.join(',\n  ')}`)
    for (const f of fkAdd) st.push(`ALTER TABLE ${T} ADD CONSTRAINT ${q(f.name)} ${fkClause(f)}`)
    if (renamedTable) st.push(`RENAME TABLE ${T} TO ${tblOf(name)}`)
    return { statements: st, warnings }
  }

  // ---------- PostgreSQL ve SQL Server: ayrı ifadeler ----------
  const msDropDefault = (col: string) =>
    `DECLARE @df sysname = (SELECT dc.name FROM sys.default_constraints dc JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id WHERE dc.parent_object_id = OBJECT_ID(${str(T)}) AND c.name = ${str(col)}); IF @df IS NOT NULL BEGIN DECLARE @sql nvarchar(max) = N'ALTER TABLE ${T.replace(/'/g, "''")} DROP CONSTRAINT ' + QUOTENAME(@df); EXEC sp_executesql @sql END`

  // SQL Server, tipi ya da NULL özelliği değişen sütunu kullanan indeks / kısıt / ilişki varken
  // ALTER COLUMN'a izin vermez: bunlar önce kaldırılıp sütun değiştikten sonra aynı adlarla yeniden kurulur.
  let msPkRebuild = false
  if (isMs) {
    const altered = new Set(changed.filter((c) => c.type !== c.orig!.type || c.nullable !== c.orig!.nullable).map((c) => c.orig!.name))
    if (altered.size) {
      for (const i of d.indexes)
        if (i.orig && !i.dropped && !idxDrop.includes(i) && splitCols(i.orig.columns).some((c) => altered.has(c))) {
          idxDrop.push(i)
          idxAdd.push(i)
        }
      for (const f of d.fks)
        if (f.orig && !f.dropped && !fkDrop.includes(f) && f.orig.columns.some((c) => altered.has(c))) {
          fkDrop.push(f)
          fkAdd.push(f)
        }
      if (!pkChanged && origPk.some((c) => altered.has(c))) msPkRebuild = true
    }
  }
  const pkRebuild = pkChanged || msPkRebuild

  for (const f of fkDrop) st.push(`ALTER TABLE ${T} DROP CONSTRAINT ${q(f.orig!.name)}`)
  for (const i of idxDrop)
    st.push(i.orig!.constraint ? `ALTER TABLE ${T} DROP CONSTRAINT ${q(i.orig!.name)}` : isMs ? `DROP INDEX ${q(i.orig!.name)} ON ${T}` : `DROP INDEX ${hasSchemas && d.schema ? q(d.schema) + '.' : ''}${q(i.orig!.name)}`)
  if (pkRebuild && origPk.length) {
    if (!d.pkName) throw new Error('Mevcut birincil anahtar kısıtının adı bulunamadı.')
    st.push(`ALTER TABLE ${T} DROP CONSTRAINT ${q(d.pkName)}`)
  }
  for (const c of dropped) {
    if (isMs) st.push(msDropDefault(c.orig!.name))
    st.push(`ALTER TABLE ${T} DROP COLUMN ${q(c.orig!.name)}`)
  }
  for (const c of changed) {
    const o = c.orig!
    let n = o.name
    if (c.name !== o.name) {
      st.push(isMs ? `EXEC sp_rename ${str(`${T}.${q(o.name)}`)}, ${str(c.name)}, N'COLUMN'` : `ALTER TABLE ${T} RENAME COLUMN ${q(o.name)} TO ${q(c.name)}`)
      n = c.name
    }
    if (isPg) {
      if (c.type !== o.type) st.push(`ALTER TABLE ${T} ALTER COLUMN ${q(n)} TYPE ${c.type} USING ${q(n)}::${c.type}`)
      if (c.nullable !== o.nullable) st.push(`ALTER TABLE ${T} ALTER COLUMN ${q(n)} ${c.nullable ? 'DROP' : 'SET'} NOT NULL`)
      if (c.autoIncrement !== o.autoIncrement) {
        if (c.autoIncrement) st.push(`ALTER TABLE ${T} ALTER COLUMN ${q(n)} ADD GENERATED BY DEFAULT AS IDENTITY`)
        else if (/^nextval\(/i.test(o.defaultValue ?? '')) st.push(`ALTER TABLE ${T} ALTER COLUMN ${q(n)} DROP DEFAULT`)
        else st.push(`ALTER TABLE ${T} ALTER COLUMN ${q(n)} DROP IDENTITY IF EXISTS`)
      }
      if ((c.defaultValue ?? null) !== (o.defaultValue ?? null) && !(c.autoIncrement !== o.autoIncrement && !c.autoIncrement && /^nextval\(/i.test(o.defaultValue ?? '')))
        st.push(c.defaultValue ? `ALTER TABLE ${T} ALTER COLUMN ${q(n)} SET DEFAULT ${c.defaultValue}` : `ALTER TABLE ${T} ALTER COLUMN ${q(n)} DROP DEFAULT`)
      if ((c.comment ?? '') !== (o.comment ?? '')) st.push(`COMMENT ON COLUMN ${T}.${q(n)} IS ${c.comment ? str(c.comment) : 'NULL'}`)
    } else {
      if (c.type !== o.type || c.nullable !== o.nullable) st.push(`ALTER TABLE ${T} ALTER COLUMN ${q(n)} ${c.type} ${c.nullable ? 'NULL' : 'NOT NULL'}`)
      if ((c.defaultValue ?? null) !== (o.defaultValue ?? null)) {
        st.push(msDropDefault(n))
        if (c.defaultValue) st.push(`ALTER TABLE ${T} ADD DEFAULT ${c.defaultValue} FOR ${q(n)}`)
      }
      if (c.autoIncrement !== o.autoIncrement) warnings.push(`SQL Server'da IDENTITY özelliği sonradan eklenip kaldırılamaz ("${c.name}"); bu değişiklik atlandı.`)
    }
  }
  for (const c of added) {
    st.push(`ALTER TABLE ${T} ADD ${isPg ? 'COLUMN ' : ''}${colDef(c, true)}`)
    if (isPg && c.comment) st.push(...pgComments([c], d.origName))
  }
  if (pkRebuild && pk.length)
    st.push(`ALTER TABLE ${T} ADD ${isMs ? `CONSTRAINT ${q(msPkRebuild && d.pkName ? d.pkName : `PK_${name}`)} ` : ''}PRIMARY KEY (${pk.map(q).join(', ')})`)
  for (const i of idxAdd)
    st.push(
      isMs && i.orig?.constraint && i.unique ? `ALTER TABLE ${T} ADD CONSTRAINT ${q(i.name)} UNIQUE (${i.columns.map(q).join(', ')})` : createIndex(i, d.origName)
    )
  for (const f of fkAdd) st.push(`ALTER TABLE ${T} ADD CONSTRAINT ${q(f.name)} ${fkClause(f)}`)
  if (renamedTable) st.push(isMs ? `EXEC sp_rename ${str(T)}, ${str(name)}` : `ALTER TABLE ${T} RENAME TO ${q(name)}`)
  return { statements: st, warnings }
}
