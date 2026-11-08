import { useEffect, useState } from 'react'
import { Copy, KeyRound } from 'lucide-react'
import type { ColumnInfo, IndexInfo, TableRef } from '@shared/types'
import { familyOf } from '@shared/dialects'
import { useStore } from '../store'
import { SqlEditor } from './SqlEditor'
import { copyText } from './ui'

export function StructureView({
  sessionId,
  table,
  columns,
  reloadSeq
}: {
  sessionId: string
  table: TableRef
  columns: ColumnInfo[]
  reloadSeq: number
}) {
  const dbType = useStore((s) => s.session!.conn.type)
  const family = familyOf(dbType)
  const [indexes, setIndexes] = useState<IndexInfo[]>([])
  const [ddl, setDdl] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let off = false
    Promise.all([window.api.getIndexes(sessionId, table), window.api.getDDL(sessionId, table)])
      .then(([i, d]) => {
        if (off) return
        setIndexes(i)
        setDdl(d)
        setError(null)
      })
      .catch((e) => !off && setError((e as Error).message))
    return () => {
      off = true
    }
  }, [sessionId, table, reloadSeq])

  return (
    <div className="structure">
      {error && <div className="error-box">{error}</div>}
      <section>
        <h4>
          {family === 'mongo' ? 'Alanlar' : 'Sütunlar'} · {columns.length}
          {family === 'mongo' && <span className="muted" style={{ textTransform: 'none', fontWeight: 400 }}>ilk 300 dokümandan çıkarıldı</span>}
        </h4>
        <table className="stable">
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Ad</th>
              <th>Tip</th>
              <th>Boş olabilir</th>
              <th>Varsayılan</th>
              <th>Ek</th>
              <th>Açıklama</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((c, i) => (
              <tr key={c.name}>
                <td className="muted">{i + 1}</td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                    {c.primaryKey && <KeyRound size={12} color="var(--warn)" />}
                    {c.name}
                  </span>
                </td>
                <td className="mono">{c.type}</td>
                <td>{c.nullable ? 'Evet' : <span className="muted">Hayır</span>}</td>
                <td className="mono">{c.defaultValue ?? <span className="muted">NULL</span>}</td>
                <td>
                  {c.primaryKey && <span className="pill pk">PK</span>}
                  {c.autoIncrement && <span className="pill">{c.extra || 'auto'}</span>}
                  {!c.autoIncrement && c.extra && <span className="pill">{c.extra}</span>}
                </td>
                <td className="muted">{c.comment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {family !== 'redis' && (
      <section>
        <h4>İndeksler · {indexes.length}</h4>
        {indexes.length ? (
          <table className="stable">
            <thead>
              <tr>
                <th>Ad</th>
                <th>Sütunlar</th>
                <th>Tür</th>
              </tr>
            </thead>
            <tbody>
              {indexes.map((i) => (
                <tr key={i.name}>
                  <td style={{ fontWeight: 600 }}>{i.name}</td>
                  <td className="mono">{i.columns}</td>
                  <td>
                    {i.primary ? <span className="pill pk">PRIMARY</span> : i.unique ? <span className="pill uq">UNIQUE</span> : <span className="pill">INDEX</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">İndeks yok</div>
        )}
      </section>
      )}

      <section>
        <h4>
          {family === 'mongo' ? 'Tanım' : family === 'redis' ? 'Bilgi' : 'DDL'}
          <button className="btn sm ghost" onClick={() => copyText(ddl)}>
            <Copy size={12} /> Kopyala
          </button>
        </h4>
        <div className="ddl-box">
          <SqlEditor value={ddl} dbType={dbType} readOnly />
        </div>
      </section>
    </div>
  )
}
