import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const apiUrl = (process.env.HERMES_API_URL || '').trim()
const dashboardUrl = (process.env.HERMES_DASHBOARD_URL || '').trim()
const stamp = (process.env.HERMES_AGENT_BACKUP_STAMP || '').trim()

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (!apiUrl) {
  fail('HERMES_API_URL is required')
}
if (!dashboardUrl && process.env.HERMES_DASHBOARD_OPTIONAL !== '1') {
  fail('HERMES_DASHBOARD_URL is required')
}
if (!stamp || !existsSync(stamp)) {
  fail(
    'Refusing to connect. Take a tar backup of the external agent ~/.hermes on its host, then point HERMES_AGENT_BACKUP_STAMP at a local file whose first line is backup-ok.',
  )
}
if (!readFileSync(stamp, 'utf8').trim().startsWith('backup-ok')) {
  fail('backup stamp is not backup-ok')
}

async function probe(base, path) {
  const target = new URL(path, base.endsWith('/') ? base : `${base}/`)
  const headers = {}
  if (process.env.HERMES_API_TOKEN) {
    headers.Authorization = `Bearer ${process.env.HERMES_API_TOKEN}`
  }
  const response = await fetch(target, { headers, signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
  await response.text()
}

if (process.env.EIPP_SKIP_DOCKER !== '1') {
  const names = (process.env.EIPP_CONTAINER_NAMES || 'awg-llm')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) fail(`unsafe container name ${name}`)
    const result = spawnSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', name], {
      encoding: 'utf8',
    })
    if (result.status !== 0) fail(`cannot read StartedAt for ${name}`)
    process.stdout.write(`${name} ${result.stdout.trim()}\n`)
  }
}

try {
  await probe(apiUrl, '/health')
} catch (error) {
  fail(error instanceof Error ? error.message : 'gateway health failed')
}
if (dashboardUrl) {
  try {
    await probe(dashboardUrl, '/api/status')
  } catch (error) {
    if (process.env.HERMES_DASHBOARD_OPTIONAL !== '1') {
      fail(error instanceof Error ? error.message : 'dashboard probe failed')
    }
    process.stdout.write('dashboard-unavailable\n')
  }
} else if (process.env.HERMES_DASHBOARD_OPTIONAL !== '1') {
  fail('HERMES_DASHBOARD_URL is required')
}
process.stdout.write('agent-preflight-ok\n')
