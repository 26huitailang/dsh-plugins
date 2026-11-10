/**
 * Disk Doctor — snapshot derivation and the exact view JSON served to the page.
 *
 * `deriveSnapshot` turns raw `df`/`diskutil` rows into the user-facing numbers.
 * `createState` / `recordSample` / `buildView` own the small amount of mutable
 * state the Host keeps between requests. No node built-ins: the page contract
 * is a plain JSON value and stays unit-testable.
 */

import { capText, extractAssistantText } from './parse.js'

/** History is capped at 288 samples: 24 h at the default 5 min interval. */
export const HISTORY_LIMIT = 288

/** Report text is capped at 20000 characters by the page contract. */
export const REPORT_TEXT_LIMIT = 20000

/** Error strings stored in the view are capped to keep the JSON small. */
const ERROR_TEXT_LIMIT = 500

/** Default interval, mirrored from `lib/collector.js` for state defaults. */
const DEFAULT_SAMPLE_INTERVAL_MS = 300000
/** Default command timeout, mirrored from `lib/collector.js` for state defaults. */
const DEFAULT_COMMAND_TIMEOUT_MS = 15000

const AI_STATUSES = new Set(['idle', 'running', 'done', 'error'])
/** Decimal GB, matching Finder / About This Mac / df -H / diskutil. */
const GB = 1e9

/**
 * @typedef {import('./parse.js').DfRow} DfRow
 * @typedef {import('./parse.js').DiskutilInfo} DiskutilInfo
 */

/**
 * @typedef {object} Snapshot
 * @property {number} at
 * @property {string} mount
 * @property {string|null} volumeName
 * @property {string|null} fileSystem
 * @property {number} totalBytes
 * @property {number} usedBytes
 * @property {number} freeBytes
 * @property {number} percentUsed
 * @property {number} freePercent
 * @property {number|null} finderAvailableBytes Finder/system "available" (includes purgeable)
 * @property {number|null} purgeableBytes finderAvailableBytes - freeBytes, clamped >= 0
 */

/**
 * Clamp one percentage into 0..100 without doing any rounding.
 * @param {number} value candidate percentage
 * @returns {number} clamped finite value
 */
function clampPercent(value) {
  if (Number.isFinite(value) === false) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

/**
 * Round to one decimal, keeping the result a finite JSON-safe number.
 * @param {number} value candidate number
 * @returns {number} one-decimal value
 */
function round1(value) {
  const rounded = Math.round(value * 10) / 10
  return Number.isFinite(rounded) ? rounded : 0
}

/**
 * Return the value when it is a finite number, otherwise null.
 * @param {unknown} value candidate
 * @returns {number|null} finite number or null
 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Validate one parsed df row. Guarded because `df` output varies across
 * filesystems and every consumer downstream assumes these invariants.
 * @param {unknown} row candidate row
 * @returns {boolean} whether the row carries usable non-negative integers
 */
function isDfRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
  if (Number.isSafeInteger(row.blocks) === false || row.blocks <= 0) return false
  if (Number.isSafeInteger(row.used) === false || row.used < 0) return false
  if (Number.isSafeInteger(row.available) === false || row.available < 0) return false
  return true
}

/**
 * Derive the user-facing snapshot from the two df rows plus best-effort
 * diskutil metadata.
 *
 * APFS on macOS reports the read-only system volume for `/`, so:
 * - `totalBytes` comes from the `/` row's `1024-blocks` (the container size);
 * - free space is authoritative on the `/System/Volumes/Data` row, with the
 *   `/` row as fallback when the Data volume is absent (non-APFS / CI);
 * - `usedBytes` is derived as `total - free` so `percentUsed + freePercent`
 *   is always 100 and stays consistent with the hero gauge.
 *
 * @param {object} input derivation inputs
 * @param {number} input.at sample timestamp (epoch ms)
 * @param {DfRow} input.root parsed `df -P -k /` row (required)
 * @param {DfRow|null} [input.data] parsed `df -P -k <data volume>` row
 * @param {DiskutilInfo|null} [input.diskutil] best-effort diskutil metadata
 * @param {import('./parse.js').CapacityReading|null} [input.finder] best-effort JXA capacity probe
 * @returns {Snapshot} JSON-safe snapshot
 * @throws {Error} when the root row is missing or produces an out-of-range size
 */
export function deriveSnapshot({ at, root, data = null, diskutil = null, finder = null }) {
  if (isDfRow(root) === false) throw new Error('df root row is missing or invalid')

  const totalBytes = root.blocks * 1024
  if (Number.isSafeInteger(totalBytes) === false) throw new Error('disk size is out of safe integer range')

  // Prefer the Data volume's own Available column; fall back to the root row
  // when that volume is missing or unparsable.
  const freeRow = isDfRow(data) ? data : root
  const freeBytes = Math.max(0, freeRow.available * 1024)
  const usedBytes = Math.max(0, totalBytes - freeBytes)

  const percentUsed = round1(clampPercent(totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0))
  const freePercent = round1(clampPercent(100 - percentUsed))

  // Finder / System Settings availability comes from the JXA probe. Accept it
  // only when it is a plausible byte count (plain integer, not negative, and
  // not absurdly above the container size); otherwise both fields are null and
  // the page hides the "system available" rows.
  const importantUsage = finder !== null && typeof finder === 'object' ? finder.importantUsage : null
  const plausible =
    typeof importantUsage === 'number' &&
    Number.isFinite(importantUsage) &&
    Number.isSafeInteger(importantUsage) &&
    importantUsage >= 0 &&
    importantUsage <= totalBytes * 2
  const finderAvailableBytes = plausible ? importantUsage : null
  const purgeableBytes = finderAvailableBytes === null ? null : Math.max(0, finderAvailableBytes - freeBytes)

  return {
    at: finiteOrNull(at) ?? 0,
    mount: typeof root.mount === 'string' && root.mount !== '' ? root.mount : '/',
    volumeName: typeof diskutil?.volumeName === 'string' && diskutil.volumeName !== '' ? diskutil.volumeName : null,
    fileSystem: typeof diskutil?.fileSystem === 'string' && diskutil.fileSystem !== '' ? diskutil.fileSystem : null,
    totalBytes,
    usedBytes,
    freeBytes,
    percentUsed,
    freePercent,
    finderAvailableBytes,
    purgeableBytes,
  }
}

/**
 * Create the mutable collector/AI state one `apply()` owns.
 *
 * State lives inside `apply` rather than at module scope so a plugin reload
 * cannot leak a stale snapshot or a stale running inspection into the next
 * activation of the same ES module instance.
 *
 * @param {object} [options] normalized configuration
 * @param {number} [options.sampleIntervalMs] interval shown in the view
 * @param {number} [options.diskCommandTimeoutMs] command timeout (not exposed)
 * @returns {object} fresh plugin state (shape consumed by `buildView`)
 */
export function createState({ sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS, diskCommandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
  const interval = Number.isSafeInteger(sampleIntervalMs) && sampleIntervalMs > 0 ? sampleIntervalMs : DEFAULT_SAMPLE_INTERVAL_MS
  const timeout = Number.isSafeInteger(diskCommandTimeoutMs) && diskCommandTimeoutMs > 0 ? diskCommandTimeoutMs : DEFAULT_COMMAND_TIMEOUT_MS
  return {
    /** @type {Snapshot|null} last successful sample */
    snapshot: null,
    /** @type {{at:number,totalBytes:number,usedBytes:number,freeBytes:number,finderAvailableBytes:number|null}[]} */
    history: [],
    collector: { lastStartedAt: 0, lastFinishedAt: 0, lastDurationMs: 0, lastError: null },
    ai: { status: 'idle', sessionId: null, startedAt: null, finishedAt: null, error: null, report: null },
    config: { sampleIntervalMs: interval, historyLimit: HISTORY_LIMIT },
    diskCommandTimeoutMs: timeout,
  }
}

/**
 * Record one successful sample: becomes the current snapshot and appends the
 * compact history entry, trimming the oldest entries past the cap.
 *
 * History rows carry `finderAvailableBytes` so the page can plot the
 * System-Settings convention (used = total - finderAvailable) from the strip;
 * the value is normalized to a safe non-negative integer or null.
 * @param {object} state plugin state from `createState`
 * @param {Snapshot} snapshot derived snapshot
 * @returns {void}
 */
export function recordSample(state, snapshot) {
  if (state === null || typeof state !== 'object') return
  if (snapshot === null || typeof snapshot !== 'object') return
  state.snapshot = snapshot
  state.history.push({
    at: snapshot.at,
    totalBytes: snapshot.totalBytes,
    usedBytes: snapshot.usedBytes,
    freeBytes: snapshot.freeBytes,
    finderAvailableBytes: nullableBytes(snapshot.finderAvailableBytes),
  })
  const overflow = state.history.length - HISTORY_LIMIT
  if (overflow > 0) state.history.splice(0, overflow)
}

/**
 * Copy one snapshot into a fresh object with guaranteed JSON-safe fields.
 * @param {unknown} snapshot candidate snapshot
 * @returns {Snapshot} normalized snapshot
 */
function pickSnapshot(snapshot) {
  const value = snapshot !== null && typeof snapshot === 'object' ? snapshot : {}
  const percentUsed = round1(clampPercent(value.percentUsed))
  return {
    at: finiteOrNull(value.at) ?? 0,
    mount: typeof value.mount === 'string' && value.mount !== '' ? value.mount : '/',
    volumeName: typeof value.volumeName === 'string' && value.volumeName !== '' ? value.volumeName : null,
    fileSystem: typeof value.fileSystem === 'string' && value.fileSystem !== '' ? value.fileSystem : null,
    totalBytes: safeBytes(value.totalBytes),
    usedBytes: safeBytes(value.usedBytes),
    freeBytes: safeBytes(value.freeBytes),
    percentUsed,
    freePercent: round1(clampPercent(Number.isFinite(value.freePercent) ? value.freePercent : 100 - percentUsed)),
    finderAvailableBytes: nullableBytes(value.finderAvailableBytes),
    purgeableBytes: nullableBytes(value.purgeableBytes),
  }
}

/**
 * Coerce a byte count into a safe non-negative integer.
 * @param {unknown} value candidate
 * @returns {number} safe byte count
 */
function safeBytes(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * Coerce an optional byte count: a safe non-negative integer survives,
 * everything else becomes null (the view contract allows null for the
 * Finder-equivalent fields when the probe is unavailable).
 * @param {unknown} value candidate
 * @returns {number|null} safe byte count or null
 */
function nullableBytes(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Copy one history row into the exact compact shape the page expects.
 * `finderAvailableBytes` is nullable: legacy rows (or probe failures) become
 * null, which the page treats as "fall back to the raw-df convention".
 * @param {unknown} row candidate history row
 * @returns {{at:number,totalBytes:number,usedBytes:number,freeBytes:number,finderAvailableBytes:number|null}} normalized row
 */
function pickHistoryRow(row) {
  const value = row !== null && typeof row === 'object' ? row : {}
  return {
    at: finiteOrNull(value.at) ?? 0,
    totalBytes: safeBytes(value.totalBytes),
    usedBytes: safeBytes(value.usedBytes),
    freeBytes: safeBytes(value.freeBytes),
    finderAvailableBytes: nullableBytes(value.finderAvailableBytes),
  }
}

/**
 * Build the exact view JSON described by DESIGN.md.
 *
 * Every field is always present and JSON-safe (`null` rather than `undefined`),
 * so the client can read the shape without defensive checks on missing keys.
 * @param {object} state plugin state from `createState`
 * @param {number} [now] generatedAt timestamp
 * @returns {object} view JSON
 */
export function buildView(state, now = Date.now()) {
  const current = state !== null && typeof state === 'object' ? state : createState()
  const collector = current.collector !== null && typeof current.collector === 'object' ? current.collector : {}
  const config = current.config !== null && typeof current.config === 'object' ? current.config : {}
  const ai = current.ai !== null && typeof current.ai === 'object' ? current.ai : {}

  const snapshot = current.snapshot === null || current.snapshot === undefined ? null : pickSnapshot(current.snapshot)
  const history = Array.isArray(current.history) ? current.history.slice(-HISTORY_LIMIT).map(pickHistoryRow) : []

  const report = normalizeReport(ai.report)
  const status = AI_STATUSES.has(ai.status) ? ai.status : 'idle'

  return {
    ok: true,
    generatedAt: finiteOrNull(now) ?? Date.now(),
    snapshot,
    history,
    collector: {
      lastStartedAt: finiteOrNull(collector.lastStartedAt) ?? 0,
      lastFinishedAt: finiteOrNull(collector.lastFinishedAt) ?? 0,
      lastDurationMs: finiteOrNull(collector.lastDurationMs) ?? 0,
      lastError: typeof collector.lastError === 'string' && collector.lastError !== '' ? capText(collector.lastError, 500) : null,
    },
    config: {
      sampleIntervalMs: finiteOrNull(config.sampleIntervalMs) ?? DEFAULT_SAMPLE_INTERVAL_MS,
      historyLimit: HISTORY_LIMIT,
    },
    ai: {
      status,
      sessionId: typeof ai.sessionId === 'string' && ai.sessionId !== '' ? ai.sessionId : null,
      startedAt: finiteOrNull(ai.startedAt),
      finishedAt: finiteOrNull(ai.finishedAt),
      error: typeof ai.error === 'string' && ai.error !== '' ? capText(ai.error, 500) : null,
      report,
    },
  }
}

/**
 * Normalize `ai.report` into `{text, at}` or null, capping text.
 * @param {unknown} report candidate report
 * @returns {{text:string,at:number}|null} normalized report
 */
function normalizeReport(report) {
  if (report === null || typeof report !== 'object') return null
  const text = typeof report.text === 'string' ? capText(report.text, REPORT_TEXT_LIMIT) : ''
  if (text === '') return null
  return { text, at: finiteOrNull(report.at) ?? Date.now() }
}

/**
 * Format a byte count as decimal GB with one decimal, exactly like every macOS
 * system tool (Finder, About This Mac, `df -H`, `du -h`, `diskutil`):
 * `bytes / 1e9`. The UI never shows GiB.
 * @param {number} bytes byte count
 * @returns {string} one-decimal decimal-GB string
 */
export function formatGb(bytes) {
  const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes / GB : 0
  return value.toFixed(1)
}

/**
 * Build the Chinese error message for a turn that did not complete.
 * `ai.status = 'error'` is set for every non-completed kind; only the message
 * differs so the panel can show something meaningful.
 * @param {number|null|undefined} turn turn number when known
 * @param {{kind?:string,error?:{message?:string}}|null|undefined} reason turn/end reason
 * @returns {string} user-facing message
 */
export function describeTurnEnd(turn, reason) {
  const label = Number.isSafeInteger(turn) && turn > 0 ? `第 ${turn} 轮` : '本轮'
  const kind = reason !== null && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : 'unknown'
  if (kind === 'error') {
    const detail = reason !== null && typeof reason === 'object' && typeof reason.error?.message === 'string' ? reason.error.message : ''
    return capText(detail === '' ? `${label}执行出错` : `${label}执行出错：${detail}`, ERROR_TEXT_LIMIT)
  }
  if (kind === 'max-tokens') return `${label}达到输出长度上限`
  if (kind === 'blocked') return `${label}被阻塞`
  if (kind === 'forked') return `${label}因分叉结束`
  return `${label}被中断`
}

/**
 * Fold one Session event of the tracked inspection Session into the AI state.
 *
 * This is the whole LLM-output capture state machine from DESIGN.md section 3:
 * - only the tracked, currently running Session is followed;
 * - the last textual `assistant/message` becomes `ai.report` (capped);
 * - `turn/end` with `reason.kind === 'completed'` closes as done, any other
 *   kind closes as error with a Chinese message;
 * - `turn/start` keeps the inspection marked running.
 *
 * Mutates `ai` in place and returns whether the event was relevant, so the
 * caller can skip logging for the thousands of unrelated Session events.
 *
 * @param {object} ai live ai state (`{status,sessionId,startedAt,finishedAt,error,report}`)
 * @param {string|null|undefined} sessionId id of the Session that emitted the event
 * @param {unknown} event Session event
 * @returns {boolean} whether this event belonged to the tracked inspection
 */
export function applySessionEvent(ai, sessionId, event) {
  if (ai === null || typeof ai !== 'object') return false
  if (ai.status !== 'running' || ai.sessionId === null || ai.sessionId !== sessionId) return false
  if (event === null || typeof event !== 'object') return false
  const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}

  if (event.type === 'assistant/message') {
    const text = extractAssistantText(data.message?.content)
    // Intermediate steps may carry tool calls but no text; keep the last
    // textual answer instead of clearing the report with an empty message.
    if (text.trim() !== '') ai.report = { text: capText(text, REPORT_TEXT_LIMIT), at: time }
    return true
  }

  if (event.type === 'turn/start') {
    ai.status = 'running'
    return true
  }

  if (event.type === 'turn/end') {
    const reason = data.reason
    if (reason !== null && typeof reason === 'object' && reason.kind === 'completed') {
      ai.status = 'done'
      ai.finishedAt = time
      ai.error = null
    } else {
      ai.status = 'error'
      ai.finishedAt = time
      ai.error = describeTurnEnd(data.turn, reason)
    }
    return true
  }

  return false
}

/**
 * Snapshot the AI state so a failed inspection start can restore it exactly.
 * @param {object} ai current ai state
 * @returns {{status:string,sessionId:string|null,startedAt:number|null,finishedAt:number|null,error:string|null,report:{text:string,at:number}|null}} detached copy
 */
export function cloneAiState(ai) {
  const value = ai !== null && typeof ai === 'object' ? ai : {}
  return {
    status: AI_STATUSES.has(value.status) ? value.status : 'idle',
    sessionId: typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : null,
    startedAt: finiteOrNull(value.startedAt),
    finishedAt: finiteOrNull(value.finishedAt),
    error: typeof value.error === 'string' && value.error !== '' ? value.error : null,
    report:
      value.report !== null && typeof value.report === 'object' && typeof value.report.text === 'string'
        ? { text: capText(value.report.text, REPORT_TEXT_LIMIT), at: finiteOrNull(value.report.at) ?? 0 }
        : null,
  }
}

/**
 * Restore the AI state captured before a failed inspection start attempt.
 * @param {object} ai live ai state
 * @param {ReturnType<typeof cloneAiState>} previous snapshot from `cloneAiState`
 * @returns {void}
 */
export function restoreAiState(ai, previous) {
  if (ai === null || typeof ai !== 'object') return
  const value = previous !== null && typeof previous === 'object' ? previous : cloneAiState(null)
  ai.status = value.status
  ai.sessionId = value.sessionId
  ai.startedAt = value.startedAt
  ai.finishedAt = value.finishedAt
  ai.error = value.error
  ai.report = value.report
}
