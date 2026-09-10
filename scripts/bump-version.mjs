import fs from 'node:fs'
import path from 'node:path'

const pkgPath = path.resolve(process.cwd(), 'package.json')

function pad2(value) {
  return String(value).padStart(2, '0')
}

function makeTodayStamp(now = new Date()) {
  const yyyy = String(now.getFullYear())
  const mm = pad2(now.getMonth() + 1)
  const dd = pad2(now.getDate())
  return `${yyyy}.${mm}.${dd}`
}

function normalizeBuildCount(value) {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

function formatVersion(dateStamp, count) {
  return `${dateStamp}.${pad2(count)}`
}

function main() {
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`package.json not found at ${pkgPath}`)
  }

  const pkgRaw = fs.readFileSync(pkgPath, 'utf8')
  const pkg = JSON.parse(pkgRaw)
  const currentVersion = String(pkg.version || '').trim()
  const today = makeTodayStamp()

  let nextCount = 1

  const match = currentVersion.match(/^(\d{4}\.\d{2}\.\d{2})\.(\d{1,})$/)
  if (match) {
    const [, currentDate, currentCountRaw] = match
    if (currentDate === today) {
      nextCount = normalizeBuildCount(currentCountRaw) + 1
    }
  }

  pkg.version = formatVersion(today, nextCount)
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

  process.stdout.write(`Version bumped to ${pkg.version}\n`)
}

main()
