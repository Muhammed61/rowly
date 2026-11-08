import { useMemo, useState } from 'react'
import { Copy, Database, FolderOpen, Loader2, Moon, Pencil, Plus, Search, Sun, Trash2 } from 'lucide-react'
import { dbTypeInfo, ENV_TAGS, type ConnectionConfig } from '@shared/types'
import { connectionLocation } from '@shared/dialects'
import { isDark, useStore } from '../store'
import { PrefsButton } from './PrefsPanel'
import { UpdateBanner } from './UpdateBanner'
import { useUpdates } from '../updates'
import { ConnectionForm, emptyConnection } from './ConnectionForm'
import { ContextMenu, DbBadge, TagChip, type MenuState } from './ui'

const subtitle = connectionLocation

export function Welcome() {
  const connections = useStore((s) => s.connections)
  const connecting = useStore((s) => s.connecting)
  const connect = useStore((s) => s.connect)
  const deleteConnection = useStore((s) => s.deleteConnection)
  const saveConnection = useStore((s) => s.saveConnection)
  const confirm = useStore((s) => s.confirm)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const [editing, setEditing] = useState<ConnectionConfig | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const appVersion = useUpdates((u) => u.version)

  const groups = useMemo(() => {
    const q = query.toLowerCase()
    const list = connections.filter(
      (c) => !q || c.name.toLowerCase().includes(q) || subtitle(c).toLowerCase().includes(q) || dbTypeInfo(c.type).label.toLowerCase().includes(q)
    )
    return ENV_TAGS.map((t) => ({ ...t, items: list.filter((c) => c.tag === t.tag).sort((a, b) => a.name.localeCompare(b.name)) })).filter(
      (g) => g.items.length
    )
  }, [connections, query])

  const remove = async (c: ConnectionConfig) => {
    if (await confirm({ title: 'Bağlantıyı sil', message: `"${c.name}" bağlantısı silinsin mi?`, confirmLabel: 'Sil', danger: true }))
      await deleteConnection(c.id)
  }
  const duplicate = (c: ConnectionConfig) => saveConnection({ ...c, id: crypto.randomUUID(), name: c.name + ' (kopya)' })

  const openSqlite = async () => {
    const file = await window.api.pickSqliteFile('open')
    if (!file) return
    const existing = connections.find((c) => c.type === 'sqlite' && c.file === file)
    const c = existing ?? { ...emptyConnection('sqlite'), file, name: file.split(/[\\/]/).pop() || 'SQLite' }
    if (!existing) await saveConnection(c)
    await connect(c)
  }

  const dark = isDark(theme)

  return (
    <>
      <div className="titlebar">
        <div className="brand">
          <div className="logo">
            <Database size={13} />
          </div>
          Rowly
        </div>
        <div className="spacer" />
        <button className="icon-btn" title="Tema" onClick={() => setTheme(dark ? 'light' : 'dark')}>
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <PrefsButton />
      </div>
      <UpdateBanner />
      <div className="welcome">
        <div className="welcome-side">
          <div className="big-logo">
            <Database size={30} />
          </div>
          <h1>Rowly</h1>
          <p>Tüm veritabanların için modern, hızlı ve ücretsiz bir istemci.</p>
          <button className="btn primary" onClick={() => setEditing(emptyConnection())}>
            <Plus size={15} /> Yeni bağlantı
          </button>
          <button className="btn" onClick={openSqlite}>
            <FolderOpen size={15} /> SQLite dosyası aç
          </button>
          <div className="spacer" />
          <div className="muted" style={{ fontSize: 11.5 }}>
            MySQL · MariaDB · PostgreSQL · SQL Server · SQLite · CockroachDB · Redshift · MongoDB · Redis
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {appVersion ? `v${appVersion}` : ''}
          </div>
        </div>

        <div className="welcome-main">
          <div className="head">
            <div className="search" style={{ flex: 1 }}>
              <Search size={14} />
              <input className="input" placeholder="Bağlantılarda ara…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>

          {connections.length === 0 ? (
            <div className="empty">
              <div>
                <Database size={40} strokeWidth={1.4} />
                <h3>Henüz bağlantı yok</h3>
                <div>İlk veritabanı bağlantını oluşturarak başla.</div>
                <button className="btn primary" style={{ marginTop: 16 }} onClick={() => setEditing(emptyConnection())}>
                  <Plus size={15} /> Yeni bağlantı
                </button>
              </div>
            </div>
          ) : (
            <div className="conn-list">
              {groups.map((g) => (
                <div key={g.tag}>
                  <div className="conn-group-title" lang="en">{g.label}</div>
                  {g.items.map((c) => (
                    <div
                      key={c.id}
                      className={`conn-item${selected === c.id ? ' selected' : ''}`}
                      onClick={() => setSelected(c.id)}
                      onDoubleClick={() => connect(c)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setSelected(c.id)
                        setMenu({
                          x: e.clientX,
                          y: e.clientY,
                          items: [
                            { label: 'Bağlan', onClick: () => connect(c) },
                            { separator: true },
                            { label: 'Düzenle', icon: <Pencil size={13} />, onClick: () => setEditing(c) },
                            { label: 'Çoğalt', icon: <Copy size={13} />, onClick: () => duplicate(c) },
                            { separator: true },
                            { label: 'Sil', icon: <Trash2 size={13} />, danger: true, onClick: () => remove(c) }
                          ]
                        })
                      }}
                    >
                      <DbBadge type={c.type} size={34} />
                      <div className="meta">
                        <div className="name">
                          {c.name}
                          <TagChip tag={c.tag} />
                        </div>
                        <div className="sub">{subtitle(c)}</div>
                      </div>
                      {connecting === c.id ? (
                        <Loader2 size={16} className="spin" />
                      ) : (
                        <div className="actions">
                          <button className="icon-btn" title="Düzenle" onClick={() => setEditing(c)}>
                            <Pencil size={14} />
                          </button>
                          <button className="icon-btn" title="Sil" onClick={() => remove(c)}>
                            <Trash2 size={14} />
                          </button>
                          <button className="btn sm primary" onClick={() => connect(c)}>
                            Bağlan
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {editing && <ConnectionForm initial={editing} onClose={() => setEditing(null)} />}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </>
  )
}
