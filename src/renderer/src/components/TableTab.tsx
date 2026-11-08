import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  CopyPlus,
  Filter as FilterIcon,
  Funnel,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Sheet,
  Trash2,
  Undo2,
  Download,
  Upload,
  Wrench,
  X
} from 'lucide-react'
import { FILTER_OPS, type Cell, type ColumnInfo, type Filter, type ResultColumn, type RowChange } from '@shared/types'
import { FAMILY_LABELS, familyOf } from '@shared/dialects'
import { tableKey, useStore, type Tab } from '../store'
import { DataGrid, cellToText, type GridColumn } from './DataGrid'
import { StructureView } from './StructureView'
import { StructureEditor } from './StructureEditor'
import { ContextMenu, copyText, type MenuState } from './ui'

type TableTabT = Extract<Tab, { kind: 'table' }>

const PAGE_SIZES = [100, 200, 500, 1000, 5000]

export function TableTab({ tab, active }: { tab: TableTabT; active: boolean }) {
  const session = useStore((s) => s.session)!
  const toast = useStore((s) => s.toast)
  const confirm = useStore((s) => s.confirm)
  const setDirty = useStore((s) => s.setDirty)
  const updateTab = useStore((s) => s.updateTab)
  const refreshTables = useStore((s) => s.refreshTables)
  const openDialog = useStore((s) => s.openDialog)
  // İçe aktarma bu tabloya veri ekleyince yeniden yükle
  const bump = useStore((s) => s.tableBump[tableKey(tab.table)] ?? 0)
  const ref = useMemo(() => ({ schema: tab.table.schema, name: tab.table.name }), [tab.table.schema, tab.table.name])
  const isTable = tab.table.kind === 'table'
  const labels = FAMILY_LABELS[familyOf(session.conn.type)]

  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [data, setData] = useState<{ cols: ResultColumn[]; rows: Cell[][] }>({ cols: [], rows: [] })
  const [total, setTotal] = useState(0)
  const [ms, setMs] = useState(0)
  const [page, setPage] = useState(0)
  const [limit, setLimit] = useState(200)
  const [orderBy, setOrderBy] = useState<{ column: string; dir: 'ASC' | 'DESC' } | null>(null)
  const [filters, setFilters] = useState<Filter[]>([])
  const [draft, setDraft] = useState<Filter[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadSeq, setReloadSeq] = useState(0)

  // Bekleyen değişiklikler
  const [edits, setEdits] = useState<Record<number, Record<number, Cell>>>({})
  const [inserts, setInserts] = useState<(Cell | undefined)[][]>([])
  const [deletes, setDeletes] = useState<Set<number>>(new Set())
  const [selection, setSelection] = useState<number[]>([])
  const [focusCell, setFocusCell] = useState<{ r: number; c: number; edit?: boolean; seq: number } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const pendingCount = Object.keys(edits).length + inserts.length + deletes.size
  const [structDirty, setStructDirty] = useState(0)
  useEffect(() => setDirty(tab.id, pendingCount + structDirty), [pendingCount, structDirty, tab.id, setDirty])

  const clearPending = () => {
    setEdits({})
    setInserts([])
    setDeletes(new Set())
  }

  // Sütun bilgisi
  useEffect(() => {
    let off = false
    window.api
      .getColumns(session.id, ref)
      .then((c) => !off && setColumns(c))
      .catch((e) => !off && setError((e as Error).message))
    return () => {
      off = true
    }
  }, [session.id, ref, reloadSeq, bump])

  // Veri
  useEffect(() => {
    let off = false
    setLoading(true)
    window.api
      .fetchRows(session.id, { table: ref, limit, offset: page * limit, orderBy, filters })
      .then((r) => {
        if (off) return
        setData({ cols: r.result.columns, rows: r.result.rows })
        setTotal(r.total)
        setMs(r.result.durationMs)
        setError(null)
        clearPending()
      })
      .catch((e) => !off && setError((e as Error).message))
      .finally(() => !off && setLoading(false))
    return () => {
      off = true
    }
  }, [session.id, ref, limit, page, orderBy, filters, reloadSeq, bump])

  const colInfoByName = useMemo(() => new Map(columns.map((c) => [c.name, c])), [columns])
  const gridCols: GridColumn[] = useMemo(
    () =>
      data.cols.map((c) => {
        const info = colInfoByName.get(c.name)
        return { name: c.name, type: info?.type, primaryKey: info?.primaryKey }
      }),
    [data.cols, colInfoByName]
  )
  const pkIdx = useMemo(() => gridCols.map((c, i) => (c.primaryKey ? i : -1)).filter((i) => i >= 0), [gridCols])
  const hasPk = pkIdx.length > 0
  const n = data.rows.length

  /** Kaydedilmemiş değişiklik varsa onay ister */
  const guard = useCallback(async () => {
    if (!pendingCount) return true
    return confirm({
      title: 'Kaydedilmemiş değişiklikler',
      message: `${pendingCount} değişiklik kaydedilmedi. Vazgeçip devam edilsin mi?`,
      confirmLabel: 'Değişiklikleri at',
      danger: true
    })
  }, [pendingCount, confirm])

  const reload = useCallback(async () => {
    if (await guard()) setReloadSeq((x) => x + 1)
  }, [guard])

  const getCell = useCallback(
    (r: number, c: number): Cell | undefined => {
      if (r < n) {
        const e = edits[r]
        if (e && c in e) return e[c]
        return data.rows[r][c]
      }
      return inserts[r - n]?.[c]
    },
    [n, edits, data.rows, inserts]
  )

  const canEdit = useCallback(
    (r: number) => isTable && !deletes.has(r) && (r >= n || hasPk),
    [isTable, deletes, n, hasPk]
  )

  const onEdit = useCallback(
    (r: number, c: number, v: Cell) => {
      if (r >= n) {
        setInserts((ins) => ins.map((row, i) => (i === r - n ? row.map((x, j) => (j === c ? v : x)) : row)))
        return
      }
      const orig = data.rows[r][c]
      setEdits((ed) => {
        const row = { ...(ed[r] ?? {}) }
        const same = v === null ? orig === null : orig !== null && String(orig) === String(v)
        if (same) delete row[c]
        else row[c] = v
        const next = { ...ed }
        if (Object.keys(row).length) next[r] = row
        else delete next[r]
        return next
      })
    },
    [n, data.rows]
  )

  const deleteRows = useCallback(
    (rows: number[]) => {
      if (!isTable) return
      const existing = rows.filter((r) => r < n)
      const newOnes = new Set(rows.filter((r) => r >= n).map((r) => r - n))
      if (existing.length && !hasPk) {
        toast('Birincil anahtarı (primary key) olmayan tablolarda satır silinemez.', 'error')
      } else if (existing.length) {
        setDeletes((d) => {
          const nx = new Set(d)
          // Hepsi zaten işaretliyse işareti kaldır (geri al)
          const allMarked = existing.every((r) => nx.has(r))
          existing.forEach((r) => (allMarked ? nx.delete(r) : nx.add(r)))
          return nx
        })
      }
      if (newOnes.size) setInserts((ins) => ins.filter((_, i) => !newOnes.has(i)))
    },
    [isTable, n, hasPk, toast]
  )

  const addRow = (copyFrom?: number) => {
    if (!isTable || !gridCols.length) return
    const row: (Cell | undefined)[] = gridCols.map((col, c) => {
      if (copyFrom === undefined) return undefined
      const info = colInfoByName.get(col.name)
      if (info?.autoIncrement || info?.primaryKey) return undefined
      return getCell(copyFrom, c)
    })
    setInserts((ins) => [...ins, row])
    const firstEditable = Math.max(
      0,
      gridCols.findIndex((c) => !colInfoByName.get(c.name)?.autoIncrement)
    )
    setFocusCell({ r: n + inserts.length, c: firstEditable, edit: copyFrom === undefined, seq: Date.now() })
  }

  const save = useCallback(async () => {
    if (!pendingCount || saving) return
    const pkOf = (r: number) => Object.fromEntries(pkIdx.map((i) => [gridCols[i].name, data.rows[r][i]]))
    const changes: RowChange[] = []
    for (const r of deletes) changes.push({ kind: 'delete', pk: pkOf(r) })
    for (const [rs, vals] of Object.entries(edits)) {
      const r = Number(rs)
      if (deletes.has(r)) continue
      changes.push({
        kind: 'update',
        pk: pkOf(r),
        values: Object.fromEntries(Object.entries(vals).map(([c, v]) => [gridCols[Number(c)].name, v]))
      })
    }
    for (const row of inserts) {
      const values: Record<string, Cell> = {}
      row.forEach((v, c) => {
        if (v !== undefined) values[gridCols[c].name] = v
      })
      changes.push({ kind: 'insert', values })
    }
    if (session.conn.tag === 'production') {
      const ok = await confirm({
        title: 'Production veritabanı',
        message: `"${session.conn.name}" bir PRODUCTION bağlantısı.\n\n${deletes.size} silme, ${Object.keys(edits).length} güncelleme, ${inserts.length} ekleme uygulanacak. Emin misin?`,
        confirmLabel: 'Uygula',
        danger: true
      })
      if (!ok) return
    }
    setSaving(true)
    try {
      await window.api.applyChanges(session.id, ref, changes)
      toast(`${changes.length} değişiklik kaydedildi`, 'success')
      clearPending()
      setReloadSeq((x) => x + 1)
    } catch (e) {
      toast(`Kaydedilemedi: ${(e as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [pendingCount, saving, pkIdx, gridCols, data.rows, deletes, edits, inserts, session, ref, toast, confirm])

  // Klavye kısayolları (yalnızca aktif sekmede)
  const actions = useRef({ save, reload, addRow, toggleFilters: () => {} })
  actions.current.save = save
  actions.current.reload = reload
  actions.current.addRow = addRow
  actions.current.toggleFilters = () => {
    setShowFilters((s) => {
      if (!s && !draft.length && gridCols.length) setDraft([{ column: gridCols[0].name, op: 'CONTAINS', value: '' }])
      return !s
    })
  }
  // Veri kısayolları yalnızca Veri görünümünde; Yapı görünümünün kendi Ctrl+S'i var
  const viewRef = useRef(tab.view)
  viewRef.current = tab.view
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (viewRef.current !== 'data') return
      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (ctrl && k === 's') {
        e.preventDefault()
        setTimeout(() => actions.current.save())
      } else if ((ctrl && k === 'r') || e.key === 'F5') {
        e.preventDefault()
        actions.current.reload()
      } else if (ctrl && k === 'f') {
        e.preventDefault()
        actions.current.toggleFilters()
      } else if (ctrl && k === 'i') {
        e.preventDefault()
        actions.current.addRow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  const onSort = useCallback(
    async (column: string) => {
      if (!(await guard())) return
      setOrderBy((o) => (o?.column !== column ? { column, dir: 'ASC' } : o.dir === 'ASC' ? { column, dir: 'DESC' } : null))
      setPage(0)
    },
    [guard]
  )

  const applyFilters = async (next: Filter[] = draft) => {
    if (!(await guard())) return
    const valid = next.filter((f) => f.column && (f.op === 'IS NULL' || f.op === 'IS NOT NULL' || f.value !== ''))
    setFilters(valid)
    setPage(0)
  }

  const goPage = async (p: number) => {
    if (await guard()) setPage(p)
  }

  const onContextMenu = useCallback(
    (e: React.MouseEvent, r: number, c: number, rows: number[]) => {
      const col = gridCols[c]
      const info = colInfoByName.get(col.name)
      const v = getCell(r, c)
      const editable = canEdit(r)
      const toJson = () =>
        JSON.stringify(
          rows.map((rr) => Object.fromEntries(gridCols.map((gc, ci) => [gc.name, getCell(rr, ci) ?? null]))),
          null,
          2
        )
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: 'Değeri kopyala', icon: <Copy size={13} />, shortcut: 'Ctrl+C', onClick: () => copyText(cellToText(v)) },
          {
            label: rows.length > 1 ? `${rows.length} satırı kopyala` : 'Satırı kopyala',
            onClick: () => copyText(rows.map((rr) => gridCols.map((_, ci) => cellToText(getCell(rr, ci))).join('\t')).join('\n'))
          },
          { label: 'JSON olarak kopyala', onClick: () => copyText(toJson()) },
          { separator: true },
          {
            label: 'Bu değerle filtrele',
            icon: <FilterIcon size={13} />,
            disabled: v === undefined,
            onClick: () => {
              const f: Filter = v === null ? { column: col.name, op: 'IS NULL', value: '' } : { column: col.name, op: '=', value: String(v) }
              setDraft([f])
              setShowFilters(true)
              applyFilters([f])
            }
          },
          { separator: true },
          {
            label: 'NULL yap',
            disabled: !editable || info?.nullable === false,
            onClick: () => onEdit(r, c, null)
          },
          {
            label: 'Değişikliği geri al',
            icon: <Undo2 size={13} />,
            disabled: !(r < n && edits[r] && c in edits[r]),
            onClick: () => onEdit(r, c, data.rows[r][c])
          },
          { label: 'Satırı çoğalt', icon: <CopyPlus size={13} />, disabled: !isTable, onClick: () => addRow(r) },
          {
            label: rows.length > 1 ? `${rows.length} satırı sil` : 'Satırı sil',
            icon: <Trash2 size={13} />,
            danger: true,
            shortcut: 'Del',
            disabled: !isTable,
            onClick: () => deleteRows(rows)
          }
        ]
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gridCols, colInfoByName, getCell, canEdit, n, edits, data.rows, isTable, onEdit, deleteRows]
  )

  const pages = Math.max(1, Math.ceil(total / limit))
  const from = total ? page * limit + 1 : 0
  const to = Math.min(total, page * limit + n)

  return (
    <>
      {tab.view === 'data' && (
        <>
          <div className="toolbar">
            <button className={`icon-btn${showFilters ? ' active' : ''}`} title="Filtre (Ctrl+F)" onClick={() => actions.current.toggleFilters()}>
              <Funnel size={15} />
            </button>
            {filters.length > 0 && (
              <span className="tag-chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                {filters.length} filtre
              </span>
            )}
            <button className="icon-btn" title="Yenile (Ctrl+R)" onClick={reload}>
              {loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            </button>
            <button
              className="icon-btn"
              title="Dışa aktar"
              onClick={() => openDialog({ kind: 'export', tables: [tab.table], filters, orderBy })}
            >
              <Download size={15} />
            </button>
            {isTable && (
              <button className="icon-btn" title="İçe aktar" onClick={() => openDialog({ kind: 'import', table: tab.table })}>
                <Upload size={15} />
              </button>
            )}
            <div style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />
            <button className="btn sm ghost" disabled={!isTable} title={`${labels.newRow} ekle (Ctrl+I)`} onClick={() => addRow()}>
              <Plus size={14} /> {labels.newRow}
            </button>
            <button className="btn sm ghost" disabled={!isTable || !selection.length} title="Seçili satırları sil (Del)" onClick={() => deleteRows(selection)}>
              <Trash2 size={14} /> Sil
            </button>
            {isTable && !hasPk && columns.length > 0 && (
              <span className="muted" style={{ fontSize: 11.5 }}>
                Birincil anahtar yok · yalnızca ekleme yapılabilir
              </span>
            )}
            {!isTable && <span className="muted" style={{ fontSize: 11.5 }}>Görünüm · salt okunur</span>}
            <div className="spacer" />
            {pendingCount > 0 && (
              <div className="pending-pill">
                {pendingCount} değişiklik
                <button className="btn sm" onClick={clearPending} title="Tüm değişiklikleri at">
                  <RotateCcw size={13} /> Vazgeç
                </button>
                <button className="btn sm primary" onClick={save} disabled={saving} title="Kaydet (Ctrl+S)">
                  {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Kaydet
                </button>
              </div>
            )}
          </div>

          {showFilters && (
            <div className="filters">
              {draft.map((f, i) => (
                <div className="filter-row" key={i}>
                  <select
                    className="select col"
                    value={f.column}
                    onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}
                  >
                    {gridCols.map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                  </select>
                  <select
                    className="select op"
                    value={f.op}
                    onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, op: e.target.value as Filter['op'] } : x)))}
                  >
                    {FILTER_OPS.map((o) => (
                      <option key={o} value={o}>
                        {o === 'CONTAINS' ? 'içerir' : o}
                      </option>
                    ))}
                  </select>
                  {f.op !== 'IS NULL' && f.op !== 'IS NOT NULL' ? (
                    <input
                      className="input mono"
                      autoFocus={i === draft.length - 1}
                      placeholder={f.op === 'IN' ? 'değer1, değer2, …' : f.op.includes('LIKE') ? '%değer%' : 'değer'}
                      value={f.value}
                      onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
                    />
                  ) : (
                    <div className="spacer" />
                  )}
                  <button
                    className="icon-btn"
                    title="Filtreyi kaldır"
                    onClick={() => {
                      const next = draft.filter((_, j) => j !== i)
                      setDraft(next)
                      if (!next.length) {
                        setShowFilters(false)
                        if (filters.length) applyFilters([])
                      }
                    }}
                  >
                    <X size={14} />
                  </button>
                  {i === draft.length - 1 && (
                    <>
                      <button
                        className="btn sm"
                        onClick={() => setDraft((d) => [...d, { column: gridCols[0]?.name ?? '', op: 'CONTAINS', value: '' }])}
                      >
                        <Plus size={13} />
                      </button>
                      <button className="btn sm primary" onClick={() => applyFilters()}>
                        Uygula
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="grid-wrap">
            {loading && <div className="loading-bar" />}
            {error ? (
              <div className="error-box">{error}</div>
            ) : (
              <DataGrid
                columns={gridCols}
                rowCount={n + inserts.length}
                getCell={getCell}
                rowNumberOffset={page * limit}
                rowClass={(r) => (deletes.has(r) ? 'deleted' : r >= n ? 'inserted' : '')}
                cellEdited={(r, c) => r < n && !!edits[r] && c in edits[r]}
                canEdit={canEdit}
                onEdit={onEdit}
                sort={orderBy}
                onSort={onSort}
                onSelectionChange={setSelection}
                onContextMenu={onContextMenu}
                onDeleteRows={deleteRows}
                onCopy={copyText}
                focusCell={focusCell}
                emptyText={loading ? '' : filters.length ? 'Filtreyle eşleşen kayıt yok' : 'Kayıt yok'}
              />
            )}
          </div>
        </>
      )}

      {tab.view === 'structure' &&
        (isTable && familyOf(session.conn.type) === 'sql' ? (
          <StructureEditor
            table={tab.table}
            active={active}
            onDirty={setStructDirty}
            onSaved={(t) => {
              // Yeniden adlandırıldıysa sekmeyi güncelle; veri görünümü yeni yapıyla yüklensin
              if (t.name !== tab.table.name) updateTab(tab.id, { table: { ...tab.table, name: t.name }, title: t.name })
              setReloadSeq((x) => x + 1)
              refreshTables()
            }}
          />
        ) : (
          <StructureView sessionId={session.id} table={ref} columns={columns} reloadSeq={reloadSeq} />
        ))}

      <div className="statusbar">
        <div className="segmented">
          <button className={tab.view === 'data' ? 'active' : ''} onClick={() => updateTab(tab.id, { view: 'data' })}>
            <Sheet size={13} /> Veri
          </button>
          <button className={tab.view === 'structure' ? 'active' : ''} onClick={() => updateTab(tab.id, { view: 'structure' })}>
            <Wrench size={13} /> Yapı
          </button>
        </div>
        {tab.view === 'data' && (
          <>
            <span>
              {total ? `${from.toLocaleString('tr-TR')}–${to.toLocaleString('tr-TR')} / ${total.toLocaleString('tr-TR')} ${labels.rows}` : `0 ${labels.rows}`}
              <span className="muted"> · {ms} ms</span>
            </span>
            <div className="spacer" />
            <div className="pager">
              <button className="icon-btn" disabled={page === 0} onClick={() => goPage(0)} title="İlk sayfa">
                <ChevronsLeft size={15} />
              </button>
              <button className="icon-btn" disabled={page === 0} onClick={() => goPage(page - 1)} title="Önceki sayfa">
                <ChevronLeft size={15} />
              </button>
              <span style={{ padding: '0 6px' }}>
                {page + 1} / {pages}
              </span>
              <button className="icon-btn" disabled={page >= pages - 1} onClick={() => goPage(page + 1)} title="Sonraki sayfa">
                <ChevronRight size={15} />
              </button>
              <button className="icon-btn" disabled={page >= pages - 1} onClick={() => goPage(pages - 1)} title="Son sayfa">
                <ChevronsRight size={15} />
              </button>
              <select
                className="select"
                value={limit}
                onChange={async (e) => {
                  if (!(await guard())) return
                  setLimit(Number(e.target.value))
                  setPage(0)
                }}
                title="Sayfa başına satır"
              >
                {PAGE_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s} satır
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </>
  )
}
