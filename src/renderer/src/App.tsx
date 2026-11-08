import { useEffect } from 'react'
import { DENSITY, isDark, useStore } from './store'
import { Welcome } from './components/Welcome'
import { Workspace } from './components/Workspace'
import { ConfirmDialog, Toasts } from './components/ui'

export function App() {
  const theme = useStore((s) => s.theme)
  const session = useStore((s) => s.session)
  const loadConnections = useStore((s) => s.loadConnections)

  useEffect(() => {
    loadConnections().catch((e) => useStore.getState().toast(String(e.message ?? e), 'error'))
  }, [loadConnections])

  const prefs = useStore((s) => s.prefs)
  useEffect(() => {
    const r = document.documentElement.style
    const d = DENSITY[prefs.density]
    r.setProperty('--ui-size', `${prefs.uiSize}px`)
    r.setProperty('--grid-size', `${prefs.gridSize}px`)
    r.setProperty('--grid-font', prefs.gridFont === 'mono' ? 'var(--mono)' : 'var(--font)')
    r.setProperty('--row-h', `${d.row}px`)
    r.setProperty('--head-h', `${d.head}px`)
  }, [prefs])

  useEffect(() => {
    const apply = () => {
      const dark = isDark(theme)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      window.api.setTitleBarTheme(dark).catch(() => {})
    }
    apply()
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  return (
    <div className="app">
      {session ? <Workspace /> : <Welcome />}
      <Toasts />
      <ConfirmDialog />
    </div>
  )
}
