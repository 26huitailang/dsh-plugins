# Disk Doctor — plugin contract (authoritative for both halves)

Package directory: `disk-doctor/` in the workspace. Install target: absolute path of that directory.
Package name (also the client module loader id): `@local/disk-doctor`.

## What this plugin does

A left-sidebar entry in the DSH Web UI opens a global main-area page that shows macOS disk
space. **All byte counts are rendered in decimal GB (`bytes / 1e9`) like every macOS system
tool (Finder, About This Mac, `df -H`, `du -h`, `diskutil`); never GiB.** A **Host half** samples disk usage with local macOS commands on a timer — scripted,
no model involved — keeps a small history, and serves the data to the page over the
authenticated Connection Fetch channel. A manual button on the page asks the **Host half**
to start a real Agent Session (LLM) with a prepared inspection prompt: the model inspects
the disk, proposes cleanup actions, and its final answer is captured back into the panel.
Nothing ever deletes data.

## Files and ownership (do not edit files outside your scope)

| File | Owner | Purpose |
|---|---|---|
| `disk-doctor/index.js` | host-engine | Host plugin entry (`apply`) |
| `disk-doctor/lib/*.js` | host-engine | Pure/collector helpers, unit-testable with node |
| `disk-doctor/client.js` | client-ui | Browser module (`window.__ModuleLoader__.load`) |
| `disk-doctor/DESIGN.md`, `package.json`, `cordis.patch.yml`, `icon.svg`, `locale/*.json` | Lead | Fixed contract/scaffold — read only |
| `disk-doctor/tests/**` | host-engine | Node unit tests for collector |
| `disk-doctor/.verify/**` | verifier | Screenshots/logs only |

## Host half (`index.js`)

Export form:

```js
export const inject = ['connection']
export function apply(ctx, config) { /* registers everything with ctx.effect/ctx.events */ }
```

- `connection` is required for the Fetch routes. Resolve optional services with
  `ctx.get('sessionController')` etc.; never throw when one is missing — the page then
  reports the AI feature as unavailable.
- All timers/listeners/routes must be created through `ctx.effect(() => disposer)` (or
  `ctx.on`) so plugin unload removes them. Cleanup on unload must be safe.

### 1. Scripted periodic collection (NO model)

- Sample immediately after activation, then every `sampleIntervalMs` (default 300000 ms;
  read `config.sampleIntervalMs` when present, clamp to >= 60000).
- Run local macOS commands with `node:child_process.execFile` (never shell string
  interpolation). Use a hard timeout (default 15000 ms). APFS on macOS reports the
  read-only system volume for `/`, and Finder/About This Mac use a *different free-space
  metric* than `df`, so the snapshot carries **two** availability numbers:
  - `execFile('/bin/df', ['-P', '-k', '/System/Volumes/Data'])` → authoritative raw
    `Available` and `Used` for user data (fall back to `df -P -k /` when the Data volume
    is missing, e.g. other filesystems/CI);
  - `execFile('/bin/df', ['-P', '-k', '/'])` → volume/container `1024-blocks` total and
    mount point;
  - `execFile('/usr/sbin/diskutil', ['info', '/'])` best-effort → `Volume Name:` and
    `File System Personality:`;
  - Finder-equivalent availability, best effort, via JXA/ObjC:
    `execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', <CAPACITY_SCRIPT>])`
    where `CAPACITY_SCRIPT` calls
    `NSURL.fileURLWithPath('/').resourceValuesForKeysError(
      ['NSURLVolumeAvailableCapacityForImportantUsageKey',
       'NSURLVolumeAvailableCapacityKey',
       'NSURLVolumeTotalCapacityKey'], ...)`
    and prints `JSON.stringify({ importantUsage, capacity, total })` (plain JS string
    keys work; the `$.NSURL...` constants do not bridge reliably). This is the number
    Finder and System Settings show as "available"; it includes purgeable space (local
    Time Machine snapshots, caches). Any failure leaves both Finder fields `null`.
- Derive: `totalBytes = dfTotalBlocks * 1024`; `freeBytes = dataAvailableBlocks * 1024`;
  `usedBytes = max(0, totalBytes - freeBytes)`; `percentUsed = usedBytes/totalBytes*100`
  (1 decimal); `freePercent = 100 - percentUsed`. Clamp percentages to 0..100.
  `finderAvailableBytes = importantUsage` when it is a finite non-negative integer and
  `<= totalBytes * 2`, else `null`; `purgeableBytes = finderAvailableBytes === null ?
  null : max(0, finderAvailableBytes - freeBytes)`.
- Expected live values on an example APFS machine (994.7 GB container): total `994662584320` B (994.7 GB),
  raw `freeBytes ≈ 67.8 GB`, `finderAvailableBytes ≈ 193.3 GB` (about 125.5 GB
  purgeable, incl. a local Time Machine snapshot). The old GiB display showed
  "926.4 GB / 63.1 GB" and must never be used for labels again.
- Parse `df -P` columns robustly: the header is followed by
  `<fs> <blocks> <used> <available> <capacity> <mount...>` and the filesystem column may
  contain spaces, so split on whitespace and take fixed positions from the end for the
  numeric columns; keep the mount column joining the remainder. Ignore lines that do not
  parse. Collect must return an error (not crash) when both `df` invocations fail.
- Keep `history`: last <= 288 samples of `{at, totalBytes, usedBytes, freeBytes, finderAvailableBytes}`.
- Collector state: `{lastStartedAt, lastFinishedAt, lastError, lastDurationMs}`.
- Errors must never crash the Host: capture into `lastError`, keep the previous snapshot.

### 2. Fetch routes (authenticated Connection Fetch channel)

Registered with `ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })`.
Paths must satisfy the channel rules (segments `[A-Za-z0-9_$.-]+`). `fetch` receives the
already-authenticated owner `Request`; return `Response.json(body, { headers: { 'cache-control': 'no-store' } })`.
The client calls them as browser-relative URLs (`fetch('api/disk-doctor.snapshot')`).

| Method | Path | Effect |
|---|---|---|
| GET | `/api/disk-doctor.snapshot` | current view (below) |
| POST | `/api/disk-doctor.collect` | collect now (scripted, no model), then return view |
| POST | `/api/disk-doctor.inspect` | start one LLM inspection Session, return `{ok, sessionId}` or `{ok:false, error:{code,message}}` |

View JSON (all fields always present, JSON-safe):

```json
{
  "ok": true,
  "generatedAt": 1730000000000,
  "snapshot": {
    "at": 1730000000000,
    "mount": "/",
    "volumeName": "Macintosh HD",
    "fileSystem": "apfs",
    "totalBytes": 994662584320,
    "usedBytes": 926867484672,
    "freeBytes": 67795099648,
    "percentUsed": 93.2,
    "freePercent": 6.8,
    "finderAvailableBytes": 193306023089,
    "purgeableBytes": 125510923441
  },
  "history": [{ "at": 0, "totalBytes": 0, "usedBytes": 0, "freeBytes": 0, "finderAvailableBytes": 0 }],
  "collector": { "lastStartedAt": 0, "lastFinishedAt": 0, "lastDurationMs": 0, "lastError": null },
  "config": { "sampleIntervalMs": 300000, "historyLimit": 288 },
  "ai": {
    "status": "idle",
    "sessionId": null,
    "startedAt": null,
    "finishedAt": null,
    "error": null,
    "report": null
  }
}
```

- `snapshot` is `null` before the first successful sample (JSON `null`, not omitted).
- `finderAvailableBytes` / `purgeableBytes` are `null` when the JXA probe is unavailable
  (the server still works; the page falls back to the raw df convention then).
- Every `history` row carries the same `at/totalBytes/usedBytes/freeBytes` as before plus
  a nullable `finderAvailableBytes` so the page can plot the System-Settings convention
  (used = total - finderAvailable) with a raw-df fallback for older rows.
- `ai.status`: `idle` | `running` | `done` | `error`.
- `ai.report`: `null` or `{ "text": "<assistant final text>", "at": <ms> }`, text capped at
  20000 chars.
- Bad request bodies must answer with a JSON `{ok:false,error}` — never throw out of `fetch`.
- Never expose anything beyond the shape above.

### 3. Manual LLM inspection (`POST /api/disk-doctor.inspect`)

Only one inspection may run at a time; a second POST while `ai.status === 'running'`
returns `{ok:false,error:{code:'busy',message:'...'}}` with HTTP 200 (the panel renders it).

Steps (all inside the request handler, returning quickly):

1. Require the optional `sessionController` service; if absent return
   `{ok:false,error:{code:'unavailable',...}}`.
2. `const created = await sessionController.create({})` → `{sessionId}`. The default
   workspace/cwd is fine; do not invent a workspace.
3. `await sessionController.prompt({ requestId: crypto.randomUUID(), sessionId, mode: 'queue',
   content: [{ type: 'text', text: buildInspectPrompt(view) }] }, abortSignal)`.
   Use a 15 s timeout AbortController. Text content part is `{type:'text', text}`.
4. On success set `ai = {status:'running', sessionId, startedAt: Date.now(), ...}` and start
   tracking that session; return `{ok:true, sessionId}`.
5. Failures return `{ok:false,error:{code:'start-failed',message}}` and restore `ai` to its
   previous non-running values.

Tracking (LLM output capture), registered once during `apply`:

```js
ctx.on('session/event', (session, event) => { /* only when session.id === ai.sessionId */ })
```

- `event.type === 'assistant/message'`: `event.data.message.content` is an array of blocks;
  concatenate blocks with `type === 'text'` (`block.text`). The last assistant message
  becomes/updates `ai.report.text` (cap 20000 chars), `ai.report.at = event.time`.
- `event.type === 'turn/end'`: `event.data.reason.kind` — `'completed'` → `ai.status='done'`,
  `finishedAt = event.time`; any other kind → `ai.status='error'`,
  `ai.error = '第 N 轮被中断'`-style message (`turn` is in `event.data.turn`).
- `event.type === 'turn/start'` while tracking may set `status='running'`.

`buildInspectPrompt(view)` must be a Chinese instruction because the UI ships zh default;
it must include: current snapshot numbers (total/used/free in GB and percent), date/time,
the mounted volume, a statement that this is a macOS machine, the concrete request —

- 巡检磁盘占用（可用 `df`、`du` 等只读命令深入检查用户目录缓存、日志、下载、Xcode
  DerivedData、Docker/包管理器缓存等常见占用点，注意超时与只读）；
- 输出结构化「清理建议」清单：每项给出位置、可释放空间估计、风险等级、执行命令（仅建议，不执行）；
- 明确说明本插件不会自动删除任何文件，执行前由用户确认；
- 同时给出两套口径的数字：Finder/系统设置口径（可用 ≈ X GB、已用 ≈ Y GB、已用率 Z%，
  macOS「系统设置 → 储存空间」显示的就是这套），以及 df/diskutil 原始口径（实际占用、
  原始剩余）；两者差额即可清除空间。若存在大量可清除空间，说明其常见来源（本地
  Time Machine 快照、缓存）并给出只读的核对命令（如 `tmutil listlocalsnapshots /`）；
- 回答控制在 600 字以内，最后给出总计可释放空间估计。

Also state the final answer is rendered in the Disk Doctor panel, so the answer must start
with a one-line conclusion. No tool registration is required on the Host half.

### 4. Config

Read only `config.sampleIntervalMs` and `config.diskCommandTimeoutMs` when they are positive
integers; otherwise fall back to defaults (300000 / 15000). No `export const Config` needed.

## Client half (`client.js`)

Format (copy of a working installed bundle): `window.__ModuleLoader__.load({ id: '@local/disk-doctor', factory(require) { ... return { inject: [...], apply(ctx) {...} } } })`.
Only `require('react')` (platform module table). No other imports, no `@deepseek-ai/*` imports.

```js
return {
  inject: ['slots', 'locale', 'layout'],
  apply(ctx) { /* ctx.effect for every registration */ },
}
```

- Locale: `const NS = 'diskDoctor'`; register en + zh dicts via
  `ctx.effect(() => ctx.locale.register(NS, { en: {...}, zh: {...} }), 'disk-doctor: locale')`;
  `const t = ctx.locale.bind(NS)`. All visible text through `t(...)`.
- Sidebar launcher:
  `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist',
    id: 'disk-doctor', order: 20, label: () => t('panel.title'), locale: NS }, DiskDoctorIcon))`.
  The icon component receives `{ size, active }` and renders an original hard-drive SVG at
  `size` px using `currentColor` (no hard-coded fill for the glyph; inherited color is the
  host's selected/unselected state).
- Main page:
  `ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'disk-doctor', locale: NS }, DiskDoctorPage))`.
- Selecting the panel is the sidebar's job. A "返回对话" button calls
  `ctx.get('layout')?.selectPanel('conversation')`.
- Data: browser-relative fetch, polling every 5000 ms while the page is mounted:
  `fetch('api/disk-doctor.snapshot', { cache: 'no-store' })`. Manual refresh:
  POST `'api/disk-doctor.collect'`. AI: POST `'api/disk-doctor.inspect'` then
  `ctx.get('uiWorkspace')?.openSession(sessionId)` (returns the main area to the
  Conversation; guard against undefined). All fetch failures render a retryable error state
  with the HTTP status/message; the last good data stays visible.
- Component state: no global stores, no DOM outside the component, no `document.body`
  writes. Cleanup intervals in `useEffect` return.
- Unit convention: every GB value is decimal (`bytes / 1e9`), matching the system.
  **System Settings is the reference the user compares against**, so make its convention
  the headline; the raw df convention stays visible as secondary data:
  - headline label `可用空间`, value = `finderAvailableBytes` (fallback `freeBytes` when
    the probe is null), unit GB, and a one-line explanation when it comes from the Finder
    probe;
  - capacity line = `已用 <total - finderAvailable> GB / 共 <total> GB · <systemUsedPercent>%`
    (this reproduces System Settings exactly, e.g. 已用 799.7 GB / 994.7 GB · 80.4%);
  - ring = system-available percent (`finderAvailableBytes / totalBytes`), drawn from two
    arcs: the raw-free share solid and the purgeable share in a lighter tone of the same
    semantic color; center label `可用`;
  - secondary rows: `原始剩余（df/diskutil 口径）≈ <freeBytes> GB` and
    `可清除空间 ≈ <purgeableBytes> GB`, plus the explanation that System Settings counts
    purgeable space (local snapshots, caches) as available while df/diskutil raw free
    does not;
  - when the probe is null: headline falls back to raw `freeBytes`, ring uses
    `freePercent`, no purgeable row, explanation hidden. Never show GiB.
- Manual refresh feedback: on a successful POST collect, briefly render
  `已刷新 · 采样于 HH:mm:ss` (auto-hide after ~4 s, cleared on unmount) so a user can
  tell the script ran even when the disk numbers did not change; keep the sampled-at
  timestamp visible at all times.
- Styling: only theme tokens listed by `cordis_inspect_query` (Theme provider):
  `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`,
  `--dsw-alias-border-l1`, `--dsw-alias-border-l2`, `--dsw-alias-brand-primary`,
  `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`,
  `--dsw-alias-state-success-primary`, `--dsw-alias-state-warn-primary`,
  `--dsw-alias-state-error-primary`, `--dsw-alias-state-idle-primary`.
  No literal colors. Render one `<style>` element as a child of the page root with unique
  class names (e.g. `.dd-*`); React removes it on unmount. Inherit host font size/family;
  no external fonts.
- Page content (first version, keep it focused):
  1. Header row: title + subtitle, "返回对话" ghost button.
  2. Hero card: SVG ring gauge for free percent (or usage percent) with "剩余 X GB" in the
     middle, "共 Y GB · 已用 Z%" below, plus volume name/mount and the sample time.
  3. Small status row: auto-sample interval ("每 5 分钟自动采集"), last collection error if any,
     "立即刷新" button, spinner while refreshing.
  4. History strip: last 48 samples as thin vertical bars. Plot the System-Settings used
     percent (`(totalBytes - finderAvailableBytes)/totalBytes`) when the row carries
     `finderAvailableBytes`, otherwise the raw-df used percent; the card title/hint names
     the convention so the two never look contradictory. Min/max labels, no chart library.
  5. AI 巡检 card: description, "AI 巡检并生成清理建议" primary button, disabled + spinner while
     `ai.status === 'running'`; when `ai.report` exists render the report text in a scrollable
     pre-wrap block (max-height ~320px) plus "打开会话" button when `ai.sessionId`; show
     `ai.error`. Mark clearly that the model only suggests — the plugin never deletes files.
- Accessibility: real `<button>` elements, `aria-live="polite"` for async status, clear
  focus outline via `outline-color: var(--dsw-alias-brand-primary)`, keyboard operable.
- Text: zh + en dictionaries, sentence case English. Number formatting: use
  `Intl.NumberFormat` with the active locale.
- The page must work in both light and dark themes and at narrow widths (min-width 360px);
  content column max-width ~720px, centered, scrolls vertically.

## Verification each owner runs

- `node --check index.js client.js lib/*.js` from the package directory.
- `node disk-doctor/tests/collector.test.js` for collector parsing (host-engine writes
  fixture-based tests; they must run without network and use only node builtins).
- Read back every file you wrote; report exact file list and any deviations from this doc.
- Do not run `plugin_manager`; the Lead installs and verifies in the live page.
