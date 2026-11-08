import { useEffect, useRef, useState } from 'react'
import { Monitor, Moon, Settings, Sun } from 'lucide-react'
import { DEFAULT_PREFS, useStore, type Prefs, type Theme } from '../store'
import { checkNow, startUpdate, statusText, useUpdates } from '../updates'

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; l: React.ReactNode }[]; onChange(v: T): void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={String(o.v)} className={o.v === value ? 'active' : ''} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  )
}

/** Başlık çubuğundaki dişli düğmesi ve görünüm ayarları paneli */
export function PrefsButton() {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const prefs = useStore((s) => s.prefs)
  const setPrefs = useStore((s) => s.setPrefs)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  const toggle = () => {
    const r = btn.current!.getBoundingClientRect()
    setPos({ x: Math.max(8, r.right - 290), y: r.bottom + 6 })
    setOpen((o) => !o)
  }

  const set = (p: Partial<Prefs>) => setPrefs(p)
  const upd = useUpdates()

  return (
    <>
      <button ref={btn} className={`icon-btn${open ? ' active' : ''}`} title="Görünüm ayarları" onClick={toggle}>
        <Settings size={15} />
      </button>
      {open && (
        <div ref={panel} className="prefs" style={{ left: pos.x, top: pos.y }}>
          <div>
            <h6>Tema</h6>
            <Seg<Theme>
              value={theme}
              onChange={setTheme}
              options={[
                { v: 'light', l: (<><Sun size={12} /> Açık</>) },
                { v: 'dark', l: (<><Moon size={12} /> Koyu</>) },
                { v: 'system', l: (<><Monitor size={12} /> Sistem</>) }
              ]}
            />
          </div>
          <div>
            <h6>Arayüz yazı boyutu</h6>
            <Seg value={prefs.uiSize} onChange={(v) => set({ uiSize: v })} options={[12, 13, 14].map((v) => ({ v, l: `${v}` }))} />
          </div>
          <div>
            <h6>Tablo yazı tipi</h6>
            <Seg<Prefs['gridFont']>
              value={prefs.gridFont}
              onChange={(v) => set({ gridFont: v })}
              options={[
                { v: 'system', l: 'Sistem' },
                { v: 'mono', l: <span style={{ fontFamily: 'var(--mono)' }}>Sabit genişlik</span> }
              ]}
            />
          </div>
          <div>
            <h6>Tablo yazı boyutu</h6>
            <Seg value={prefs.gridSize} onChange={(v) => set({ gridSize: v })} options={[11.5, 12, 12.5, 13, 14].map((v) => ({ v, l: `${v}` }))} />
          </div>
          <div>
            <h6>Satır yoğunluğu</h6>
            <Seg<Prefs['density']>
              value={prefs.density}
              onChange={(v) => set({ density: v })}
              options={[
                { v: 'compact', l: 'Sıkı' },
                { v: 'normal', l: 'Normal' },
                { v: 'comfortable', l: 'Rahat' }
              ]}
            />
          </div>
          <div className="prefs-sample">
            <div>
              <span>1</span>
              <span>Ayşe Yılmaz</span>
              <span>İzmir</span>
              <span>1.250,00</span>
            </div>
            <div>
              <span>2</span>
              <span>Mehmet Öz</span>
              <span>Ankara</span>
              <span style={{ color: 'var(--text-3)' }}>NULL</span>
            </div>
          </div>
          <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setPrefs(DEFAULT_PREFS)}>
            Varsayılana dön
          </button>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <h6>Güncellemeler · Rowly {upd.version}</h6>
            <div className="upd-row">
              <span className="grow">{statusText(upd.state)}</span>
              {upd.state.status === 'available' ? (
                <button className="btn sm primary" onClick={startUpdate}>
                  {upd.manual ? 'İndir' : 'Güncelle'}
                </button>
              ) : (
                <button className="btn sm" disabled={upd.state.status === 'dev' || upd.state.status === 'checking' || upd.state.status === 'downloading' || upd.state.status === 'installing'} onClick={checkNow}>
                  Denetle
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
