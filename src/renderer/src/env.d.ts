import type { Api } from '@shared/api'
import type { TransferProgress, UpdateState } from '@shared/types'

declare global {
  interface Window {
    api: Api
    platform: string
    updateEvents: { onState(cb: (s: UpdateState) => void): () => void }
    transferEvents: { onProgress(cb: (p: TransferProgress) => void): () => void }
  }
}

export {}
