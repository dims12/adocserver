#!/usr/bin/env node

import { createServer } from 'vite'
import { createAdocPlugin } from '../src/plugin.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const assetsDir = path.resolve(__dirname, '../assets')

// ---- Arg parsing -------------------------------------------------------

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
adocserver — AsciiDoc dev server with sidebar navigation

Usage:
  adocserver [docsDir] [options]

Arguments:
  docsDir          Directory containing your .adoc files (default: current dir)
                   Must contain an index.adoc that defines the nav via include::

Options:
  --port <n>       Port to listen on (default: 3000)
  --host <h>       Host to bind (default: 0.0.0.0, i.e. all interfaces)
  --open           Open browser on start
  --help, -h       Show this help

Config file:
  Place docserver.config.js in your docs directory to customise:

    export default {
      title: 'My Docs',       // site name shown in sidebar and page titles
      accent: '#2563eb',      // primary/accent color
      accentStrong: '#1d4ed8', // hover/active variant (defaults to a darker shade)
      logo: '/logo.png',       // logo URL (served from your docs/public/ directory)
    }
`)
  process.exit(0)
}

let docsDir = null
let port    = 3000
let host    = '0.0.0.0'
let open    = false

for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
    port = parseInt(args[++i], 10); continue
  }
  if (args[i] === '--host' && args[i + 1]) {
    host = args[++i]; continue
  }
  if (args[i] === '--open') { open = true; continue }
  if (!args[i].startsWith('--')) { docsDir = args[i]; continue }
}

docsDir = docsDir ? path.resolve(process.cwd(), docsDir) : process.cwd()

if (!existsSync(docsDir)) {
  console.error(`adocserver: directory not found: ${docsDir}`)
  process.exit(1)
}

const indexFile = path.resolve(docsDir, 'index.adoc')
if (!existsSync(indexFile)) {
  console.error(`adocserver: no index.adoc found in ${docsDir}`)
  console.error('Create an index.adoc that includes your other .adoc files via include:: directives.')
  process.exit(1)
}

// ---- Load optional config ----------------------------------------------

let config = {}
const configPath = path.resolve(docsDir, 'docserver.config.js')
if (existsSync(configPath)) {
  try {
    config = (await import(pathToFileURL(configPath).href)).default ?? {}
  } catch (err) {
    console.warn(`adocserver: failed to load docserver.config.js: ${err.message}`)
  }
}

// ---- Start Vite --------------------------------------------------------

const server = await createServer({
  root: docsDir,
  server: {
    port,
    host,
    open: open ? '/docs/' : false,
  },
  plugins: [
    createAdocPlugin({ docsDir, assetsDir, config }),
  ],
})

await server.listen()
server.printUrls()
