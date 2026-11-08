import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Info } from 'lucide-react'
import { dbTypeInfo, ENV_TAGS, type DbType, type EnvTag } from '@shared/types'
import { useStore } from '../store'

export function DbBadge({ type, size = 30 }: { type: DbType; size?: number }) {
  const info = dbTypeInfo(type)
  return (
    <span className="badge" style={{ width: size, height: size, background: info.color, fontSize: size * 0.4 }}>
      {info.short}
    </span>
  )
}

export function TagChip({ tag }: { tag: EnvTag }) {
  const t = ENV_TAGS.find((x) => x.tag === tag) ?? ENV_TAGS[0]
  return (
    <span className="tag-chip" lang="en" style={{ background: t.color + '22', color: t.color }}>
      {t.label}
    </span>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'success' ? <CheckCircle2 size={16} /> : t.kind === 'error' ? <AlertCircle size={16} /> : <Info size={16} />}
          <div>{t.text}</div>
        </div>
      ))}
    </div>
  )
}

export function Modal({ children, onClose, small, wide }: { children: ReactNode; onClose: () => void; small?: boolean; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${small ? ' small' : ''}${wide ? ' wide' : ''}`}>{children}</div>
    </div>
  )
}

export function ConfirmDialog() {
  const req = useStore((s) => s.confirmReq)
  const okRef = useRef<HTMLButtonElement>(null)
  useEffect(() => okRef.current?.focus(), [req])
  if (!req) return null
  return (
    <Modal small onClose={() => req.resolve(false)}>
      <div className="modal-head">
        {req.danger && <AlertCircle size={18} color="var(--danger)" />}
        {req.title}
      </div>
      <div className="modal-body" style={{ whiteSpace: 'pre-wrap' }}>
        {req.message}
      </div>
      <div className="modal-foot">
        <div className="spacer" />
        <button className="btn" onClick={() => req.resolve(false)}>
          Vazgeç
        </button>
        <button ref={okRef} className={`btn ${req.danger ? 'danger solid' : 'primary'}`} onClick={() => req.resolve(true)}>
          {req.confirmLabel ?? 'Tamam'}
        </button>
      </div>
    </Modal>
  )
}

export interface MenuItem {
  label?: string
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
  separator?: boolean
}

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 6),
      y: Math.min(menu.y, window.innerHeight - r.height - 6)
    })
  }, [menu])
  useEffect(() => {
    if (!menu) return
    const close = () => onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', key)
    }
  }, [menu, onClose])
  if (!menu) return null
  return (
    <div ref={ref} className="ctx" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {menu.items.map((it, i) =>
        it.separator ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            className={it.danger ? 'danger' : ''}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onClick?.()
            }}
          >
            {it.icon}
            {it.label}
            {it.shortcut && <span className="sc">{it.shortcut}</span>}
          </button>
        )
      )}
    </div>
  )
}

/** Sürüklenerek boyutlandırılan ayırıcı */
export function Resizer({ dir, onResize }: { dir: 'x' | 'y'; onResize: (delta: number) => void }) {
  const [drag, setDrag] = useState(false)
  return (
    <div
      className={`resizer-${dir}${drag ? ' dragging' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault()
        let last = dir === 'x' ? e.clientX : e.clientY
        setDrag(true)
        const move = (ev: MouseEvent) => {
          const cur = dir === 'x' ? ev.clientX : ev.clientY
          onResize(cur - last)
          last = cur
        }
        const up = () => {
          setDrag(false)
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
    />
  )
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    useStore.getState().toast('Panoya kopyalandı', 'success')
  } catch {
    useStore.getState().toast('Panoya kopyalanamadı', 'error')
  }
}
