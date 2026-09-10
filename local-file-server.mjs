import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function resolveBaseDir() {
  if (process.pkg) {
    return path.dirname(process.execPath)
  }
  return __dirname
}

const BASE_DIR = resolveBaseDir()

const DIST_DIR = path.join(BASE_DIR, 'dist')
const DATA_FILE = path.join(BASE_DIR, 'server-access-items.json')
const OFFLINE_EXE_ZIP = path.join(BASE_DIR, 'offline-exe.zip')
const MAX_BODY_BYTES = 5 * 1024 * 1024

async function resolveOfflineExeZipPath() {
  try {
    const files = await fs.readdir(BASE_DIR)
    const datedZipNames = files
      .filter((name) => /^offline-exe-\d{4}-\d{2}-\d{2}\.zip$/.test(name))
      .sort((a, b) => b.localeCompare(a))

    if (datedZipNames.length) {
      return path.join(BASE_DIR, datedZipNames[0])
    }
  } catch {
    // Fallback to legacy static file name
  }

  return OFFLINE_EXE_ZIP
}

function parseArg(name, fallback) {
  const idx = process.argv.indexOf(name)
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1]
  }
  return fallback
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function resolveCliPath(value) {
  if (!value) return ''
  if (path.isAbsolute(value)) return value
  return path.resolve(process.cwd(), value)
}

const host = parseArg('--host', '127.0.0.1')
const port = Number.parseInt(parseArg('--port', '4173'), 10)
const useHttps = hasFlag('--https')
const certPath = resolveCliPath(parseArg('--cert', ''))
const keyPath = resolveCliPath(parseArg('--key', ''))
const pfxPath = resolveCliPath(parseArg('--pfx', ''))
const pfxPassphrase = parseArg('--pfx-pass', process.env.SAM_PFX_PASS || '')

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
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
  const body = `${JSON.stringify(payload, null, 2)}\n`
  const tempFile = `${DATA_FILE}.tmp`
  await fs.writeFile(tempFile, body, 'utf8')
  await fs.rename(tempFile, DATA_FILE)
}

async function readRequestBody(req) {
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

function sanitizePathname(urlPathname) {
  let pathname = decodeURIComponent(urlPathname)
  if (pathname === '/') {
    return '/index.html'
  }
  return pathname
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true })
    return true
  }

  if (pathname === '/api/items' && req.method === 'GET') {
    const payload = await loadStoragePayload()
    sendJson(res, 200, payload)
    return true
  }

  if (pathname === '/api/items' && req.method === 'PUT') {
    let bodyText = ''
    try {
      bodyText = await readRequestBody(req)
      const parsed = JSON.parse(bodyText)

      if (
        !Array.isArray(parsed) &&
        (typeof parsed !== 'object' || parsed === null)
      ) {
        sendJson(res, 400, { error: 'payload must be a JSON object or array' })
        return true
      }

      await savePayload(parsed)
      sendJson(res, 200, { ok: true })
      return true
    } catch (error) {
      if (error.message === 'payload too large') {
        sendJson(res, 413, { error: 'payload too large' })
        return true
      }
      sendJson(res, 400, { error: 'invalid request body' })
      return true
    }
  }

  if (pathname === '/api/offline-exe-download' && req.method === 'GET') {
    try {
      const zipPath = await resolveOfflineExeZipPath()
      const zipBuffer = await fs.readFile(zipPath)
      const downloadFileName = path.basename(zipPath)
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${downloadFileName}"`,
        'Cache-Control': 'no-store',
      })
      res.end(zipBuffer)
    } catch {
      sendJson(res, 404, { error: 'offline-exe-YYYY-MM-DD.zip not found. Run prepare-offline-exe-package.bat first.' })
    }
    return true
  }

  if (pathname === '/api/offline-exe-meta' && req.method === 'GET') {
    try {
      const zipPath = await resolveOfflineExeZipPath()
      await fs.access(zipPath)
      sendJson(res, 200, { fileName: path.basename(zipPath) })
    } catch {
      sendJson(res, 404, { error: 'offline-exe zip file not found' })
    }
    return true
  }

  return false
}

async function serveStatic(res, pathname) {
  const filePath = path.resolve(DIST_DIR, `.${pathname}`)
  const isInsideDist = filePath.startsWith(DIST_DIR)

  if (!isInsideDist) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const data = await fs.readFile(filePath)
    const ext = path.extname(filePath)
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(data)
    return
  } catch {
    try {
      const indexHtml = await fs.readFile(path.join(DIST_DIR, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(indexHtml)
    } catch {
      res.writeHead(500)
      res.end('dist/index.html not found. Run prepare-offline-package.bat first.')
    }
  }
}

const createAppHandler = () => async (req, res) => {
  const protocol = useHttps ? 'https' : 'http'
  const url = new URL(req.url || '/', `${protocol}://${req.headers.host || 'localhost'}`)
  const pathname = sanitizePathname(url.pathname)

  if (pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, pathname)
    if (!handled) {
      sendJson(res, 404, { error: 'Not found' })
    }
    return
  }

  await serveStatic(res, pathname)
}

const handler = createAppHandler()

let server
if (useHttps) {
  const httpsOptions = {}

  if (pfxPath) {
    httpsOptions.pfx = await fs.readFile(pfxPath)
    if (pfxPassphrase) {
      httpsOptions.passphrase = pfxPassphrase
    }
  } else if (certPath && keyPath) {
    httpsOptions.cert = await fs.readFile(certPath)
    httpsOptions.key = await fs.readFile(keyPath)
  } else {
    throw new Error('HTTPS mode requires --pfx [--pfx-pass] or --cert with --key')
  }

  server = createHttpsServer(httpsOptions, handler)
} else {
  server = createHttpServer(handler)
}

server.listen(port, host, () => {
  const protocol = useHttps ? 'https' : 'http'
  const displayHost = host === '0.0.0.0' ? 'localhost' : host
  console.log(`Server Access Manager running at ${protocol}://${displayHost}:${port}/`)
  if (host === '0.0.0.0') {
    console.log(`Listening on all interfaces (bind: ${host}:${port})`)
  }
  if (useHttps) {
    console.log('HTTPS mode enabled')
  }
})
