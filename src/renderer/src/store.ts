import { create } from 'zustand'
import type { ConnectionConfig, FetchOptions, Filter, ServerInfo, TableInfo } from '@shared/types'

export type Theme = 'light' | 'dark' | 'system'

/** Görünüm tercihleri (yazı boyutu, ızgara yazı tipi, satır yoğunluğu) */
export interface Prefs {
  uiSize: number
  gridSize: number
  gridFont: 'system' | 'mono'
  density: 'compact' | 'normal' | 'comfortable'
}

export const DEFAULT_PREFS: Prefs = { uiSize: 13, gridSize: 12.5, gridFont: 'system', density: 'normal' }
export const DENSITY: Record<Prefs['density'], { row: number; head: number }> = {
  compact: { row: 21, head: 24 },
  normal: { row: 24, head: 26 },
  comfortable: { row: 28, head: 30 }
}

const readPrefs = (): Prefs => {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('prefs') ?? '{}') }
  } catch {
    return DEFAULT_PREFS
  }
}

export type Tab =
  | { id: string; kind: 'table'; table: TableInfo; title: string; view: 'data' | 'structure' }
  | { id: string; kind: 'query'; title: string; sql: string }
  | { id: string; kind: 'newtable'; title: string }

export type DialogState =
  | { kind: 'export'; tables: TableInfo[]; filters?: Filter[]; orderBy?: FetchOptions['orderBy'] }
  | { kind: 'import'; table?: TableInfo }
  | null

export interface Session {
  id: string
  conn: ConnectionConfig
  info: ServerInfo
  databases: string[]
  tables: TableInfo[]
  loadingTables: boolean
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
}

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

interface State {
  theme: Theme
  prefs: Prefs
  connections: ConnectionConfig[]
  session: Session | null
  connecting: string | null
  tabs: Tab[]
  activeTabId: string | null
  toasts: Toast[]
  confirmReq: ConfirmRequest | null
  /** Tablo sekmelerinde kaydedilmemiş değişiklik sayısı */
  dirty: Record<string, number>
  dialog: DialogState
  /** İçe aktarma sonrası ilgili tablo sekmesini yeniden yüklemek için sayaç */
  tableBump: Record<string, number>

  openDialog(d: DialogState): void
  bumpTable(key: string): void
  setTheme(t: Theme): void
  setPrefs(p: Partial<Prefs>): void
  loadConnections(): Promise<void>
  saveConnection(c: ConnectionConfig): Promise<void>
  deleteConnection(id: string): Promise<void>
  connect(c: ConnectionConfig): Promise<void>
  disconnect(): Promise<void>
  refreshTables(): Promise<void>
  switchDatabase(name: string): Promise<void>
  openTable(t: TableInfo, view?: 'data' | 'structure'): void
  openQuery(sql?: string, title?: string): void
  openNewTable(): void
  closeTab(id: string): Promise<void>
  setActiveTab(id: string): void
  updateTab(id: string, patch: Partial<Tab>): void
  setDirty(tabId: string, n: number): void
  toast(text: string, kind?: Toast['kind']): void
  confirm(req: Omit<ConfirmRequest, 'resolve'>): Promise<boolean>
}

let toastSeq = 0
let tabSeq = 0
const newId = () => `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`

const readTheme = (): Theme => {
  try {
    return (localStorage.getItem('theme') as Theme) || 'system'
  } catch {
    return 'system'
  }
}

export const isDark = (t: Theme) => t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)

export const tableKey = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`

export const useStore = create<State>((set, get) => ({
  theme: readTheme(),
  prefs: readPrefs(),
  connections: [],
  session: null,
  connecting: null,
  tabs: [],
  activeTabId: null,
  toasts: [],
  confirmReq: null,
  dirty: {},
  dialog: null,
  tableBump: {},

  openDialog(dialog) {
    set({ dialog })
  },

  bumpTable(key) {
    set({ tableBump: { ...get().tableBump, [key]: (get().tableBump[key] ?? 0) + 1 } })
  },

  setTheme(theme) {
    try {
      localStorage.setItem('theme', theme)
    } catch {
      /* depolama kapalı */
    }
    set({ theme })
  },

  setPrefs(patch) {
    const prefs = { ...get().prefs, ...patch }
    try {
      localStorage.setItem('prefs', JSON.stringify(prefs))
    } catch {
      /* depolama kapalı */
    }
    set({ prefs })
  },

  async loadConnections() {
    set({ connections: await window.api.listConnections() })
  },

  async saveConnection(c) {
    set({ connections: await window.api.saveConnection(c) })
  },

  async deleteConnection(id) {
    set({ connections: await window.api.deleteConnection(id) })
  },

  async connect(conn) {
    set({ connecting: conn.id })
    try {
      const { sessionId, info } = await window.api.openSession(conn)
      // SSH: ilk bağlantıda sunucu anahtarını kaydet; sonra değişirse bağlantı reddedilir
      if (conn.ssh?.enabled && !conn.ssh.hostKey && info.sshFingerprint) {
        conn = { ...conn, ssh: { ...conn.ssh, hostKey: info.sshFingerprint } }
        if (get().connections.some((c) => c.id === conn.id)) await get().saveConnection(conn)
        get().toast(`SSH sunucu anahtarı kaydedildi: ${info.sshFingerprint}`, 'info')
      }
      set({
        session: { id: sessionId, conn, info, databases: [], tables: [], loadingTables: true },
        tabs: [],
        activeTabId: null,
        dirty: {}
      })
      const [databases, tables] = await Promise.all([
        window.api.listDatabases(sessionId).catch(() => [] as string[]),
        window.api.listTables(sessionId).catch(() => [] as TableInfo[])
      ])
      const s = get().session
      if (s?.id === sessionId) set({ session: { ...s, databases, tables, loadingTables: false } })
    } catch (e) {
      get().toast((e as Error).message, 'error')
    } finally {
      set({ connecting: null })
    }
  },

  async disconnect() {
    const s = get().session
    const dirtyCount = Object.values(get().dirty).reduce((a, b) => a + b, 0)
    if (dirtyCount && !(await get().confirm({ title: 'Kaydedilmemiş değişiklikler', message: `${dirtyCount} kaydedilmemiş değişiklik kaybolacak. Bağlantı kapatılsın mı?`, confirmLabel: 'Kapat', danger: true })))
      return
    if (s) await window.api.closeSession(s.id).catch(() => {})
    set({ session: null, tabs: [], activeTabId: null, dirty: {} })
  },

  async refreshTables() {
    const s = get().session
    if (!s) return
    set({ session: { ...s, loadingTables: true } })
    try {
      const [tables, databases, info] = await Promise.all([
        window.api.listTables(s.id),
        window.api.listDatabases(s.id).catch(() => s.databases),
        window.api.serverInfo(s.id).catch(() => s.info)
      ])
      set({ session: { ...get().session!, tables, databases, info, loadingTables: false } })
    } catch (e) {
      set({ session: { ...get().session!, loadingTables: false } })
      get().toast((e as Error).message, 'error')
    }
  },

  async switchDatabase(name) {
    const s = get().session
    if (!s) return
    const dirtyCount = Object.values(get().dirty).reduce((a, b) => a + b, 0)
    if (dirtyCount && !(await get().confirm({ title: 'Kaydedilmemiş değişiklikler', message: `${dirtyCount} kaydedilmemiş değişiklik kaybolacak. Devam edilsin mi?`, confirmLabel: 'Devam', danger: true })))
      return
    set({ session: { ...s, loadingTables: true } })
    try {
      const info = await window.api.useDatabase(s.id, name)
      const tables = await window.api.listTables(s.id)
      // Tablo sekmeleri eski veritabanına ait; sorgu sekmeleri kalır.
      const tabs = get().tabs.filter((t) => t.kind === 'query')
      set({
        session: { ...get().session!, info, tables, loadingTables: false },
        tabs,
        activeTabId: tabs[0]?.id ?? null,
        dirty: {}
      })
    } catch (e) {
      set({ session: { ...get().session!, loadingTables: false } })
      get().toast((e as Error).message, 'error')
    }
  },

  openTable(table, view = 'data') {
    const existing = get().tabs.find((t) => t.kind === 'table' && tableKey(t.table) === tableKey(table))
    if (existing) {
      if (existing.kind === 'table' && existing.view !== view) get().updateTab(existing.id, { view })
      set({ activeTabId: existing.id })
      return
    }
    const tab: Tab = { id: newId(), kind: 'table', table, title: table.name, view }
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id })
  },

  openNewTable() {
    const tab: Tab = { id: newId(), kind: 'newtable', title: 'Yeni tablo' }
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id })
  },

  openQuery(sql = '', title) {
    const n = get().tabs.filter((t) => t.kind === 'query').length + 1
    const tab: Tab = { id: newId(), kind: 'query', title: title ?? `Sorgu ${n}`, sql }
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id })
  },

  async closeTab(id) {
    const d = get().dirty[id]
    if (d && !(await get().confirm({ title: 'Kaydedilmemiş değişiklikler', message: `Bu sekmede ${d} kaydedilmemiş değişiklik var. Yine de kapatılsın mı?`, confirmLabel: 'Kapat', danger: true })))
      return
    const tabs = get().tabs
    const i = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    const dirty = { ...get().dirty }
    delete dirty[id]
    let activeTabId = get().activeTabId
    if (activeTabId === id) activeTabId = next[Math.min(i, next.length - 1)]?.id ?? null
    set({ tabs: next, activeTabId, dirty })
  },

  setActiveTab(id) {
    set({ activeTabId: id })
  },

  updateTab(id, patch) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) })
  },

  setDirty(tabId, n) {
    if ((get().dirty[tabId] ?? 0) === n) return
    set({ dirty: { ...get().dirty, [tabId]: n } })
  },

  toast(text, kind = 'info') {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, kind, text }] })
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 3500)
  },

  confirm(req) {
    return new Promise<boolean>((resolve) => {
      set({
        confirmReq: {
          ...req,
          resolve: (ok) => {
            set({ confirmReq: null })
            resolve(ok)
          }
        }
      })
    })
  }
}))
