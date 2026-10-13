import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROUTE_START = '# awg-hermes-workspace route start'
export const ROUTE_END = '# awg-hermes-workspace route end'
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/

export function routeBlock(indent) {
  const pad = indent || '    '
  const lines = [
    `${pad}${ROUTE_START}`,
    `${pad}location = /hermes { return 308 /hermes/; }`,
    `${pad}location ^~ /hermes/ {`,
    `${pad}    proxy_pass http://127.0.0.1:3010;`,
    `${pad}    proxy_http_version 1.1;`,
    `${pad}    proxy_set_header Upgrade $http_upgrade;`,
    `${pad}    proxy_set_header Connection "upgrade";`,
    `${pad}    proxy_set_header Host $host;`,
    `${pad}    proxy_set_header X-Real-IP $remote_addr;`,
    `${pad}    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `${pad}    proxy_set_header X-Forwarded-Proto https;`,
    `${pad}    proxy_read_timeout 3600s;`,
    `${pad}    proxy_send_timeout 3600s;`,
    `${pad}}`,
    `${pad}${ROUTE_END}`,
    '',
  ]
  return lines.join('\n')
}

function blockPattern() {
  return new RegExp(
    `^[ \\t]*${ROUTE_START}\\n[\\s\\S]*?^[ \\t]*${ROUTE_END}\\n?`,
    'm',
  )
}

export function removeRoute(text) {
  return text.replace(blockPattern(), '')
}

function serverBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  let start = null
  let depth = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (start === null && /^[ \t]*server[ \t]*\{/.test(lines[index])) {
      start = index
      depth = 0
    }
    if (start !== null) {
      depth += (lines[index].match(/\{/g) || []).length
      depth -= (lines[index].match(/\}/g) || []).length
      if (depth === 0) {
        blocks.push({ start, end: index, lines: lines.slice(start, index + 1) })
        start = null
      }
    }
  }
  return { lines, blocks }
}

function myaiHttpsBlock(blocks) {
  const eligible = blocks.filter((block) => {
    const body = block.lines.join('\n')
    return (
      /^[ \t]*listen[ \t]+443[ \t]+ssl\b[^;]*;/m.test(body) &&
      /^[ \t]*server_name[ \t]+[^;]*\bmyai\.awg\.ru\b[^;]*;/m.test(body)
    )
  })
  if (eligible.length !== 1) {
    throw new Error('expected exactly one MyAI HTTPS server block')
  }
  return eligible[0]
}

export function installRoute(text) {
  const stripped = removeRoute(text)
  const { lines, blocks } = serverBlocks(stripped)
  const block = myaiHttpsBlock(blocks)
  const fallbacks = block.lines
    .map((line, index) => ({ line, index }))
    .filter((item) => /^[ \t]*location[ \t]+\/[ \t]*\{/.test(item.line))
  if (fallbacks.length !== 1) {
    throw new Error('expected exactly one MyAI HTTPS fallback location')
  }
  const indent = (/^[ \t]*/.exec(fallbacks[0].line) || [''])[0]
  const insertion = routeBlock(indent).replace(/\n$/, '')
  const nextLines = lines.slice()
  nextLines.splice(block.start + fallbacks[0].index, 0, insertion)
  return `${nextLines.join('\n')}${text.endsWith('\n') ? '' : ''}`
}

export function shutdownTimeoutSeconds(text) {
  const match = text.match(/^\s*worker_shutdown_timeout\s+(\d+)\s*;/m)
  if (!match) return null
  return Number(match[1])
}

export function shutdownAllowsLongRequests(seconds) {
  if (seconds == null) return true
  if (seconds === 0) return true
  return seconds >= 120
}

export function moscowHour(date) {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(date)
  return Number(hour)
}

export function inSnapshotWindow(date) {
  const hour = moscowHour(date)
  return hour >= 5 && hour <= 7
}

export function guardFailure(options) {
  const now = options.now || new Date()
  if (inSnapshotWindow(now)) return 'snapshot-window'
  if (!shutdownAllowsLongRequests(options.shutdownSeconds)) return 'shutdown-timeout'
  if (options.runningCount == null) return 'snapshot-guard-unconfigured'
  if (options.runningCount > 0) return 'snapshot-running'
  return null
}

export function runningCountFromEnv(env) {
  if (env.EIPP_GUARD_FIXTURE === 'idle') return 0
  if (env.EIPP_GUARD_FIXTURE === 'running') return 1
  if (env.EIPP_GUARD_MODE === 'graceful-reload') return 0
  const container = env.EIPP_PG_CONTAINER || ''
  const user = env.EIPP_PG_USER || ''
  const database = env.EIPP_PG_DATABASE || ''
  if (!container && !user && !database) return null
  if (![container, user, database].every((value) => SAFE_NAME.test(value))) {
    throw new Error('unsafe eipp database coordinates')
  }
  const query = [
    'SELECT (SELECT count(*) FROM jobs WHERE status = \'running\')',
    '+ (SELECT count(*) FROM code_repositories WHERE last_status = \'running\');',
  ].join(' ')
  const result = spawnSync(
    'docker',
    ['exec', container, 'psql', '-U', user, '-d', database, '-tA', '-c', query],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error('eipp snapshot query failed')
  }
  const count = Number(String(result.stdout).trim())
  if (!Number.isInteger(count)) throw new Error('eipp snapshot query returned junk')
  return count
}

function guardOptions(env, mainConfigText) {
  return {
    now: env.EIPP_GUARD_NOW ? new Date(env.EIPP_GUARD_NOW) : new Date(),
    shutdownSeconds: shutdownTimeoutSeconds(mainConfigText || ''),
    runningCount: runningCountFromEnv(env),
  }
}

function writeConfig(path, next, original) {
  const backup = resolve(dirname(path), 'myai.awg.ru.conf.before-hermes-workspace')
  if (!existsSync(backup)) {
    mkdirSync(dirname(backup), { recursive: true })
    copyFileSync(path, backup)
  }
  writeFileSync(path, next)
  return backup
}

function reload(env) {
  if (env.ANGIE_SKIP_RELOAD === '1') return
  const bin = env.ANGIE_BIN || '/usr/sbin/angie'
  const test = spawnSync(bin, ['-t'], { encoding: 'utf8' })
  if (test.status !== 0) throw new Error('angie -t failed')
  const reloadResult = spawnSync('systemctl', ['reload', 'angie'], { encoding: 'utf8' })
  if (reloadResult.status !== 0) throw new Error('angie reload failed')
}

function commandMain(argv, env) {
  const action = argv[2]
  const configFlag = argv.indexOf('--config')
  const configPath = configFlag === -1 ? '' : argv[configFlag + 1]
  const mainFlag = argv.indexOf('--main-config')
  const mainPath = mainFlag === -1 ? '' : argv[mainFlag + 1]
  if (!configPath) throw new Error('missing --config')
  const original = readFileSync(configPath, 'utf8')
  const mainText = mainPath ? readFileSync(mainPath, 'utf8') : ''
  if (action === 'install' || action === 'remove') {
    const failure = guardFailure(guardOptions(env, mainText))
    if (failure) {
      process.stderr.write(`${failure}\n`)
      process.exitCode = 2
      return
    }
  }
  const next = action === 'install' ? installRoute(original) : removeRoute(original)
  if (action !== 'install' && action !== 'remove') throw new Error('unknown action')
  const backup = writeConfig(configPath, next, original)
  try {
    reload(env)
  } catch (error) {
    writeFileSync(configPath, original)
    try {
      reload(env)
    } catch {
      process.stderr.write(`restore reload failed; backup=${backup}\n`)
    }
    throw error
  }
  process.stdout.write(`${action} ok\n`)
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  try {
    commandMain(process.argv, process.env)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'route failed'}\n`)
    process.exitCode = 1
  }
}
