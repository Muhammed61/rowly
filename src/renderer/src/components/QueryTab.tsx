import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { Download, History, Loader2, Play, PlayCircle } from 'lucide-react'
import type { QueryResult } from '@shared/types'
import { changesSchema, familyOf, isReadStatement, splitStatements } from '@shared/dialects'
import { useStore, type Tab } from '../store'
import { DataGrid } from './DataGrid'
import { SqlEditor } from './SqlEditor'
import { ContextMenu, Resizer, copyText, type MenuState } from './ui'

type QueryTabT = Extract<Tab, { kind: 'query' }>

interface HistoryItem {
  sql: string
  at: number
}

const historyKey = (id: string) => `history:${id}`
const readHistory = (id: string): HistoryItem[] => {
  try {
    return JSON.parse(localStorage.getItem(historyKey(id)) ?? '[]')
  } catch {
    return []
  }
}
const pushHistory = (id: string, sql: string) => {
  try {
    const list = [{ sql, at: Date.now() }, ...readHistory(id).filter((h) => h.sql !== sql)].slice(0, 200)
    localStorage.setItem(historyKey(id), JSON.stringify(list))
  } catch {
    /* depolama kapalı */
  }
}

export function QueryTab({ tab, active }: { tab: QueryTabT; active: boolean }) {
  const session = useStore((s) => s.session)!
  const updateTab = useStore((s) => s.updateTab)
  const refreshTables = useStore((s) => s.refreshTables)
  const confirm = useStore((s) => s.confirm)
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const [editorH, setEditorH] = useState(260)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<QueryResult[]>([])
  const [messages, setMessages] = useState<{ ok: boolean; text: string }[]>([])
  const [view, setView] = useState<number | 'msg'>('msg')
  const [menu, setMenu] = useState<MenuState | null>(null)

  const family = familyOf(session.conn.type)
  const schema = useMemo(() => Object.fromEntries(session.tables.map((t) => [t.name, [] as string[]])), [session.tables])

  const run = useCallback(
    async (mode: 'current' | 'all') => {
      const view = editorRef.current?.view
      const doc = view?.state.doc.toString() ?? tab.sql
      let text = doc
      if (view) {
        const sel = view.state.selection.main
        if (!sel.empty) text = doc.slice(sel.from, sel.to)
        else if (mode === 'current') {
          const stmts = splitStatements(doc, family)
          const pos = sel.head
          const cur = stmts.find((s) => pos >= s.from && pos <= s.to + 1) ?? [...stmts].reverse().find((s) => s.from <= pos) ?? stmts[0]
          text = cur?.text ?? ''
        }
      }
      if (!text.trim()) return
      if (session.conn.tag === 'production' && splitStatements(text, family).some((s) => !isReadStatement(family, s.text))) {
        const ok = await confirm({
          title: 'Production veritabanı',
          message: `Bu sorgu "${session.conn.name}" (PRODUCTION) üzerinde veri değiştirebilir. Çalıştırılsın mı?\n\n${text.slice(0, 400)}`,
          confirmLabel: 'Çalıştır',
          danger: true
        })
        if (!ok) return
      }
      setRunning(true)
      const started = Date.now()
      try {
        const res = await window.api.rawQuery(session.id, text)
        pushHistory(session.conn.id, text.trim())
        setResults(res.filter((r) => !r.isCommand))
        const msgs = res.map((r) =>
          r.isCommand
            ? { ok: true, text: `✓ Komut çalıştı · ${r.rowsAffected ?? 0} satır etkilendi` }
            : { ok: true, text: `✓ ${r.rows.length.toLocaleString('tr-TR')} satır döndü` }
        )
        msgs.push({ ok: true, text: `Toplam süre: ${Date.now() - started} ms` })
        setMessages(msgs)
        const firstSet = res.findIndex((r) => !r.isCommand)
        setView(firstSet >= 0 ? 0 : 'msg')
        if (changesSchema(family, text)) refreshTables()
      } catch (e) {
        setMessages([{ ok: false, text: (e as Error).message }])
        setResults([])
        setView('msg')
      } finally {
        setRunning(false)
      }
    },
    [session, tab.sql, confirm, refreshTables, family]
  )

  // Sekme öne gelince editöre odaklan; odak başka yerdeyken de Ctrl+Enter çalışsın
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      const v = editorRef.current?.view
      if (v && !document.activeElement?.closest('.modal, .filters')) {
        v.focus()
        if (!v.state.selection.main.head && v.state.doc.length) v.dispatch({ selection: { anchor: v.state.doc.length } })
      }
    }, 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.key !== 'Enter') return
      e.preventDefault()
      runRef.current(e.shiftKey ? 'all' : 'current')
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [active])

  const toast = useStore((s) => s.toast)
  const saveResult = async (format: 'csv' | 'json') => {
    if (typeof view !== 'number' || !results[view]) return
    try {
      const p = await window.api.saveResult(results[view], format, `${tab.title}-sonuc`.replace(/[\\/:*?"<>|]+/g, '_'))
      if (p) toast(`Kaydedildi: ${p.split(/[\\/]/).pop()}`, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const showHistory = (e: React.MouseEvent) => {
    const list = readHistory(session.conn.id)
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: list.length
        ? list.slice(0, 30).map((h) => ({
            label: h.sql.replace(/\s+/g, ' ').slice(0, 90),
            onClick: () => updateTab(tab.id, { sql: h.sql })
          }))
        : [{ label: 'Geçmiş boş', disabled: true }]
    })
  }

  const current = typeof view === 'number' ? results[view] : null

  return (
    <div className="query">
      <div className="toolbar">
        <button className="btn sm primary" onClick={() => run('current')} disabled={running} title="Seçimi veya imlecin olduğu ifadeyi çalıştır (Ctrl+Enter)">
          {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />} Çalıştır
        </button>
        <button className="btn sm" onClick={() => run('all')} disabled={running} title="Tümünü çalıştır (Ctrl+Shift+Enter)">
          <PlayCircle size={13} /> Tümünü çalıştır
        </button>
        <button className="btn sm ghost" onClick={showHistory}>
          <History size={13} /> Geçmiş
        </button>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 11.5 }}>
          <span className="kbd">Ctrl+Enter</span> çalıştır · <span className="kbd">Ctrl+Shift+Enter</span> tümü
        </span>
      </div>
      <div className="editor-wrap" style={{ height: editorH }}>
        <SqlEditor
          editorRef={editorRef}
          value={tab.sql}
          onChange={(v) => updateTab(tab.id, { sql: v })}
          dbType={session.conn.type}
          schema={schema}
          onRun={run}
          height="100%"
        />
      </div>
      <Resizer dir="y" onResize={(d) => setEditorH((h) => Math.max(80, Math.min(window.innerHeight - 200, h + d)))} />
      <div className="results">
        <div className="result-tabs">
          {results.map((r, i) => (
            <button key={i} className={view === i ? 'active' : ''} onClick={() => setView(i)}>
              Sonuç {results.length > 1 ? i + 1 : ''} · {r.rows.length}
            </button>
          ))}
          <button className={view === 'msg' ? 'active' : ''} onClick={() => setView('msg')}>
            Mesajlar
          </button>
          <div className="spacer" />
          {current && (
            <>
              <button className="btn sm ghost" title="Sonucu CSV olarak kaydet" onClick={() => saveResult('csv')}>
                <Download size={12} /> CSV
              </button>
              <button className="btn sm ghost" title="Sonucu JSON olarak kaydet" onClick={() => saveResult('json')}>
                <Download size={12} /> JSON
              </button>
            </>
          )}
          {current && (
            <span className="muted" style={{ fontSize: 11.5, paddingRight: 6 }}>
              {current.rows.length.toLocaleString('tr-TR')} satır · {current.durationMs} ms
            </span>
          )}
        </div>
        {current ? (
          <DataGrid
            key={view}
            columns={current.columns.map((c) => ({ name: c.name }))}
            rowCount={current.rows.length}
            getCell={(r, c) => current.rows[r][c]}
            onCopy={copyText}
            emptyText="Sonuç boş"
          />
        ) : (
          <div className="messages">
            {running && <div className="muted">Çalışıyor…</div>}
            {!running && !messages.length && <QueryHints family={family} />}
            {messages.map((m, i) => (
              <div key={i} className={m.ok ? 'ok' : 'err'}>
                {m.text}
              </div>
            ))}
          </div>
        )}
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  )
}

const HINTS: Record<string, { title: string; lines: string[] }> = {
  sql: { title: 'SQL yaz ve Ctrl+Enter ile çalıştır.', lines: [] },
  mongo: {
    title: 'mongosh sözdizimiyle yaz, Ctrl+Enter ile çalıştır. Örnekler:',
    lines: [
      'db.users.find({ age: { $gt: 18 } }).sort({ name: 1 }).limit(20)',
      'db.orders.aggregate([{ $group: { _id: "$status", adet: { $sum: 1 } } }])',
      'db.users.updateOne({ _id: ObjectId("…") }, { $set: { active: true } })',
      'db.getCollectionNames()'
    ]
  },
  redis: {
    title: 'Her satıra bir Redis komutu yaz, Ctrl+Enter ile çalıştır. Örnekler:',
    lines: ['GET kullanici:1', 'HGETALL oturum:abc', 'SET sayac 10 EX 60', 'SCAN 0 MATCH kullanici:* COUNT 100', 'INFO memory']
  }
}

function QueryHints({ family }: { family: string }) {
  const h = HINTS[family] ?? HINTS.sql
  return (
    <div className="muted">
      <div>{h.title}</div>
      {h.lines.map((l) => (
        <div key={l} style={{ color: 'var(--text-2)' }}>
          {l}
        </div>
      ))}
    </div>
  )
}
