/**
 * Disk Doctor — Chinese inspection prompt builder for the manual AI review.
 *
 * The UI ships a Chinese default and the prompt's answer is rendered verbatim
 * in the Disk Doctor panel, so this text is authored in Chinese, asks for a
 * structured cleanup list, and forbids any destructive action. The function is
 * pure (view + clock in, string out) so the fixture test can pin its wording.
 */

import { formatGb } from './view.js'

/**
 * Pad a number to two digits.
 * @param {number} value 0..99
 * @returns {string} two-character string
 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * Format an epoch-ms timestamp as local `YYYY-MM-DD HH:mm:ss`.
 * @param {number} ms epoch milliseconds
 * @returns {string} local date/time, or a placeholder for invalid input
 */
export function formatDateTime(ms) {
  if (typeof ms !== 'number' || Number.isFinite(ms) === false) return '未知时间'
  const date = new Date(ms)
  if (Number.isFinite(date.getTime()) === false) return '未知时间'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/**
 * Format one percentage with at most one decimal.
 * @param {unknown} value candidate percentage
 * @returns {string} percentage string without the `%` sign
 */
function formatPercent(value) {
  if (typeof value !== 'number' || Number.isFinite(value) === false) return '0'
  return String(Math.round(value * 10) / 10)
}

/**
 * Build the Chinese inspection prompt sent as the first user message of the
 * inspection Session.
 *
 * The design requires the prompt to carry the current numbers, the volume,
 * date/time, a macOS statement, the read-only / structured-suggestion request,
 * and the note that the final answer appears in the Disk Doctor panel and must
 * start with a one-line conclusion.
 *
 * @param {object} view current view JSON from `buildView`
 * @param {number} [now] current wall-clock time (epoch ms)
 * @returns {string} the prompt text
 */
export function buildInspectPrompt(view, now = Date.now()) {
  const safeView = view !== null && typeof view === 'object' ? view : {}
  const snapshot = safeView.snapshot !== null && typeof safeView.snapshot === 'object' ? safeView.snapshot : null
  const lines = []

  lines.push('你是一台 macOS 机器的磁盘巡检助手，只做只读检查，绝不要删除、移动或修改任何文件。')
  lines.push('')

  if (snapshot === null) {
    lines.push(`当前磁盘快照暂时无法读取（采集失败，时间：${formatDateTime(now)}）。请先用 df -h / 与 df -h /System/Volumes/Data 自行确认磁盘占用，再给出清理建议。`)
    lines.push('')
  } else {
    const volume = typeof snapshot.volumeName === 'string' && snapshot.volumeName !== '' ? snapshot.volumeName : '未知'
    const fileSystem = typeof snapshot.fileSystem === 'string' && snapshot.fileSystem !== '' ? snapshot.fileSystem : '未知'
    const mount = typeof snapshot.mount === 'string' && snapshot.mount !== '' ? snapshot.mount : '/'
    const finderAvailable = typeof snapshot.finderAvailableBytes === 'number' && Number.isFinite(snapshot.finderAvailableBytes) ? snapshot.finderAvailableBytes : null
    const purgeable = typeof snapshot.purgeableBytes === 'number' && Number.isFinite(snapshot.purgeableBytes) ? snapshot.purgeableBytes : null
    const total = typeof snapshot.totalBytes === 'number' && Number.isFinite(snapshot.totalBytes) && snapshot.totalBytes > 0 ? snapshot.totalBytes : 0
    // System-Settings convention: used = total - finderAvailable. Clamp the
    // derived numbers defensively so a weird probe can never print a negative.
    const systemUsed = finderAvailable === null ? null : Math.max(0, total - finderAvailable)
    const systemUsedPercent = systemUsed === null || total === 0 ? null : Math.min(100, Math.max(0, (systemUsed / total) * 100))
    const availablePercent = finderAvailable === null || total === 0 ? null : Math.min(100, Math.max(0, (finderAvailable / total) * 100))

    lines.push(
      `当前磁盘状态（采样时间：${formatDateTime(snapshot.at)}；当前时间：${formatDateTime(now)}；卷名称：${volume}；挂载点：${mount}；文件系统：${fileSystem}）：`,
      `- 总容量 ${formatGb(snapshot.totalBytes)} GB。`,
      `- df/diskutil 原始口径：实际占用 ${formatGb(snapshot.usedBytes)} GB（已用率 ${formatPercent(snapshot.percentUsed)}%）；原始剩余 ${formatGb(snapshot.freeBytes)} GB（剩余率 ${formatPercent(snapshot.freePercent)}%）。`,
    )
    if (finderAvailable !== null && systemUsed !== null && systemUsedPercent !== null && availablePercent !== null) {
      lines.push(
        `- Finder/系统设置口径：可用 ≈ ${formatGb(finderAvailable)} GB（可用率 ${formatPercent(availablePercent)}%）；已用 ≈ ${formatGb(systemUsed)} GB（已用率 ${formatPercent(systemUsedPercent)}%）；macOS「系统设置 → 储存空间」显示的就是这套（已用 = 总容量 − 可用）。`,
      )
      if (purgeable !== null) {
        lines.push(`- 两套口径的差额即可清除空间 ≈ ${formatGb(purgeable)} GB（约 ${formatPercent(total > 0 ? (purgeable / total) * 100 : 0)}%）；常见来源是本地 Time Machine 快照与缓存（系统会在需要时自动回收），可用只读命令 tmutil listlocalsnapshots / 核对。`)
      } else {
        lines.push('- 两套口径的差额即可清除空间（常见来源：本地 Time Machine 快照与缓存，可用只读命令 tmutil listlocalsnapshots / 核对）。')
      }
    } else {
      lines.push('- Finder/系统设置口径（macOS「系统设置 → 储存空间」显示的那套）本次无法读取（容量探针失败），仅提供 df/diskutil 原始口径。')
    }
    lines.push('')
  }

  lines.push(
    '请立即巡检磁盘占用（可用 df、du 等只读命令深入检查用户目录缓存、日志、下载、Xcode DerivedData、Docker/包管理器缓存等常见占用点，注意超时与只读）。',
    '输出结构化「清理建议」清单：每项给出位置、可释放空间估计、风险等级、执行命令（仅建议，不执行）。',
    '同时给出两套口径的数字：Finder/系统设置口径（可用 ≈ X GB、已用 ≈ Y GB、已用率 Z%，macOS「系统设置 → 储存空间」显示的就是这套），以及 df/diskutil 原始口径（实际占用、原始剩余）；两者差额即可清除空间。若存在大量可清除空间，说明其常见来源（本地 Time Machine 快照、缓存）并给出只读的核对命令（如 tmutil listlocalsnapshots /），并说明可清除空间与真正可释放空间的区别。',
    '明确说明本插件不会自动删除任何文件，执行前由用户确认。',
    '回答控制在 600 字以内，最后给出总计可释放空间估计。',
    '',
    '注意：你的最终回答会直接显示在 Disk Doctor 面板中，请第一行先给出一句话结论。',
  )

  return lines.join('\n')
}
