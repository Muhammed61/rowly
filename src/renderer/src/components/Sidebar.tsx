import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Code2, Copy, Eye, Loader2, RefreshCw, Search, Sheet, Table2, Trash2, Eraser, Wrench, KeyRound, Boxes, Download, Upload, Plus } from 'lucide-react'
import { dbTypeInfo, type TableInfo } from '@shared/types'
import { FAMILY_LABELS, familyOf, tableLabel, templates } from '@shared/dialects'
import { tableKey, useStore } from '../store'
import { ContextMenu, copyText, type MenuItem, type MenuState } from './ui'

export function Sidebar({ width }: { width: number }) {
  const session = useStore((s) => s.session)!
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const openTable = useStore((s) => s.openTable)
  const openQuery = useStore((s) => s.openQuery)
  const openNewTable = useStore((s) => s.openNewTable)
  const refreshTables = useStore((s) => s.refreshTables)
  const switchDatabase = useStore((s) => s.switchDatabase)
  const confirm = useStore((s) => s.confirm)
  const toast = useStore((s) => s.toast)
  const openDialog = useStore((s) => s.openDialog)
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)

  const type = session.conn.type
  const info = dbTypeInfo(type)
  const family = familyOf(type)
  const labels = FAMILY_LABELS[family]
  const tpl = templates(type)
  const active = tabs.find((t) => t.id === activeTabId)
  const activeKey = active?.kind === 'table' ? tableKey(active.table) : null

  const groups = useMemo(() => {
    const ql = q.toLowerCase()
    const filtered = session.tables.filter((t) => !ql || tableLabel(type, t).toLowerCase().includes(ql) || t.name.toLowerCase().includes(ql))
    const multiSchema = info.hasSchemas && new Set(session.tables.map((t) => t.schema)).size > 1
    if (multiSchema) {
      const schemas = [...new Set(filtered.map((t) => t.schema))]
      return schemas.map((s) => ({ key: s, label: s, items: filtered.filter((t) => t.schema === s) }))
    }
    if (family === 'redis') return [{ key: '__tables', label: labels.tables, items: filtered }]
    return [
      { key: '__tables', label: labels.tables, items: filtered.filter((t) => t.kind === 'table') },
      { key: '__views', label: labels.views, items: filtered.filter((t) => t.kind === 'view') }
    ].filter((g) => g.items.length || g.key === '__tables')
  }, [session.tables, q, info.hasSchemas, family, labels, type])

  const runDanger = async (t: TableInfo, kind: 'truncate' | 'drop') => {
    const sql = kind === 'drop' ? tpl.drop?.(t) : tpl.truncate?.(t)
    if (!sql) return
    const ok = await confirm({
      title: kind === 'drop' ? `${t.kind === 'view' ? 'Görünümü' : family === 'mongo' ? 'Koleksiyonu' : 'Tabloyu'} sil` : 'İçeriği boşalt',
      message: `${sql}\n\nBu işlem geri alınamaz.${session.conn.tag === 'production' ? '\n\n⚠ Bu bir PRODUCTION bağlantısı!' : ''}`,
      confirmLabel: kind === 'drop' ? 'Sil' : 'Boşalt',
      danger: true
    })
    if (!ok) return
    try {
      await window.api.rawQuery(session.id, sql)
      toast(kind === 'drop' ? `${t.name} silindi` : `${t.name} boşaltıldı`, 'success')
      if (kind === 'drop') {
        const tab = useStore.getState().tabs.find((x) => x.kind === 'table' && tableKey(x.table) === tableKey(t))
        if (tab) {
          useStore.getState().setDirty(tab.id, 0)
          await useStore.getState().closeTab(tab.id)
        }
      }
      await refreshTables()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const tableMenu = (e: React.MouseEvent, t: TableInfo) => {
    e.preventDefault()
    const items: MenuItem[] = [
      { label: family === 'redis' ? 'Anahtarları aç' : 'Veriyi aç', icon: <Sheet size={13} />, onClick: () => openTable(t, 'data') },
      { label: 'Yapıyı göster', icon: <Wrench size={13} />, onClick: () => openTable(t, 'structure') },
      {
        label: family === 'sql' ? 'SELECT sorgusu oluştur' : 'Sorgu oluştur',
        icon: <Code2 size={13} />,
        onClick: () => openQuery(tpl.select(t), tableLabel(type, t))
      },
      { label: family === 'redis' ? 'Deseni kopyala' : 'Adı kopyala', icon: <Copy size={13} />, onClick: () => copyText(t.name) },
      { separator: true },
      { label: 'Dışa aktar…', icon: <Download size={13} />, onClick: () => openDialog({ kind: 'export', tables: [t] }) },
      ...(t.kind === 'table' ? [{ label: 'İçe aktar…', icon: <Upload size={13} />, onClick: () => openDialog({ kind: 'import', table: t }) }] : [])
    ]
    const danger: MenuItem[] = []
    if (tpl.truncate && t.kind === 'table') danger.push({ label: 'Boşalt…', icon: <Eraser size={13} />, danger: true, onClick: () => runDanger(t, 'truncate') })
    if (tpl.drop)
      danger.push({
        label: t.kind === 'view' ? 'Görünümü sil…' : family === 'mongo' ? 'Koleksiyonu sil…' : 'Tabloyu sil…',
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => runDanger(t, 'drop')
      })
    setMenu({ x: e.clientX, y: e.clientY, items: danger.length ? [...items, { separator: true }, ...danger] : items })
  }

  const icon = (t: TableInfo) =>
    family === 'redis' ? (t.name === '*' ? <Boxes size={14} /> : <KeyRound size={14} />) : t.kind === 'view' ? <Eye size={14} /> : <Table2 size={14} />

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-top">
        {!info.fileBased && session.databases.length > 0 && (
          <select className="select" value={session.info.currentDatabase} onChange={(e) => switchDatabase(e.target.value)} title="Veritabanı">
            {!session.info.currentDatabase && <option value="">Veritabanı seç…</option>}
            {session.databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          <div className="search" style={{ flex: 1 }}>
            <Search size={13} />
            <input className="input" placeholder={family === 'redis' ? 'Grup ara…' : family === 'mongo' ? 'Koleksiyon ara…' : 'Tablo ara…'} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {family === 'sql' && (
            <button className="icon-btn" title="Yeni tablo" onClick={openNewTable}>
              <Plus size={14} />
            </button>
          )}
          <button className="icon-btn" title="Yenile" onClick={refreshTables}>
            {session.loadingTables ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>
      <div className="sidebar-list">
        {!session.info.currentDatabase && !info.fileBased ? (
          <div className="muted" style={{ padding: 12, lineHeight: 1.5 }}>
            İçeriği görmek için yukarıdan bir veritabanı seç.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.key}>
              <div className="side-section" onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}>
                {collapsed[g.key] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                {g.label}
                <span className="count">{family === 'redis' ? Math.max(0, g.items.length - 1) : g.items.length}</span>
              </div>
              {!collapsed[g.key] &&
                g.items.map((t) => (
                  <div
                    key={tableKey(t)}
                    className={`side-item${activeKey === tableKey(t) ? ' active' : ''}`}
                    onClick={() => openTable(t)}
                    onContextMenu={(e) => tableMenu(e, t)}
                    title={info.hasSchemas ? `${t.schema}.${t.name}` : t.name}
                  >
                    {icon(t)}
                    <span>{tableLabel(type, t)}</span>
                    {t.count !== undefined && (
                      <span className="muted" style={{ marginLeft: 'auto', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                        {t.count.toLocaleString('tr-TR')}
                      </span>
                    )}
                  </div>
                ))}
              {!collapsed[g.key] && g.items.length === 0 && !session.loadingTables && (
                <div className="muted" style={{ padding: '4px 10px', fontSize: 12 }}>
                  {q ? 'Eşleşme yok' : family === 'mongo' ? 'Koleksiyon yok' : 'Tablo yok'}
                </div>
              )}
            </div>
          ))
        )}
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
