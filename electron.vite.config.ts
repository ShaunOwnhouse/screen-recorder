import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const pages = ['index', 'overlay', 'editor', 'audio'] as const
const preloads = ['index', 'overlay', 'editor', 'audio'] as const

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: Object.fromEntries(preloads.map((p) => [p, resolve(__dirname, `src/preload/${p}.ts`)]))
      }
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        input: Object.fromEntries(pages.map((p) => [p, resolve(__dirname, `src/renderer/${p}.html`)]))
      }
    }
  }
})
