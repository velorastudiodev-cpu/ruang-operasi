import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const { APP_PORT = '3001' } = loadEnv(mode, process.cwd(), '')
  const api = { target: `http://127.0.0.1:${APP_PORT}`, changeOrigin: false }
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/api': api, '/healthz': api },
    },
  }
})
