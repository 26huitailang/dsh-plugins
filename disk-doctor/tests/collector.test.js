/**
 * Disk Doctor — Host collector unit tests.
 *
 * Fixture-based and offline: every df/diskutil/osascript output below was
 * captured on the real macOS machine the plugin targets, then pinned as a
 * string. No child process, network, clock or filesystem access happens here,
 * so the suite is deterministic and also runs on CI. All GB numbers are decimal
 * (`bytes / 1e9`), matching Finder and every macOS system tool.
 *
 * Run with: node tests/collector.test.js
 */

import assert from 'node:assert/strict'

import { CAPACITY_SCRIPT, collectSnapshot, describeError, normalizeConfig } from '../lib/collector.js'
import { capText, extractAssistantText, firstDfRow, parseCapacityJson, parseDf, parseDfLine, parseDiskutil } from '../lib/parse.js'
import { buildInspectPrompt, formatDateTime } from '../lib/prompt.js'
import {
  HISTORY_LIMIT,
  REPORT_TEXT_LIMIT,
  applySessionEvent,
  buildView,
  cloneAiState,
  createState,
  deriveSnapshot,
  formatGb,
  recordSample,
  restoreAiState,
} from '../lib/view.js'

// ---------------------------------------------------------------------------
// Real-machine fixtures (captured from `df -P -k` and `diskutil info /`).
// ---------------------------------------------------------------------------

const ROOT_DF = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   971350180  13340500  70720740    16%    /
`

const DATA_DF = `Filesystem   1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s5   971350180 871789268  70720740    93%    /System/Volumes/Data
`

// Real `diskutil info /` capture from an APFS machine. Device names, sizes and
// UUIDs are sanitized/illustrative: the parser only consumes Volume Name and
// File System Personality, so the fixture does not describe any real machine.
const DISKUTIL_INFO = `   Device Identifier:         disk3s1s1
   Device Node:               /dev/disk3s1s1
   Whole:                     No
   Part of Whole:             disk3

   Volume Name:               Macintosh HD
   Mounted:                   Yes
   Mount Point:               /

   Partition Type:            41504653-0000-11AA-AA11-00306543ECAC
   File System Personality:   APFS
   Type (Bundle):             apfs
   Name (User Visible):       APFS
   Owners:                    Enabled

   OS Can Be Installed:       No
   Booter Disk:               disk3s2
   Recovery Disk:             disk3s3
   Media Type:                通用
   Protocol:                  Apple Fabric
   SMART Status:              Verified
   Volume UUID:               11111111-2222-3333-4444-555555555555
   Disk / Partition UUID:     11111111-2222-3333-4444-555555555555

   Disk Size:                 994.7 GB (994662584320 Bytes) (exactly 1942700360 512-Byte-Units)
   Device Block Size:         4096 Bytes

   Volume Used Space:         13.7 GB (13660672000 Bytes) (exactly 26681000 512-Byte-Units)
   Container Total Space:     994.7 GB (994662584320 Bytes) (exactly 1942700360 512-Byte-Units)
   Container Free Space:      72.4 GB (72418033664 Bytes) (exactly 141441472 512-Byte-Units)
`

/** Root-only machine (non-APFS / CI): a different Available proves the fallback. */
const ROOT_ONLY_DF = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/sda1        1000000     600000    250000     71%    /
`

/**
 * DESIGN.md's live example: df root with 66206152 KiB available (raw free
 * 67,795,099,648 B) and the JXA probe's Finder-equivalent 193,306,023,089 B.
 */
const ROOT_DF_LIVE = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   971350180  13340500  66206152    17%    /
`
const DATA_DF_LIVE = `Filesystem   1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s5   971350180 876261840  66206152    93%    /System/Volumes/Data
`

/** Real osascript/JXA capacity output shape (single JSON object + newline). */
const CAPACITY_JSON = '{"importantUsage":193306023089,"capacity":67795099648,"total":994662584320}\n'

const TOTAL_BYTES = 994662584320 // 971350180 * 1024
const FREE_BYTES = 72418037760 // 70720740 * 1024
const USED_BYTES = TOTAL_BYTES - FREE_BYTES // 922244546560
const FINDER_AVAILABLE_BYTES = 193306023089
/** purgeable = finderAvailableBytes - df freeBytes, clamped >= 0 */
const PURGEABLE_BYTES = FINDER_AVAILABLE_BYTES - FREE_BYTES // 120887985329

/** Expected snapshot derived from the captured df rows + capacity probe. */
const REAL_SNAPSHOT = {
  at: 0,
  mount: '/',
  volumeName: 'Macintosh HD',
  fileSystem: 'apfs',
  totalBytes: TOTAL_BYTES,
  usedBytes: USED_BYTES,
  freeBytes: FREE_BYTES,
  percentUsed: 92.7,
  freePercent: 7.3,
  finderAvailableBytes: FINDER_AVAILABLE_BYTES,
  purgeableBytes: PURGEABLE_BYTES,
}

/** Expected snapshot when the Finder-equivalent probe is unavailable. */
const BASE_SNAPSHOT = { ...REAL_SNAPSHOT, finderAvailableBytes: null, purgeableBytes: null }

/**
 * Fake `exec` matching the exact command contract the collector is allowed to
 * use. Records every argv so tests can prove no shell strings / extra commands
 * leak in.
 * @param {object} [behaviour] optional per-command overrides
 * @param {(file:string,args:string[])=>string=} [behaviour.df] df override
 * @param {(file:string,args:string[])=>string=} [behaviour.diskutil] diskutil override
 * @param {(file:string,args:string[])=>string=} [behaviour.capacity] JXA probe override
 * @returns {{exec:Function,calls:{file:string,args:string[]}[]}} injected runner and recorded calls
 */
function fakeExec(behaviour = {}) {
  const calls = []
  const df = behaviour.df ?? ((file, args) => (args[args.length - 1] === '/System/Volumes/Data' ? DATA_DF : ROOT_DF))
  const diskutil = behaviour.diskutil ?? (() => DISKUTIL_INFO)
  const capacity = behaviour.capacity ?? (() => CAPACITY_JSON)
  const exec = async (file, args) => {
    calls.push({ file, args: [...args] })
    if (file === '/bin/df') return df(file, args)
    if (file === '/usr/sbin/diskutil') return diskutil(file, args)
    if (file === '/usr/bin/osascript') return capacity(file, args)
    throw new Error(`unexpected command: ${file}`)
  }
  return { exec, calls }
}

// ---------------------------------------------------------------------------
// Tiny assertion harness (no test framework dependency).
// ---------------------------------------------------------------------------

/** @type {{name:string,fn:Function}[]} */
const tests = []
/** @param {string} name @param {Function} fn */
function test(name, fn) {
  tests.push({ name, fn })
}

// ---------------------------------------------------------------------------
// df parsing
// ---------------------------------------------------------------------------

test('parseDf parses the real root df row', () => {
  const rows = parseDf(ROOT_DF)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    fileSystem: '/dev/disk3s1s1',
    blocks: 971350180,
    used: 13340500,
    available: 70720740,
    capacity: '16%',
    mount: '/',
  })
})

test('parseDf parses the real APFS data-volume row', () => {
  const rows = parseDf(DATA_DF)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].fileSystem, '/dev/disk3s5')
  assert.equal(rows[0].available, 70720740)
  assert.equal(rows[0].mount, '/System/Volumes/Data')
})

test('parseDf keeps filesystems and mount points that contain spaces', () => {
  const output = `Filesystem 1024-blocks Used Available Capacity Mounted on
map auto_home 1000 200 800 20% /Volumes/My Disk
`
  const rows = parseDf(output)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].fileSystem, 'map auto_home')
  assert.equal(rows[0].blocks, 1000)
  assert.equal(rows[0].used, 200)
  assert.equal(rows[0].available, 800)
  assert.equal(rows[0].capacity, '20%')
  assert.equal(rows[0].mount, '/Volumes/My Disk')
})

test('parseDf ignores headers, blank lines and garbage lines', () => {
  const output = `Filesystem 1024-blocks Used Available Capacity Mounted on

this is not a df row at all
- - - - - -
/dev/disk9s9 twelve 3 4 25% /tmp
`
  assert.deepEqual(parseDf(output), [])
  // A mount point containing spaces still parses (no filesystem spaces here).
  assert.equal(parseDfLine('/dev/disk9s9 12 3 4 25% /tmp maybe').mount, '/tmp maybe')
  assert.deepEqual(parseDf(''), [])
  assert.deepEqual(parseDf(null), [])
  assert.equal(parseDfLine(undefined), null)
})

test('parseDfLine rejects rows whose numeric columns are not numeric', () => {
  assert.equal(parseDfLine('/dev/disk1s1 notanumber 1 2 3% /'), null)
  assert.equal(parseDfLine('/dev/disk1s1 1 2 3% /'), null) // capacity too early to have three numeric columns
  assert.equal(parseDfLine('a b c d e f'), null)
  // A filesystem with spaces plus a normal mount still parses.
  const row = parseDfLine('map auto_home 0 0 0 100% /System/Volumes/Data')
  assert.equal(row.fileSystem, 'map auto_home')
  assert.equal(row.mount, '/System/Volumes/Data')
})

test('firstDfRow returns null when nothing parses', () => {
  assert.equal(firstDfRow('Filesystem blocks\nnonsense'), null)
  assert.equal(firstDfRow(ROOT_DF).mount, '/')
})

// ---------------------------------------------------------------------------
// diskutil parsing
// ---------------------------------------------------------------------------

test('parseDiskutil reads the real volume name and normalizes APFS', () => {
  assert.deepEqual(parseDiskutil(DISKUTIL_INFO), { volumeName: 'Macintosh HD', fileSystem: 'apfs' })
})

test('parseDiskutil tolerates missing or empty fields', () => {
  assert.deepEqual(parseDiskutil(''), { volumeName: null, fileSystem: null })
  assert.deepEqual(parseDiskutil('Volume Name:   \n'), { volumeName: null, fileSystem: null })
  assert.deepEqual(parseDiskutil('File System Personality:   Journaled HFS+\n'), {
    volumeName: null,
    fileSystem: 'journaled hfs+',
  })
  assert.deepEqual(parseDiskutil(null), { volumeName: null, fileSystem: null })
})

// ---------------------------------------------------------------------------
// JXA capacity-probe output parsing
// ---------------------------------------------------------------------------

test('parseCapacityJson reads the three live probe numbers', () => {
  assert.deepEqual(parseCapacityJson(CAPACITY_JSON), {
    importantUsage: 193306023089,
    capacity: 67795099648,
    total: 994662584320,
  })
  // Trailing/leading whitespace and no trailing newline both parse.
  assert.deepEqual(parseCapacityJson('  {"importantUsage":1,"capacity":2,"total":3}  '), { importantUsage: 1, capacity: 2, total: 3 })
})

test('parseCapacityJson tolerates malformed and partial payloads', () => {
  const empty = { importantUsage: null, capacity: null, total: null }
  assert.deepEqual(parseCapacityJson(''), empty)
  assert.deepEqual(parseCapacityJson(null), empty)
  assert.deepEqual(parseCapacityJson(undefined), empty)
  assert.deepEqual(parseCapacityJson('not json'), empty)
  assert.deepEqual(parseCapacityJson('[]'), empty)
  assert.deepEqual(parseCapacityJson('null'), empty)
  assert.deepEqual(parseCapacityJson('{"importantUsage":1}'), { importantUsage: 1, capacity: null, total: null })
})

test('parseCapacityJson rejects NaN / negative / non-integer values field by field', () => {
  const parsed = parseCapacityJson('{"importantUsage":-1,"capacity":1.5,"total":"994662584320"}')
  assert.deepEqual(parsed, { importantUsage: null, capacity: null, total: null })
  // A JSON number that cannot be represented as a safe integer degrades to null.
  assert.equal(parseCapacityJson('{"importantUsage":9007199254740993}').importantUsage, null)
  assert.equal(parseCapacityJson('{"importantUsage":true}').importantUsage, null)
})

// ---------------------------------------------------------------------------
// Snapshot derivation
// ---------------------------------------------------------------------------

test('deriveSnapshot assembles total/free/used/percentages from the real rows', () => {
  const root = firstDfRow(ROOT_DF)
  const data = firstDfRow(DATA_DF)
  const info = parseDiskutil(DISKUTIL_INFO)
  // Without the JXA probe both Finder-equivalent fields are null.
  const snapshot = deriveSnapshot({ at: 1730000000000, root, data, diskutil: info })
  assert.deepEqual(snapshot, { ...BASE_SNAPSHOT, at: 1730000000000 })
  // Sanity: bytes reconcile and percentages complement each other.
  assert.equal(snapshot.usedBytes + snapshot.freeBytes, snapshot.totalBytes)
  assert.equal(snapshot.percentUsed + snapshot.freePercent, 100)
})

test('deriveSnapshot reads finderAvailableBytes/purgeableBytes from the capacity probe', () => {
  const snapshot = deriveSnapshot({
    at: 1730000000000,
    root: firstDfRow(ROOT_DF),
    data: firstDfRow(DATA_DF),
    diskutil: parseDiskutil(DISKUTIL_INFO),
    finder: parseCapacityJson(CAPACITY_JSON),
  })
  assert.deepEqual(snapshot, { ...REAL_SNAPSHOT, at: 1730000000000 })
  assert.equal(snapshot.purgeableBytes, snapshot.finderAvailableBytes - snapshot.freeBytes)
})

test('deriveSnapshot matches the DESIGN.md live example numbers exactly', () => {
  const snapshot = deriveSnapshot({
    at: 1730000000000,
    root: firstDfRow(ROOT_DF_LIVE),
    data: firstDfRow(DATA_DF_LIVE),
    diskutil: parseDiskutil(DISKUTIL_INFO),
    finder: parseCapacityJson(CAPACITY_JSON),
  })
  assert.deepEqual(snapshot, {
    at: 1730000000000,
    mount: '/',
    volumeName: 'Macintosh HD',
    fileSystem: 'apfs',
    totalBytes: 994662584320,
    usedBytes: 926867484672, // total - free per the DESIGN derivation rule
    freeBytes: 67795099648,
    percentUsed: 93.2,
    freePercent: 6.8,
    finderAvailableBytes: 193306023089,
    purgeableBytes: 125510923441,
  })
})

test('deriveSnapshot clamps implausible capacity-probe values to null', () => {
  const derive = (importantUsage) =>
    deriveSnapshot({ at: 1, root: firstDfRow(ROOT_DF), data: firstDfRow(DATA_DF), finder: { importantUsage, capacity: null, total: null } })

  assert.equal(derive(-1).finderAvailableBytes, null)
  assert.equal(derive(1.5).finderAvailableBytes, null)
  assert.equal(derive('193306023089').finderAvailableBytes, null)
  assert.equal(derive(Number.NaN).finderAvailableBytes, null)
  assert.equal(derive(TOTAL_BYTES * 2 + 1).finderAvailableBytes, null) // absurdly large
  assert.equal(derive(TOTAL_BYTES * 2).finderAvailableBytes, TOTAL_BYTES * 2) // boundary accepted
  // A reading below raw free space clamps purgeable to zero instead of going negative.
  const low = derive(1000)
  assert.equal(low.finderAvailableBytes, 1000)
  assert.equal(low.purgeableBytes, 0)
  assert.equal(low.purgeableBytes >= 0, true)
  // Missing probe object entirely -> both null.
  const missing = deriveSnapshot({ at: 1, root: firstDfRow(ROOT_DF), data: firstDfRow(DATA_DF) })
  assert.equal(missing.finderAvailableBytes, null)
  assert.equal(missing.purgeableBytes, null)
})

test('deriveSnapshot falls back to the root df free space when the data volume misses', () => {
  const root = firstDfRow(ROOT_ONLY_DF)
  const snapshot = deriveSnapshot({ at: 1, root, data: null, diskutil: null })
  assert.equal(snapshot.totalBytes, 1000000 * 1024)
  assert.equal(snapshot.freeBytes, 250000 * 1024)
  assert.equal(snapshot.usedBytes, snapshot.totalBytes - snapshot.freeBytes)
  assert.equal(snapshot.mount, '/')
  assert.equal(snapshot.volumeName, null)
  assert.equal(snapshot.fileSystem, null)
  assert.equal(snapshot.finderAvailableBytes, null)
  assert.equal(snapshot.purgeableBytes, null)
  assert.equal(JSON.parse(JSON.stringify(snapshot)).volumeName, null)
})

test('deriveSnapshot throws on an invalid root row instead of producing NaN bytes', () => {
  assert.throws(() => deriveSnapshot({ at: 1, root: null }), /df root row is missing or invalid/)
  assert.throws(() => deriveSnapshot({ at: 1, root: { blocks: 0, used: 0, available: 0 } }), /df root row is missing or invalid/)
  assert.throws(() => deriveSnapshot({ at: 1, root: { blocks: Number.MAX_SAFE_INTEGER, used: 0, available: 0 } }), /out of safe integer range/)
})

// ---------------------------------------------------------------------------
// Collector (injected command runner)
// ---------------------------------------------------------------------------

test('collectSnapshot runs exactly df /, df data volume, diskutil, then the JXA probe', async () => {
  const { exec, calls } = fakeExec()
  const result = await collectSnapshot({ exec, now: 1730000000000 })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map((call) => call.file), ['/bin/df', '/bin/df', '/usr/sbin/diskutil', '/usr/bin/osascript'])
  assert.deepEqual(calls[0].args, ['-P', '-k', '/'])
  assert.deepEqual(calls[1].args, ['-P', '-k', '/System/Volumes/Data'])
  assert.deepEqual(calls[2].args, ['info', '/'])
  assert.deepEqual(calls[3].args.slice(0, 3), ['-l', 'JavaScript', '-e'])
  assert.equal(calls[3].args[3], CAPACITY_SCRIPT)
  // The JXA script must use the three NSURL resource keys as plain JS strings
  // (the ObjC `$.NSURL...` constants do not bridge reliably) and print JSON.
  for (const key of ['NSURLVolumeAvailableCapacityForImportantUsageKey', 'NSURLVolumeAvailableCapacityKey', 'NSURLVolumeTotalCapacityKey']) {
    assert.ok(CAPACITY_SCRIPT.includes(`'${key}'`), `script uses ${key} as a plain string`)
  }
  assert.ok(CAPACITY_SCRIPT.includes('resourceValuesForKeysError'))
  assert.ok(CAPACITY_SCRIPT.includes('JSON.stringify'))
  assert.deepEqual(result.snapshot, { ...REAL_SNAPSHOT, at: 1730000000000 })
})

test('collectSnapshot leaves both Finder fields null when the JXA probe fails', async () => {
  const { exec, calls } = fakeExec({
    capacity: () => {
      throw Object.assign(new Error('osascript: execution error'), { code: 1 })
    },
  })
  const result = await collectSnapshot({ exec, now: 11 })
  assert.equal(result.ok, true)
  assert.equal(calls.filter((call) => call.file === '/usr/bin/osascript').length, 1)
  assert.deepEqual(result.snapshot, { ...BASE_SNAPSHOT, at: 11 })
  assert.equal(JSON.parse(JSON.stringify(result.snapshot)).finderAvailableBytes, null)
})

test('collectSnapshot leaves both Finder fields null when the JXA output is malformed', async () => {
  const { exec } = fakeExec({ capacity: () => 'not a JSON object\n' })
  const result = await collectSnapshot({ exec, now: 12 })
  assert.equal(result.ok, true)
  assert.equal(result.snapshot.finderAvailableBytes, null)
  assert.equal(result.snapshot.purgeableBytes, null)
  assert.equal(result.snapshot.totalBytes, TOTAL_BYTES)
})

test('collectSnapshot degrades to root df free space when the data volume command fails', async () => {
  const { exec } = fakeExec({
    df: (file, args) => {
      if (args[args.length - 1] === '/System/Volumes/Data') throw Object.assign(new Error('df: No such file or directory'), { code: 1 })
      return ROOT_ONLY_DF
    },
    // A plausible reading for this small synthetic volume (<= 2x its total).
    capacity: () => '{"importantUsage":500000000,"capacity":250000000,"total":1024000000}\n',
  })
  const result = await collectSnapshot({ exec, now: 42 })
  assert.equal(result.ok, true)
  assert.equal(result.snapshot.totalBytes, 1000000 * 1024)
  assert.equal(result.snapshot.freeBytes, 250000 * 1024)
  assert.equal(result.snapshot.at, 42)
  // The probe still contributes the Finder-equivalent metric.
  assert.equal(result.snapshot.finderAvailableBytes, 500000000)
  assert.equal(result.snapshot.purgeableBytes, 500000000 - 250000 * 1024)
})

test('collectSnapshot returns an error (never throws) when df / fails and never probes', async () => {
  const { exec, calls } = fakeExec({
    df: () => {
      throw Object.assign(new Error('Command failed: /bin/df -P -k /\nspawn EACCES'), { code: 'EACCES' })
    },
  })
  const result = await collectSnapshot({ exec })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'df-root-failed')
  assert.match(result.error.message, /无法读取磁盘总量/)
  assert.match(result.error.message, /EACCES/)
  assert.equal(calls.length, 1) // the root df call, then we bail out
})

test('collectSnapshot returns an error when df / output is unparsable', async () => {
  const { exec, calls } = fakeExec({ df: () => 'Filesystem blocks\nnot a real row\n' })
  const result = await collectSnapshot({ exec })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'df-root-unparsable')
  assert.equal(calls.length, 1)
})

test('collectSnapshot keeps metadata null but still succeeds when diskutil fails', async () => {
  const { exec } = fakeExec({
    diskutil: () => {
      throw new Error('diskutil: not found')
    },
  })
  const result = await collectSnapshot({ exec, now: 7 })
  assert.equal(result.ok, true)
  assert.equal(result.snapshot.volumeName, null)
  assert.equal(result.snapshot.fileSystem, null)
  assert.equal(result.snapshot.totalBytes, TOTAL_BYTES)
  assert.equal(result.snapshot.finderAvailableBytes, FINDER_AVAILABLE_BYTES)
})

test('collectSnapshot rejects a missing runner without throwing', async () => {
  const result = await collectSnapshot({ exec: null })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'exec-unavailable')
})

// ---------------------------------------------------------------------------
// describeError
// ---------------------------------------------------------------------------

test('describeError flattens command failures into one short line', () => {
  assert.equal(describeError(new Error('boom')), 'boom')
  assert.match(describeError(Object.assign(new Error('spawn /bin/df ENOENT'), { code: 'ENOENT' })), /ENOENT \(ENOENT\)/)
  assert.equal(describeError({ name: 'AbortError' }), '命令已取消')
  assert.equal(describeError({ killed: true, message: 'killed' }), '命令执行超时')
  assert.equal(describeError(Object.assign(new Error('session busy'), { code: 'session/agent-busy', isDSHRemoteError: true })), 'session busy (session/agent-busy)')
  assert.equal(describeError(new Error('line one\nline two')), 'line one line two')
  assert.equal(describeError(null), '未知错误')
  assert.ok(describeError(new Error('x'.repeat(2000))).length <= 270)
})

// ---------------------------------------------------------------------------
// Config normalization
// ---------------------------------------------------------------------------

test('normalizeConfig uses defaults for missing / invalid values', () => {
  assert.deepEqual(normalizeConfig(undefined), { sampleIntervalMs: 300000, diskCommandTimeoutMs: 15000 })
  assert.deepEqual(normalizeConfig(null), { sampleIntervalMs: 300000, diskCommandTimeoutMs: 15000 })
  assert.deepEqual(normalizeConfig({ sampleIntervalMs: 0, diskCommandTimeoutMs: -1 }), { sampleIntervalMs: 300000, diskCommandTimeoutMs: 15000 })
  assert.deepEqual(normalizeConfig({ sampleIntervalMs: 1.5, diskCommandTimeoutMs: '9000' }), { sampleIntervalMs: 300000, diskCommandTimeoutMs: 15000 })
})

test('normalizeConfig clamps the interval to one minute and keeps valid overrides', () => {
  assert.equal(normalizeConfig({ sampleIntervalMs: 1000 }).sampleIntervalMs, 60000)
  assert.equal(normalizeConfig({ sampleIntervalMs: 600000 }).sampleIntervalMs, 600000)
  assert.equal(normalizeConfig({ diskCommandTimeoutMs: 5000 }).diskCommandTimeoutMs, 5000)
})

// ---------------------------------------------------------------------------
// View JSON
// ---------------------------------------------------------------------------

test('buildView matches the contracted shape before the first sample', () => {
  const state = createState()
  const view = buildView(state, 1730000000000)
  assert.deepEqual(Object.keys(view), ['ok', 'generatedAt', 'snapshot', 'history', 'collector', 'config', 'ai'])
  assert.deepEqual(view, {
    ok: true,
    generatedAt: 1730000000000,
    snapshot: null,
    history: [],
    collector: { lastStartedAt: 0, lastFinishedAt: 0, lastDurationMs: 0, lastError: null },
    config: { sampleIntervalMs: 300000, historyLimit: 288 },
    ai: { status: 'idle', sessionId: null, startedAt: null, finishedAt: null, error: null, report: null },
  })
})

test('buildView is JSON-safe byte-for-byte and carries the Finder fields', () => {
  const state = createState({ sampleIntervalMs: 600000 })
  const snapshot = deriveSnapshot({
    at: 1730000000000,
    root: firstDfRow(ROOT_DF),
    data: firstDfRow(DATA_DF),
    diskutil: parseDiskutil(DISKUTIL_INFO),
    finder: parseCapacityJson(CAPACITY_JSON),
  })
  recordSample(state, snapshot)
  const view = buildView(state, 1730000000001)
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
  assert.deepEqual(view.snapshot, { ...REAL_SNAPSHOT, at: 1730000000000 })
  assert.deepEqual(Object.keys(view.snapshot), [
    'at',
    'mount',
    'volumeName',
    'fileSystem',
    'totalBytes',
    'usedBytes',
    'freeBytes',
    'percentUsed',
    'freePercent',
    'finderAvailableBytes',
    'purgeableBytes',
  ])
  assert.equal(view.config.sampleIntervalMs, 600000)
  assert.equal(view.config.historyLimit, HISTORY_LIMIT)
})

test('buildView tolerates NaN/Infinity/invalid state without emitting them', () => {
  const state = createState()
  state.snapshot = {
    at: Number.NaN,
    mount: 42,
    volumeName: '',
    fileSystem: undefined,
    totalBytes: Number.NaN,
    usedBytes: -1,
    freeBytes: Infinity,
    percentUsed: Number.NaN,
    freePercent: Infinity,
    finderAvailableBytes: -1,
    purgeableBytes: 'lots',
  }
  state.history = [{ at: Number.NaN, totalBytes: Number.NaN, usedBytes: Infinity, freeBytes: -5 }]
  state.collector = { lastStartedAt: Number.NaN, lastFinishedAt: 'x', lastDurationMs: Infinity, lastError: 42 }
  state.ai = { status: 'nonsense', sessionId: 7, startedAt: 'x', finishedAt: Infinity, error: 9, report: { text: 42, at: 'x' } }
  const view = buildView(state, Number.NaN)
  const roundTripped = JSON.parse(JSON.stringify(view))
  assert.deepEqual(roundTripped, view)
  assert.equal(view.ai.status, 'idle')
  assert.equal(view.ai.sessionId, null)
  assert.equal(view.ai.finishedAt, null)
  assert.equal(view.ai.error, null)
  assert.equal(view.ai.report, null)
  assert.equal(view.collector.lastError, null)
  assert.equal(view.snapshot.totalBytes, 0)
  assert.equal(view.snapshot.finderAvailableBytes, null)
  assert.equal(view.snapshot.purgeableBytes, null)
  assert.equal(view.history.length, 1)
  assert.ok(Number.isFinite(view.generatedAt))
})

test('buildView emits null Finder fields when the snapshot predates the probe', () => {
  const state = createState()
  const snapshot = deriveSnapshot({ at: 1, root: firstDfRow(ROOT_DF), data: firstDfRow(DATA_DF), diskutil: parseDiskutil(DISKUTIL_INFO) })
  recordSample(state, snapshot)
  const view = buildView(state, 2)
  assert.equal(Object.prototype.hasOwnProperty.call(view.snapshot, 'finderAvailableBytes'), true)
  assert.equal(Object.prototype.hasOwnProperty.call(view.snapshot, 'purgeableBytes'), true)
  assert.equal(view.snapshot.finderAvailableBytes, null)
  assert.equal(view.snapshot.purgeableBytes, null)
})

test('history rows keep the compact five-field shape with nullable Finder availability', () => {
  const state = createState()
  const snapshot = deriveSnapshot({ at: 1730000000000, root: firstDfRow(ROOT_DF), data: firstDfRow(DATA_DF) })
  recordSample(state, snapshot)
  const view = buildView(state, 1730000000001)
  assert.deepEqual(Object.keys(view.history[0]), ['at', 'totalBytes', 'usedBytes', 'freeBytes', 'finderAvailableBytes'])
  assert.deepEqual(view.history[0], {
    at: 1730000000000,
    totalBytes: TOTAL_BYTES,
    usedBytes: USED_BYTES,
    freeBytes: FREE_BYTES,
    finderAvailableBytes: null,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})

test('history rows pass the Finder availability through when the probe succeeded', () => {
  const state = createState()
  const snapshot = deriveSnapshot({
    at: 1730000000000,
    root: firstDfRow(ROOT_DF),
    data: firstDfRow(DATA_DF),
    finder: parseCapacityJson(CAPACITY_JSON),
  })
  recordSample(state, snapshot)
  const view = buildView(state, 1730000000001)
  assert.deepEqual(view.history[0], {
    at: 1730000000000,
    totalBytes: TOTAL_BYTES,
    usedBytes: USED_BYTES,
    freeBytes: FREE_BYTES,
    finderAvailableBytes: FINDER_AVAILABLE_BYTES,
  })
})

test('recordSample normalizes the history Finder field to integer|null', () => {
  const state = createState()
  const base = { at: 1, totalBytes: 100, usedBytes: 50, freeBytes: 50, mount: '/', volumeName: null, fileSystem: null, percentUsed: 50, freePercent: 50 }
  const values = [FINDER_AVAILABLE_BYTES, null, -1, 1.5, 'x', Number.NaN, 2 ** 60]
  for (const [index, finderAvailableBytes] of values.entries()) {
    recordSample(state, { ...base, at: index + 1, finderAvailableBytes })
  }
  assert.deepEqual(state.history.map((row) => row.finderAvailableBytes), [FINDER_AVAILABLE_BYTES, null, null, null, null, null, null])
  assert.deepEqual(JSON.parse(JSON.stringify(state.history)), state.history)
})

test('buildView normalizes legacy and malformed history rows defensively', () => {
  const state = createState()
  state.history = [
    { at: 1, totalBytes: 100, usedBytes: 50, freeBytes: 50 }, // legacy 4-field row
    { at: 2, totalBytes: 100, usedBytes: 50, freeBytes: 50, finderAvailableBytes: 80 },
    { at: Number.NaN, totalBytes: Number.NaN, usedBytes: Infinity, freeBytes: -5, finderAvailableBytes: 'x' },
    { at: 4, totalBytes: 100, usedBytes: 50, freeBytes: 50, finderAvailableBytes: -2 },
    null,
  ]
  const view = buildView(state, 5)
  assert.equal(view.history.length, 5)
  assert.deepEqual(view.history[0], { at: 1, totalBytes: 100, usedBytes: 50, freeBytes: 50, finderAvailableBytes: null })
  assert.equal(view.history[1].finderAvailableBytes, 80)
  assert.deepEqual(view.history[2], { at: 0, totalBytes: 0, usedBytes: 0, freeBytes: 0, finderAvailableBytes: null })
  assert.equal(view.history[3].finderAvailableBytes, null)
  assert.deepEqual(view.history[4], { at: 0, totalBytes: 0, usedBytes: 0, freeBytes: 0, finderAvailableBytes: null })
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})

test('formatGb renders decimal GB (bytes / 1e9), never GiB', () => {
  assert.equal(formatGb(994662584320), '994.7')
  assert.equal(formatGb(67795099648), '67.8')
  assert.equal(formatGb(193306023089), '193.3')
  assert.equal(formatGb(125510923441), '125.5')
  assert.equal(formatGb(1000000000), '1.0')
  assert.equal(formatGb(0), '0.0')
  assert.equal(formatGb(Number.NaN), '0.0')
  assert.equal(formatGb(null), '0.0')
})

test('recordSample caps history at 288 entries and trims the oldest', () => {
  const state = createState()
  for (let index = 0; index < 300; index += 1) {
    recordSample(state, {
      at: index,
      totalBytes: 1000,
      usedBytes: 500,
      freeBytes: 500,
      mount: '/',
      volumeName: null,
      fileSystem: null,
      percentUsed: 50,
      freePercent: 50,
      finderAvailableBytes: index,
    })
  }
  assert.equal(state.history.length, 288)
  assert.equal(state.history[0].at, 12)
  assert.equal(state.history[287].at, 299)
  assert.equal(state.history[287].finderAvailableBytes, 299)
  const view = buildView(state, 0)
  assert.equal(view.history.length, 288)
  assert.equal(view.history[0].finderAvailableBytes, 12)
})

test('buildView caps report text and error text', () => {
  const state = createState()
  state.ai = { status: 'done', sessionId: 's1', startedAt: 1, finishedAt: 2, error: 'e'.repeat(1000), report: { text: 'x'.repeat(REPORT_TEXT_LIMIT + 500), at: 3 } }
  const view = buildView(state, 4)
  assert.equal(view.ai.report.text.length, REPORT_TEXT_LIMIT)
  assert.equal(view.ai.report.at, 3)
  assert.ok(view.ai.error.length <= 500)
})

// ---------------------------------------------------------------------------
// AI inspection state machine
// ---------------------------------------------------------------------------

/** Create a state whose inspection for session `s1` is running. */
function runningAiState() {
  const state = createState()
  state.ai.status = 'running'
  state.ai.sessionId = 's1'
  state.ai.startedAt = 1000
  return state
}

test('applySessionEvent ignores unrelated sessions and non-running states', () => {
  const state = runningAiState()
  assert.equal(applySessionEvent(state.ai, 'other-session', { type: 'turn/start', time: 1, data: { turn: 1 } }), false)
  assert.equal(state.ai.status, 'running')
  assert.equal(applySessionEvent(state.ai, 's1', { type: 'tool/call', time: 1, data: {} }), false)
  state.ai.status = 'done'
  assert.equal(applySessionEvent(state.ai, 's1', { type: 'turn/end', time: 9, data: { turn: 1, reason: { kind: 'completed' } } }), false)
  assert.equal(state.ai.status, 'done')
})

test('applySessionEvent captures the last assistant text block', () => {
  const state = runningAiState()
  assert.equal(
    applySessionEvent(state.ai, 's1', {
      type: 'assistant/message',
      time: 2000,
      data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '想一下' }, { type: 'tool-call', id: 'c1', name: 'df', arguments: '{}' }], role: 'assistant' } },
    }),
    true,
  )
  assert.equal(state.ai.report, null) // tool-call-only step must not clear a report

  applySessionEvent(state.ai, 's1', {
    type: 'assistant/message',
    time: 2100,
    data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '结论：可以释放 12 GB。' }, { type: 'text', text: '\n共 3 条建议。' }], role: 'assistant' } },
  })
  assert.deepEqual(state.ai.report, { text: '结论：可以释放 12 GB。\n共 3 条建议。', at: 2100 })

  applySessionEvent(state.ai, 's1', {
    type: 'assistant/message',
    time: 2200,
    data: { turn: 1, step: 3, message: { content: [{ type: 'text', text: '最终答案' }], role: 'assistant' } },
  })
  assert.deepEqual(state.ai.report, { text: '最终答案', at: 2200 })
})

test('applySessionEvent caps a very long assistant answer', () => {
  const state = runningAiState()
  applySessionEvent(state.ai, 's1', { type: 'assistant/message', time: 1, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x'.repeat(30000) }] } } })
  assert.equal(state.ai.report.text.length, REPORT_TEXT_LIMIT)
})

test('applySessionEvent marks a completed turn done', () => {
  const state = runningAiState()
  applySessionEvent(state.ai, 's1', { type: 'turn/start', time: 1500, data: { turn: 1 } })
  applySessionEvent(state.ai, 's1', { type: 'assistant/message', time: 2000, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '好了' }] } } })
  applySessionEvent(state.ai, 's1', { type: 'turn/end', time: 3000, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(state.ai.status, 'done')
  assert.equal(state.ai.finishedAt, 3000)
  assert.equal(state.ai.error, null)
  assert.deepEqual(state.ai.report, { text: '好了', at: 2000 })
})

test('applySessionEvent marks interrupted turns as errors with a Chinese message', () => {
  const aborted = runningAiState()
  applySessionEvent(aborted.ai, 's1', { type: 'turn/end', time: 3000, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(aborted.ai.status, 'error')
  assert.equal(aborted.ai.error, '第 2 轮被中断')

  const blocked = runningAiState()
  applySessionEvent(blocked.ai, 's1', { type: 'turn/end', time: 3001, data: { turn: 3, reason: { kind: 'blocked' } } })
  assert.equal(blocked.ai.status, 'error')
  assert.equal(blocked.ai.error, '第 3 轮被阻塞')

  const failed = runningAiState()
  applySessionEvent(failed.ai, 's1', { type: 'turn/end', time: 3002, data: { turn: 4, reason: { kind: 'error', error: { message: 'rate limited' } } } })
  assert.equal(failed.ai.status, 'error')
  assert.match(failed.ai.error, /第 4 轮执行出错：rate limited/)

  const limited = runningAiState()
  applySessionEvent(limited.ai, 's1', { type: 'turn/end', time: 3003, data: { turn: 5, reason: { kind: 'max-tokens' } } })
  assert.equal(limited.ai.error, '第 5 轮达到输出长度上限')
})

test('cloneAiState / restoreAiState round-trips the previous non-running state', () => {
  const state = createState()
  state.ai = { status: 'done', sessionId: 'old', startedAt: 10, finishedAt: 20, error: null, report: { text: '旧报告', at: 15 } }
  const previous = cloneAiState(state.ai)
  // Simulate a failed attempt that clobbered the live state.
  state.ai.status = 'running'
  state.ai.sessionId = 'new'
  state.ai.report = null
  restoreAiState(state.ai, previous)
  assert.deepEqual(state.ai, previous)
  assert.equal(buildView(state, 0).ai.status, 'done')
})

// ---------------------------------------------------------------------------
// Assistant text extraction
// ---------------------------------------------------------------------------

test('extractAssistantText concatenates text blocks only', () => {
  const content = [
    { type: 'text', text: '第一段' },
    { type: 'reasoning', text: '内部推理' },
    { type: 'tool-call', id: 'c1', name: 'df', arguments: '{}' },
    { type: 'text', text: '第二段' },
    null,
    { type: 'text', text: 42 },
  ]
  assert.equal(extractAssistantText(content), '第一段第二段')
  assert.equal(extractAssistantText(null), '')
  assert.equal(extractAssistantText({}), '')
})

test('capText truncates and rejects invalid limits', () => {
  assert.equal(capText('abcdef', 3), 'abc')
  assert.equal(capText('abc', 10), 'abc')
  assert.equal(capText(42, 10), '')
  assert.equal(capText('abc', 0), '')
})

// ---------------------------------------------------------------------------
// Inspection prompt
// ---------------------------------------------------------------------------

/**
 * The real-machine view used by the prompt tests: DESIGN.md's live numbers
 * (total 994.7 GB, raw free 67.8 GB, Finder-available 193.3 GB).
 */
function realView() {
  const state = createState()
  const snapshot = deriveSnapshot({
    at: Date.UTC(2026, 10, 10, 2, 19, 24),
    root: firstDfRow(ROOT_DF_LIVE),
    data: firstDfRow(DATA_DF_LIVE),
    diskutil: parseDiskutil(DISKUTIL_INFO),
    finder: parseCapacityJson(CAPACITY_JSON),
  })
  recordSample(state, snapshot)
  return buildView(state, Date.UTC(2026, 10, 10, 2, 19, 24))
}

test('buildInspectPrompt carries the real decimal-GB numbers, volume, mount and macOS statement', () => {
  const prompt = buildInspectPrompt(realView(), new Date(2026, 10, 10, 10, 19, 24).getTime())
  // Decimal GB from DESIGN.md's live example: 994.7 total, 926.9 used, 67.8 raw free.
  assert.match(prompt, /总容量 994\.7 GB/)
  assert.match(prompt, /df\/diskutil 原始口径：实际占用 926\.9 GB（已用率 93\.2%）；原始剩余 67\.8 GB（剩余率 6\.8%）/)
  assert.match(prompt, /macOS/)
  assert.match(prompt, /卷名称：Macintosh HD/)
  assert.match(prompt, /挂载点：\//)
  assert.match(prompt, /2026-11-10 10:19:24/)
})

test('buildInspectPrompt carries both availability conventions and the purgeable explanation', () => {
  const prompt = buildInspectPrompt(realView(), 1730000000000)
  // System-Settings convention: available 193.3 GB, used = total - finder = 801.4 GB.
  assert.match(prompt, /Finder\/系统设置口径：可用 ≈ 193\.3 GB（可用率 19\.4%）；已用 ≈ 801\.4 GB（已用率 80\.6%）/)
  assert.match(prompt, /macOS「系统设置 → 储存空间」显示的就是这套（已用 = 总容量 − 可用）/)
  assert.match(prompt, /两套口径的差额即可清除空间 ≈ 125\.5 GB（约 12\.6%）/)
  assert.match(prompt, /本地 Time Machine 快照与缓存/)
  assert.match(prompt, /tmutil listlocalsnapshots \//)
  assert.match(prompt, /同时给出两套口径的数字/)
  assert.match(prompt, /Finder\/系统设置口径（可用 ≈ X GB、已用 ≈ Y GB、已用率 Z%/)
  assert.match(prompt, /df\/diskutil 原始口径（实际占用、原始剩余）/)
  assert.match(prompt, /可清除空间与真正可释放空间的区别/)
})

test('buildInspectPrompt states the System-Settings used numbers explicitly', () => {
  const prompt = buildInspectPrompt(realView(), 1730000000000)
  // The user's System Settings shows total − important-usage available; the
  // prompt must quote that convention, not only the df numbers.
  assert.match(prompt, /可用 ≈ 193\.3 GB/)
  assert.match(prompt, /已用 ≈ 801\.4 GB/)
  assert.match(prompt, /已用率 80\.6%/)
  assert.match(prompt, /实际占用 926\.9 GB/)
})

test('buildInspectPrompt still sends raw df metrics when the Finder probe is unavailable', () => {
  const state = createState()
  const snapshot = deriveSnapshot({ at: 1730000000000, root: firstDfRow(ROOT_DF), data: firstDfRow(DATA_DF), diskutil: parseDiskutil(DISKUTIL_INFO) })
  recordSample(state, snapshot)
  const prompt = buildInspectPrompt(buildView(state, 1730000000000), 1730000000000)
  assert.match(prompt, /总容量 994\.7 GB/)
  assert.match(prompt, /df\/diskutil 原始口径：实际占用 922\.2 GB（已用率 92\.7%）；原始剩余 72\.4 GB（剩余率 7\.3%）/)
  assert.match(prompt, /Finder\/系统设置口径（macOS「系统设置 → 储存空间」显示的那套）本次无法读取（容量探针失败）/)
  assert.doesNotMatch(prompt, /Finder\/系统设置口径：可用 ≈/)
  assert.doesNotMatch(prompt, /两套口径的差额即可清除空间 ≈/)
  assert.match(prompt, /tmutil listlocalsnapshots \//) // the read-only hint is still requested
})

test('buildInspectPrompt states the read-only, no-delete contract and the answer format', () => {
  const prompt = buildInspectPrompt(realView(), 1730000000000)
  assert.match(prompt, /绝不要删除、移动或修改任何文件/)
  assert.match(prompt, /只读/)
  assert.match(prompt, /df、du/)
  assert.match(prompt, /DerivedData/)
  assert.match(prompt, /Docker/)
  assert.match(prompt, /清理建议/)
  assert.match(prompt, /位置、可释放空间估计、风险等级、执行命令/)
  assert.match(prompt, /不会自动删除任何文件/)
  assert.match(prompt, /600 字以内/)
  assert.match(prompt, /总计可释放空间估计/)
  assert.match(prompt, /Disk Doctor 面板/)
  assert.match(prompt, /一句话结论/)
})

test('buildInspectPrompt falls back to a self-collect instruction without a snapshot', () => {
  const state = createState()
  const prompt = buildInspectPrompt(buildView(state, 1730000000000), 1730000000000)
  assert.match(prompt, /当前磁盘快照暂时无法读取/)
  assert.match(prompt, /df -h \//)
  assert.match(prompt, /清理建议/)
})

test('formatDateTime is defensive', () => {
  const local = new Date(2026, 0, 2, 3, 4, 5).getTime()
  assert.equal(formatDateTime(local), '2026-01-02 03:04:05')
  assert.equal(formatDateTime(Number.NaN), '未知时间')
  assert.equal(formatDateTime('x'), '未知时间')
})

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`not ok - ${name}`)
    console.error(error?.stack ?? error)
  }
}

console.log(`\n${tests.length - failed}/${tests.length} tests passed`)
if (failed > 0) process.exitCode = 1
