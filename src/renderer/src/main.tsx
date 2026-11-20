import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './shell/App'

const root = document.getElementById('root')
if (!root) throw new Error('Renderer root is missing')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
