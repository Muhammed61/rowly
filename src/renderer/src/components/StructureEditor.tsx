import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Copy, KeyRound, Link2, ListTree, Loader2, Plus, RotateCcw, Save, Trash2, Undo2 } from 'lucide-react'
import type { ColumnInfo, TableInfo } from '@shared/types'
import {
  FK_ACTIONS,
  colChanged,
  countChanges,
  draftFrom,
  fkChanged,
  generateDDL,
  idxChanged,
  newColumn,
  newKey,
  newTableDraft,
  supportsComments,
  typeSuggestions,
  type DdlResult,
  type EditColumn,
  type EditFk,
  type EditIndex,
  type TableDraft
} from '@shared/ddl'
import { useStore } from '../store'
import { SqlEditor } from './SqlEditor'
import { Modal, copyText } from './ui'

const listOf = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/**
 * Tablo yapısını düzenler (table = null ise yeni tablo oluşturur). Değişiklikler önce taslakta
 * birikir; Kaydet'e basınca üretilen SQL önizlenir ve onaylanınca uygulanır.
 */
export function StructureEditor({
  table,
  active,
  onDirty,
  onSaved
}: {
  table: TableInfo | null
  active: boolean
  onDirty?(n: number): void
  onSaved(t: TableInfo): void
}) {
  const session = useStore((s) => s.session)!
  const toast = useStore((s) => s.toast)
  const type = session.conn.type
  const schema = table?.schema ?? (type === 'postgres' || type === 'cockroach' || type === 'redshift' ? 'public' : type === 'mssql' ? 'dbo' : session.info.currentDatabase || 'main')
  const [draft, setDraft] = useState<TableDraft | null>(table ? null : newTableDraft(type, schema))
  const [ddl, setDdl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<DdlResult | null>(null)
  const [applying, setApplying] = useState(false)
  const [reloadSeq, setReloadSeq] = useState(0)
  const [refCols, setRefCols] = useState<Record<string, string[]>>({})
  const nameRef = useRef<HTMLInputElement>(null)

  // Mevcut tablonun yapısını yükle
  useEffect(() => {
    if (!table) return
    let off = false
    const ref = { schema: table.schema, name: table.name }
    Promise.all([window.api.getColumns(session.id, ref), window.api.getIndexes(session.id, ref), window.api.getForeignKeys(session.id, ref), window.api.getDDL(session.id, ref)])
      .then(([c, i, f, d]) => {
        if (off) return
        setDraft(draftFrom(table.schema, table.name, c, i, f))
        setDdl(d)
        setError(null)
      })
      .catch((e) => !off && setError((e as Error).message))
    return () => {
      off = true
    }
  }, [session.id, table, reloadSeq])

  useEffect(() => {
    if (!table) setTimeout(() => nameRef.current?.focus(), 50)
  }, [table])

  const changes = draft ? countChanges(draft) + (table ? 0 : 1) : 0
  useEffect(() => onDirty?.(table ? (draft ? countChanges(draft) : 0) : 0), [draft, table, onDirty])

  const tables = useMemo(() => session.tables.filter((t) => t.kind === 'table'), [session.tables])
  const liveCols = draft?.columns.filter((c) => !c.dropped).map((c) => c.name) ?? []
  const renames = useMemo(() => new Map(draft?.columns.filter((c) => c.orig && !c.dropped).map((c) => [c.orig!.name, c.name]) ?? []), [draft])

  // Hedef tablo sütunlarını FK önerileri için yükle
  const loadRefCols = useCallback(
    (t: string) => {
      if (!t || refCols[t]) return
      const info = tables.find((x) => x.name === t)
      if (!info) return
      window.api.getColumns(session.id, info).then((c: ColumnInfo[]) => setRefCols((m) => ({ ...m, [t]: c.map((x) => x.name) }))).catch(() => {})
    },
    [refCols, tables, session.id]
  )
  useEffect(() => draft?.fks.forEach((f) => loadRefCols(f.refTable)), [draft, loadRefCols])

  // ---------- Taslak düzenleme ----------
  const upd = (fn: (d: TableDraft) => TableDraft) => setDraft((d) => (d ? fn(d) : d))
  const setCol = (key: string, patch: Partial<EditColumn>) =>
    upd((d) => {
      const old = d.columns.find((c) => c.key === key)!
      const next = { ...d, columns: d.columns.map((c) => (c.key === key ? { ...c, ...patch } : c)) }
      // Sütun yeniden adlandırılınca indeks ve ilişkilerdeki adı da güncelle
      if (patch.name !== undefined && old.name !== patch.name) {
        const swap = (arr: string[]) => arr.map((x) => (x === old.name ? patch.name! : x))
        next.indexes = next.indexes.map((i) => ({ ...i, columns: swap(i.columns) }))
        next.fks = next.fks.map((f) => ({ ...f, columns: swap(f.columns) }))
      }
      // AUTO_INCREMENT bir anahtar ister
      if (patch.autoIncrement) next.columns = next.columns.map((c) => (c.key === key ? { ...c, primaryKey: true, nullable: false } : c))
      if (patch.primaryKey) next.columns = next.columns.map((c) => (c.key === key ? { ...c, nullable: false } : c))
      return next
    })
  const setIdx = (key: string, patch: Partial<EditIndex>) => upd((d) => ({ ...d, indexes: d.indexes.map((i) => (i.key === key ? { ...i, ...patch } : i)) }))
  const setFk = (key: string, patch: Partial<EditFk>) => upd((d) => ({ ...d, fks: d.fks.map((f) => (f.key === key ? { ...f, ...patch } : f)) }))

  const removeCol = (c: EditColumn) => upd((d) => ({ ...d, columns: c.orig ? d.columns.map((x) => (x.key === c.key ? { ...x, dropped: !x.dropped } : x)) : d.columns.filter((x) => x.key !== c.key) }))
  const removeIdx = (i: EditIndex) => upd((d) => ({ ...d, indexes: i.orig ? d.indexes.map((x) => (x.key === i.key ? { ...x, dropped: !x.dropped } : x)) : d.indexes.filter((x) => x.key !== i.key) }))
  const removeFk = (f: EditFk) => upd((d) => ({ ...d, fks: f.orig ? d.fks.map((x) => (x.key === f.key ? { ...x, dropped: !x.dropped } : x)) : d.fks.filter((x) => x.key !== f.key) }))

  const addCol = () =>
    upd((d) => {
      let n = d.columns.length + 1
      while (d.columns.some((c) => c.name === `sutun_${n}`)) n++
      return { ...d, columns: [...d.columns, newColumn(type, `sutun_${n}`)] }
    })
  const addIdx = () =>
    upd((d) => {
      const first = d.columns.find((c) => !c.dropped && !c.primaryKey)?.name ?? liveCols[0]
      return { ...d, indexes: [...d.indexes, { key: newKey(), orig: null, name: `idx_${d.name || 'tablo'}_${first}`, columns: first ? [first] : [], unique: false, dropped: false }] }
    })
  const addFk = () =>
    upd((d) => {
      const col = d.columns.find((c) => !c.dropped && /_id$/i.test(c.name))?.name ?? liveCols[0] ?? ''
      const guess = tables.find((t) => col && col.replace(/_id$/i, '').toLowerCase().startsWith(t.name.toLowerCase().replace(/s$|ler$|lar$/, '')))?.name ?? tables[0]?.name ?? ''
      loadRefCols(guess)
      return {
        ...d,
        fks: [...d.fks, { key: newKey(), orig: null, name: `fk_${d.name || 'tablo'}_${col}`, columns: col ? [col] : [], refTable: guess, refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION', dropped: false }]
      }
    })

  const reset = () => (table ? setReloadSeq((x) => x + 1) : setDraft(newTableDraft(type, schema)))

  // ---------- Kaydet ----------
  const openPreview = useCallback(() => {
    if (!draft || !changes) return
    try {
      const r = generateDDL(type, draft, ddl)
      if (!r.statements.length && !r.warnings.length) return
      setPreview(r)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [draft, changes, type, ddl, toast])

  const apply = async () => {
    if (!preview || !draft) return
    setApplying(true)
    try {
      await window.api.applyDDL(session.id, preview.statements)
      setPreview(null)
      toast(table ? 'Tablo yapısı güncellendi' : `${draft.name} oluşturuldu`, 'success')
      const saved: TableInfo = { schema: draft.schema, name: draft.name.trim(), kind: 'table' }
      if (table) setReloadSeq((x) => x + 1)
      onSaved(saved)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setApplying(false)
    }
  }

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (preview) apply()
        else openPreview()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (error) return <div className="error-box">{error}</div>
  if (!draft)
    return (
      <div className="home-empty">
        <Loader2 size={20} className="spin" />
      </div>
    )

  const comments = supportsComments(type)
  const types = typeSuggestions(type)
  const rowCls = (orig: unknown, dropped: boolean, changed: boolean) => (dropped ? 'dropped' : !orig ? 'added' : changed ? 'changed' : '')

  return (
    <div className="sedit">
      <div className="toolbar">
        <span className="muted">{table ? 'Tablo' : 'Yeni tablo'}</span>
        <input
          ref={nameRef}
          className={`input mono${table && draft.name !== draft.origName ? ' changed' : ''}`}
          style={{ width: 220 }}
          placeholder="tablo_adi"
          value={draft.name}
          onChange={(e) => upd((d) => ({ ...d, name: e.target.value }))}
        />
        <div style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />
        <button className="btn sm ghost" onClick={addCol}>
          <Plus size={13} /> Sütun
        </button>
        <button className="btn sm ghost" onClick={addIdx}>
          <ListTree size={13} /> İndeks
        </button>
        <button className="btn sm ghost" onClick={addFk} disabled={!tables.length}>
          <Link2 size={13} /> İlişki
        </button>
        <div className="spacer" />
        {changes > 0 && (
          <div className="pending-pill">
            {table ? `${changes} değişiklik` : 'Kaydedilmedi'}
            <button className="btn sm" onClick={reset}>
              <RotateCcw size={13} /> Vazgeç
            </button>
            <button className="btn sm primary" onClick={openPreview} title="SQL'i gör ve uygula (Ctrl+S)">
              <Save size={13} /> {table ? 'Kaydet' : 'Oluştur'}
            </button>
          </div>
        )}
      </div>

      <div className="structure">
        <datalist id={`types-${type}`}>
          {types.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>

        <section>
          <h4>Sütunlar · {liveCols.length}</h4>
          <table className="stable edit">
            <thead>
              <tr>
                <th style={{ width: 30 }}>#</th>
                <th>Ad</th>
                <th>Tip</th>
                <th style={{ width: 70 }} title="NULL olabilir">Boş</th>
                <th>Varsayılan</th>
                <th style={{ width: 54 }} title="Otomatik artan">Oto</th>
                <th style={{ width: 44 }} title="Birincil anahtar">PK</th>
                {comments && <th>Açıklama</th>}
                <th style={{ width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {draft.columns.map((c, i) => {
                const lock = c.dropped || !!c.orig?.generated
                return (
                  <tr key={c.key} className={rowCls(c.orig, c.dropped, colChanged(c))}>
                    <td className="muted">{i + 1}</td>
                    <td>
                      <div className="cell-flex">
                        {c.primaryKey && <KeyRound size={12} color="var(--warn)" />}
                        <input className="input mono" value={c.name} disabled={lock} onChange={(e) => setCol(c.key, { name: e.target.value })} />
                      </div>
                    </td>
                    <td>
                      <input className="input mono" list={`types-${type}`} value={c.type} disabled={lock} onChange={(e) => setCol(c.key, { type: e.target.value })} />
                    </td>
                    <td className="center">
                      <input type="checkbox" checked={c.nullable} disabled={lock || c.primaryKey} onChange={(e) => setCol(c.key, { nullable: e.target.checked })} />
                    </td>
                    <td>
                      <input
                        className="input mono"
                        placeholder={c.nullable ? 'NULL' : 'yok'}
                        title="SQL ifadesi: metin için tırnak kullan ('abc'), sayı için 0, tarih için CURRENT_TIMESTAMP"
                        value={c.defaultValue ?? ''}
                        disabled={lock}
                        onChange={(e) => setCol(c.key, { defaultValue: e.target.value === '' ? null : e.target.value })}
                      />
                    </td>
                    <td className="center">
                      <input type="checkbox" checked={c.autoIncrement} disabled={lock} onChange={(e) => setCol(c.key, { autoIncrement: e.target.checked })} />
                    </td>
                    <td className="center">
                      <input type="checkbox" checked={c.primaryKey} disabled={lock} onChange={(e) => setCol(c.key, { primaryKey: e.target.checked })} />
                    </td>
                    {comments && (
                      <td>
                        <input className="input" value={c.comment} disabled={lock} onChange={(e) => setCol(c.key, { comment: e.target.value })} />
                      </td>
                    )}
                    <td className="center">
                      {c.orig?.generated ? (
                        <span className="pill" title="Hesaplanan sütunlar buradan düzenlenemez">hesap</span>
                      ) : (
                        <button className="icon-btn" title={c.dropped ? 'Geri al' : 'Sütunu sil'} onClick={() => removeCol(c)}>
                          {c.dropped ? <Undo2 size={13} /> : <Trash2 size={13} />}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>

        <section>
          <h4>İndeksler · {draft.indexes.filter((i) => !i.dropped).length}</h4>
          {draft.indexes.length ? (
            <table className="stable edit">
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>Sütunlar</th>
                  <th style={{ width: 80 }}>Benzersiz</th>
                  <th style={{ width: 34 }} />
                </tr>
              </thead>
              <tbody>
                {draft.indexes.map((x) => (
                  <tr key={x.key} className={rowCls(x.orig, x.dropped, idxChanged(x, renames))}>
                    <td>
                      <input className="input mono" value={x.name} disabled={x.dropped} onChange={(e) => setIdx(x.key, { name: e.target.value })} />
                    </td>
                    <td>
                      <ColumnsInput value={x.columns} options={liveCols} disabled={x.dropped} onChange={(v) => setIdx(x.key, { columns: v })} />
                    </td>
                    <td className="center">
                      <input type="checkbox" checked={x.unique} disabled={x.dropped} onChange={(e) => setIdx(x.key, { unique: e.target.checked })} />
                    </td>
                    <td className="center">
                      <button className="icon-btn" title={x.dropped ? 'Geri al' : 'İndeksi sil'} onClick={() => removeIdx(x)}>
                        {x.dropped ? <Undo2 size={13} /> : <Trash2 size={13} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted">İndeks yok. Birincil anahtar, sütunlardaki PK işaretiyle belirlenir.</div>
          )}
        </section>

        <section>
          <h4>İlişkiler (FOREIGN KEY) · {draft.fks.filter((f) => !f.dropped).length}</h4>
          {draft.fks.length ? (
            <table className="stable edit">
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>Sütun</th>
                  <th>Hedef tablo</th>
                  <th>Hedef sütun</th>
                  <th>Silinince</th>
                  <th>Güncellenince</th>
                  <th style={{ width: 34 }} />
                </tr>
              </thead>
              <tbody>
                {draft.fks.map((f) => (
                  <tr key={f.key} className={rowCls(f.orig, f.dropped, fkChanged(f, renames))}>
                    <td>
                      <input className="input mono" value={f.name} disabled={f.dropped || type === 'sqlite'} onChange={(e) => setFk(f.key, { name: e.target.value })} />
                    </td>
                    <td>
                      <ColumnsInput value={f.columns} options={liveCols} disabled={f.dropped} onChange={(v) => setFk(f.key, { columns: v })} />
                    </td>
                    <td>
                      <select
                        className="select"
                        value={f.refTable}
                        disabled={f.dropped}
                        onChange={(e) => {
                          loadRefCols(e.target.value)
                          setFk(f.key, { refTable: e.target.value })
                        }}
                      >
                        {!tables.some((t) => t.name === f.refTable) && <option value={f.refTable}>{f.refTable}</option>}
                        {tables.map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <ColumnsInput value={f.refColumns} options={refCols[f.refTable] ?? []} disabled={f.dropped} onChange={(v) => setFk(f.key, { refColumns: v })} />
                    </td>
                    {(['onDelete', 'onUpdate'] as const).map((k) => (
                      <td key={k}>
                        <select className="select" value={f[k]} disabled={f.dropped} onChange={(e) => setFk(f.key, { [k]: e.target.value } as Partial<EditFk>)}>
                          {FK_ACTIONS.map((a) => (
                            <option key={a}>{a}</option>
                          ))}
                        </select>
                      </td>
                    ))}
                    <td className="center">
                      <button className="icon-btn" title={f.dropped ? 'Geri al' : 'İlişkiyi sil'} onClick={() => removeFk(f)}>
                        {f.dropped ? <Undo2 size={13} /> : <Trash2 size={13} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted">İlişki yok.</div>
          )}
        </section>

        {table && ddl && (
          <section>
            <h4>
              DDL
              <button className="btn sm ghost" onClick={() => copyText(ddl)}>
                <Copy size={12} /> Kopyala
              </button>
            </h4>
            <div className="ddl-box">
              <SqlEditor value={ddl} dbType={type} readOnly />
            </div>
          </section>
        )}
      </div>

      {preview && (
        <Modal wide onClose={() => !applying && setPreview(null)}>
          <div className="modal-head">
            <Save size={17} /> {table ? 'Yapı değişikliklerini uygula' : 'Tabloyu oluştur'}
          </div>
          <div className="modal-body transfer">
            {session.conn.tag === 'production' && (
              <div className="result-box err">
                <AlertTriangle size={18} color="var(--danger)" />
                <div>
                  <b>Production veritabanı</b>
                  <div className="muted">Bu değişiklikler canlı sistemde uygulanacak.</div>
                </div>
              </div>
            )}
            {preview.warnings.map((w) => (
              <div key={w} className="warn-line">
                <AlertTriangle size={14} /> {w}
              </div>
            ))}
            {(type === 'mysql' || type === 'mariadb') && preview.statements.length > 1 && (
              <div className="muted">MySQL yapı değişikliklerini geri alamaz: ifadeler sırayla çalışır, hata olursa öncekiler uygulanmış kalır.</div>
            )}
            <div className="ddl-box">
              <SqlEditor value={preview.statements.join(';\n\n') + ';'} dbType={type} readOnly />
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn sm ghost" onClick={() => copyText(preview.statements.join(';\n\n') + ';')}>
              <Copy size={13} /> SQL'i kopyala
            </button>
            <div className="spacer" />
            <button className="btn" onClick={() => setPreview(null)} disabled={applying}>
              Vazgeç
            </button>
            <button className={`btn ${session.conn.tag === 'production' ? 'danger solid' : 'primary'}`} onClick={apply} disabled={applying}>
              {applying ? <Loader2 size={14} className="spin" /> : <Save size={14} />} Uygula
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** Virgülle ayrılmış sütun listesi + listeden ekleme */
function ColumnsInput({ value, options, disabled, onChange }: { value: string[]; options: string[]; disabled?: boolean; onChange(v: string[]): void }) {
  const [text, setText] = useState(value.join(', '))
  useEffect(() => setText(value.join(', ')), [value])
  const rest = options.filter((o) => !value.includes(o))
  return (
    <div className="cell-flex">
      <input
        className="input mono"
        value={text}
        disabled={disabled}
        placeholder="sütun1, sütun2"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(listOf(text))}
        onKeyDown={(e) => e.key === 'Enter' && onChange(listOf(text))}
      />
      {!disabled && rest.length > 0 && (
        <select className="select add-col" value="" title="Sütun ekle" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">+</option>
          {rest.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
