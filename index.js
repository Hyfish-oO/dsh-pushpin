/**
 * Host half of the pin-window plugin.
 *
 * DSH exposes no Electron BrowserWindow to a plugin, so nothing in the Host
 * can call `setAlwaysOnTop`. What a plugin can do is ask Windows directly:
 * `SetWindowPos(HWND_TOPMOST)` on the Harness main window.
 *
 * Spawning PowerShell per press costs most of a second, so this keeps one warm
 * server process and speaks to it one line at a time. The process is not held
 * forever: it is started on demand and released after `idleTimeoutMs` of no
 * use, so an installed-but-unused plugin costs nothing.
 *
 * Settings and the last known pin state live in two small JSON files under the
 * DSH home directory. Both are best-effort: a read or write failure degrades to
 * defaults instead of failing the request.
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_PATH = '/dsh-pin/api/state'
const TOGGLE_PATH = '/dsh-pin/api/toggle'
const SERVER_SCRIPT = fileURLToPath(new URL('./scripts/pin-server.ps1', import.meta.url))

const HOME_DIRECTORY = join(homedir(), '.dsh')
const CONFIG_FILE = join(HOME_DIRECTORY, 'dsh-pin-window.json')
const STATE_FILE = join(HOME_DIRECTORY, 'dsh-pin-window.state.json')

const DEFAULT_CONFIG = {
  /** Release the warm PowerShell process after this much idle time; 0 keeps it. */
  idleTimeoutMs: 120000,
  /** Re-apply the last pin state when DSH starts. */
  restoreOnStart: true,
}

const REPLY_TIMEOUT_MS = 6000
const RESTORE_DELAY_MS = 2500

/** Codes the Client can turn into a sentence the user understands. */
const FAILURE = {
  ok: { text: 'ok' },
  unsupportedPlatform: { code: 'unsupported-platform', text: '窗口置顶目前只支持 Windows' },
  noWindow: { code: 'no-window', text: '没找到 DeepSeek Harness 的窗口' },
  serverFailed: { code: 'server-failed', text: 'PowerShell 启动失败，可能被系统策略或安全软件拦住了' },
  timeout: { code: 'timeout', text: 'PowerShell 没有响应，已经把它重启了' },
  badOutput: { code: 'bad-output', text: 'PowerShell 返回了看不懂的内容' },
}

function refusedOrigin(request, allowed) {
  const origin = request.headers?.origin
  if (!origin || origin === 'null') return false
  if (!allowed) return false
  return origin !== allowed
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function parseLine(line) {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' ? value : { ok: false, error: 'bad-output' }
  } catch {
    return { ok: false, error: 'bad-output' }
  }
}

//#region small json files

async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, 'utf8')
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  try {
    await mkdir(dirname(file), { recursive: true })
    const temporary = file + '.' + process.pid + '.tmp'
    await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
    await rename(temporary, file)
  } catch {
    /* a read-only home directory just means settings are not persisted */
  }
}

async function loadConfig() {
  const stored = await readJson(CONFIG_FILE, {})
  const idle = Number(stored.idleTimeoutMs)
  return {
    idleTimeoutMs:
      Number.isFinite(idle) && idle >= 0 ? idle : DEFAULT_CONFIG.idleTimeoutMs,
    restoreOnStart:
      typeof stored.restoreOnStart === 'boolean' ? stored.restoreOnStart : DEFAULT_CONFIG.restoreOnStart,
  }
}

//#endregion

/**
 * One warm powershell.exe, one request in flight at a time. Anything that goes
 * wrong tears the process down so the next press starts a clean one instead of
 * feeding a wedged pipe.
 */
function createPinServer() {
  const state = {
    child: null,
    ready: false,
    buffer: '',
    queue: [],
    inFlight: null,
    closed: false,
  }

  function stopChild() {
    const child = state.child
    state.child = null
    state.ready = false
    state.buffer = ''
    if (child) {
      try {
        child.stdin.write('quit\n')
        child.stdin.end()
      } catch {
        /* already gone */
      }
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  }

  function failInFlight(error) {
    const job = state.inFlight
    state.inFlight = null
    if (job) {
      clearTimeout(job.timer)
      job.resolve({ ok: false, error })
    }
  }

  function pump() {
    if (!state.ready || state.inFlight !== null || !state.child) return
    const job = state.queue.shift()
    if (!job) return
    state.inFlight = job
    try {
      state.child.stdin.write(job.action + '\n')
    } catch {
      state.inFlight = null
      job.resolve({ ok: false, error: 'server-failed' })
      stopChild()
    }
  }

  function handleLine(line) {
    if (line.indexOf('"ready"') !== -1) {
      state.ready = true
      pump()
      return
    }
    const job = state.inFlight
    state.inFlight = null
    if (job) {
      clearTimeout(job.timer)
      job.resolve(parseLine(line))
    }
    pump()
  }

  function start() {
    if (state.child || state.closed) return
    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SERVER_SCRIPT],
        { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
      )
    } catch {
      state.child = null
      return
    }

    state.child = child
    state.ready = false
    state.buffer = ''

    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        state.buffer += chunk
        let index
        while ((index = state.buffer.indexOf('\n')) >= 0) {
          const line = state.buffer.slice(0, index).trim()
          state.buffer = state.buffer.slice(index + 1)
          if (line !== '') handleLine(line)
        }
      })
    }

    child.on('error', () => {
      if (state.child === child) {
        state.child = null
        state.ready = false
        failInFlight('server-failed')
      }
    })

    child.on('exit', () => {
      if (state.child === child) {
        state.child = null
        state.ready = false
        failInFlight('server-failed')
      }
    })
  }

  function ask(action) {
    return new Promise((resolve) => {
      if (state.closed) {
        resolve({ ok: false, error: 'closed' })
        return
      }
      start()
      if (!state.child) {
        resolve({ ok: false, error: 'server-failed' })
        return
      }
      const job = { action, resolve }
      job.timer = setTimeout(() => {
        if (state.inFlight === job) {
          state.inFlight = null
          stopChild()
        }
        resolve({ ok: false, error: 'timeout' })
        pump()
      }, REPLY_TIMEOUT_MS)
      if (job.timer.unref) job.timer.unref()
      state.queue.push(job)
      pump()
    })
  }

  function stop() {
    state.queue.length = 0
    failInFlight('idle')
    stopChild()
  }

  function close() {
    state.closed = true
    stop()
  }

  return { ask, stop, close }
}

export const inject = ['webServer']

export function apply(ctx) {
  const supported = process.platform === 'win32'
  const server = createPinServer()

  let config = { ...DEFAULT_CONFIG }
  let idleTimer = null

  const touchIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (!supported || config.idleTimeoutMs <= 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      server.stop()
    }, config.idleTimeoutMs)
    if (idleTimer.unref) idleTimer.unref()
  }

  const rememberState = (topmost) => {
    writeJson(STATE_FILE, { pinned: topmost === true, at: Date.now() })
  }

  const ask = async (action) => {
    const reply = await server.ask(action)
    touchIdle()
    if (reply && reply.ok === true) rememberState(reply.topmost)
    return reply
  }

  const fail = (failure, extra) => ({
    ok: false,
    error: failure.code,
    message: failure.text,
    ...(extra === undefined ? {} : { detail: extra }),
  })

  const guard = (request, response) => {
    if (refusedOrigin(request, ctx.get('webServer')?.getOrigin?.())) {
      sendJson(response, 403, { ok: false, error: 'untrusted-origin', message: '请求来源不受信任' })
      return false
    }
    return true
  }

  const stateHandler = async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }
    if (!guard(request, response)) return

    if (!supported) {
      sendJson(response, 200, { ...fail(FAILURE.unsupportedPlatform), supported: false, platform: process.platform })
      return
    }

    const reply = await ask('get')
    if (reply && reply.ok === true) {
      sendJson(response, 200, {
        ok: true,
        supported: true,
        platform: process.platform,
        topmost: reply.topmost === true,
        hwnd: reply.hwnd,
        pid: reply.pid,
        readAt: Date.now(),
      })
      return
    }
    const failure =
      reply && reply.error === 'no-window' ? FAILURE.noWindow : reply && reply.error === 'timeout' ? FAILURE.timeout : FAILURE.serverFailed
    sendJson(response, 200, { ...fail(failure, reply && reply.error), supported: true, platform: process.platform })
  }

  const toggleHandler = async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!guard(request, response)) return

    if (!supported) {
      sendJson(response, 200, { ...fail(FAILURE.unsupportedPlatform), supported: false, platform: process.platform })
      return
    }

    let action = 'toggle'
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text !== '') {
        const parsed = JSON.parse(text)
        if (parsed && (parsed.action === 'on' || parsed.action === 'off' || parsed.action === 'toggle')) {
          action = parsed.action
        }
      }
    } catch {
      /* an unreadable body just means "toggle" */
    }

    const reply = await ask(action)
    if (reply && reply.ok === true) {
      sendJson(response, 200, {
        ok: true,
        supported: true,
        topmost: reply.topmost === true,
        hwnd: reply.hwnd,
      })
      return
    }
    const failure =
      reply && reply.error === 'no-window'
        ? FAILURE.noWindow
        : reply && reply.error === 'timeout'
          ? FAILURE.timeout
          : reply && reply.error === 'bad-output'
            ? FAILURE.badOutput
            : FAILURE.serverFailed
    sendJson(response, 200, { ...fail(failure, reply && reply.error), supported: true })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: STATE_PATH, handler: stateHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: TOGGLE_PATH, handler: toggleHandler }))
  ctx.effect(() => () => {
    if (idleTimer) clearTimeout(idleTimer)
    server.close()
  })

  if (!supported) return

  // Restore the last pin state once the window exists. Two attempts: at plugin
  // load the BrowserWindow may not be up yet, and a miss is silent.
  void (async () => {
    config = await loadConfig()
    if (!config.restoreOnStart) return
    const stored = await readJson(STATE_FILE, {})
    if (stored.pinned !== true) return
    const attempt = async (remaining) => {
      const reply = await server.ask('on')
      touchIdle()
      if (reply && reply.ok === true) return
      if (reply && reply.error === 'no-window' && remaining > 0) {
        setTimeout(() => void attempt(remaining - 1), RESTORE_DELAY_MS)
      }
    }
    setTimeout(() => void attempt(2), RESTORE_DELAY_MS)
  })()
}
