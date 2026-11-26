import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@fontsource-variable/inter'
import '@fontsource-variable/manrope'
import { App } from './app'
import './styles.css'

const client = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: false, staleTime: 15_000 },
  },
})

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const clickAnimations = new WeakMap<HTMLElement, Animation>()
document.addEventListener('click', (event) => {
  if (reducedMotion.matches || !(event.target instanceof Element)) return
  const control = event.target.closest('button, a[href], summary, select, input[type="checkbox"]')
  if (!(control instanceof HTMLElement) || control.matches(':disabled, [aria-disabled="true"], .mobile-backdrop')) return
  clickAnimations.get(control)?.cancel()
  clickAnimations.set(control, control.animate(
    [{ scale: '0.96' }, { scale: '1' }],
    { duration: 190, easing: 'cubic-bezier(.2, .75, .25, 1)' },
  ))
}, { capture: true })

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><QueryClientProvider client={client}><App /></QueryClientProvider></React.StrictMode>,
)
