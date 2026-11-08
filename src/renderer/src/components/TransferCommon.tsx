import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, FolderOpen } from 'lucide-react'
import type { TransferProgress, TransferSummary } from '@shared/types'

export const newJobId = () => `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export function useProgress(jobId: string | null) {
  const [p, setP] = useState<TransferProgress | null>(null)
  useEffect(() => {
    if (!jobId) return
    setP(null)
    return window.transferEvents.onProgress((x) => x.jobId === jobId && setP(x))
  }, [jobId])
  return p
}

export function ProgressView({ progress, label }: { progress: TransferProgress | null; label: string }) {
  const pct = progress?.total ? Math.min(100, (progress.done / progress.total) * 100) : null
  return (
    <div className="transfer" style={{ padding: '18px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <b>{label}</b>
        <span className="muted">{progress?.message ?? 'Başlatılıyor…'}</span>
        <span className="spacer" />
        {pct !== null && <span className="mono">{pct.toFixed(0)}%</span>}
      </div>
      <div className={`progress${pct === null ? ' indeterminate' : ''}`}>
        <div style={{ width: `${pct ?? 30}%` }} />
      </div>
    </div>
  )
}

export function SummaryView({ summary, verb }: { summary: TransferSummary; verb: string }) {
  const failed = summary.errors.length > 0 && summary.rows === 0
  return (
    <div className="transfer">
      <div className={`result-box${failed ? ' err' : ''}`}>
        {failed ? <AlertCircle size={22} color="var(--danger)" /> : <CheckCircle2 size={22} color="var(--success)" />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <b>
            {summary.cancelled
              ? 'İptal edildi'
              : failed
                ? 'İşlem başarısız'
                : `${summary.rows.toLocaleString('tr-TR')} kayıt ${verb}`}
          </b>
          <span className="muted">
            {(summary.ms / 1000).toFixed(1)} sn
            {summary.errors.length > 0 && !failed ? ` · ${summary.errors.length} hata` : ''}
          </span>
          {summary.files.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                {summary.files.length === 1 ? summary.files[0] : `${summary.files.length} dosya · ${summary.files[0].replace(/[\\/][^\\/]+$/, '')}`}
              </span>
              <button className="btn sm" onClick={() => window.api.showInFolder(summary.files[0])}>
                <FolderOpen size={13} /> Klasörde göster
              </button>
            </div>
          )}
        </div>
      </div>
      {summary.errors.length > 0 && <div className="err-list">{summary.errors.join('\n')}</div>}
    </div>
  )
}

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
