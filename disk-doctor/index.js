/**
 * Disk Doctor — Host half.
 *
 * Samples macOS disk usage with read-only local commands on a timer (no model
 * involved), serves the snapshot over the authenticated Connection Fetch
 * channel, and starts one real Agent Session on demand to produce cleanup
 * suggestions. Nothing here ever deletes a file.
 *
 * Lifecycle: every timer, listener, command and route is owned by this plugin's
 * Cordis fiber. `ctx.effect` disposers clear timers and abort in-flight
 * children on unload; `ctx.connection.fetch.register` and `ctx.on` are scoped to
 * the same fiber, so unload needs no manual bookkeeping in the page.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { collectSnapshot, describeError, normalizeConfig } from './lib/collector.js'
import { capText } from './lib/parse.js'
import { buildInspectPrompt } from './lib/prompt.js'
import { applySessionEvent, buildView, cloneAiState, createState, recordSample, restoreAiState } from './lib/view.js'

/**
 * The Connection service is required: the page reaches the Host only through
 * the authenticated Fetch channel.
 */
export const inject = ['connection']

/** GET: current view JSON. */
const ROUTE_SNAPSHOT = '/api/disk-doctor.snapshot'
/** POST: collect now (scripted), then return the view JSON. */
const ROUTE_COLLECT = '/api/disk-doctor.collect'
/** POST: start one LLM inspection Session. */
const ROUTE_INSPECT = '/api/disk-doctor.inspect'

/** Hard cap for one command invocation (df/diskutil print a single screen). */
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024
/** Timeout for create()+prompt() of the inspection Session. */
const PROMPT_TIMEOUT_MS = 15000
/** Cache header required for every Fetch route response. */
const NO_STORE_HEADERS = Object.freeze({ 'cache-control': 'no-store' })
/** Error text stored in the view is capped so one runaway message cannot bloat it. */
const ERROR_TEXT_LIMIT = 500

/**
 * Build a JSON Response with the no-store header the design requires.
 * @param {unknown} body JSON-safe body
 * @returns {Response} HTTP 200 JSON response
 */
function jsonResponse(body) {
  try {
    if (typeof Response.json === 'function') return Response.json(body, { headers: { ...NO_STORE_HEADERS } })
  } catch {
    // Fall through to the constructor form (older Response implementations).
  }
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE_HEADERS },
  })
}

/**
 * Build the JSON body every route returns on a contained failure. HTTP status
 * stays 200: the page renders the `{ok:false,error}` shape itself.
 * @param {string} code stable error code
 * @param {string} message human diagnostic
 * @returns {Response} HTTP 200 JSON error response
 */
function errorResponse(code, message) {
  return jsonResponse({ ok: false, error: { code, message: capText(message, ERROR_TEXT_LIMIT) } })
}

/**
 * POST routes accept an empty body or one JSON value. Malformed bodies answer
 * the contracted `{ok:false,error}` JSON (HTTP 200) instead of throwing, as
 * DESIGN.md requires for the Connection Fetch channel.
 * @param {Request} request authenticated owner request
 * @returns {Promise<{ok:true}|{ok:false,response:Response}>} whether the body is acceptable
 */
async function acceptOptionalJsonBody(request) {
  try {
    const text = request !== null && typeof request === 'object' && typeof request.text === 'function' ? await request.text() : ''
    if (text.trim() === '') return { ok: true }
    JSON.parse(text)
    return { ok: true }
  } catch {
    return { ok: false, response: errorResponse('bad-request', '请求体不是合法 JSON。') }
  }
}

/**
 * Read the optional `sessionController` service without throwing when the
 * deployment does not mount it.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @returns {{create:Function,prompt:Function}|undefined} usable controller or undefined
 */
function resolveSessionController(ctx) {
  const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
  if (controller === null || controller === undefined) return undefined
  if (typeof controller.create !== 'function' || typeof controller.prompt !== 'function') return undefined
  return controller
}

/**
 * Wrap the Host logger so a logging failure can never break collection.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @returns {{info:Function,warn:Function,error:Function}} safe logger
 */
function createLogger(ctx) {
  const logger = ctx !== null && typeof ctx === 'object' ? ctx.logger : undefined
  const write = (level, message) => {
    try {
      if (logger !== undefined && logger !== null && typeof logger[level] === 'function') logger[level](`disk-doctor: ${message}`)
    } catch {
      // Logging is diagnostic only; never surface it as a plugin failure.
    }
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/**
 * Host plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context (owns all registrations)
 * @param {object} config plugin config passed by the Loader (usually empty)
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const state = createState(options)
  const log = createLogger(ctx)

  // Non-serializable runtime fields, deliberately kept off `state`'s view shape.
  state.children = new Set()
  state.disposed = false
  state.inflight = null
  state.lifecycle = new AbortController()

  /**
   * Run one read-only command with a hard timeout and abort support, tracking
   * the child so plugin unload can kill it. Resolves with stdout only.
   * @param {string} file absolute executable path
   * @param {readonly string[]} args fixed argument list (never a shell string)
   * @returns {Promise<string>} stdout
   */
  const exec = (file, args) =>
    new Promise((resolve, reject) => {
      let settled = false
      /** @type {import('node:child_process').ChildProcess|undefined} */
      let child
      const finish = (error, stdout) => {
        if (settled) return
        settled = true
        if (child !== undefined) state.children.delete(child)
        if (error !== null && error !== undefined) reject(error)
        else resolve(typeof stdout === 'string' ? stdout : '')
      }
      try {
        child = execFileCallback(
          file,
          [...args],
          {
            timeout: options.diskCommandTimeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
            encoding: 'utf8',
            windowsHide: true,
            signal: state.lifecycle.signal,
            env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
          },
          (error, stdout) => finish(error, stdout),
        )
      } catch (error) {
        finish(error, '')
        return
      }
      state.children.add(child)
      child.once('close', () => state.children.delete(child))
      if (state.disposed) {
        try {
          child.kill('SIGKILL')
        } catch {
          // The process may have exited between spawn and this check.
        }
      }
    })

  /**
   * Collect once (single-flight) and fold the outcome into the plugin state.
   * Never rejects; collection errors land in `collector.lastError`.
   * @returns {Promise<{ok:true,snapshot:object}|{ok:false,error:{code:string,message:string}}>} result
   */
  const collectNow = () => {
    if (state.disposed) return Promise.resolve({ ok: false, error: { code: 'disposed', message: '插件已卸载。' } })
    if (state.inflight !== null) return state.inflight

    const startedAt = Date.now()
    state.collector.lastStartedAt = startedAt

    const task = (async () => {
      let result
      try {
        result = await collectSnapshot({ exec })
      } catch (error) {
        result = { ok: false, error: { code: 'collect-failed', message: describeError(error) } }
      }
      try {
        // A disposed plugin no longer owns its state; skip the write so a late
        // command callback cannot resurrect a stale snapshot.
        if (state.disposed) return result
        const finishedAt = Date.now()
        state.collector.lastFinishedAt = finishedAt
        state.collector.lastDurationMs = Math.max(0, finishedAt - startedAt)
        if (result.ok === true && result.snapshot !== null && result.snapshot !== undefined) {
          recordSample(state, result.snapshot)
          state.collector.lastError = null
        } else {
          state.collector.lastError = result.error !== undefined && result.error !== null ? result.error.message : '磁盘采集失败。'
          log.warn(`collection failed: ${state.collector.lastError}`)
        }
      } catch (error) {
        log.error(`failed to update collector state: ${describeError(error)}`)
      }
      return result
    })()

    state.inflight = task
    const clearInflight = () => {
      if (state.inflight === task) state.inflight = null
    }
    task.then(clearInflight, clearInflight)
    return task
  }

  /**
   * Run one scheduled sample and contain every possible failure.
   * @param {string} reason diagnostic label only
   * @returns {void}
   */
  const sample = (reason) => {
    try {
      collectNow().catch((error) => log.warn(`${reason} sample failed: ${describeError(error)}`))
    } catch (error) {
      log.warn(`${reason} sample threw synchronously: ${describeError(error)}`)
    }
  }

  /**
   * Start one inspection Session and return the page-facing result.
   * All failures are converted to `{ok:false,error}` with HTTP 200.
   * @returns {Promise<Response>} route response
   */
  const handleInspect = async () => {
    const ai = state.ai

    // Busy guard: exactly one inspection may run at a time. `running` is set
    // synchronously below, before the first await, so two concurrent POSTs
    // cannot both pass this check.
    if (ai.status === 'running') return errorResponse('busy', '已有一次 AI 巡检正在进行，请稍候。')

    const sessionController = resolveSessionController(ctx)
    if (sessionController === undefined) {
      return errorResponse('unavailable', '当前部署未提供会话服务（sessionController），AI 巡检不可用。')
    }

    const previous = cloneAiState(ai)
    ai.status = 'running'
    ai.sessionId = null
    ai.startedAt = Date.now()
    ai.finishedAt = null
    ai.error = null
    ai.report = null

    // The prompt should carry real numbers; if the very first sample has not
    // landed yet (page opened immediately after install), sample once first.
    if (state.snapshot === null) {
      try {
        await collectNow()
      } catch {
        // A failed first sample still gets the fallback prompt branch.
      }
    }

    const promptText = buildInspectPrompt(buildView(state))
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        controller.abort()
      } catch {
        // AbortController.abort() never throws in practice.
      }
    }, PROMPT_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()

    try {
      const created = await sessionController.create({})
      const sessionId = created !== null && typeof created === 'object' ? created.sessionId : undefined
      if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionController.create() 未返回 sessionId')

      // Register the tracking target before prompting: turn events can only
      // follow the prompt, but registering first removes any race window.
      ai.sessionId = sessionId
      await sessionController.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: promptText }],
        },
        controller.signal,
      )
      log.info(`inspection session started: ${sessionId}`)
      return jsonResponse({ ok: true, sessionId })
    } catch (error) {
      restoreAiState(ai, previous)
      if (timedOut) return errorResponse('start-failed', `启动 AI 巡检超时（${PROMPT_TIMEOUT_MS / 1000} 秒）。`)
      return errorResponse('start-failed', `启动 AI 巡检失败：${describeError(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: abort in-flight commands and children on unload. Registered
  // before the timer so disposers run in reverse order (timer cleared first).
  // ---------------------------------------------------------------------------
  ctx.effect(
    () => () => {
      state.disposed = true
      try {
        state.lifecycle.abort()
      } catch {
        // Nothing to recover: the controller is ours.
      }
      for (const child of state.children) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already exited.
        }
      }
      state.children.clear()
    },
    'disk-doctor: collection lifetime',
  )

  // ---------------------------------------------------------------------------
  // Scripted periodic collection: immediately after activation, then on the
  // configured interval. No model is involved here.
  // ---------------------------------------------------------------------------
  ctx.effect(() => {
    const timer = setInterval(() => sample('interval'), options.sampleIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    sample('startup')
    return () => {
      clearInterval(timer)
    }
  }, 'disk-doctor: sampling timer')

  // ---------------------------------------------------------------------------
  // Fetch routes. The Connection service owns authentication; handlers only
  // ever return JSON and contain their own failures.
  // ---------------------------------------------------------------------------
  ctx.connection.fetch.register({
    path: ROUTE_SNAPSHOT,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return jsonResponse(buildView(state))
      } catch (error) {
        return errorResponse('internal', describeError(error))
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTE_COLLECT,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const accepted = await acceptOptionalJsonBody(request)
        if (accepted.ok !== true) return accepted.response
        const result = await collectNow()
        if (result.ok !== true) {
          return errorResponse('collect-failed', result.error !== undefined && result.error !== null ? result.error.message : '磁盘采集失败。')
        }
        return jsonResponse(buildView(state))
      } catch (error) {
        return errorResponse('collect-failed', describeError(error))
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTE_INSPECT,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const accepted = await acceptOptionalJsonBody(request)
        if (accepted.ok !== true) return accepted.response
        return await handleInspect()
      } catch (error) {
        return errorResponse('internal', describeError(error))
      }
    },
  })

  // ---------------------------------------------------------------------------
  // LLM output capture: the Session events of the inspection Session are folded
  // into the view's `ai` fields. Scoped to this plugin fiber by `ctx.on`.
  // ---------------------------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session !== null && typeof session === 'object' ? session.id : undefined
      applySessionEvent(state.ai, sessionId, event)
    } catch (error) {
      log.warn(`session event handling failed: ${describeError(error)}`)
    }
  })
}
