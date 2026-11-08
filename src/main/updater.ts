// Otomatik güncelleme: public Muhammed61/rowly-releases deposundaki sürümleri denetler.
// Yeni sürüm varsa arayüzde şerit gösterilir; kullanıcı onaylayınca indirilir, kurulur
// ve uygulama yeniden açılır.
// macOS'ta uygulama Apple sertifikasıyla imzalı olmadığı için kendini değiştiremez; orada
// yeni sürüm yine bildirilir ama "İndir" tarayıcıda .dmg dosyasını açar.
import { app, BrowserWindow, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo, UpdateState } from '@shared/types'

const RELEASES = 'https://github.com/Muhammed61/rowly-releases/releases'
const manual = process.platform === 'darwin'
let state: UpdateState = { status: app.isPackaged || process.env['ROWLY_UPDATE_TEST'] ? 'idle' : 'dev' }
let available = ''
let lastCheck = 0
let checking = false
const enabled = () => app.isPackaged || !!process.env['ROWLY_UPDATE_TEST']
const busy = () => checking || state.status === 'downloading' || state.status === 'installing'

/** electron-updater'ın uzun İngilizce hata metnini kısa bir Türkçe açıklamaya çevirir */
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '')
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|net::ERR_/i.test(msg)) return 'İnternet bağlantısı yok; güncellemeler denetlenemedi.'
  if (/latest.*\.yml|404/i.test(msg)) return 'Sunucuda güncelleme bilgisi bulunamadı. Yeni sürüm yayınlandığında tekrar deneyin.'
  if (/sha512|checksum/i.test(msg)) return 'İndirilen dosya doğrulanamadı. Lütfen tekrar deneyin.'
  if (/pkexec|sudo|dpkg|apt|exit code|status 12[67]/i.test(msg))
    return 'Güncelleme kurulamadı (yönetici izni verilmedi). Tekrar deneyin ya da yeni .deb dosyasını indirme sayfasından kurun.'
  return `Güncelleme sırasında bir sorun oluştu: ${msg.split('\n')[0].slice(0, 140)}`
}

function set(next: UpdateState) {
  state = next
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update-state', state)
}

function check() {
  if (!enabled() || busy()) return
  checking = true
  lastCheck = Date.now()
  autoUpdater
    .checkForUpdates()
    .catch(() => undefined)
    .finally(() => (checking = false))
}

export function initUpdater() {
  if (!enabled()) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // Testte yerel bir güncelleme sunucusu kullanılabilir (dev-app-update.yml)
  if (process.env['ROWLY_UPDATE_TEST']) autoUpdater.forceDevUpdateConfig = true
  autoUpdater.on('checking-for-update', () => {
    if (!['available', 'downloading', 'installing'].includes(state.status)) set({ status: 'checking' })
  })
  autoUpdater.on('update-not-available', () => set({ status: 'none' }))
  autoUpdater.on('update-available', (info) => {
    available = info.version
    if (state.status === 'downloading' || state.status === 'installing') return
    set({ status: 'available', version: info.version })
  })
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', version: available, percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'installing', version: info.version })
    // Sessiz kurulum, ardından uygulama yeniden açılır
    if (!process.env['ROWLY_UPDATE_NO_INSTALL']) setTimeout(() => autoUpdater.quitAndInstall(true, true), 1500)
  })
  autoUpdater.on('error', (e) => {
    // İndirme sırasında hata olursa tekrar denenebilsin
    if (available && state.status === 'downloading') set({ status: 'available', version: available })
    else set({ status: 'error', message: friendlyError(e) })
  })

  setTimeout(check, 5000)
  setInterval(check, 30 * 60 * 1000)
  // Pencereye dönüldüğünde (en fazla 5 dakikada bir) tekrar bakılır
  app.on('browser-window-focus', () => Date.now() - lastCheck > 5 * 60 * 1000 && check())
}

export const updates = {
  info(): UpdateInfo {
    return { version: app.getVersion(), state, manual }
  },

  async check(): Promise<{ message: string }> {
    if (!enabled()) return { message: 'Geliştirme modunda güncelleme denetlenmez.' }
    if (busy()) return { message: '' }
    try {
      checking = true
      lastCheck = Date.now()
      const r = await autoUpdater.checkForUpdates().finally(() => (checking = false))
      return { message: r && r.isUpdateAvailable ? '' : `Rowly güncel (sürüm ${app.getVersion()}).` }
    } catch (e) {
      throw new Error(friendlyError(e))
    }
  },

  /** Kullanıcının onayıyla indirir; inince kurup uygulamayı yeniden başlatır */
  download(): boolean {
    if (state.status !== 'available') return false
    if (manual) {
      const dmg = `Rowly-${available}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
      shell.openExternal(`${RELEASES}/download/v${available}/${dmg}`)
      return true
    }
    set({ status: 'downloading', version: available, percent: 0 })
    autoUpdater.downloadUpdate().catch(() => undefined)
    return true
  }
}
