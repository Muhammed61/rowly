import { useMemo, useState } from 'react'
import { Download, Search } from 'lucide-react'
import type { ExportFormat, FetchOptions, Filter, TableInfo, TransferSummary } from '@shared/types'
import { familyOf, tableLabel } from '@shared/dialects'
import { tableKey, useStore } from '../store'
import { Modal } from './ui'
import { ProgressView, SummaryView, newJobId, useProgress } from './TransferCommon'

const FORMATS: { f: ExportFormat; title: string; desc: string }[] = [
  { f: 'csv', title: 'CSV', desc: 'Excel ve tablolama programları' },
  { f: 'json', title: 'JSON', desc: 'Uygulamalar ve API’ler' },
  { f: 'sql', title: 'SQL', desc: 'Yapı + veri, başka sunucuya taşıma' }
]

const DELIMS = [
  { v: ',', l: 'Virgül (,)' },
  { v: ';', l: 'Noktalı virgül (;) — Türkçe Excel' },
  { v: '\t', l: 'Sekme' },
  { v: '|', l: 'Dikey çizgi (|)' }
]

export function ExportDialog({
  initial,
  filters,
  orderBy,
  onClose
}: {
  initial: TableInfo[]
  filters?: Filter[]
  orderBy?: FetchOptions['orderBy']
  onClose: () => void
}) {
  const session = useStore((s) => s.session)!
  const type = session.conn.type
  const family = familyOf(type)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial.map(tableKey)))
  const [q, setQ] = useState('')
  const [format, setFormat] = useState<ExportFormat>(family === 'sql' ? 'sql' : 'json')
  const [csv, setCsv] = useState({ delimiter: ',', header: true, bom: true })
  const [sql, setSql] = useState({ structure: true, data: true, drop: true })
  const [useFilters, setUseFilters] = useState(true)
  const [jobId, setJobId] = useState<string | null>(null)
  const [summary, setSummary] = useState<TransferSummary | null>(null)
  const progress = useProgress(jobId)

  const tables = session.tables
  const visible = useMemo(() => tables.filter((t) => !q || tableLabel(type, t).toLowerCase().includes(q.toLowerCase())), [tables, q, type])
  const chosen = tables.filter((t) => selected.has(tableKey(t)))
  const hasFilters = !!filters?.length && chosen.length === 1 && tableKey(chosen[0]) === tableKey(initial[0] ?? { schema: '', name: '' })
  const running = !!jobId && !summary

  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  const start = async () => {
    if (!chosen.length) return
    const db = session.info.currentDatabase || session.conn.name
    let target: string | null
    if (format === 'sql') target = await window.api.pickSavePath(`${db}.sql`, ['sql'])
    else if (chosen.length === 1) target = await window.api.pickSavePath(`${tableLabel(type, chosen[0]).replace(/[\\/:*?"<>|]+/g, '_')}.${format}`, [format])
    else target = await window.api.pickFolder()
    if (!target) return
    const id = newJobId()
    setJobId(id)
    try {
      const r = await window.api.exportData(session.id, {
        jobId: id,
        tables: chosen,
        format,
        target,
        filters: hasFilters && useFilters ? filters : undefined,
        orderBy: hasFilters && useFilters ? orderBy : undefined,
        csv,
        sql
      })
      setSummary(r)
    } catch (e) {
      setSummary({ rows: 0, files: [], errors: [(e as Error).message], ms: 0, cancelled: false })
    }
  }

  const noun = family === 'mongo' ? 'Koleksiyonlar' : family === 'redis' ? 'Anahtar grupları' : 'Tablolar'

  return (
    <Modal wide onClose={() => !running && onClose()}>
      <div className="modal-head">
        <Download size={17} /> Dışa aktar
      </div>
      <div className="modal-body">
        {summary ? (
          <SummaryView summary={summary} verb="dışa aktarıldı" />
        ) : running ? (
          <ProgressView progress={progress} label="Dışa aktarılıyor" />
        ) : (
          <div className="transfer">
            <div>
              <h5>
                {noun} · {chosen.length} / {tables.length}
                <span className="spacer" />
                <button className="btn sm ghost" onClick={() => setSelected(new Set(visible.map(tableKey)))}>
                  Tümünü seç
                </button>
                <button className="btn sm ghost" onClick={() => setSelected(new Set())}>
                  Hiçbiri
                </button>
              </h5>
              {tables.length > 8 && (
                <div className="search" style={{ marginBottom: 6 }}>
                  <Search size={13} />
                  <input className="input" placeholder="Ara…" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
              )}
              <div className="pick-list">
                {visible.map((t) => (
                  <label key={tableKey(t)}>
                    <input type="checkbox" checked={selected.has(tableKey(t))} onChange={() => toggle(tableKey(t))} />
                    {tableLabel(type, t)}
                    {t.kind === 'view' && <span className="pill">görünüm</span>}
                    {t.count !== undefined && <span className="muted">{t.count.toLocaleString('tr-TR')}</span>}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <h5>Biçim</h5>
              <div className="format-cards">
                {FORMATS.map((x) => (
                  <div
                    key={x.f}
                    className={`format-card${format === x.f ? ' active' : ''}${x.f === 'sql' && family !== 'sql' ? ' disabled' : ''}`}
                    onClick={() => setFormat(x.f)}
                  >
                    <b>{x.title}</b>
                    <span>{x.f === 'json' && family === 'mongo' ? 'Tipleri korur (mongoexport biçimi)' : x.desc}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h5>Seçenekler</h5>
              {format === 'csv' && (
                <div className="opt-row">
                  <select className="select" value={csv.delimiter} onChange={(e) => setCsv({ ...csv, delimiter: e.target.value })}>
                    {DELIMS.map((d) => (
                      <option key={d.l} value={d.v}>
                        {d.l}
                      </option>
                    ))}
                  </select>
                  <label className="check">
                    <input type="checkbox" checked={csv.header} onChange={(e) => setCsv({ ...csv, header: e.target.checked })} /> Başlık satırı
                  </label>
                  <label className="check" title="Excel'in Türkçe karakterleri doğru göstermesi için">
                    <input type="checkbox" checked={csv.bom} onChange={(e) => setCsv({ ...csv, bom: e.target.checked })} /> Excel uyumlu (UTF-8 BOM)
                  </label>
                </div>
              )}
              {format === 'sql' && (
                <div className="opt-row">
                  <label className="check">
                    <input type="checkbox" checked={sql.structure} onChange={(e) => setSql({ ...sql, structure: e.target.checked })} /> Yapı (CREATE)
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={sql.data} onChange={(e) => setSql({ ...sql, data: e.target.checked })} /> Veri (INSERT)
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={sql.drop}
                      disabled={!sql.structure}
                      onChange={(e) => setSql({ ...sql, drop: e.target.checked })}
                    />{' '}
                    Önce DROP … IF EXISTS
                  </label>
                </div>
              )}
              {format === 'json' && (
                <div className="muted">
                  {family === 'sql'
                    ? 'Her satır bir JSON nesnesi olarak yazılır.'
                    : family === 'mongo'
                      ? 'Dokümanlar EJSON olarak yazılır: ObjectId, tarih ve sayı tipleri geri içe aktarıldığında korunur.'
                      : 'Her anahtar { key, type, ttl, value } olarak, koleksiyonların tamamıyla yazılır.'}
                </div>
              )}
              {hasFilters && (
                <label className="check" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={useFilters} onChange={(e) => setUseFilters(e.target.checked)} />
                  Yalnızca geçerli filtreye uyan kayıtlar ({filters!.length} filtre)
                </label>
              )}
              {chosen.length > 1 && format !== 'sql' && (
                <div className="muted" style={{ marginTop: 8 }}>
                  Birden fazla seçim: her biri seçeceğin klasöre ayrı bir dosya olarak yazılır.
                </div>
              )}
            </div>
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
            <button className="btn primary" disabled={!chosen.length || (format === 'sql' && !sql.structure && !sql.data)} onClick={start}>
              <Download size={14} /> Dışa aktar…
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
