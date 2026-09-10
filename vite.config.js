import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PACKAGE_JSON = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
const APP_VERSION = String(PACKAGE_JSON?.version || '0.0.0')
const DATA_FILE = path.join(__dirname, 'data', 'server-access-items.json')
const OFFLINE_EXE_ZIP = path.join(__dirname, 'offline-exe.zip')
const MAX_BODY_BYTES = 5 * 1024 * 1024

async function resolveOfflineExeZipPath() {
  try {
    const files = await fs.readdir(__dirname)
    const datedZipNames = files
      .filter((name) => /^offline-exe-\d{4}-\d{2}-\d{2}\.zip$/.test(name))
      .sort((a, b) => b.localeCompare(a))

    if (datedZipNames.length) {
      return path.join(__dirname, datedZipNames[0])
    }
  } catch {
    // Fallback to legacy static file name
  }

  return OFFLINE_EXE_ZIP
}

async function ensureDataFile() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true })
  try {
    await fs.access(DATA_FILE)
  } catch {
    await fs.writeFile(DATA_FILE, '{"items": []}\n', 'utf8')
  }
}

async function loadStoragePayload() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return { items: [] }
  }
}

async function savePayload(payload) {
  const next = `${JSON.stringify(payload, null, 2)}\n`
  const temp = `${DATA_FILE}.tmp`
  await fs.writeFile(temp, next, 'utf8')
  await fs.rename(temp, DATA_FILE)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new Error('payload too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function localFileApiPlugin() {
  return {
    name: 'local-file-api',
    async configureServer(server) {
      await ensureDataFile()

      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url || '').split('?')[0]
        if (!pathname.startsWith('/api/')) {
          next()
          return
        }

        try {
          if (pathname === '/api/health' && req.method === 'GET') {
            sendJson(res, 200, { ok: true })
            return
          }

          if (pathname === '/api/items' && req.method === 'GET') {
            sendJson(res, 200, await loadStoragePayload())
            return
          }

          if (pathname === '/api/items' && req.method === 'PUT') {
            const bodyText = await readBody(req)
            const parsed = JSON.parse(bodyText)

            if (
              !Array.isArray(parsed) &&
              (typeof parsed !== 'object' || parsed === null)
            ) {
              sendJson(res, 400, { error: 'payload must be a JSON object or array' })
              return
            }

            await savePayload(parsed)
            sendJson(res, 200, { ok: true })
            return
          }

          if (pathname === '/api/offline-exe-download' && req.method === 'GET') {
            try {
              const zipPath = await resolveOfflineExeZipPath()
              const zipBuffer = await fs.readFile(zipPath)
              const downloadFileName = path.basename(zipPath)
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/zip')
              res.setHeader('Content-Disposition', `attachment; filename="${downloadFileName}"`)
              res.setHeader('Cache-Control', 'no-store')
              res.end(zipBuffer)
            } catch {
              sendJson(res, 404, { error: 'offline-exe-YYYY-MM-DD.zip not found. Run prepare-offline-exe-package.bat first.' })
            }
            return
          }

          if (pathname === '/api/offline-exe-meta' && req.method === 'GET') {
            try {
              const zipPath = await resolveOfflineExeZipPath()
              await fs.access(zipPath)
              sendJson(res, 200, { fileName: path.basename(zipPath) })
            } catch {
              sendJson(res, 404, { error: 'offline-exe zip file not found' })
            }
            return
          }

          sendJson(res, 404, { error: 'Not found' })
        } catch (error) {
          if (error?.message === 'payload too large') {
            sendJson(res, 413, { error: 'payload too large' })
            return
          }
          sendJson(res, 400, { error: 'invalid request body' })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localFileApiPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    host: '0.0.0.0',
   // host: '127.0.0.1',
    port: 4173,
  },
  preview: {
    //host: '127.0.0.1',
    host: '0.0.0.0',
  },
})
