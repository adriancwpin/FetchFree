import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Server's PORT; must match the Enable Banking redirect URI (localhost:3000/callback).
    // 127.0.0.1, not "localhost": the server binds IPv4 loopback only, and "localhost" can resolve to ::1.
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
})
