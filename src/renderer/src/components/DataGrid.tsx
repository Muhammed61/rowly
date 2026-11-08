import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, KeyRound } from 'lucide-react'
import type { Cell } from '@shared/types'
import { DENSITY, useStore } from '../store'

export interface GridColumn {
  name: string
  type?: string
  primaryKey?: boolean
}

export interface GridProps {
  columns: GridColumn[]
  rowCount: number
  getCell(r: number, c: number): Cell | undefined
  rowNumberOffset?: number
  rowClass?(r: number): string
  cellEdited?(r: number, c: number): boolean
  canEdit?(r: number, c: number): boolean
  onEdit?(r: number, c: number, value: Cell): void
  sort?: { column: string; dir: 'ASC' | 'DESC' } | null
  onSort?(column: string): void
  onSelectionChange?(rows: number[]): void
  onContextMenu?(e: React.MouseEvent, r: number, c: number, rows: number[]): void
  onDeleteRows?(rows: number[]): void
  onCopy?(text: string): void
  /** Dışarıdan bir hücreyi aktif yapmak için (ör. yeni satır eklenince) */
  focusCell?: { r: number; c: number; edit?: boolean; seq: number } | null
  emptyText?: string
}

const NUMERIC = /int|dec|num|float|double|real|money|serial|bit\b|year/i

export const cellToText = (v: Cell | undefined) => (v === undefined ? '' : v === null ? 'NULL' : String(v))

function display(v: Cell | undefined) {
  if (v === undefined) return <span className="def">DEFAULT</span>
  if (v === null) return <span className="null">NULL</span>
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  const s = String(v)
  if (s === '') return ''
  return (s.length > 400 ? s.slice(0, 400) + '…' : s).replace(/\r?\n/g, '↵ ')
}

function measure(columns: GridColumn[], rowCount: number, getCell: GridProps['getCell']) {
  const sample = Math.min(rowCount, 60)
  return columns.map((col, c) => {
    // Başlıkta ad ve tip yan yana durur: ikisinin toplamı sığmalı
    let w = col.name.length * 7.6 + (col.type ? Math.min(col.type.length, 18) * 6.2 + 8 : 0) + (col.primaryKey ? 18 : 0) + 24
    for (let r = 0; r < sample; r++) {
      const v = getCell(r, c)
      const len = v === null || v === undefined ? 5 : Math.min(String(v).length, 60)
      w = Math.max(w, len * 7.3 + 18)
    }
    return Math.round(Math.min(Math.max(w, 70), 340))
  })
}

interface EditState {
  r: number
  c: number
  value: string
  multiline: boolean
}

export const DataGrid = memo(function DataGrid(p: GridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Satır yüksekliği görünüm ayarından gelir
  const { row: ROW_H, head: HEAD_H } = DENSITY[useStore((s) => s.prefs.density)]
  const [active, setActive] = useState<{ r: number; c: number } | null>(null)
  const [selRows, setSelRows] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const colKey = p.columns.map((c) => c.name).join('\u0001')
  const [widths, setWidths] = useState<number[]>([])

  // Sütun seti değişince genişlikleri yeniden hesapla
  useLayoutEffect(() => {
    setWidths(measure(p.columns, p.rowCount, p.getCell))
    setActive(null)
    setSelRows(new Set())
    setEditing(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey])

  // Satır sayısı değişince seçim dışında kalanları temizle
  useEffect(() => {
    setSelRows((s) => {
      const n = new Set([...s].filter((r) => r < p.rowCount))
      return n.size === s.size ? s : n
    })
    setActive((a) => (a && a.r >= p.rowCount ? null : a))
  }, [p.rowCount])

  const selectedList = useMemo(() => {
    if (selRows.size) return [...selRows].sort((a, b) => a - b)
    return active ? [active.r] : []
  }, [selRows, active])

  const onSel = p.onSelectionChange
  useEffect(() => onSel?.(selectedList), [selectedList, onSel])

  const digits = String((p.rowNumberOffset ?? 0) + p.rowCount).length
  const numW = Math.max(44, 18 + digits * 8)
  const lefts = useMemo(() => {
    const l: number[] = []
    let x = numW
    for (const w of widths) {
      l.push(x)
      x += w
    }
    l.push(x)
    return l
  }, [widths, numW])
  const totalW = lefts[lefts.length - 1] ?? numW

  const virt = useVirtualizer({
    count: p.rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 14
  })
  useEffect(() => virt.measure(), [ROW_H, virt])

  const numericCol = useMemo(() => p.columns.map((c) => !!c.type && NUMERIC.test(c.type)), [p.columns])

  const scrollIntoView = useCallback(
    (r: number, c: number) => {
      const el = scrollRef.current
      if (!el) return
      const top = r * ROW_H
      const viewTop = el.scrollTop
      const viewH = el.clientHeight - HEAD_H
      if (top < viewTop) el.scrollTop = top
      else if (top + ROW_H > viewTop + viewH) el.scrollTop = top + ROW_H - viewH
      const left = lefts[c] - numW
      const right = lefts[c + 1]
      if (left < el.scrollLeft) el.scrollLeft = left
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
    },
    [lefts, numW, ROW_H, HEAD_H]
  )

  const startEdit = useCallback(
    (r: number, c: number, initial?: string) => {
      if (!p.canEdit?.(r, c)) return
      const v = p.getCell(r, c)
      const text = initial ?? (v === null || v === undefined ? '' : String(v))
      setEditing({ r, c, value: text, multiline: text.length > 80 || text.includes('\n') })
      scrollIntoView(r, c)
    },
    [p, scrollIntoView]
  )

  const commitEdit = useCallback(
    (e: EditState | null, focusGrid = true) => {
      if (!e) return
      setEditing(null)
      const orig = p.getCell(e.r, e.c)
      const origText = orig === null || orig === undefined ? null : String(orig)
      if (origText !== e.value || orig === undefined) {
        if (!(orig === undefined && e.value === '')) p.onEdit?.(e.r, e.c, e.value)
      }
      if (focusGrid) requestAnimationFrame(() => scrollRef.current?.focus())
    },
    [p]
  )

  // Dışarıdan odak isteği
  useEffect(() => {
    if (!p.focusCell) return
    const { r, c, edit } = p.focusCell
    setActive({ r, c })
    setSelRows(new Set())
    requestAnimationFrame(() => {
      scrollIntoView(r, c)
      if (edit) startEdit(r, c)
      else scrollRef.current?.focus()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focusCell?.seq])

  const copySelection = () => {
    if (selRows.size) {
      const lines = selectedList.map((r) => p.columns.map((_, c) => cellToText(p.getCell(r, c))).join('\t'))
      p.onCopy?.(lines.join('\n'))
    } else if (active) {
      p.onCopy?.(cellToText(p.getCell(active.r, active.c)))
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      copySelection()
      return
    }
    if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelRows(new Set(Array.from({ length: p.rowCount }, (_, i) => i)))
      return
    }
    if (e.key === 'Escape') {
      setSelRows(new Set())
      return
    }
    if ((e.key === 'Delete' || (e.key === 'Backspace' && ctrl)) && p.onDeleteRows && selectedList.length) {
      e.preventDefault()
      p.onDeleteRows(selectedList)
      return
    }
    if (!active) {
      if (p.rowCount && p.columns.length && e.key.startsWith('Arrow')) setActive({ r: 0, c: 0 })
      return
    }
    let { r, c } = active
    const maxR = p.rowCount - 1
    const maxC = p.columns.length - 1
    switch (e.key) {
      case 'ArrowUp':
        r = ctrl ? 0 : Math.max(0, r - 1)
        break
      case 'ArrowDown':
        r = ctrl ? maxR : Math.min(maxR, r + 1)
        break
      case 'ArrowLeft':
        c = ctrl ? 0 : Math.max(0, c - 1)
        break
      case 'ArrowRight':
        c = ctrl ? maxC : Math.min(maxC, c + 1)
        break
      case 'Tab':
        c = e.shiftKey ? Math.max(0, c - 1) : Math.min(maxC, c + 1)
        break
      case 'PageDown':
        r = Math.min(maxR, r + 20)
        break
      case 'PageUp':
        r = Math.max(0, r - 20)
        break
      case 'Home':
        c = 0
        break
      case 'End':
        c = maxC
        break
      case 'Enter':
      case 'F2':
        e.preventDefault()
        startEdit(r, c)
        return
      default:
        if (e.key.length === 1 && !ctrl && !e.altKey) {
          e.preventDefault()
          startEdit(r, c, e.key)
        }
        return
    }
    e.preventDefault()
    if (!e.shiftKey || e.key === 'Tab') setSelRows(new Set())
    setActive({ r, c })
    scrollIntoView(r, c)
  }

  const clickRowNum = (e: React.MouseEvent, r: number) => {
    scrollRef.current?.focus()
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, r), Math.max(anchor.current, r)]
      setSelRows(new Set(Array.from({ length: b - a + 1 }, (_, i) => a + i)))
    } else if (e.ctrlKey || e.metaKey) {
      setSelRows((s) => {
        const n = new Set(s)
        if (n.has(r)) n.delete(r)
        else n.add(r)
        return n
      })
      anchor.current = r
    } else {
      setSelRows(new Set([r]))
      anchor.current = r
    }
    setActive({ r, c: active?.c ?? 0 })
  }

  const startResize = (e: React.MouseEvent, c: number) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = widths[c]
    const move = (ev: MouseEvent) => {
      const w = Math.max(50, startW + ev.clientX - startX)
      setWidths((ws) => ws.map((x, i) => (i === c ? w : x)))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const items = virt.getVirtualItems()

  return (
    <div className="grid-wrap">
      <div className="grid" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}>
        <div className="grid-inner" style={{ width: totalW, height: HEAD_H + virt.getTotalSize() }}>
          <div className="grid-head" style={{ width: totalW }}>
            <div className="rownum" style={{ width: numW, lineHeight: HEAD_H + 'px' }} />
            {p.columns.map((col, c) => (
              <div
                key={col.name + c}
                className="gh"
                style={{ width: widths[c] }}
                title={col.type ? `${col.name} · ${col.type}` : col.name}
                onClick={() => p.onSort?.(col.name)}
              >
                {col.primaryKey && <KeyRound size={12} className="pk" />}
                <span className="name">{col.name}</span>
                {col.type && <span className="type">{col.type}</span>}
                {p.sort?.column === col.name && (
                  <span className="sort">{p.sort.dir === 'ASC' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}</span>
                )}
                <div className="resize" onMouseDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} />
              </div>
            ))}
          </div>

          {items.map((vr) => {
            const r = vr.index
            const sel = selRows.has(r)
            return (
              <div
                key={r}
                data-row={r}
                className={`gr${sel ? ' sel' : ''} ${p.rowClass?.(r) ?? ''}`}
                style={{ top: HEAD_H + vr.start, width: totalW }}
              >
                <div className="rownum" style={{ width: numW }} onMouseDown={(e) => clickRowNum(e, r)}>
                  {(p.rowNumberOffset ?? 0) + r + 1}
                </div>
                {p.columns.map((_, c) => {
                  const v = p.getCell(r, c)
                  const isActive = active?.r === r && active?.c === c
                  const cls = `gc${numericCol[c] || typeof v === 'number' ? ' num' : ''}${p.cellEdited?.(r, c) ? ' edited' : ''}${
                    isActive ? ' active' : ''
                  }`
                  return (
                    <div
                      key={c}
                      className={cls}
                      style={{ width: widths[c] }}
                      onMouseDown={(e) => {
                        if (e.button === 2 && (selRows.has(r) || (active?.r === r && active.c === c))) return
                        setActive({ r, c })
                        if (!e.shiftKey) setSelRows(new Set())
                      }}
                      onDoubleClick={() => startEdit(r, c)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        const rows = selRows.has(r) ? selectedList : [r]
                        if (!selRows.has(r)) setActive({ r, c })
                        p.onContextMenu?.(e, r, c, rows)
                      }}
                    >
                      {display(v)}
                    </div>
                  )
                })}
              </div>
            )
          })}

          {editing && (
            <CellEditor
              key={`${editing.r}:${editing.c}`}
              state={editing}
              left={lefts[editing.c]}
              top={HEAD_H + editing.r * ROW_H}
              width={Math.max(widths[editing.c], editing.multiline ? 360 : 0)}
              rowH={ROW_H}
              onChange={(value) => setEditing((s) => (s ? { ...s, value } : s))}
              onCommit={(next) => {
                commitEdit(editing)
                if (next) {
                  const c = Math.max(0, Math.min(p.columns.length - 1, editing.c + next.dc))
                  const r = Math.max(0, Math.min(p.rowCount - 1, editing.r + next.dr))
                  setActive({ r, c })
                  scrollIntoView(r, c)
                  // Tab ile veri girişi: sonraki hücre doğrudan düzenleme modunda açılır
                  if (next.dc !== 0 && c !== editing.c) requestAnimationFrame(() => startEdit(r, c))
                }
              }}
              onBlurCommit={() => commitEdit(editing, false)}
              onCancel={() => {
                setEditing(null)
                requestAnimationFrame(() => scrollRef.current?.focus())
              }}
            />
          )}
        </div>
        {p.rowCount === 0 && p.emptyText && <div className="grid-msg">{p.emptyText}</div>}
      </div>
    </div>
  )
})

function CellEditor(props: {
  state: EditState
  left: number
  top: number
  width: number
  rowH: number
  onChange(v: string): void
  onCommit(next?: { dr: number; dc: number }): void
  onBlurCommit(): void
  onCancel(): void
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const len = el.value.length
    el.setSelectionRange(len, len)
  }, [])
  const finish = (fn: () => void) => {
    done.current = true
    fn()
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+S: düzenlemeyi işle ve kaydetme kısayolunun pencereye ulaşmasına izin ver
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      finish(() => props.onCommit())
      return
    }
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      finish(props.onCancel)
    } else if (e.key === 'Enter' && !(props.state.multiline && e.shiftKey)) {
      e.preventDefault()
      finish(() => props.onCommit({ dr: 1, dc: 0 }))
    } else if (e.key === 'Tab') {
      e.preventDefault()
      finish(() => props.onCommit({ dr: 0, dc: e.shiftKey ? -1 : 1 }))
    }
  }
  const common = {
    ref,
    className: 'cell-editor',
    value: props.state.value,
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => props.onChange(e.target.value),
    onKeyDown,
    onBlur: () => {
      if (!done.current) props.onBlurCommit()
    }
  }
  return props.state.multiline ? (
    <textarea {...common} style={{ left: props.left, top: props.top, width: props.width, height: 140 }} />
  ) : (
    <input {...common} style={{ left: props.left, top: props.top, width: props.width, height: props.rowH }} />
  )
}
