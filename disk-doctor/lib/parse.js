/**
 * Disk Doctor — pure parsers for the macOS commands the Host half runs.
 *
 * Everything in this module is a deterministic string -> data function: no
 * node built-ins, no I/O, no clock. `tests/collector.test.js` pins the exact
 * real-machine outputs this code has to survive.
 */

/** `df -P` capacity column, e.g. `93%`. */
const CAPACITY_PATTERN = /^\d+%$/
/** Plain non-negative integer token (df numeric columns). */
const COUNT_PATTERN = /^\d+$/

/**
 * @typedef {object} DfRow
 * @property {string} fileSystem filesystem column; may contain spaces
 * @property {number} blocks 1024-byte blocks (authoritative device size)
 * @property {number} used blocks used, as reported by df
 * @property {number} available blocks available, as reported by df
 * @property {string} capacity raw capacity column, e.g. `93%`
 * @property {string} mount mount point; spaces preserved
 */

/**
 * @typedef {object} DiskutilInfo
 * @property {string|null} volumeName human-readable volume name
 * @property {string|null} fileSystem normalized file-system personality (`apfs`)
 */

/**
 * Convert one df numeric token, accepting only safe non-negative integers.
 * @param {string} token whitespace-delimited df field
 * @returns {number|null} the count, or null when the token is not numeric
 */
function parseCount(token) {
  if (typeof token !== 'string' || COUNT_PATTERN.test(token) === false) return null
  const value = Number(token)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * Parse one pre-classified `df -P -k` line.
 *
 * The output is `<fs> <blocks> <used> <available> <capacity> <mount...>`. The
 * filesystem column may contain spaces (`map auto_home`) and, on unusual
 * systems, the mount point too (`/Volumes/My Disk`), so we anchor on the
 * distinctive `NN%` capacity column: the three previous tokens are the numeric
 * columns, everything before them is the filesystem, everything after is the
 * mount point. This also keeps the columns correct when the filesystem column
 * contains no spaces, which is the normal macOS case.
 *
 * @param {string} line one line of df stdout
 * @returns {DfRow|null} the parsed row, or null for headers / garbage
 */
export function parseDfLine(line) {
  if (typeof line !== 'string') return null
  const tokens = line.trim().split(/\s+/)
  if (tokens.length < 6) return null

  // The capacity column always has three numeric columns and one filesystem
  // token before it, so it can never appear before index 4.
  let capacityIndex = -1
  for (let index = tokens.length - 1; index >= 4; index -= 1) {
    if (CAPACITY_PATTERN.test(tokens[index])) {
      capacityIndex = index
      break
    }
  }
  if (capacityIndex < 4) return null

  const blocks = parseCount(tokens[capacityIndex - 3])
  const used = parseCount(tokens[capacityIndex - 2])
  const available = parseCount(tokens[capacityIndex - 1])
  if (blocks === null || used === null || available === null) return null

  const fileSystem = tokens.slice(0, capacityIndex - 3).join(' ').trim()
  const mount = tokens.slice(capacityIndex + 1).join(' ').trim()
  if (fileSystem === '' || mount === '') return null

  return { fileSystem, blocks, used, available, capacity: tokens[capacityIndex], mount }
}

/**
 * Parse complete `df -P -k` stdout into data rows.
 *
 * Header lines and unparsable lines are ignored rather than treated as errors.
 * @param {string} stdout df output
 * @returns {DfRow[]} parsed data rows in output order
 */
export function parseDf(stdout) {
  if (typeof stdout !== 'string') return []
  const rows = []
  for (const line of stdout.split(/\r?\n/)) {
    const row = parseDfLine(line)
    if (row !== null) rows.push(row)
  }
  return rows
}

/**
 * Pick the first row of a `df` run that targets one path. A df invocation may
 * repeat rows for the same path when the argument list is unusual; the first
 * row always describes the requested path.
 * @param {string} stdout df output
 * @returns {DfRow|null} first parsed row, or null
 */
export function firstDfRow(stdout) {
  const rows = parseDf(stdout)
  return rows.length > 0 ? rows[0] : null
}

/**
 * Parse the `diskutil info <volume>` plain-text report into the two metadata
 * fields the page displays.
 *
 * The command prints many `Key: value` lines; unknown keys are ignored and a
 * missing key yields null. Non-zero exits / missing diskutil are handled by the
 * caller (best effort only).
 * @param {string} stdout diskutil stdout
 * @returns {DiskutilInfo} volume name and normalized file-system personality
 */
export function parseDiskutil(stdout) {
  const fields = new Map()
  if (typeof stdout === 'string') {
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line)
      if (match === null) continue
      const key = match[1]
      if (fields.has(key) === false) fields.set(key, match[2])
    }
  }
  const volumeName = trimToNull(fields.get('Volume Name'))
  const personality = trimToNull(fields.get('File System Personality'))
  return {
    volumeName,
    // The page shows the short lowercase form (`apfs`), matching the design
    // example, while diskutil reports `APFS`.
    fileSystem: personality === null ? null : personality.toLowerCase(),
  }
}

/**
 * Keep a trimmed non-empty string, otherwise null.
 * @param {unknown} value candidate value
 * @returns {string|null} normalized string
 */
function trimToNull(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Concatenate the text blocks of an assistant message.
 *
 * Model messages also carry reasoning and tool-call blocks; only `text` blocks
 * belong in the captured report. The block shape is validated defensively so a
 * malformed event cannot crash the Host.
 * @param {unknown} content assistant message content blocks
 * @returns {string} concatenated text (empty when there is none)
 */
export function extractAssistantText(content) {
  if (Array.isArray(content) === false) return ''
  let text = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    text += block.text
  }
  return text
}

/**
 * Cap a string to `limit` UTF-16 code units. Used for report and error fields
 * so a pathologically long answer cannot bloat the view JSON.
 * @param {unknown} value candidate string
 * @param {number} limit maximum length
 * @returns {string} the original string, or a prefix
 */
export function capText(value, limit) {
  if (typeof value !== 'string') return ''
  if (Number.isFinite(limit) === false || limit <= 0) return ''
  return value.length > limit ? value.slice(0, limit) : value
}

/**
 * @typedef {object} CapacityReading
 * @property {number|null} importantUsage
 *   NSURLVolumeAvailableCapacityForImportantUsage — the availability figure
 *   Finder / System Settings show (includes purgeable space).
 * @property {number|null} capacity
 *   NSURLVolumeAvailableCapacity — raw available bytes as the OS reports them.
 * @property {number|null} total
 *   NSURLVolumeTotalCapacity — container total bytes.
 */

/**
 * Keep one probe value only when it is a finite non-negative safe integer.
 * JXA/ObjC bridges may hand back floats, NaN, nulls, or strings for an
 * unavailable key; every one of those must degrade to null instead of leaking
 * into the snapshot JSON.
 * @param {unknown} value candidate value
 * @returns {number|null} usable byte count or null
 */
function probeByteCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Parse the stdout of the JXA `NSURL` capacity probe.
 *
 * The probe prints one JSON object and osascript may append a newline. The
 * parser is deliberately tolerant: a malformed or partial payload yields all
 * nulls and the page hides the Finder-equivalent rows (the scripted df numbers
 * keep working).
 *
 * @param {unknown} stdout osascript stdout
 * @returns {CapacityReading} the three readings, each possibly null
 */
export function parseCapacityJson(stdout) {
  const reading = { importantUsage: null, capacity: null, total: null }
  if (typeof stdout !== 'string') return reading
  const text = stdout.trim()
  if (text === '') return reading
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return reading
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return reading
  reading.importantUsage = probeByteCount(parsed.importantUsage)
  reading.capacity = probeByteCount(parsed.capacity)
  reading.total = probeByteCount(parsed.total)
  return reading
}
