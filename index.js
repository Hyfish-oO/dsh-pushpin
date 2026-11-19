/**
 * Host half of the pushpin plugin.
 *
 * DSH exposes no Electron BrowserWindow to a plugin, so nothing in the Host
 * can call `setAlwaysOnTop`. Every backend here asks the operating system
 * directly through whatever that platform actually offers:
 *
 * - Windows: a warm PowerShell server driving `SetWindowPos(HWND_TOPMOST)`.
 * - Linux (X11): `wmctrl` for the change and `xprop` for the read-back.
 * - macOS: `yabai`, because the system ships no CLI for window level.
 *
 * A backend that cannot run reports why, and the client hides the button.
 * State is always read back from the window manager, never assumed.
 */

import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_PATH = '/dsh-pin/api/state'
const TOGGLE_PATH = '/dsh-pin/api/toggle'
const WINDOWS_SCRIPT = fileURLToPath(new URL('./scripts/pin-server.ps1', import.meta.url))
const LINUX_SCRIPT = fileURLToPath(new URL('./scripts/pin-linux.sh', import.meta.url))
const MACOS_SCRIPT = fileURLToPath(new URL('./scripts/pin-macos.sh', import.meta.url))

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
const SCRIPT_TIMEOUT_MS = 5000
const RESTORE_DELAY_MS = 2500

const FAILURE = {
  unsupportedPlatform: {
    code: 'unsupported-platform',
    text: '这个系统上没有可用的置顶接口',
  },
  missingTool: {
    code: 'missing-tool',
    text: '缺少系统工具，装好之后重启 DSH 就能用',
  },
  noWindow: {
    code: 'no-window',
    text: '没找到 DeepSeek Harness 的窗口',
  },
  serverFailed: {
    code: 'server-failed',
    text: '系统接口调用失败了',
  },
  timeout: {
    code: 'timeout',
    text: '系统接口没有响应',
  },
  badOutput: {
    code: 'bad-output',
    text: '系统接口返回了看不懂的内容',
  },
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

function parseJsonLine(line) {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
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
    idleTimeoutMs: Number.isFinite(idle) && idle >= 0 ? idle : DEFAULT_CONFIG.idleTimeoutMs,
    restoreOnStart:
      typeof stored.restoreOnStart === 'boolean' ? stored.restoreOnStart : DEFAULT_CONFIG.restoreOnStart,
  }
}

//#endregion

/** Run one short-lived script and parse its single JSON line. */
function runScript(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 },
      (error, stdout) => {
        const line = String(stdout ?? '')
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter((value) => value.startsWith('{'))
          .pop()
        if (!line) {
          resolve({ ok: false, error: error ? 'server-failed' : 'bad-output' })
          return
        }
        const parsed = parseJsonLine(line)
        resolve(parsed ?? { ok: false, error: 'bad-output' })
      },
    )
  })
}

//#region Windows backend: one warm powershell.exe

function createWindowsBackend() {
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
      job.resolve(parseJsonLine(line) ?? { ok: false, error: 'bad-output' })
    }
    pump()
  }

  function start() {
    if (state.child || state.closed) return
    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_SCRIPT],
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

  return {
    id: 'windows',
    available: true,
    ask,
    stop() {
      state.queue.length = 0
      failInFlight('idle')
      stopChild()
    },
    close() {
      state.closed = true
      this.stop()
    },
  }
}

//#endregion

//#region script backends: Linux and macOS

function createScriptBackend(id, script) {
  return {
    id,
    available: true,
    ask(action) {
      return runScript('bash', [script, action], SCRIPT_TIMEOUT_MS)
    },
    stop() {},
    close() {},
  }
}

/** A backend that stays silent: the profile cannot do the job here. */
function createMissingBackend(id) {
  return {
    id,
    available: false,
    ask() {
      return Promise.resolve({ ok: false, error: 'missing-tool' })
    },
    stop() {},
    close() {},
  }
}

//#endregion

function createBackend(platform) {
  if (platform === 'win32') return createWindowsBackend()
  if (platform === 'linux') return createScriptBackend('linux', LINUX_SCRIPT)
  if (platform === 'darwin') return createScriptBackend('macos', MACOS_SCRIPT)
  return createMissingBackend(platform)
}

export const inject = ['webServer']

export function apply(ctx) {
  const backend = createBackend(process.platform)
  const server = backend

  let config = { ...DEFAULT_CONFIG }
  let idleTimer = null

  const touchIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (!backend.available || config.idleTimeoutMs <= 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      backend.stop()
    }, config.idleTimeoutMs)
    if (idleTimer.unref) idleTimer.unref()
  }

  const rememberState = (topmost) => {
    writeJson(STATE_FILE, { pinned: topmost === true, at: Date.now() })
  }

  const ask = async (action) => {
    const reply = await backend.ask(action)
    touchIdle()
    if (reply && reply.ok === true) rememberState(reply.topmost)
    return reply
  }

  const toFailure = (reply) => {
    const code = reply && reply.error
    if (code === 'missing-tool') return FAILURE.missingTool
    if (code === 'no-window') return FAILURE.noWindow
    if (code === 'timeout') return FAILURE.timeout
    if (code === 'bad-output') return FAILURE.badOutput
    return FAILURE.serverFailed
  }

  const fail = (failure, detail) => ({
    ok: false,
    error: failure.code,
    message: failure.text,
    ...(typeof detail === 'string' ? { detail } : {}),
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

    const reply = await ask('get')
    if (reply && reply.ok === true) {
      sendJson(response, 200, {
        ok: true,
        supported: true,
        platform: process.platform,
        backend: backend.id,
        topmost: reply.topmost === true,
        readAt: Date.now(),
      })
      return
    }
    sendJson(response, 200, {
      ...fail(toFailure(reply), reply && reply.error),
      supported: backend.available,
      platform: process.platform,
      backend: backend.id,
    })
  }

  const toggleHandler = async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!guard(request, response)) return

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
      })
      return
    }
    sendJson(response, 200, { ...fail(toFailure(reply), reply && reply.error), supported: backend.available })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: STATE_PATH, handler: stateHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: TOGGLE_PATH, handler: toggleHandler }))
  ctx.effect(() => () => {
    if (idleTimer) clearTimeout(idleTimer)
    backend.close()
  })

  void (async () => {
    config = await loadConfig()
    if (!config.restoreOnStart || !backend.available) return
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
