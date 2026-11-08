import { useEffect, useMemo, useState } from 'react'
import { FileText, Loader2, Upload } from 'lucide-react'
import type { ColumnInfo, ImportPreview, TableInfo, TransferSummary } from '@shared/types'
import { familyOf, tableLabel } from '@shared/dialects'
import { tableKey, useStore } from '../store'
import { DataGrid } from './DataGrid'
import { Modal } from './ui'
import { ProgressView, SummaryView, formatBytes, newJobId, useProgress } from './TransferCommon'

const norm = (s: string) =>
  s
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]/g, '')

const DELIMS = [
  { v: ',', l: 'Virgül (,)' },
  { v: ';', l: 'Noktalı virgül (;)' },
  { v: '\t', l: 'Sekme' },
  { v: '|', l: 'Dikey çizgi (|)' }
]

export function ImportDialog({ initial, onClose }: { initial?: TableInfo; onClose: () => void }) {
  const session = useStore((s) => s.session)!
  const confirm = useStore((s) => s.confirm)
  const refreshTables = useStore((s) => s.refreshTables)
  const bumpTable = useStore((s) => s.bumpTable)
  const type = session.conn.type
  const family = familyOf(type)

  const [file, setFile] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [delimiter, setDelimiter] = useState<string | undefined>()
  const [header, setHeader] = useState(true)
  const targets = useMemo(() => session.tables.filter((t) => t.kind === 'table'), [session.tables])
  const [targetName, setTargetName] = useState(initial?.kind === 'table' ? initial.name : (targets[0]?.name ?? ''))
  const [targetCols, setTargetCols] = useState<ColumnInfo[]>([])
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [emptyAsNull, setEmptyAsNull] = useState(true)
  const [truncate, setTruncate] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [stopOnError, setStopOnError] = useState(true)
  const [jobId, setJobId] = useState<string | null>(null)
  const [summary, setSummary] = useState<TransferSummary | null>(null)
  const progress = useProgress(jobId)

  const target: TableInfo | null = useMemo(() => {
    if (!targetName) return null
    return (
      targets.find((t) => t.name === targetName) ??
      (family === 'mongo' ? { schema: session.info.currentDatabase, name: targetName, kind: 'table' } : null)
    )
  }, [targetName, targets, family, session.info.currentDatabase])

  const load = async (p: string, delim?: string) => {
    setLoading(true)
    setError(null)
    try {
      const pr = await window.api.previewImport(p, delim)
      setFile(p)
      setPreview(pr)
      setDelimiter(pr.delimiter)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const pick = async () => {
    const p = await window.api.pickImportFile()
    if (p) load(p)
  }

  useEffect(() => {
    if (!target || targets.every((t) => t.name !== target.name)) {
      setTargetCols([])
      return
    }
    let off = false
    window.api
      .getColumns(session.id, target)
      .then((c) => !off && setTargetCols(c))
      .catch(() => !off && setTargetCols([]))
    return () => {
      off = true
    }
  }, [session.id, target, targets])

  const fileCols = useMemo(() => {
    if (!preview) return []
    return header || preview.kind !== 'csv' ? preview.columns : preview.columns.map((_, i) => `sütun${i + 1}`)
  }, [preview, header])
  const fileRows = useMemo(() => {
    if (!preview) return []
    return header || preview.kind !== 'csv' ? preview.rows : [preview.columns, ...preview.rows]
  }, [preview, header])

  // Otomatik eşleme: aynı (normalize edilmiş) ada sahip sütun
  useEffect(() => {
    const m: Record<string, string | null> = {}
    for (const c of fileCols) {
      const hit = targetCols.find((t) => norm(t.name) === norm(c))
      m[c] = hit ? hit.name : family === 'mongo' ? c : null
    }
    setMapping(m)
  }, [fileCols, targetCols, family])

  const asDocuments = preview?.kind === 'json' && family !== 'sql'
  const mappedCount = Object.values(mapping).filter(Boolean).length
  const running = !!jobId && !summary
  const canStart =
    !!preview &&
    !!file &&
    (preview.kind === 'sql' ? family === 'sql' : !!target && (asDocuments || mappedCount > 0))

  const start = async () => {
    if (!preview || !file) return
    if (session.conn.tag === 'production') {
      const ok = await confirm({
        title: 'Production veritabanı',
        message: `"${session.conn.name}" bir PRODUCTION bağlantısı. İçe aktarma veri ekleyecek${truncate ? ' ve önce tabloyu BOŞALTACAK' : ''}. Devam edilsin mi?`,
        confirmLabel: 'İçe aktar',
        danger: true
      })
      if (!ok) return
    } else if (truncate) {
      const ok = await confirm({ title: 'Önce boşalt', message: `${target?.name} içindeki tüm kayıtlar silinecek. Emin misin?`, confirmLabel: 'Boşalt ve aktar', danger: true })
      if (!ok) return
    }
    const id = newJobId()
    setJobId(id)
    try {
      const r = await window.api.importData(session.id, {
        jobId: id,
        file,
        kind: preview.kind,
        table: target ?? undefined,
        mapping: fileCols.map((c) => ({ source: c, target: mapping[c] ?? null })),
        delimiter,
        header,
        emptyAsNull,
        truncate,
        overwrite,
        stopOnError
      })
      setSummary(r)
      if (r.rows > 0) {
        if (target) bumpTable(tableKey(target))
        refreshTables()
      }
    } catch (e) {
      setSummary({ rows: 0, files: [], errors: [(e as Error).message], ms: 0, cancelled: false })
    }
  }

  return (
    <Modal wide onClose={() => !running && onClose()}>
      <div className="modal-head">
        <Upload size={17} /> İçe aktar
      </div>
      <div className="modal-body">
        {summary ? (
          <SummaryView summary={summary} verb={preview?.kind === 'sql' ? 'ifade çalıştırıldı' : 'içe aktarıldı'} />
        ) : running ? (
          <ProgressView progress={progress} label="İçe aktarılıyor" />
        ) : !preview ? (
          <div className="transfer">
            <div className="drop-zone" onClick={pick}>
              {loading ? <Loader2 size={26} className="spin" /> : <Upload size={26} />}
              <div style={{ marginTop: 10, fontWeight: 600 }}>Dosya seç</div>
              <div className="muted" style={{ marginTop: 4 }}>
                CSV, TSV, JSON / NDJSON{family === 'sql' ? ' veya SQL betiği' : ''}
              </div>
            </div>
            {error && <div className="error-box" style={{ margin: 0 }}>{error}</div>}
          </div>
        ) : (
          <div className="transfer">
            <div className="file-chip">
              <FileText size={18} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="name" title={file ?? ''}>
                  {file?.split(/[\\/]/).pop()}
                </div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {preview.kind.toUpperCase()} · {formatBytes(preview.size)}
                  {preview.totalRows !== undefined && ` · ${preview.totalRows.toLocaleString('tr-TR')} kayıt`}
                  {preview.statements !== undefined && ` · ${preview.statements.toLocaleString('tr-TR')} ifade`}
                </div>
              </div>
              <button className="btn sm" onClick={pick}>
                Değiştir
              </button>
            </div>
            {error && <div className="error-box" style={{ margin: 0 }}>{error}</div>}

            {preview.kind === 'sql' ? (
              family !== 'sql' ? (
                <div className="error-box" style={{ margin: 0 }}>SQL betikleri yalnızca SQL veritabanlarında çalıştırılabilir.</div>
              ) : (
                <>
                  <div>
                    <h5>Betik · {session.info.currentDatabase || session.conn.name} üzerinde çalışacak</h5>
                    <pre className="sql-sample">{preview.sample}</pre>
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} /> İlk hatada dur
                  </label>
                </>
              )
            ) : (
              <>
                <div className="opt-row">
                  <span className="muted">Hedef:</span>
                  {family === 'mongo' ? (
                    <>
                      <input
                        className="input"
                        list="import-targets"
                        style={{ width: 240 }}
                        placeholder="koleksiyon adı"
                        value={targetName}
                        onChange={(e) => setTargetName(e.target.value)}
                      />
                      <datalist id="import-targets">
                        {targets.map((t) => (
                          <option key={t.name} value={t.name} />
                        ))}
                      </datalist>
                      {targetName && !targets.some((t) => t.name === targetName) && <span className="pill uq">yeni koleksiyon</span>}
                    </>
                  ) : (
                    <select className="select" style={{ minWidth: 220 }} value={targetName} onChange={(e) => setTargetName(e.target.value)}>
                      {targets.map((t) => (
                        <option key={tableKey(t)} value={t.name}>
                          {tableLabel(type, t)}
                        </option>
                      ))}
                    </select>
                  )}
                  {preview.kind === 'csv' && (
                    <>
                      <select className="select" value={delimiter} onChange={(e) => file && load(file, e.target.value)}>
                        {DELIMS.map((d) => (
                          <option key={d.l} value={d.v}>
                            {d.l}
                          </option>
                        ))}
                      </select>
                      <label className="check">
                        <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> İlk satır başlık
                      </label>
                    </>
                  )}
                </div>

                <div>
                  <h5>Önizleme</h5>
                  <div className="preview-grid">
                    <DataGrid columns={fileCols.map((name) => ({ name }))} rowCount={fileRows.length} getCell={(r, c) => fileRows[r]?.[c] ?? null} emptyText="Dosya boş" />
                  </div>
                </div>

                {asDocuments ? (
                  <div className="muted">
                    {family === 'mongo'
                      ? 'Dokümanlar olduğu gibi eklenir; EJSON tipleri ($oid, $date…) korunur.'
                      : 'Her kayıt { key, type, ttl, value } biçiminde olmalı (Rowly’nin dışa aktardığı biçim).'}
                  </div>
                ) : (
                  <div>
                    <h5>
                      Sütun eşleme · {mappedCount} / {fileCols.length}
                    </h5>
                    <div className="map-scroll">
                      <table className="map-table">
                        <tbody>
                          {fileCols.map((c) => (
                            <tr key={c}>
                              <td>{c}</td>
                              <td style={{ width: 24, color: 'var(--text-3)' }}>→</td>
                              <td>
                                {family === 'mongo' ? (
                                  <input
                                    className="input"
                                    placeholder="(atla)"
                                    value={mapping[c] ?? ''}
                                    onChange={(e) => setMapping({ ...mapping, [c]: e.target.value || null })}
                                  />
                                ) : (
                                  <select
                                    className="select"
                                    value={mapping[c] ?? ''}
                                    onChange={(e) => setMapping({ ...mapping, [c]: e.target.value || null })}
                                  >
                                    <option value="">— atla —</option>
                                    {targetCols
                                      .filter((t) => !(family === 'redis' && t.name === 'size'))
                                      .map((t) => (
                                        <option key={t.name} value={t.name}>
                                          {t.name} ({t.type})
                                        </option>
                                      ))}
                                  </select>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div className="opt-row">
                  {preview.kind === 'csv' && (
                    <label className="check">
                      <input type="checkbox" checked={emptyAsNull} onChange={(e) => setEmptyAsNull(e.target.checked)} /> Boş hücreler NULL
                    </label>
                  )}
                  {asDocuments && (
                    <label className="check">
                      <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Varsa üzerine yaz
                    </label>
                  )}
                  {family !== 'redis' && (
                    <label className="check" style={{ color: truncate ? 'var(--danger)' : undefined }}>
                      <input type="checkbox" checked={truncate} onChange={(e) => setTruncate(e.target.checked)} /> Önce hedefi boşalt
                    </label>
                  )}
                  <label className="check" title="Kapalıysa hatalı satırlar atlanır ve raporlanır">
                    <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} /> İlk hatada dur
                  </label>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="modal-foot">
        <div className="spacer" />
        {summary ? (
          <button className="btn primary" onClick={onClose}>
            Kapat
          </button>
        ) : running ? (
          <button className="btn" onClick={() => jobId && window.api.cancelJob(jobId)}>
            İptal
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Vazgeç
            </button>
            <button className="btn primary" disabled={!canStart} onClick={start}>
              <Upload size={14} /> {preview?.kind === 'sql' ? 'Betiği çalıştır' : 'İçe aktar'}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
