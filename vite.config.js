import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Ship CHANGELOG.md beside public/changelog.html, which renders it.
const changelog = {
  name: 'copy-changelog',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'CHANGELOG.md', source: readFileSync('CHANGELOG.md', 'utf8') })
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), changelog],
  base: '/suno-style-creator/', // must match your repo name
})
