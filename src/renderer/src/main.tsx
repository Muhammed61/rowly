import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Platforma göre küçük stil farkları (ör. macOS'ta pencere düğmeleri solda)
document.documentElement.dataset.platform = window.platform

createRoot(document.getElementById('root')!).render(<App />)
