import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import type { Api } from '@shared/api'
import { dbTypeInfo, type ConnectionConfig, type DbType, type IpcResponse, type ServerInfo } from '@shared/types'
import { createDriver } from './drivers'
import type { Driver } from './drivers/base'
import { deleteConnection, listConnections, saveConnection } from './store'
import { openTunnel, type Tunnel } from './tunnel'
import { updates } from './updater'
import { cancelJob, exportData, importData, previewImport, writeResult } from './transfer'

/** Başlık çubuğu ve Windows pencere düğmelerinin rengi (styles.css'teki --chrome ile aynı) */
export const chromeColors = (dark: boolean) =>
  dark ? { color: '#2a2a2b', symbolColor: '#e4e4e6' } : { color: '#ececec', symbolColor: '#1d1d1f' }

const sessions = new Map<string, { driver: Driver; type: DbType; tunnel: Tunnel | null }>()
/** Çağrıyı yapan pencere (ilerleme olayları buraya gönderilir); işleyicinin ilk satırında okunmalı */
let currentSender: WebContents | null = null

const session = (sid: string) => {
  const d = sessions.get(sid)?.driver
  if (!d) throw new Error('Bağlantı kapalı. Lütfen yeniden bağlanın.')
  return d
}

const sessionType = (sid: string) => sessions.get(sid)!.type

/** Gerekirse SSH tüneli açıp sürücüyü bağlar. Hata olursa açılan her şeyi kapatır. */
async function connectDriver(c: ConnectionConfig): Promise<{ driver: Driver; tunnel: Tunnel | null; info: ServerInfo }> {
  let tunnel: Tunnel | null = null
  let cfg = c
  if (c.ssh?.enabled && !dbTypeInfo(c.type).fileBased) {
    if (c.uri?.trim()) throw new Error('SSH tüneli bağlantı URI\'si ile birlikte kullanılamaz; host ve port alanlarını kullanın.')
    tunnel = await openTunnel(c.ssh, c.host || '127.0.0.1', c.port || dbTypeInfo(c.type).defaultPort)
    cfg = { ...c, host: '127.0.0.1', port: tunnel.localPort }
  }
  const driver = createDriver(cfg)
  try {
    await driver.connect()
    const info = await driver.serverInfo()
    return { driver, tunnel, info: tunnel ? { ...info, sshFingerprint: tunnel.fingerprint } : info }
  } catch (e) {
    await driver.close().catch(() => {})
    await tunnel?.close().catch(() => {})
    throw e
  }
}

const handlers: Api = {
  listConnections: async () => listConnections(),
  saveConnection: async (c) => saveConnection(c),
  deleteConnection: async (id) => deleteConnection(id),
  testConnection: async (c) => {
    const { driver, tunnel, info } = await connectDriver(c)
    await driver.close().catch(() => {})
    await tunnel?.close().catch(() => {})
    return info
  },
  openSession: async (c) => {
    const { driver, tunnel, info } = await connectDriver(c)
    const sessionId = randomUUID()
    sessions.set(sessionId, { driver, type: c.type, tunnel })
    return { sessionId, info }
  },
  closeSession: async (sid) => {
    const s = sessions.get(sid)
    sessions.delete(sid)
    await s?.driver.close().catch(() => {})
    await s?.tunnel?.close().catch(() => {})
  },
  pickKeyFile: async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const r = await dialog.showOpenDialog(win, {
      title: 'SSH özel anahtarı seç',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  serverInfo: async (sid) => session(sid).serverInfo(),
  listDatabases: async (sid) => session(sid).listDatabases(),
  useDatabase: async (sid, name) => {
    const d = session(sid)
    await d.useDatabase(name)
    return d.serverInfo()
  },
  listTables: async (sid) => session(sid).listTables(),
  getColumns: async (sid, ref) => session(sid).getColumns(ref),
  getIndexes: async (sid, ref) => session(sid).getIndexes(ref),
  getDDL: async (sid, ref) => session(sid).getDDL(ref),
  getForeignKeys: async (sid, ref) => session(sid).getForeignKeys(ref),
  applyDDL: async (sid, statements) => {
    const d = session(sid)
    const type = sessionType(sid)
    const fail = (i: number, e: unknown) =>
      new Error(`${i + 1}. ifade başarısız: ${(e as Error).message}\n\n${statements[i]}${i > 0 && (type === 'mysql' || type === 'mariadb') ? `\n\nNot: MySQL yapı değişikliklerini geri alamaz; önceki ${i} ifade uygulandı.` : ''}`)
    if (type === 'mysql' || type === 'mariadb') {
      for (let i = 0; i < statements.length; i++) {
        try {
          await d.rawQuery(statements[i])
        } catch (e) {
          throw fail(i, e)
        }
      }
      return
    }
    let i = 0
    await d.transaction(async (exec) => {
      for (i = 0; i < statements.length; i++) {
        try {
          await exec(statements[i], [])
        } catch (e) {
          throw fail(i, e)
        }
      }
    })
  },
  fetchRows: async (sid, opts) => session(sid).fetchRows(opts),
  rawQuery: async (sid, sql) => session(sid).rawQuery(sql),
  applyChanges: async (sid, ref, changes) => session(sid).applyChanges(ref, changes),
  pickSqliteFile: async (mode) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const filters = [
      { name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] },
      { name: 'Tüm dosyalar', extensions: ['*'] }
    ]
    if (mode === 'save') {
      const r = await dialog.showSaveDialog(win, { title: 'Yeni SQLite veritabanı', filters, defaultPath: 'veritabani.sqlite' })
      return r.canceled ? null : (r.filePath ?? null)
    }
    const r = await dialog.showOpenDialog(win, { title: 'SQLite dosyası seç', filters, properties: ['openFile'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  exportData: async (sid, opts) => {
    const sender = currentSender
    return exportData(session(sid), sessionType(sid), opts, sender)
  },
  previewImport: async (file, delimiter) => previewImport(file, delimiter),
  importData: async (sid, opts) => {
    const sender = currentSender
    return importData(session(sid), sessionType(sid), opts, sender)
  },
  cancelJob: async (id) => cancelJob(id),
  pickSavePath: async (defaultName, extensions) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const r = await dialog.showSaveDialog(win, {
      title: 'Kaydet',
      defaultPath: defaultName,
      filters: [{ name: extensions.map((e) => e.toUpperCase()).join(', '), extensions }, { name: 'Tüm dosyalar', extensions: ['*'] }]
    })
    return r.canceled ? null : (r.filePath ?? null)
  },
  pickFolder: async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const r = await dialog.showOpenDialog(win, { title: 'Klasör seç', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  pickImportFile: async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const r = await dialog.showOpenDialog(win, {
      title: 'İçe aktarılacak dosya',
      properties: ['openFile'],
      filters: [
        { name: 'Desteklenen dosyalar', extensions: ['csv', 'tsv', 'txt', 'json', 'ndjson', 'jsonl', 'sql'] },
        { name: 'Tüm dosyalar', extensions: ['*'] }
      ]
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  saveResult: async (result, format, name) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const r = await dialog.showSaveDialog(win, { title: 'Sonucu kaydet', defaultPath: `${name}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] })
    if (r.canceled || !r.filePath) return null
    writeResult(r.filePath, result, format)
    return r.filePath
  },
  showInFolder: async (p) => shell.showItemInFolder(p),
  updateInfo: async () => updates.info(),
  updateCheck: async () => updates.check(),
  updateDownload: async () => updates.download(),
  openExternal: async (url) => {
    // Yalnızca GitHub sayfaları açılır
    if (!/^https:\/\/github\.com\//.test(url)) throw new Error('Geçersiz adres')
    await shell.openExternal(url)
  },
  setTitleBarTheme: async (dark) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.setTitleBarOverlay(chromeColors(dark))
      } catch {
        /* overlay desteklenmeyen platform */
      }
    }
  }
}

function clean(e: unknown): string {
  if (e instanceof AggregateError && e.errors?.length) return clean(e.errors[0])
  const msg = e instanceof Error ? e.message : String(e)
  const code = (e as { code?: string })?.code
  if (code === 'ECONNREFUSED')
    return `Sunucuya ulaşılamadı (${msg || code}). Sunucunun çalıştığından ve host/port bilgisinin doğru olduğundan emin olun.`
  if (!msg && code) return code
  return msg
}

export function registerIpc() {
  ipcMain.handle('api', async (_e, method: keyof Api, ...args: unknown[]): Promise<IpcResponse<unknown>> => {
    try {
      const fn = handlers[method] as (...a: unknown[]) => Promise<unknown>
      if (!fn) throw new Error(`Bilinmeyen komut: ${method}`)
      currentSender = _e.sender
      return { ok: true, data: await fn(...args) }
    } catch (e) {
      return { ok: false, error: clean(e) }
    }
  })
}

export async function closeAllSessions() {
  await Promise.all([...sessions.values()].map(async (s) => {
    await s.driver.close().catch(() => {})
    await s.tunnel?.close().catch(() => {})
  }))
  sessions.clear()
}
