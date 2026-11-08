import { useEffect, useState } from 'react'
import { Code2, Database, Download, Eye, KeyRound, LogOut, Moon, Plus, Sun, Table2, Upload, X } from 'lucide-react'
import { ENV_TAGS, dbTypeInfo } from '@shared/types'
import { connectionLocation, tableLabel } from '@shared/dialects'
import { isDark, useStore } from '../store'
import { PrefsButton } from './PrefsPanel'
import { UpdateBanner } from './UpdateBanner'
import { Sidebar } from './Sidebar'
import { TableTab } from './TableTab'
import { QueryTab } from './QueryTab'
import { StructureEditor } from './StructureEditor'
import { DbBadge, Resizer } from './ui'
import { ExportDialog } from './ExportDialog'
import { ImportDialog } from './ImportDialog'

export function Workspace() {
  const session = useStore((s) => s.session)!
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const dirty = useStore((s) => s.dirty)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const openQuery = useStore((s) => s.openQuery)
  const openTable = useStore((s) => s.openTable)
  const refreshTables = useStore((s) => s.refreshTables)
  const disconnect = useStore((s) => s.disconnect)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const dialog = useStore((s) => s.dialog)
  const openDialog = useStore((s) => s.openDialog)
  const [sideW, setSideW] = useState(260)

  const conn = session.conn
  const env = ENV_TAGS.find((t) => t.tag === conn.tag) ?? ENV_TAGS[0]
  const info = dbTypeInfo(conn.type)
  const dark = isDark(theme)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      const k = e.key.toLowerCase()
      if (k === 't') {
        e.preventDefault()
        openQuery()
      } else if (k === 'w') {
        e.preventDefault()
        const id = useStore.getState().activeTabId
        if (id) closeTab(id)
      } else if (k === 'tab') {
        e.preventDefault()
        const { tabs, activeTabId } = useStore.getState()
        if (!tabs.length) return
        const i = tabs.findIndex((t) => t.id === activeTabId)
        const n = (i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length
        setActiveTab(tabs[n].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openQuery, closeTab, setActiveTab])

  const location = info.fileBased ? conn.file.split(/[\\/]/).pop() : connectionLocation({ ...conn, database: '', ssh: undefined })

  return (
    <>
      <div className="env-bar" style={{ background: env.color }} />
      <div className="titlebar">
        <div className="brand">
          <div className="logo">
            <Database size={13} />
          </div>
        </div>
        <div className="conn-pill no-drag" title={`${session.info.version}\n${location}`}>
          <DbBadge type={conn.type} size={20} />
          <span className="tag-chip" lang="en" style={{ background: env.color, color: '#fff' }}>
            {env.label}
          </span>
          {conn.ssh?.enabled && (
            <span className="ssh-chip" title={`SSH tüneli: ${conn.ssh.user}@${conn.ssh.host}:${conn.ssh.port || 22}`}>
              <KeyRound size={10} /> SSH
            </span>
          )}
          <div className="info">
            <b>{conn.name}</b>
            <span className="sep">|</span>
            {session.info.version}
            <span className="sep">:</span>
            {location}
            {session.info.currentDatabase && !info.fileBased && (
              <>
                <span className="sep">:</span>
                <b>{session.info.currentDatabase}</b>
              </>
            )}
          </div>
        </div>
        <div className="spacer" />
        <button className="btn ghost sm" title="Yeni sorgu (Ctrl+T)" onClick={() => openQuery()}>
          <Code2 size={14} /> {info.family === 'sql' ? 'SQL' : 'Sorgu'}
        </button>
        <button
          className="icon-btn"
          title="Dışa aktar (CSV, JSON, SQL)"
          onClick={() => openDialog({ kind: 'export', tables: info.family === 'redis' ? session.tables.filter((t) => t.name === '*') : session.tables })}
        >
          <Download size={15} />
        </button>
        <button className="icon-btn" title="İçe aktar (CSV, JSON, SQL)" onClick={() => openDialog({ kind: 'import' })}>
          <Upload size={15} />
        </button>
        <button className="icon-btn" title="Tema" onClick={() => setTheme(dark ? 'light' : 'dark')}>
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <PrefsButton />
        <button className="icon-btn" title="Bağlantıyı kapat" onClick={disconnect}>
          <LogOut size={15} />
        </button>
      </div>
      <UpdateBanner />
      <div className="workspace">
        <Sidebar width={sideW} />
        <Resizer dir="x" onResize={(d) => setSideW((w) => Math.max(180, Math.min(520, w + d)))} />
        <div className="main">
          <div className="tabbar">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`tab${t.id === activeTabId ? ' active' : ''}`}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    closeTab(t.id)
                  } else setActiveTab(t.id)
                }}
                title={t.kind === 'table' ? `${t.table.schema}.${t.table.name}` : t.title}
              >
                {t.kind === 'query' ? (
                  <Code2 size={13} color="var(--accent)" />
                ) : t.kind === 'newtable' ? (
                  <Plus size={13} color="var(--success)" />
                ) : t.table.kind === 'view' ? (
                  <Eye size={13} />
                ) : (
                  <Table2 size={13} />
                )}
                <span className="title">{t.kind === 'table' ? tableLabel(conn.type, t.table) : t.title}</span>
                <button
                  className={`close${dirty[t.id] ? ' dirty' : ''}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => closeTab(t.id)}
                  title="Kapat (Ctrl+W)"
                >
                  {dirty[t.id] ? <span className="dirty-dot" /> : <X size={12} />}
                </button>
              </div>
            ))}
            <button className="tab-new" title="Yeni sorgu (Ctrl+T)" onClick={() => openQuery()}>
              <Plus size={15} />
            </button>
          </div>
          {tabs.length === 0 && (
            <div className="home-empty">
              <div>
                <Database size={38} strokeWidth={1.3} />
                <div style={{ marginTop: 10, fontSize: 14, color: 'var(--text-2)' }}>Soldan bir tablo seç ya da yeni bir sorgu başlat</div>
                <div className="shortcuts">
                  <span className="kbd">Ctrl+T</span> <span>Yeni SQL sorgusu</span>
                  <span className="kbd">Ctrl+Enter</span> <span>Sorguyu çalıştır</span>
                  <span className="kbd">Ctrl+S</span> <span>Değişiklikleri kaydet</span>
                  <span className="kbd">Ctrl+R</span> <span>Veriyi yenile</span>
                  <span className="kbd">Ctrl+F</span> <span>Filtre</span>
                  <span className="kbd">Ctrl+W</span> <span>Sekmeyi kapat</span>
                </div>
              </div>
            </div>
          )}
          {tabs.map((t) => (
            <div key={t.id} className={`tab-pane${t.id === activeTabId ? '' : ' hidden'}`}>
              {t.kind === 'table' ? (
                <TableTab tab={t} active={t.id === activeTabId} />
              ) : t.kind === 'newtable' ? (
                <StructureEditor
                  table={null}
                  active={t.id === activeTabId}
                  onSaved={async (created) => {
                    await closeTab(t.id)
                    await refreshTables()
                    openTable(created, 'structure')
                  }}
                />
              ) : (
                <QueryTab tab={t} active={t.id === activeTabId} />
              )}
            </div>
          ))}
        </div>
      </div>
      {dialog?.kind === 'export' && <ExportDialog initial={dialog.tables} filters={dialog.filters} orderBy={dialog.orderBy} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'import' && <ImportDialog initial={dialog.table} onClose={() => openDialog(null)} />}
    </>
  )
}
