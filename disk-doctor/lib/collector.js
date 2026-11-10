/**
 * Disk Doctor — scripted disk collector.
 *
 * The Host half samples macOS disk usage with read-only local commands on a
 * timer. This module owns the command contract (exact binaries/args, hard
 * timeout), configuration normalization, and the fail-soft result conversion.
 * The child-process runner itself is injected by `index.js` so this module has
 * no node:child_process dependency and can be unit-tested with fake commands.
 */

import { firstDfRow, parseCapacityJson, parseDiskutil } from './parse.js'
import { deriveSnapshot } from './view.js'

/** Default sampling interval: 5 minutes. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 300000
/** Minimum accepted sampling interval; smaller values are clamped up. */
export const MIN_SAMPLE_INTERVAL_MS = 60000
/** Default hard command timeout: 15 seconds. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15000

/** Root volume mount point; the source of the container size. */
export const ROOT_PATH = '/'
/** APFS data volume; the source of authoritative free space. */
export const DATA_VOLUME_PATH = '/System/Volumes/Data'

/** @type {readonly string[]} */
const DF_COMMAND = Object.freeze(['/bin/df'])
/** @type {readonly string[]} */
const DISKUTIL_COMMAND = Object.freeze(['/usr/sbin/diskutil'])
/** @type {readonly string[]} */
const OSASCRIPT_COMMAND = Object.freeze(['/usr/bin/osascript'])
/** Script language flag for the JXA capacity probe. */
const JXA_LANGUAGE_ARGS = Object.freeze(['-l', 'JavaScript', '-e'])

/**
 * JXA script that reads the same "available" capacity numbers Finder and
 * System Settings show for the root volume.
 *
 * `NSURLVolumeAvailableCapacityForImportantUsageKey` includes purgeable space
 * (local Time Machine snapshots, caches), which is why it can be far larger
 * than `df`'s raw Available. Plain JS string keys are used on purpose: the
 * `$.NSURL...` key constants do not bridge reliably through osascript's ObjC
 * bridge, while the string keys resolve fine. The script is a single
 * expression so osascript prints the JSON on stdout.
 *
 * Failure policy: callers treat any error / malformed output as "no reading".
 */
export const CAPACITY_SCRIPT = `ObjC.import('Foundation');
const url = $.NSURL.fileURLWithPath('/');
const keys = [
  'NSURLVolumeAvailableCapacityForImportantUsageKey',
  'NSURLVolumeAvailableCapacityKey',
  'NSURLVolumeTotalCapacityKey'
];
const values = url.resourceValuesForKeysError(keys, null);
JSON.stringify({
  importantUsage: values.objectForKey('NSURLVolumeAvailableCapacityForImportantUsageKey').js,
  capacity: values.objectForKey('NSURLVolumeAvailableCapacityKey').js,
  total: values.objectForKey('NSURLVolumeTotalCapacityKey').js
});`

/**
 * @typedef {(file: string, args: readonly string[]) => Promise<string>} CommandRunner
 *   Runs one read-only command and resolves with its stdout, rejecting on any
 *   non-zero exit, timeout, or abort.
 */

/**
 * Return a positive safe integer or null.
 * @param {unknown} value candidate config value
 * @returns {number|null} usable positive integer
 */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Normalize plugin config into the two values the design allows.
 *
 * `sampleIntervalMs` is clamped to at least one minute; `diskCommandTimeoutMs`
 * only needs to be a positive integer. Anything else falls back to the default.
 * @param {unknown} config plugin config passed to `apply`
 * @returns {{sampleIntervalMs:number,diskCommandTimeoutMs:number}} normalized config
 */
export function normalizeConfig(config) {
  const options = config !== null && typeof config === 'object' && Array.isArray(config) === false ? config : {}
  const requestedInterval = positiveInteger(options.sampleIntervalMs)
  const requestedTimeout = positiveInteger(options.diskCommandTimeoutMs)
  return {
    sampleIntervalMs: requestedInterval === null ? DEFAULT_SAMPLE_INTERVAL_MS : Math.max(MIN_SAMPLE_INTERVAL_MS, requestedInterval),
    diskCommandTimeoutMs: requestedTimeout === null ? DEFAULT_COMMAND_TIMEOUT_MS : requestedTimeout,
  }
}

/**
 * Turn any thrown value into one short, single-line, JSON-safe message. The
 * message is stored in `collector.lastError` / returned to the page, so it must
 * never contain newlines from a command-failure stack.
 * @param {unknown} error thrown value
 * @returns {string} one-line diagnostic (max 300 chars)
 */
export function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'object') {
    const name = typeof error.name === 'string' ? error.name : ''
    if (name === 'AbortError') return '命令已取消'
    if (error.killed === true) return '命令执行超时'
    const code = typeof error.code === 'string' || typeof error.code === 'number' ? ` (${error.code})` : ''
    const raw = typeof error.message === 'string' ? error.message : String(error)
    const message = raw.replace(/\s+/g, ' ').trim()
    if (message === '') return `未知错误${code}`
    return `${message.slice(0, 260)}${code}`
  }
  return String(error).replace(/\s+/g, ' ').trim().slice(0, 260) || '未知错误'
}

/**
 * Build one internal failure result.
 * @param {string} code stable error code
 * @param {string} message human diagnostic
 * @returns {{ok:false,error:{code:string,message:string}}} failure result
 */
function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Run the read-only probes and derive the user-facing snapshot.
 *
 * Failure policy (from DESIGN.md):
 * - the `/` df call is required: without the container size no snapshot exists;
 * - the Data volume call is optional and falls back to `/` free space;
 * - diskutil and the JXA capacity probe are best effort and only add metadata
 *   (the Finder-equivalent fields degrade to null on any failure);
 * - every failure is returned, never thrown, so the collector state survives.
 *
 * @param {object} input collector inputs
 * @param {CommandRunner} input.exec injected command runner
 * @param {number} [input.now] sample timestamp override (tests)
 * @returns {Promise<{ok:true,snapshot:object}|{ok:false,error:{code:string,message:string}}>} result
 */
export async function collectSnapshot({ exec, now = Date.now() }) {
  if (typeof exec !== 'function') return failure('exec-unavailable', '磁盘采集不可用：缺少命令执行器。')
  const sampledAt = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()

  // Root row: authoritative container size and mount point.
  let rootRow
  try {
    rootRow = firstDfRow(await exec(DF_COMMAND[0], ['-P', '-k', ROOT_PATH]))
  } catch (error) {
    return failure('df-root-failed', `无法读取磁盘总量：${describeError(error)}`)
  }
  if (rootRow === null) return failure('df-root-unparsable', '无法解析 df 输出：磁盘总量未知。')

  // Data volume row: authoritative Available on APFS. A failure here only
  // downgrades the free-space source to the root row.
  let dataRow = null
  try {
    dataRow = firstDfRow(await exec(DF_COMMAND[0], ['-P', '-k', DATA_VOLUME_PATH]))
  } catch {
    dataRow = null
  }

  // diskutil metadata is cosmetic; never let it fail the sample.
  let info = { volumeName: null, fileSystem: null }
  try {
    info = parseDiskutil(await exec(DISKUTIL_COMMAND[0], ['info', ROOT_PATH]))
  } catch {
    info = { volumeName: null, fileSystem: null }
  }

  // Finder/System Settings availability is best effort: a missing osascript,
  // a refused JXA call, or a malformed payload only leaves both Finder fields
  // null — the scripted df snapshot must still succeed.
  let capacity = { importantUsage: null, capacity: null, total: null }
  try {
    capacity = parseCapacityJson(await exec(OSASCRIPT_COMMAND[0], [...JXA_LANGUAGE_ARGS, CAPACITY_SCRIPT]))
  } catch {
    capacity = { importantUsage: null, capacity: null, total: null }
  }

  try {
    return {
      ok: true,
      snapshot: deriveSnapshot({ at: sampledAt, root: rootRow, data: dataRow, diskutil: info, finder: capacity }),
    }
  } catch (error) {
    return failure('derive-failed', `无法计算磁盘用量：${describeError(error)}`)
  }
}
