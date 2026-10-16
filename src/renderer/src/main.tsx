import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ACCOUNT_CHROME_HEIGHT } from '../../shared/ipc'
import App from './App'

document.documentElement.style.setProperty('--account-chrome-height', `${ACCOUNT_CHROME_HEIGHT}px`)

const root = document.getElementById('root')
if (!root) throw new Error('Renderer root is missing')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
