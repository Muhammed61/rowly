// Güncelleme şeridi ve Ayarlar'daki güncelleme bölümü için durum
import { create } from 'zustand'
import type { UpdateState } from '@shared/types'
import { useStore } from './store'

interface UpdateStore {
  version: string
  manual: boolean
  state: UpdateState
  /** "Sonra" denilen sürüm: aynı sürüm için şerit tekrar gösterilmez */
  dismissed: string | null
  dismiss(v: string): void
}

export const useUpdates = create<UpdateStore>((set) => ({
  version: '',
  manual: false,
  state: { status: 'idle' },
  dismissed: null,
  dismiss: (v) => set({ dismissed: v })
}))

window.api
  .updateInfo()
  .then((i) => useUpdates.setState({ version: i.version, manual: i.manual, state: i.state }))
  .catch(() => {})
window.updateEvents.onState((state) => useUpdates.setState({ state }))

export async function startUpdate() {
  const { manual } = useUpdates.getState()
  const app = useStore.getState()
  if (manual) {
    await window.api.updateDownload()
    app.toast("Kurulum dosyası tarayıcıda indiriliyor. Açıp Rowly'yi Uygulamalar klasörüne sürükleyin; ayarlarınız korunur.", 'success')
    return
  }
  const unsaved = Object.values(app.dirty).reduce((a, b) => a + b, 0)
  if (app.session || unsaved) {
    const parts = [app.session ? `"${app.session.conn.name}" bağlantısı kapanacak` : '', unsaved ? `${unsaved} kaydedilmemiş değişiklik kaybolacak` : ''].filter(Boolean)
    const ok = await app.confirm({
      title: 'Güncelleme kurulsun mu?',
      message: `Rowly kapanıp yeniden açılacak: ${parts.join(', ')}.`,
      confirmLabel: 'Güncelle',
      danger: unsaved > 0
    })
    if (!ok) return
  }
  await window.api.updateDownload()
}

export async function checkNow() {
  try {
    const r = await window.api.updateCheck()
    if (r.message) useStore.getState().toast(r.message, 'success')
  } catch (e) {
    useStore.getState().toast((e as Error).message, 'error')
  }
}

export function statusText(s: UpdateState): string {
  switch (s.status) {
    case 'dev':
      return 'Geliştirme modunda çalışıyor; güncelleme yalnızca kurulu uygulamada denetlenir.'
    case 'idle':
      return 'Güncellemeler otomatik olarak denetlenir.'
    case 'checking':
      return 'Denetleniyor…'
    case 'none':
      return 'Rowly güncel.'
    case 'available':
      return `Yeni sürüm ${s.version} hazır.`
    case 'downloading':
      return `Sürüm ${s.version} indiriliyor… %${s.percent}`
    case 'installing':
      return `Sürüm ${s.version} kuruluyor…`
    case 'error':
      return s.message
  }
}
