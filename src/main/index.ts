import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
import { chromeColors, closeAllSessions, registerIpc } from './ipc'
import { initUpdater } from './updater'

const isMac = process.platform === 'darwin'

/**
 * Uygulamanın eski adı "Tablo" idi. Ayarlar ve kayıtlı bağlantılar eski klasördeyse yeni klasöre
 * bir kez kopyalanır. "Local State" da kopyalanmalı: şifreleri çözen anahtar orada saklanır.
 * Eski klasör yedek olarak yerinde bırakılır.
 */
function migrateFromTablo(oldDir: string, newDir: string) {
  try {
    if (!fs.existsSync(path.join(oldDir, 'connections.json'))) return
    if (fs.existsSync(path.join(newDir, 'connections.json'))) return
    const skip = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUPersistentCache', 'GrShaderCache', 'ShaderCache', 'blob_storage', 'Crashpad', 'DevToolsActivePort'])
    fs.mkdirSync(newDir, { recursive: true })
    for (const entry of fs.readdirSync(oldDir)) if (!skip.has(entry)) fs.cpSync(path.join(oldDir, entry), path.join(newDir, entry), { recursive: true })
  } catch (e) {
    console.error('Eski ayarlar taşınamadı:', e)
  }
}

// Testlerde ayrı bir veri klasörü kullanabilmek için (ROWLY_APPDATA: geçişi test etmek için sahte AppData)
const testUserData = process.env['ROWLY_USER_DATA'] ?? process.env['TABLO_USER_DATA']
if (testUserData) app.setPath('userData', testUserData)
else {
  const appData = process.env['ROWLY_APPDATA'] ?? app.getPath('appData')
  if (process.env['ROWLY_APPDATA']) app.setPath('userData', path.join(appData, 'Rowly'))
  migrateFromTablo(path.join(appData, 'Tablo'), app.getPath('userData'))
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Rowly',
    backgroundColor: chromeColors(dark).color,
    // macOS: trafik ışıkları solda, başlık çubuğunun içinde; Windows/Linux: sağda kendi düğmeleri
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 12 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { ...chromeColors(dark), height: 38 } }),
    // Geliştirme modunda pencere ikonu (paketlenmiş uygulamada ikon kurulumdan gelir)
    icon: !app.isPackaged && !isMac ? path.join(__dirname, '../../build/icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  // Geliştirici araçları: Ctrl+Shift+I / F12
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools()
      e.preventDefault()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  // macOS'ta menü olmadan Cmd+C / Cmd+V / Cmd+Z çalışmaz: en küçük uygulama ve düzen menüsü
  Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null)
  registerIpc()
  createWindow()
  initUpdater()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', async () => {
  await closeAllSessions()
  if (process.platform !== 'darwin') app.quit()
})
