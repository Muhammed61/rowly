import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, type Api } from '@shared/api'
import type { IpcResponse, TransferProgress, UpdateState } from '@shared/types'

const api = {} as Record<string, (...args: unknown[]) => Promise<unknown>>
for (const m of API_METHODS) {
  api[m] = async (...args: unknown[]) => {
    const r = (await ipcRenderer.invoke('api', m, ...args)) as IpcResponse<unknown>
    if (!r.ok) throw new Error(r.error)
    return r.data
  }
}

contextBridge.exposeInMainWorld('api', api as unknown as Api)

// Uzun süren aktarma işlerinin ilerleme bildirimleri
// Güncelleme durumu değişiklikleri
contextBridge.exposeInMainWorld('updateEvents', {
  onState(cb: (s: UpdateState) => void) {
    const h = (_e: unknown, s: UpdateState) => cb(s)
    ipcRenderer.on('update-state', h)
    return () => ipcRenderer.removeListener('update-state', h)
  }
})

contextBridge.exposeInMainWorld('transferEvents', {
  onProgress(cb: (p: TransferProgress) => void) {
    const h = (_e: unknown, p: TransferProgress) => cb(p)
    ipcRenderer.on('transfer:progress', h)
    return () => ipcRenderer.removeListener('transfer:progress', h)
  }
})
contextBridge.exposeInMainWorld('platform', process.platform)
