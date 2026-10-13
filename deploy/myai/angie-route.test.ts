import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  guardFailure,
  inSnapshotWindow,
  installRoute,
  removeRoute,
  runningCountFromEnv,
  shutdownAllowsLongRequests,
  shutdownTimeoutSeconds,
} from './angie-route.mjs'

const FIXTURE = `server {
    listen 80;
    server_name myai.awg.ru;
    location / { proxy_pass http://127.0.0.1:8080; }
}
server {
    listen 443 ssl;
    server_name myai.awg.ru;
    location ^~ /fls/ { proxy_pass http://127.0.0.1:18081/; }
    location / { proxy_pass http://127.0.0.1:8080; }
}
`

describe('angie hermes route', () => {
  it('inserts one /hermes block before the https fallback and can put the file back', () => {
    const installed = installRoute(FIXTURE)
    expect(installed.match(/location \^~ \/hermes\//g)).toHaveLength(1)
    expect(installed).toContain('proxy_pass http://127.0.0.1:3010;')
    expect(installed.indexOf('location ^~ /hermes/')).toBeLessThan(installed.lastIndexOf('location / {'))
    expect(installed).toContain('location ^~ /fls/')
    expect(removeRoute(installed)).toBe(FIXTURE)
    expect(installRoute(installed)).toBe(installed)
  })

  it('refuses reload while a snapshot is running, the window is open, or angie would cut long responses', () => {
    const noon = new Date('2026-10-13T12:00:00+03:00')
    const morning = new Date('2026-10-13T06:30:00+03:00')
    expect(inSnapshotWindow(morning)).toBe(true)
    expect(inSnapshotWindow(noon)).toBe(false)
    expect(guardFailure({ now: noon, shutdownSeconds: null, runningCount: 0 })).toBe(null)
    expect(guardFailure({ now: noon, shutdownSeconds: null, runningCount: 2 })).toBe(
      'snapshot-running',
    )
    expect(guardFailure({ now: morning, shutdownSeconds: null, runningCount: 0 })).toBe(
      'snapshot-window',
    )
    expect(guardFailure({ now: noon, shutdownSeconds: 30, runningCount: 0 })).toBe(
      'shutdown-timeout',
    )
    expect(guardFailure({ now: noon, shutdownSeconds: null, runningCount: null })).toBe(
      'snapshot-guard-unconfigured',
    )
    expect(shutdownTimeoutSeconds('worker_shutdown_timeout 30s;')).toBe(null)
    expect(shutdownTimeoutSeconds('worker_shutdown_timeout 30;')).toBe(30)
    expect(shutdownAllowsLongRequests(null)).toBe(true)
    expect(shutdownAllowsLongRequests(0)).toBe(true)
    expect(shutdownAllowsLongRequests(30)).toBe(false)
    expect(runningCountFromEnv({ EIPP_GUARD_MODE: 'graceful-reload' })).toBe(0)
    expect(runningCountFromEnv({ EIPP_GUARD_FIXTURE: 'running', EIPP_GUARD_MODE: 'graceful-reload' })).toBe(1)
  })

  it('install then remove through the cli restores the config without reloading angie', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-angie-'))
    const config = join(dir, 'myai.awg.ru.conf')
    writeFileSync(config, FIXTURE)
    const script = fileURLToPath(new URL('./angie-route.mjs', import.meta.url))
    const env = {
      ...process.env,
      ANGIE_SKIP_RELOAD: '1',
      EIPP_GUARD_FIXTURE: 'idle',
      EIPP_GUARD_NOW: '2026-10-13T12:00:00+03:00',
    }
    const installed = spawnSync(process.execPath, [script, 'install', '--config', config], { env })
    expect(installed.status).toBe(0)
    expect(readFileSync(config, 'utf8')).toContain('location ^~ /hermes/')
    const removed = spawnSync(process.execPath, [script, 'remove', '--config', config], { env })
    expect(removed.status).toBe(0)
    expect(readFileSync(config, 'utf8')).toBe(FIXTURE)
    rmSync(dir, { recursive: true, force: true })
  })
})
