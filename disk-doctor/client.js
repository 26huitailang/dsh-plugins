/**
 * Disk Doctor — browser half.
 *
 * Contributes one global sidebar entry (`disk-doctor`) that opens the matching
 * keyed main-area page. The page polls the Host half through browser-relative
 * Connection Fetch routes, renders a scripted disk-space snapshot with a small
 * history, and starts a manual model inspection on request.
 *
 * Only `react` comes from the platform module table. All styling is rendered as
 * one scoped `<style>` child of the page root and uses only `--dsw-alias-*`
 * theme tokens, so the page follows the host theme in light and dark mode.
 *
 * Contract: see DESIGN.md (Client half) in this package.
 */
window.__ModuleLoader__.load({
  id: '@local/disk-doctor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    /** Locale namespace owned by this plugin. */
    const NS = 'diskDoctor';
    /** Id shared by the sidebar entry and the main panel it addresses. */
    const PANEL_ID = 'disk-doctor';
    /** Page heading id used for the section's accessible name. */
    const HEADING_ID = 'dd-page-heading';
    /** Browser-relative Connection Fetch routes served by the Host half. */
    const SNAPSHOT_ROUTE = 'api/disk-doctor.snapshot';
    const COLLECT_ROUTE = 'api/disk-doctor.collect';
    const INSPECT_ROUTE = 'api/disk-doctor.inspect';
    /** Snapshot polling period while the page is mounted. */
    const POLL_INTERVAL_MS = 5000;
    /** How long the manual-refresh confirmation chip stays visible. */
    const REFRESHED_FEEDBACK_MS = 4000;
    /** How many trailing history samples the strip draws. */
    const HISTORY_BARS = 48;
    /** macOS renders disk sizes in decimal GB: one GB is 1e9 bytes, never GiB. */
    const BYTES_PER_GB = 1e9;

    const LOCALE_DICTIONARIES = {
      en: {
        'panel.title': 'Disk doctor',
        'page.title': 'Disk doctor',
        'page.subtitle': 'macOS disk space and cleanup advice',
        'page.back': 'Back to conversation',
        'loading.title': 'Reading disk space…',
        'loading.hint': 'The first sample can take a few seconds',
        'empty.title': 'No disk data yet',
        'empty.hint': 'The Host has not finished its first sample, or the disk is currently unavailable.',
        'empty.action': 'Sample now',
        'loadFailed.title': 'Could not load disk data',
        'loadFailed.hint': 'Disk doctor needs the local Host connection to read disk space.',
        'error.load': 'Could not load disk data: {message}',
        'error.refresh': 'Refresh failed: {message}',
        'error.host': 'Host error: {message}',
        'error.http': 'Request failed (HTTP {status})',
        'error.network': 'Network request failed',
        'error.badResponse': 'The Host returned an unexpected response',
        'error.retry': 'Retry',
        'hero.title': 'Disk overview',
        'hero.freeLabel': 'Free space',
        'hero.availableLabel': 'Available space',
        'hero.availableHint': 'Matches Finder and System Settings, including purgeable space',
        'hero.ringLabel': 'Free',
        'hero.ringLabelAvailable': 'Available',
        'hero.ringAria': '{percent}% of disk free',
        'hero.ringAriaSystem': '{available}% available, {purgeable}% purgeable',
        'hero.capacity': '{used} GB used / {total} GB total · {percent}% used',
        'hero.rawFreeLabel': 'Raw free (df/diskutil)',
        'hero.purgeableLabel': 'Purgeable space',
        'hero.approxGb': '≈ {value} GB',
        'hero.differentConventionsNote': 'Finder and System Settings count purgeable space (local snapshots, caches) as available; raw df/diskutil free space does not include it.',
        'hero.sampledAt': 'Sampled {time}',
        'status.auto': 'Auto-samples every {interval}',
        'status.autoFallback': 'Automatic sampling',
        'status.duration': 'Last sample took {duration}',
        'status.error': 'Last sample failed: {message}',
        'status.refreshing': 'Refreshing…',
        'status.refreshed': 'Refreshed · sampled at {time}',
        'action.refresh': 'Refresh now',
        'action.dismiss': 'Dismiss',
        'interval.minutes': '{count} min',
        'interval.seconds': '{count} s',
        'duration.ms': '{value} ms',
        'duration.seconds': '{value} s',
        'history.title': 'Usage trend · df convention',
        'history.titleSystem': 'Usage trend · system convention',
        'history.summary': 'Last {count} samples · min {min}% · max {max}%',
        'history.summarySystem': 'Last {count} samples · system convention min {min}% · max {max}%',
        'history.aria': 'Across the last {count} samples, disk usage ranged from {min}% to {max}%.',
        'history.ariaSystem': 'Across the last {count} samples, system-convention disk usage ranged from {min}% to {max}%.',
        'history.barTitle': '{time} · {percent}% used',
        'history.barTitleSystem': '{time} · {percent}% used (system convention)',
        'history.empty': 'No history yet',
        'ai.title': 'AI inspection',
        'ai.description': 'Starts a model session that inspects caches, logs, downloads, and developer-tool caches read-only, then proposes cleanup steps.',
        'ai.state.idle': 'Not inspected yet',
        'ai.state.running': 'Inspection running',
        'ai.state.done': 'Inspection complete',
        'ai.state.error': 'Inspection interrupted',
        'ai.runningHint': 'The model is inspecting the disk. Its report appears here when ready.',
        'ai.button': 'Inspect with AI',
        'ai.buttonStarting': 'Starting inspection…',
        'ai.buttonRunning': 'Inspecting…',
        'ai.openSession': 'Open session',
        'ai.reportTitle': 'Cleanup suggestions',
        'ai.reportAt': 'Finished {time}',
        'ai.finishedAt': 'Finished {time}',
        'ai.error.busy': 'An inspection is already running.',
        'ai.error.unavailable': 'Model sessions are unavailable in this deployment.',
        'ai.error.failed': 'Inspection failed: {message}',
        'ai.note': 'The model only suggests. This plugin never deletes files; review every command before running it.',
      },
      zh: {
        'panel.title': '磁盘医生',
        'page.title': '磁盘医生',
        'page.subtitle': 'macOS 磁盘占用与清理建议',
        'page.back': '返回对话',
        'loading.title': '正在读取磁盘空间…',
        'loading.hint': '首次采集可能需要几秒钟',
        'empty.title': '还没有磁盘数据',
        'empty.hint': 'Host 尚未完成第一次采集，或者这块磁盘暂时不可用。',
        'empty.action': '立即采集',
        'loadFailed.title': '无法读取磁盘数据',
        'loadFailed.hint': '磁盘医生需要连接本机 Host 才能读取磁盘空间。',
        'error.load': '读取磁盘数据失败：{message}',
        'error.refresh': '刷新失败：{message}',
        'error.host': '服务返回错误：{message}',
        'error.http': '请求失败（HTTP {status}）',
        'error.network': '网络请求失败',
        'error.badResponse': '服务返回了无法识别的数据',
        'error.retry': '重试',
        'hero.title': '磁盘概况',
        'hero.freeLabel': '剩余空间',
        'hero.availableLabel': '可用空间',
        'hero.availableHint': '与 Finder/系统设置口径一致，含可清除空间',
        'hero.ringLabel': '剩余',
        'hero.ringLabelAvailable': '可用',
        'hero.ringAria': '磁盘剩余 {percent}%',
        'hero.ringAriaSystem': '可用 {available}%，其中可清除 {purgeable}%',
        'hero.capacity': '已用 {used} GB / 共 {total} GB · {percent}%',
        'hero.rawFreeLabel': '原始剩余（df/diskutil 口径）',
        'hero.purgeableLabel': '可清除空间',
        'hero.approxGb': '≈ {value} GB',
        'hero.differentConventionsNote': 'Finder 和系统设置把可清除空间（本地快照、缓存）算作可用空间，而 df/diskutil 的原始剩余不包含它。',
        'hero.sampledAt': '采样于 {time}',
        'status.auto': '每 {interval}自动采集',
        'status.autoFallback': '自动采集',
        'status.duration': '上次耗时 {duration}',
        'status.error': '采集失败：{message}',
        'status.refreshing': '正在刷新…',
        'status.refreshed': '已刷新 · 采样于 {time}',
        'action.refresh': '立即刷新',
        'action.dismiss': '关闭',
        'interval.minutes': '{count} 分钟',
        'interval.seconds': '{count} 秒',
        'duration.ms': '{value} 毫秒',
        'duration.seconds': '{value} 秒',
        'history.title': '占用趋势 · df 口径',
        'history.titleSystem': '占用趋势 · 系统口径',
        'history.summary': '最近 {count} 次采样 · 最低 {min}% · 最高 {max}%',
        'history.summarySystem': '最近 {count} 次采样 · 系统口径最低 {min}% · 最高 {max}%',
        'history.aria': '最近 {count} 次采样中，磁盘已用比例在 {min}% 到 {max}% 之间。',
        'history.ariaSystem': '最近 {count} 次采样中，系统口径的磁盘已用比例在 {min}% 到 {max}% 之间。',
        'history.barTitle': '{time} · 已用 {percent}%',
        'history.barTitleSystem': '{time} · 系统口径已用 {percent}%',
        'history.empty': '还没有历史数据',
        'ai.title': 'AI 巡检',
        'ai.description': '启动一个模型会话，只读检查缓存、日志、下载和开发工具缓存等常见占用点，并给出可执行的清理建议。',
        'ai.state.idle': '尚未巡检',
        'ai.state.running': '巡检进行中',
        'ai.state.done': '巡检完成',
        'ai.state.error': '巡检中断',
        'ai.runningHint': '模型正在查看磁盘，报告完成后会显示在这里。',
        'ai.button': 'AI 巡检并生成清理建议',
        'ai.buttonStarting': '正在启动巡检…',
        'ai.buttonRunning': '正在巡检…',
        'ai.openSession': '打开会话',
        'ai.reportTitle': '清理建议',
        'ai.reportAt': '完成于 {time}',
        'ai.finishedAt': '完成于 {time}',
        'ai.error.busy': '已有一次巡检正在进行。',
        'ai.error.unavailable': '此部署无法启动模型会话。',
        'ai.error.failed': '巡检失败：{message}',
        'ai.note': '模型只会给出建议：本插件不会自动删除任何文件，执行清理命令前请自行确认。',
      },
    };

    /* ------------------------------------------------------------------ *
     * Small value/format helpers.                                        *
     * ------------------------------------------------------------------ */

    /** @returns {number|null} a finite number, or null for anything else. */
    function numberOrNull(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    /** @returns {number|null} a positive epoch-millisecond timestamp, or null. */
    function timestampOrNull(value) {
      const number = numberOrNull(value);
      return number !== null && number > 0 ? number : null;
    }

    /** @returns {number|null} a usable non-negative Finder-available byte count. */
    function finderAvailableOf(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return null;
      const value = numberOrNull(snapshot.finderAvailableBytes);
      return value !== null && value >= 0 ? value : null;
    }

    /** Clamp a percentage into 0..100 (unknown values become 0). */
    function clampPercent(value) {
      const number = numberOrNull(value);
      if (number === null) return 0;
      return Math.min(100, Math.max(0, number));
    }

    /** @returns {number|null} a percentage clamped into 0..100, or null. */
    function percentOrNull(value) {
      const number = numberOrNull(value);
      if (number === null) return null;
      return Math.min(100, Math.max(0, number));
    }

    /** Read the user-facing message out of a Host error shape (string or object). */
    function errorMessageOf(value) {
      if (typeof value === 'string') return value.trim();
      if (value && typeof value === 'object') {
        if (typeof value.message === 'string') return value.message.trim();
        if (typeof value.error === 'string') return value.error.trim();
      }
      return '';
    }

    /** Read the message out of a whole response body's `error` field. */
    function readErrorMessage(body) {
      if (!body || typeof body !== 'object') return '';
      return errorMessageOf(body.error);
    }

    /** @returns {Intl.NumberFormat} a formatter that degrades to the default locale. */
    function numberFormatter(locale, options) {
      try {
        return new Intl.NumberFormat(locale || undefined, options || {});
      } catch (error) {
        return new Intl.NumberFormat(undefined, options || {});
      }
    }

    /** Format a byte count as a decimal GB number string (unit rendered separately). */
    function formatGigabytes(bytes, locale) {
      const number = numberOrNull(bytes);
      if (number === null || number < 0) return '—';
      return numberFormatter(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }).format(number / BYTES_PER_GB);
    }

    /** Format a percent with at most one decimal; unknown values show an em dash. */
    function formatPercent(value, locale) {
      const number = percentOrNull(value);
      if (number === null) return '—';
      return numberFormatter(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }).format(number);
    }

    /** Format an epoch-millisecond timestamp as a local wall-clock time. */
    function formatTime(value, locale) {
      const timestamp = timestampOrNull(value);
      if (timestamp === null) return '';
      try {
        return new Intl.DateTimeFormat(locale || undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(new Date(timestamp));
      } catch (error) {
        return new Date(timestamp).toLocaleTimeString();
      }
    }

    /** Format a sampling interval as a localized minute/second phrase. */
    function formatInterval(value, t, locale) {
      const number = numberOrNull(value);
      if (number === null || number <= 0) return '';
      if (number >= 60000) {
        return t('interval.minutes', {
          count: numberFormatter(locale, { maximumFractionDigits: 0 }).format(Math.round(number / 60000)),
        });
      }
      return t('interval.seconds', {
        count: numberFormatter(locale, { maximumFractionDigits: 0 }).format(Math.round(number / 1000)),
      });
    }

    /** Format a collection duration for the status row. */
    function formatDuration(value, t, locale) {
      const number = numberOrNull(value);
      if (number === null || number < 0) return '';
      if (number < 1000) return t('duration.ms', { value: String(Math.round(number)) });
      return t('duration.seconds', {
        value: numberFormatter(locale, { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(number / 1000),
      });
    }

    /** Derive the display metrics from one snapshot, tolerating partial data. */
    function metricsOf(snapshot) {
      const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
      const totalBytes = numberOrNull(source.totalBytes);
      let freeBytes = numberOrNull(source.freeBytes);
      let usedBytes = numberOrNull(source.usedBytes);
      if (usedBytes === null && totalBytes !== null && freeBytes !== null) {
        usedBytes = Math.max(0, totalBytes - freeBytes);
      }
      if (freeBytes === null && totalBytes !== null && usedBytes !== null) {
        freeBytes = Math.max(0, totalBytes - usedBytes);
      }
      let percentUsed = percentOrNull(source.percentUsed);
      if (percentUsed === null && totalBytes !== null && totalBytes > 0 && usedBytes !== null) {
        percentUsed = clampPercent((usedBytes / totalBytes) * 100);
      }
      let freePercent = percentOrNull(source.freePercent);
      if (freePercent === null && percentUsed !== null) freePercent = clampPercent(100 - percentUsed);
      if (freePercent === null && totalBytes !== null && totalBytes > 0 && freeBytes !== null) {
        freePercent = clampPercent((freeBytes / totalBytes) * 100);
      }
      return { totalBytes, usedBytes, freeBytes, percentUsed, freePercent };
    }

    /** Free-space tone used by the ring and its labels. */
    function freeTone(percent) {
      const number = percentOrNull(percent);
      if (number === null) return 'idle';
      if (number < 10) return 'error';
      if (number < 20) return 'warn';
      return 'success';
    }

    /** Used-space tone used by the history bars. */
    function usedTone(percent) {
      const number = percentOrNull(percent);
      if (number === null) return 'idle';
      if (number >= 85) return 'error';
      if (number >= 70) return 'warn';
      return 'success';
    }

    /** Normalize the Host's `ai.status` into a known state. */
    function normalizeAiStatus(status) {
      if (status === 'running' || status === 'done' || status === 'error') return status;
      return 'idle';
    }

    /** Localized AI state label. */
    function aiStateText(status, t) {
      if (status === 'running') return t('ai.state.running');
      if (status === 'done') return t('ai.state.done');
      if (status === 'error') return t('ai.state.error');
      return t('ai.state.idle');
    }

    /** Tone of the AI state dot. */
    function aiTone(status) {
      if (status === 'running') return 'warn';
      if (status === 'done') return 'success';
      if (status === 'error') return 'error';
      return 'idle';
    }

    /** Latched snapshot body predicate: the view always carries `snapshot`. */
    function isViewPayload(body) {
      return !!body && typeof body === 'object' && body.ok !== false &&
        Object.prototype.hasOwnProperty.call(body, 'snapshot');
    }

    /** Localized text for a resolved body that is not a view. */
    function viewFailureText(body, t) {
      const message = readErrorMessage(body);
      if (message) return t('error.host', { message });
      return t('error.badResponse');
    }

    /** Localized text for a rejected request (HTTP status or transport failure). */
    function requestErrorText(error, t) {
      if (error && typeof error.status === 'number' && error.status > 0) {
        const base = t('error.http', { status: String(error.status) });
        const message = readErrorMessage(error.body);
        return message ? base + ' · ' + message : base;
      }
      return t('error.network');
    }

    /** Localized text for a failed inspect request. */
    function inspectFailureText(body, t) {
      const error = body && typeof body === 'object' && body.error && typeof body.error === 'object'
        ? body.error
        : null;
      const code = error && typeof error.code === 'string' ? error.code : '';
      if (code === 'busy') return t('ai.error.busy');
      if (code === 'unavailable') return t('ai.error.unavailable');
      const message = readErrorMessage(body);
      if (message) return t('ai.error.failed', { message });
      return t('error.badResponse');
    }

    /** Fetch a route and resolve with its JSON body, rejecting on non-2xx. */
    function fetchJson(route, init) {
      return fetch(route, init).then(function (response) {
        return response.json().catch(function () {
          return null;
        }).then(function (body) {
          if (!response.ok) {
            const error = new Error(readErrorMessage(body) || 'HTTP ' + response.status);
            error.status = response.status;
            error.body = body;
            throw error;
          }
          return body;
        });
      });
    }

    /** Read the active locale id through the injected action face. */
    function activeLocaleOf(actions) {
      try {
        const snapshot = actions && actions.getLocaleSnapshot ? actions.getLocaleSnapshot() : null;
        if (snapshot && typeof snapshot.active === 'string') return snapshot.active;
      } catch (error) {
        /* locale service unavailable: fall back to the browser locale */
      }
      return undefined;
    }

    /* ------------------------------------------------------------------ *
     * Inline SVG glyphs (currentColor only).                             *
     * ------------------------------------------------------------------ */

    /**
     * Build one 16-unit stroke glyph.
     * @param {number} size rendered square edge in pixels.
     * @param {Array} children path elements.
     */
    function glyph(size, children) {
      const props = {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
      };
      return h.apply(null, ['svg', props].concat(children));
    }

    function IconBack() {
      return glyph(14, [
        h('path', { key: 'shaft', d: 'M13 8H3.2' }),
        h('path', { key: 'head', d: 'M7.4 3.6 3 8l4.4 4.4' }),
      ]);
    }

    function IconRefresh() {
      return glyph(14, [
        h('path', { key: 'arc', d: 'M13.2 8a5.2 5.2 0 1 1-1.53-3.68' }),
        h('path', { key: 'head', d: 'M13.5 2.6v3.3h-3.3' }),
      ]);
    }

    function IconDisk() {
      return glyph(14, [
        h('rect', { key: 'body', x: 2.2, y: 3.4, width: 11.6, height: 8, rx: 1.6 }),
        h('path', { key: 'slot', d: 'M2.2 8.1h11.6' }),
        h('circle', { key: 'led', cx: 11.1, cy: 5.7, r: 0.75, fill: 'currentColor', stroke: 'none' }),
      ]);
    }

    function IconClock() {
      return glyph(14, [
        h('circle', { key: 'face', cx: 8, cy: 8, r: 5.6 }),
        h('path', { key: 'hands', d: 'M8 4.9v3.3l2.2 1.3' }),
      ]);
    }

    function IconAlert() {
      return glyph(16, [
        h('circle', { key: 'face', cx: 8, cy: 8, r: 5.9 }),
        h('path', { key: 'stem', d: 'M8 4.9v3.6' }),
        h('path', { key: 'dot', d: 'M8 11.1v.15' }),
      ]);
    }

    function IconShield() {
      return glyph(14, [
        h('path', { key: 'body', d: 'M8 1.9 12.6 3.6v3.5c0 2.9-1.9 4.9-4.6 6-2.7-1.1-4.6-3.1-4.6-6V3.6Z' }),
        h('path', { key: 'check', d: 'M5.8 7.6 7.3 9.1l3-3.1' }),
      ]);
    }

    function IconSparkles() {
      return glyph(14, [
        h('path', { key: 'star', d: 'M6.6 1.9l1 2.8 2.8 1-2.8 1-1 2.8-1-2.8-2.8-1 2.8-1Z' }),
        h('path', { key: 'spark', d: 'M11.4 9.1l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6Z' }),
      ]);
    }

    function IconOpen() {
      return glyph(14, [
        h('path', { key: 'shaft', d: 'M5.4 10.6 10.9 5.1' }),
        h('path', { key: 'head', d: 'M6.4 5.1h4.5v4.5' }),
      ]);
    }

    /** Spinner used by buttons and the refresh affordance. */
    function Spinner() {
      return h('span', { className: 'dd-spinner', 'aria-hidden': 'true' });
    }

    /* ------------------------------------------------------------------ *
     * Presentational pieces.                                             *
     * ------------------------------------------------------------------ */

    /**
     * SVG ring gauge for the available share. The solid arc is the raw-free
     * share and the faint arc is the purgeable share, so together they read as
     * the System-Settings "available" percentage.
     */
    function RingGauge(props) {
      const size = 148;
      const stroke = 12;
      const center = size / 2;
      const radius = (size - stroke) / 2;
      const circumference = 2 * Math.PI * radius;
      const availablePercent = percentOrNull(props.availablePercent);
      const rawPercent = percentOrNull(props.rawPercent);
      const availableSafe = availablePercent === null ? 0 : availablePercent;
      const rawSafe = rawPercent === null ? availableSafe : Math.min(rawPercent, availableSafe);
      const purgePercent = Math.max(0, availableSafe - rawSafe);
      const rawDash = (rawSafe / 100) * circumference;
      const purgeDash = (purgePercent / 100) * circumference;
      const purgeStart = -90 + rawSafe * 3.6;
      const tone = typeof props.tone === 'string' ? props.tone : freeTone(availablePercent);
      const label = availablePercent === null
        ? '—'
        : formatPercent(availablePercent, props.locale) + '%';
      const arcs = [
        h('circle', {
          key: 'raw',
          className: 'dd-ringArc',
          'data-tone': tone,
          cx: center,
          cy: center,
          r: radius,
          fill: 'none',
          strokeWidth: stroke,
          strokeDasharray: rawDash + ' ' + (circumference - rawDash),
          transform: 'rotate(-90 ' + center + ' ' + center + ')',
        }),
      ];
      if (purgePercent > 0.01) {
        arcs.push(h('circle', {
          key: 'purge',
          className: 'dd-ringArcPurge',
          'data-tone': tone,
          cx: center,
          cy: center,
          r: radius,
          fill: 'none',
          strokeWidth: stroke,
          strokeDasharray: purgeDash + ' ' + (circumference - purgeDash),
          transform: 'rotate(' + purgeStart + ' ' + center + ' ' + center + ')',
        }));
      }
      return h('div', {
        className: 'dd-ringWrap',
        role: 'img',
        'aria-label': typeof props.ariaLabel === 'string' ? props.ariaLabel : '',
      },
        h('svg', {
          className: 'dd-ring',
          viewBox: '0 0 148 148',
          width: size,
          height: size,
          'aria-hidden': 'true',
          focusable: 'false',
        },
          h('circle', {
            key: 'track',
            className: 'dd-ringTrack',
            cx: center,
            cy: center,
            r: radius,
            fill: 'none',
            strokeWidth: stroke,
          }),
          arcs
        ),
        h('div', { className: 'dd-ringCenter', 'aria-hidden': 'true' },
          h('span', { className: 'dd-ringLabel' }, typeof props.centerLabel === 'string' ? props.centerLabel : ''),
          h('span', { className: 'dd-ringValue' }, label)
        )
      );
    }

    /** Status row under the hero: sampling cadence, last failure, manual refresh. */
    function StatusRow(props) {
      const collector = props.collector;
      const lastError = errorMessageOf(collector.lastError);
      const refreshedTime = timestampOrNull(props.refreshedAt);
      const duration = formatDuration(collector.lastDurationMs, props.t, props.locale);
      const interval = formatInterval(props.config.sampleIntervalMs, props.t, props.locale);
      const statusText = props.refreshing
        ? props.t('status.refreshing')
        : interval
          ? props.t('status.auto', { interval })
          : props.t('status.autoFallback');
      const tone = lastError ? 'error' : props.refreshing ? 'warn' : 'success';
      return h('div', { className: 'dd-status' },
        h('div', { className: 'dd-statusInfo' },
          h('span', { className: 'dd-statusDot', 'data-tone': tone, 'aria-hidden': 'true' }),
          h('span', {
            className: 'dd-statusText',
            role: 'status',
            'aria-live': 'polite',
          }, statusText),
          refreshedTime !== null
            ? h('span', {
              className: 'dd-refreshedChip',
              role: 'status',
            }, props.t('status.refreshed', {
              time: formatTime(refreshedTime, props.locale),
            }))
            : null,
          duration
            ? h('span', { className: 'dd-statusMeta' }, props.t('status.duration', { duration }))
            : null,
          lastError
            ? h('span', {
              className: 'dd-statusError',
              title: lastError,
            }, props.t('status.error', { message: lastError }))
            : null
        ),
        h('button', {
          type: 'button',
          className: 'dd-btn dd-btnGhost dd-statusRefresh',
          disabled: props.refreshing,
          'aria-busy': props.refreshing,
          onClick: props.onRefresh,
        },
          props.refreshing ? h(Spinner) : h(IconRefresh),
          props.t('action.refresh')
        )
      );
    }

    /** Hero card: ring, free capacity, total/used line, volume metadata, status row. */
    function HeroCard(props) {
      const t = props.t;
      const locale = props.locale;
      const metrics = metricsOf(props.snapshot);
      const snapshot = props.snapshot;
      const probeAvailable = finderAvailableOf(snapshot);
      const hasSystemProbe = probeAvailable !== null;
      const totalBytes = metrics.totalBytes;
      const availableBytes = hasSystemProbe ? probeAvailable : metrics.freeBytes;
      const availableText = formatGigabytes(availableBytes, locale);
      const systemUsedBytes = totalBytes !== null && availableBytes !== null
        ? Math.max(0, totalBytes - availableBytes)
        : null;
      const usedBytes = hasSystemProbe && systemUsedBytes !== null ? systemUsedBytes : metrics.usedBytes;
      const usedPercent = hasSystemProbe && totalBytes !== null && totalBytes > 0 && systemUsedBytes !== null
        ? clampPercent((systemUsedBytes / totalBytes) * 100)
        : metrics.percentUsed;
      const usedText = formatPercent(usedPercent, locale);
      const availablePercent = totalBytes !== null && totalBytes > 0 && availableBytes !== null
        ? clampPercent((availableBytes / totalBytes) * 100)
        : metrics.freePercent;
      const rawPercent = totalBytes !== null && totalBytes > 0 && metrics.freeBytes !== null
        ? clampPercent((metrics.freeBytes / totalBytes) * 100)
        : metrics.freePercent;
      const purgeableProbe = numberOrNull(snapshot.purgeableBytes);
      const purgeable = hasSystemProbe && purgeableProbe !== null && purgeableProbe >= 0
        ? purgeableProbe
        : null;
      const purgeablePercent = hasSystemProbe ? Math.max(0, availablePercent - rawPercent) : 0;
      const ringTone = freeTone(hasSystemProbe ? availablePercent : metrics.freePercent);
      const capacityText = t('hero.capacity', {
        used: formatGigabytes(usedBytes, locale),
        total: formatGigabytes(totalBytes, locale),
        percent: usedText,
      });
      const volumeName = typeof snapshot.volumeName === 'string' ? snapshot.volumeName.trim() : '';
      const mount = typeof snapshot.mount === 'string' && snapshot.mount.trim()
        ? snapshot.mount.trim()
        : '/';
      const fileSystem = typeof snapshot.fileSystem === 'string' ? snapshot.fileSystem.trim() : '';
      const sampleAt = formatTime(snapshot.at, locale);
      const metaParts = [];
      if (volumeName) metaParts.push(volumeName);
      if (mount) metaParts.push(mount);
      if (fileSystem) metaParts.push(fileSystem);
      const metaNodes = [];
      for (let partIndex = 0; partIndex < metaParts.length; partIndex += 1) {
        if (partIndex > 0) {
          metaNodes.push(h('span', {
            key: 'meta-sep-' + partIndex,
            className: 'dd-metaSep',
            'aria-hidden': 'true',
          }, '·'));
        }
        metaNodes.push(h('span', {
          key: 'meta-part-' + partIndex,
          className: 'dd-metaItem',
        }, metaParts[partIndex]));
      }
      return h('section', { className: 'dd-card dd-hero', 'aria-label': t('hero.title') },
        h(RingGauge, {
          locale,
          availablePercent,
          rawPercent,
          tone: ringTone,
          centerLabel: hasSystemProbe ? t('hero.ringLabelAvailable') : t('hero.ringLabel'),
          ariaLabel: hasSystemProbe
            ? t('hero.ringAriaSystem', {
              available: formatPercent(availablePercent, locale),
              purgeable: formatPercent(purgeablePercent, locale),
            })
            : t('hero.ringAria', { percent: formatPercent(availablePercent, locale) }),
        }),
        h('div', { className: 'dd-heroReadout' },
          h('span', {
            className: 'dd-freeLabel',
          }, hasSystemProbe ? t('hero.availableLabel') : t('hero.freeLabel')),
          h('div', { className: 'dd-freeValue' },
            availableText,
            h('span', { className: 'dd-freeUnit' }, 'GB')
          ),
          h('p', { className: 'dd-capacity' }, capacityText),
          hasSystemProbe ? h('p', { className: 'dd-freeHint' }, t('hero.availableHint')) : null,
          hasSystemProbe
            ? h('div', { className: 'dd-secondary', 'data-tone': ringTone },
              h('div', { className: 'dd-secondRow' },
                h('span', { className: 'dd-secondLabel' },
                  h('span', { className: 'dd-secondDot', 'aria-hidden': 'true' }),
                  t('hero.rawFreeLabel')
                ),
                h('span', { className: 'dd-secondValue' }, t('hero.approxGb', {
                  value: formatGigabytes(metrics.freeBytes, locale),
                }))
              ),
              purgeable !== null
                ? h('div', { className: 'dd-secondRow' },
                  h('span', { className: 'dd-secondLabel' },
                    h('span', { className: 'dd-secondDot dd-secondDotFaint', 'aria-hidden': 'true' }),
                    t('hero.purgeableLabel')
                  ),
                  h('span', { className: 'dd-secondValue' }, t('hero.approxGb', {
                    value: formatGigabytes(purgeable, locale),
                  }))
                )
                : null,
              h('p', { className: 'dd-secondNote' }, t('hero.differentConventionsNote'))
            )
            : null,
          h('div', { className: 'dd-metaRows' },
            h('div', { className: 'dd-metaRow' },
              h(IconDisk),
              metaNodes
            ),
            sampleAt
              ? h('div', { className: 'dd-metaRow' },
                h(IconClock),
                h('span', { className: 'dd-metaItem' }, t('hero.sampledAt', { time: sampleAt }))
              )
              : null
          )
        ),
        h(StatusRow, {
          t,
          locale,
          collector: props.collector,
          config: props.config,
          refreshing: props.refreshing,
          refreshedAt: props.refreshedAt,
          onRefresh: props.onRefresh,
        })
      );
    }

    /**
     * History card: trailing used-percent bars. Rows carrying
     * `finderAvailableBytes` plot the System-Settings convention
     * (used = total - finderAvailable); legacy rows fall back to raw df usage.
     * The title, summary and tooltips name the convention so the strip and the
     * headline cannot look contradictory.
     */
    function HistoryCard(props) {
      const t = props.t;
      const locale = props.locale;
      const samples = Array.isArray(props.history) ? props.history.slice(-HISTORY_BARS) : [];
      const bars = [];
      let min = null;
      let max = null;
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        if (!sample || typeof sample !== 'object') continue;
        const total = numberOrNull(sample.totalBytes);
        if (total === null || total <= 0) continue;
        const finderAvailable = numberOrNull(sample.finderAvailableBytes);
        let percent = null;
        let system = false;
        if (finderAvailable !== null && finderAvailable >= 0) {
          percent = clampPercent((Math.max(0, total - finderAvailable) / total) * 100);
          system = true;
        } else {
          const used = numberOrNull(sample.usedBytes);
          if (used === null) continue;
          percent = clampPercent((used / total) * 100);
        }
        bars.push({ at: timestampOrNull(sample.at), percent, system });
        if (min === null || percent < min) min = percent;
        if (max === null || percent > max) max = percent;
      }
      const systemConvention = bars.some(function (bar) {
        return bar.system;
      }) || props.hasSystemProbe === true;
      const firstTime = bars.length ? formatTime(bars[0].at, locale) : '';
      const lastTime = bars.length ? formatTime(bars[bars.length - 1].at, locale) : '';
      let hint = null;
      let ariaLabel = null;
      if (bars.length) {
        const minText = formatPercent(min, locale);
        const maxText = formatPercent(max, locale);
        hint = systemConvention
          ? t('history.summarySystem', { count: String(bars.length), min: minText, max: maxText })
          : t('history.summary', { count: String(bars.length), min: minText, max: maxText });
        ariaLabel = systemConvention
          ? t('history.ariaSystem', { count: String(bars.length), min: minText, max: maxText })
          : t('history.aria', { count: String(bars.length), min: minText, max: maxText });
      }
      const title = systemConvention ? t('history.titleSystem') : t('history.title');
      return h('section', { className: 'dd-card dd-history', 'aria-label': title },
        h('div', { className: 'dd-cardHead' },
          h('h2', { className: 'dd-cardTitle' }, title),
          hint ? h('span', { className: 'dd-cardHint' }, hint) : null
        ),
        bars.length
          ? h('div', {
            className: 'dd-bars',
            role: 'img',
            'aria-label': ariaLabel,
          }, bars.map(function (bar, index) {
            return h('span', {
              key: 'bar-' + index,
              className: 'dd-bar',
              'data-tone': usedTone(bar.percent),
              style: { height: Math.max(3, bar.percent) + '%' },
              title: t(bar.system ? 'history.barTitleSystem' : 'history.barTitle', {
                time: formatTime(bar.at, locale) || '—',
                percent: formatPercent(bar.percent, locale),
              }),
            });
          }))
          : h('p', { className: 'dd-empty' }, t('history.empty')),
        bars.length && (firstTime || lastTime)
          ? h('div', { className: 'dd-barFoot' },
            h('span', null, firstTime),
            h('span', null, lastTime)
          )
          : null
      );
    }

    /** AI card: start a model inspection, show its report, open its session. */
    function AiCard(props) {
      const t = props.t;
      const locale = props.locale;
      const ai = props.ai && typeof props.ai === 'object' ? props.ai : {};
      const status = normalizeAiStatus(ai.status);
      const running = status === 'running';
      const busy = props.inspectBusy || running;
      const sessionId = typeof ai.sessionId === 'string' && ai.sessionId ? ai.sessionId : null;
      const report = ai.report && typeof ai.report === 'object' ? ai.report : null;
      const reportText = report && typeof report.text === 'string' ? report.text.trim() : '';
      const reportAt = report
        ? (timestampOrNull(report.at) || timestampOrNull(ai.finishedAt))
        : timestampOrNull(ai.finishedAt);
      const hostError = errorMessageOf(ai.error);
      const buttonLabel = props.inspectBusy
        ? t('ai.buttonStarting')
        : running
          ? t('ai.buttonRunning')
          : t('ai.button');
      return h('section', { className: 'dd-card dd-aiCard', 'aria-label': t('ai.title') },
        h('div', { className: 'dd-cardHead' },
          h('h2', { className: 'dd-cardTitle' }, t('ai.title')),
          h('span', {
            className: 'dd-aiState',
            role: 'status',
            'aria-live': 'polite',
          },
            h('span', { className: 'dd-aiDot', 'data-tone': aiTone(status), 'aria-hidden': 'true' }),
            aiStateText(status, t)
          )
        ),
        h('p', { className: 'dd-aiDesc' }, t('ai.description')),
        h('div', { className: 'dd-aiActions' },
          h('button', {
            type: 'button',
            className: 'dd-btn dd-btnPrimary',
            onClick: props.onInspect,
            disabled: busy,
            'aria-busy': props.inspectBusy || running,
          },
            busy ? h(Spinner) : h(IconSparkles),
            buttonLabel
          ),
          sessionId
            ? h('button', {
              type: 'button',
              className: 'dd-btn dd-btnGhost',
              onClick: function () {
                props.onOpenSession(sessionId);
              },
            }, h(IconOpen), t('ai.openSession'))
            : null
        ),
        running ? h('p', { className: 'dd-aiHint' }, t('ai.runningHint')) : null,
        !running && status === 'done' && reportAt
          ? h('p', { className: 'dd-aiHint' }, t('ai.finishedAt', { time: formatTime(reportAt, locale) }))
          : null,
        !running && status === 'error' && hostError
          ? h('div', { className: 'dd-alert dd-alertInline', role: 'alert' },
            h('span', { className: 'dd-alertIcon' }, h(IconAlert)),
            h('span', { className: 'dd-alertText' }, t('ai.error.failed', { message: hostError }))
          )
          : null,
        props.inspectError
          ? h('div', { className: 'dd-alert dd-alertInline', role: 'alert' },
            h('span', { className: 'dd-alertIcon' }, h(IconAlert)),
            h('span', { className: 'dd-alertText' }, props.inspectError)
          )
          : null,
        reportText
          ? h('div', { className: 'dd-report' },
            h('div', { className: 'dd-reportHead' },
              h('span', { className: 'dd-reportTitle' }, t('ai.reportTitle')),
              reportAt
                ? h('span', { className: 'dd-reportTime' }, t('ai.reportAt', { time: formatTime(reportAt, locale) }))
                : null
            ),
            h('pre', {
              className: 'dd-reportText',
              tabIndex: 0,
              'aria-label': t('ai.reportTitle'),
            }, reportText)
          )
          : null,
        h('p', { className: 'dd-note' },
          h(IconShield),
          h('span', null, t('ai.note'))
        )
      );
    }

    /** First-load skeleton, shown until the first snapshot resolves. */
    function LoadingState(props) {
      const t = props.t;
      return h('section', { className: 'dd-card dd-hero dd-heroLoading', 'aria-busy': 'true' },
        h('div', { className: 'dd-ringWrap' },
          h('div', { className: 'dd-skelRing', 'aria-hidden': 'true' })
        ),
        h('div', { className: 'dd-heroReadout' },
          h('span', { className: 'dd-loadingTitle', role: 'status', 'aria-live': 'polite' }, t('loading.title')),
          h('span', { className: 'dd-loadingHint' }, t('loading.hint')),
          h('span', { className: 'dd-skel dd-skelLine', style: { width: '190px', height: '12px' }, 'aria-hidden': 'true' }),
          h('span', { className: 'dd-skel dd-skelLine', style: { width: '140px', height: '12px' }, 'aria-hidden': 'true' })
        )
      );
    }

    /** Shown when no snapshot has ever resolved (Host has not sampled yet). */
    function EmptyState(props) {
      const t = props.t;
      return h('section', { className: 'dd-card dd-state', 'aria-live': 'polite' },
        h('span', { className: 'dd-stateIcon' }, h(IconDisk)),
        h('h2', { className: 'dd-stateTitle' }, t('empty.title')),
        h('p', { className: 'dd-stateText' }, t('empty.hint')),
        h('div', { className: 'dd-stateActions' },
          h('button', {
            type: 'button',
            className: 'dd-btn dd-btnPrimary',
            onClick: props.onRefresh,
            disabled: props.refreshing,
            'aria-busy': props.refreshing,
          },
            props.refreshing ? h(Spinner) : h(IconRefresh),
            t('empty.action')
          )
        )
      );
    }

    /** Shown when the first snapshot request failed and no data exists yet. */
    function LoadErrorState(props) {
      const t = props.t;
      return h('section', { className: 'dd-card dd-state', role: 'alert' },
        h('span', { className: 'dd-stateIcon dd-stateIconError' }, h(IconAlert)),
        h('h2', { className: 'dd-stateTitle' }, t('loadFailed.title')),
        h('p', { className: 'dd-stateText' }, props.message),
        h('p', { className: 'dd-stateHint' }, t('loadFailed.hint')),
        h('div', { className: 'dd-stateActions' },
          h('button', {
            type: 'button',
            className: 'dd-btn dd-btnPrimary',
            onClick: props.onRetry,
          }, h(IconRefresh), t('error.retry'))
        )
      );
    }

    /**
     * Build the registered main-area page component.
     * @param actions Browser services bound once by `apply`.
     * @param fallbackT Locale translator used when the slot does not inject one.
     */
    function createPage(actions, fallbackT) {
      /**
       * @param props Slot props: the framework `t` seat plus the bound action face.
       */
      function DiskDoctorPageView(props) {
        const t = props.t;
        const [view, setView] = useState(null);
        const [loading, setLoading] = useState(true);
        const [loadError, setLoadError] = useState(null);
        const [pollNonce, setPollNonce] = useState(0);
        const [refreshing, setRefreshing] = useState(false);
        const [refreshedAt, setRefreshedAt] = useState(null);
        const [refreshError, setRefreshError] = useState(null);
        const [inspectBusy, setInspectBusy] = useState(false);
        const [inspectError, setInspectError] = useState(null);
        const tRef = useRef(t);
        const aliveRef = useRef(true);
        const refreshingRef = useRef(false);
        const inspectBusyRef = useRef(false);
        tRef.current = t;

        useEffect(function () {
          aliveRef.current = true;
          return function () {
            aliveRef.current = false;
          };
        }, []);

        // Auto-hide the manual-refresh confirmation chip; the timer is also
        // cleared when a new refresh restarts it or the page unmounts.
        useEffect(function () {
          if (refreshedAt === null) return undefined;
          const timer = setTimeout(function () {
            setRefreshedAt(null);
          }, REFRESHED_FEEDBACK_MS);
          return function () {
            clearTimeout(timer);
          };
        }, [refreshedAt]);

        // Poll the snapshot every five seconds while the page stays mounted.
        useEffect(function () {
          let alive = true;
          let timer = null;
          async function tick() {
            try {
              const body = await fetchJson(SNAPSHOT_ROUTE, { cache: 'no-store' });
              if (!alive) return;
              if (isViewPayload(body)) {
                setView(body);
                setLoadError(null);
                setRefreshError(null);
              } else {
                setLoadError(viewFailureText(body, tRef.current));
              }
            } catch (error) {
              if (!alive) return;
              setLoadError(requestErrorText(error, tRef.current));
            } finally {
              if (alive) {
                setLoading(false);
                timer = setTimeout(tick, POLL_INTERVAL_MS);
              }
            }
          }
          tick();
          return function () {
            alive = false;
            if (timer !== null) clearTimeout(timer);
          };
        }, [pollNonce]);

        const retryLoad = function () {
          setLoadError(null);
          if (!view) setLoading(true);
          setPollNonce(function (count) {
            return count + 1;
          });
        };

        const refreshNow = async function () {
          if (refreshingRef.current) return;
          refreshingRef.current = true;
          setRefreshing(true);
          setRefreshError(null);
          try {
            const body = await fetchJson(COLLECT_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            });
            if (!aliveRef.current) return;
            if (isViewPayload(body)) {
              setView(body);
              setLoadError(null);
              const sampleAt = body.snapshot && typeof body.snapshot === 'object'
                ? timestampOrNull(body.snapshot.at)
                : null;
              setRefreshedAt(sampleAt !== null ? sampleAt : Date.now());
            } else {
              setRefreshError(viewFailureText(body, tRef.current));
            }
          } catch (error) {
            if (!aliveRef.current) return;
            setRefreshError(requestErrorText(error, tRef.current));
          } finally {
            refreshingRef.current = false;
            if (aliveRef.current) setRefreshing(false);
          }
        };

        const startInspection = async function () {
          if (inspectBusyRef.current) return;
          const currentAi = view && view.ai && typeof view.ai === 'object' ? view.ai : null;
          if (currentAi && normalizeAiStatus(currentAi.status) === 'running') return;
          inspectBusyRef.current = true;
          setInspectBusy(true);
          setInspectError(null);
          try {
            const body = await fetchJson(INSPECT_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            });
            const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : '';
            if (!body || body.ok !== true || !sessionId) {
              if (aliveRef.current) setInspectError(inspectFailureText(body, tRef.current));
              return;
            }
            // Pull the running state in immediately, then hand the main area to
            // the new Conversation so the user watches the inspection happen.
            setPollNonce(function (count) {
              return count + 1;
            });
            actions.openSession(sessionId);
          } catch (error) {
            if (!aliveRef.current) return;
            setInspectError(requestErrorText(error, tRef.current));
          } finally {
            inspectBusyRef.current = false;
            if (aliveRef.current) setInspectBusy(false);
          }
        };

        const locale = activeLocaleOf(actions);
        const snapshot = view && view.snapshot && typeof view.snapshot === 'object' ? view.snapshot : null;
        const collector = view && view.collector && typeof view.collector === 'object' ? view.collector : {};
        const config = view && view.config && typeof view.config === 'object' ? view.config : {};
        const ai = view && view.ai && typeof view.ai === 'object' ? view.ai : {};
        const history = view && Array.isArray(view.history) ? view.history : [];
        const hasSystemProbe = finderAvailableOf(snapshot) !== null;

        const content = h('div', { className: 'dd-content' },
          h('header', { className: 'dd-header' },
            h('div', { className: 'dd-heading' },
              h('h1', { className: 'dd-title', id: HEADING_ID }, t('page.title')),
              h('p', { className: 'dd-subtitle' }, t('page.subtitle'))
            ),
            h('div', { className: 'dd-headerActions' },
              h('button', {
                type: 'button',
                className: 'dd-btn dd-btnGhost',
                onClick: actions.backToConversation,
              },
                h(IconBack),
                t('page.back')
              )
            )
          ),
          view && loadError
            ? h('div', { className: 'dd-alert dd-banner', role: 'alert' },
              h('span', { className: 'dd-alertIcon' }, h(IconAlert)),
              h('span', { className: 'dd-alertText' }, t('error.load', { message: loadError })),
              h('span', { className: 'dd-alertActions' },
                h('button', {
                  type: 'button',
                  className: 'dd-btn dd-btnGhost dd-btnSmall',
                  onClick: retryLoad,
                }, t('error.retry'))
              )
            )
            : null,
          view && refreshError
            ? h('div', { className: 'dd-alert dd-banner', 'data-tone': 'warn', role: 'alert' },
              h('span', { className: 'dd-alertIcon' }, h(IconAlert)),
              h('span', { className: 'dd-alertText' }, t('error.refresh', { message: refreshError })),
              h('span', { className: 'dd-alertActions' },
                h('button', {
                  type: 'button',
                  className: 'dd-btn dd-btnGhost dd-btnSmall',
                  onClick: function () {
                    setRefreshError(null);
                  },
                }, t('action.dismiss'))
              )
            )
            : null,
          !view && loading ? h(LoadingState, { t }) : null,
          !view && !loading && loadError
            ? h(LoadErrorState, { t, message: loadError, onRetry: retryLoad })
            : null,
          !view && !loading && !loadError ? h(LoadingState, { t }) : null,
          view && snapshot
            ? h(HeroCard, {
              t,
              locale,
              snapshot,
              collector,
              config,
              refreshing,
              refreshedAt,
              onRefresh: refreshNow,
            })
            : null,
          view && !snapshot
            ? h(EmptyState, { t, refreshing, onRefresh: refreshNow })
            : null,
          view ? h(HistoryCard, { t, locale, history, hasSystemProbe }) : null,
          view ? h(AiCard, {
            t,
            locale,
            ai,
            inspectBusy,
            inspectError,
            onInspect: startInspection,
            onOpenSession: actions.openSession,
          }) : null
        );

        return h('section', {
          className: 'dd-page',
          'aria-labelledby': HEADING_ID,
        },
          h('style', { key: 'disk-doctor-styles' }, STYLES),
          h('div', { className: 'dd-scroll' }, content)
        );
      }

      return function DiskDoctorPage(slotProps) {
        return h(DiskDoctorPageView, {
          ...slotProps,
          t: slotProps.t || fallbackT,
          actions,
        });
      };
    }

    /** Original hard-drive glyph for the sidebar row; inherits the row color. */
    function DiskDoctorIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
        h('rect', { key: 'body', x: 3.2, y: 4.8, width: 17.6, height: 12.4, rx: 2.6 }),
        h('path', { key: 'slot', d: 'M3.2 11.2h17.6' }),
        h('circle', { key: 'led', cx: 16.8, cy: 8, r: 1.1, fill: 'currentColor', stroke: 'none' }),
        h('path', { key: 'check', d: 'M8.2 14.4l2.1 2.1 4.1-4.3' })
      );
    }

    /* ------------------------------------------------------------------ *
     * Scoped stylesheet. One <style> child of the page root, dd- prefixed. *
     * Only --dsw-alias-* theme tokens are referenced; no literal colors.  *
     * ------------------------------------------------------------------ */

    const STYLES = `
.dd-page,
.dd-page *,
.dd-page *::before,
.dd-page *::after {
  box-sizing: border-box;
}
.dd-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.6;
}
.dd-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
  --dsh-scrollbar-width: 9px;
  --dsh-scrollbar-thumb-border: 2px;
}
.dd-content {
  width: 100%;
  max-width: 720px;
  min-width: 0;
  margin: 0 auto;
  padding: 28px clamp(20px, 4vw, 32px) 48px;
}
[data-platform='darwin'] .dd-content {
  padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px));
}

/* Header */
.dd-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.dd-heading { min-width: 0; }
.dd-title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 20px;
  font-weight: 500;
  line-height: 28px;
}
.dd-subtitle {
  margin: 4px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.dd-headerActions { flex: none; display: flex; align-items: center; gap: 8px; }

/* Buttons */
.dd-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  margin: 0;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 16px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
  appearance: none;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease;
}
.dd-btn:disabled { cursor: default; opacity: .45; }
.dd-btn:active:not(:disabled) { opacity: .72; }
.dd-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dd-btnPrimary {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font-weight: 500;
}
@media (hover: hover) {
  .dd-btnPrimary:hover:not(:disabled) { opacity: .84; }
}
.dd-btnGhost {
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
@media (hover: hover) {
  .dd-btnGhost:hover:not(:disabled) {
    background: var(--dsw-alias-bg-layer-2);
    color: var(--dsw-alias-label-primary);
  }
}
.dd-btnSmall { height: 28px; padding: 0 10px; font-size: 12px; border-radius: 14px; }

/* Cards */
.dd-card {
  width: 100%;
  margin-top: 16px;
  padding: 18px 20px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
}
.dd-cardHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-bottom: 12px;
}
.dd-cardTitle {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  font-weight: 500;
  line-height: 22px;
}
.dd-cardHint {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}

/* Hero */
.dd-hero {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 20px 28px;
  padding: 20px 24px 16px;
}
.dd-ringWrap {
  position: relative;
  flex: none;
  width: 148px;
  height: 148px;
}
.dd-ring { display: block; width: 100%; height: 100%; }
.dd-ringTrack { stroke: var(--dsw-alias-border-l2); }
.dd-ringArc {
  stroke: var(--dsw-alias-state-success-primary);
  stroke-linecap: round;
  transition: stroke-dasharray .5s ease, stroke .3s ease;
}
.dd-ringArc[data-tone='warn'] { stroke: var(--dsw-alias-state-warn-primary); }
.dd-ringArc[data-tone='error'] { stroke: var(--dsw-alias-state-error-primary); }
.dd-ringArc[data-tone='idle'] { stroke: var(--dsw-alias-state-idle-primary); }
.dd-ringArcPurge {
  stroke: var(--dsw-alias-state-success-primary);
  stroke-linecap: round;
  opacity: .34;
  transition: stroke-dasharray .5s ease, stroke .3s ease;
}
.dd-ringArcPurge[data-tone='warn'] { stroke: var(--dsw-alias-state-warn-primary); }
.dd-ringArcPurge[data-tone='error'] { stroke: var(--dsw-alias-state-error-primary); }
.dd-ringArcPurge[data-tone='idle'] { stroke: var(--dsw-alias-state-idle-primary); }
.dd-ringCenter {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  pointer-events: none;
  text-align: center;
}
.dd-ringLabel {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 16px;
}
.dd-ringValue {
  color: var(--dsw-alias-label-primary);
  font-size: 26px;
  font-weight: 600;
  line-height: 30px;
  letter-spacing: -.02em;
  font-variant-numeric: tabular-nums;
}
.dd-heroReadout {
  display: flex;
  flex-direction: column;
  flex: 1 1 260px;
  gap: 2px;
  min-width: 0;
}
.dd-freeLabel {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 18px;
}
.dd-freeValue {
  color: var(--dsw-alias-label-primary);
  font-size: 34px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -.02em;
  font-variant-numeric: tabular-nums;
}
.dd-freeUnit {
  margin-left: 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0;
}
.dd-capacity {
  margin: 2px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
}
.dd-freeHint {
  margin: 3px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dd-secondary {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dd-secondRow {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 1px 12px;
  font-size: 12px;
  line-height: 18px;
}
.dd-secondLabel {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
}
.dd-secondDot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  opacity: .9;
}
.dd-secondDotFaint { opacity: .34; }
.dd-secondary[data-tone='warn'] .dd-secondDot { background: var(--dsw-alias-state-warn-primary); }
.dd-secondary[data-tone='error'] .dd-secondDot { background: var(--dsw-alias-state-error-primary); }
.dd-secondary[data-tone='idle'] .dd-secondDot { background: var(--dsw-alias-state-idle-primary); }
.dd-secondValue {
  margin-left: auto;
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dd-secondNote {
  margin: 2px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dd-metaRows {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dd-metaRow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dd-metaItem { overflow-wrap: anywhere; }
.dd-metaSep { opacity: .6; }

/* Status row */
.dd-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 1 0 100%;
  flex-wrap: wrap;
  gap: 10px 16px;
  margin-top: 2px;
  padding-top: 14px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dd-statusInfo {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dd-statusDot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
}
.dd-statusDot[data-tone='warn'] { background: var(--dsw-alias-state-warn-primary); }
.dd-statusDot[data-tone='error'] { background: var(--dsw-alias-state-error-primary); }
.dd-statusDot[data-tone='idle'] { background: var(--dsw-alias-state-idle-primary); }
.dd-statusMeta { opacity: .9; }
.dd-statusError {
  max-width: 100%;
  overflow: hidden;
  color: var(--dsw-alias-state-error-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dd-statusRefresh { flex: none; }
.dd-refreshedChip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  animation: dd-fade-in .2s ease;
}
.dd-refreshedChip::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
}

/* Alerts */
.dd-alert {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-left: 3px solid var(--dsw-alias-state-error-primary);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dd-alert[data-tone='warn'] { border-left-color: var(--dsw-alias-state-warn-primary); }
.dd-alertIcon {
  flex: none;
  margin-top: 2px;
  color: var(--dsw-alias-state-error-primary);
}
.dd-alert[data-tone='warn'] .dd-alertIcon { color: var(--dsw-alias-state-warn-primary); }
.dd-alertText { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.dd-alertActions { flex: none; display: flex; align-items: center; gap: 8px; }
.dd-banner { margin-bottom: 16px; }
.dd-alertInline { margin-top: 14px; }

/* History */
.dd-bars {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 2px;
  height: 72px;
  padding-bottom: 1px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dd-bar {
  flex: 1 1 0;
  min-width: 2px;
  max-width: 14px;
  border-radius: 2px 2px 0 0;
  background: var(--dsw-alias-state-success-primary);
  opacity: .9;
  transition: height .3s ease, opacity .15s ease;
}
.dd-bar[data-tone='warn'] { background: var(--dsw-alias-state-warn-primary); }
.dd-bar[data-tone='error'] { background: var(--dsw-alias-state-error-primary); }
.dd-bar[data-tone='idle'] { background: var(--dsw-alias-state-idle-primary); }
@media (hover: hover) {
  .dd-bar:hover { opacity: 1; }
}
.dd-barFoot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}
.dd-empty {
  margin: 0;
  padding: 18px 0 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}

/* AI inspection */
.dd-aiCard { padding-bottom: 16px; }
.dd-aiState {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dd-aiDot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}
.dd-aiDot[data-tone='success'] { background: var(--dsw-alias-state-success-primary); }
.dd-aiDot[data-tone='warn'] {
  background: var(--dsw-alias-state-warn-primary);
  animation: dd-pulse 1.4s ease-in-out infinite;
}
.dd-aiDot[data-tone='error'] { background: var(--dsw-alias-state-error-primary); }
.dd-aiDesc {
  margin: 0 0 14px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 21px;
}
.dd-aiActions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dd-aiHint {
  margin: 10px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dd-report {
  margin-top: 14px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
}
.dd-reportHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 12px;
  line-height: 18px;
}
.dd-reportTitle { color: var(--dsw-alias-label-primary); font-weight: 500; }
.dd-reportTime { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dd-reportText {
  display: block;
  max-height: 320px;
  margin: 0;
  overflow: auto;
  padding: 12px 14px 14px;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 21px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  scrollbar-gutter: stable;
  --dsh-scrollbar-width: 9px;
  --dsh-scrollbar-thumb-border: 2px;
}
.dd-reportText:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dd-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dd-note > svg { margin-top: 2px; }

/* First-load / dead-end states */
.dd-heroLoading { align-items: center; }
.dd-skel,
.dd-skelRing {
  display: block;
  background: var(--dsw-alias-state-idle-primary);
  animation: dd-pulse 1.8s ease-in-out infinite;
}
.dd-skel { border-radius: 6px; opacity: .5; }
.dd-skelRing {
  width: 148px;
  height: 148px;
  border-radius: 50%;
  opacity: .22;
}
.dd-skelLine { margin-top: 4px; }
.dd-loadingTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
}
.dd-loadingHint {
  margin-top: 2px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dd-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 28px 24px;
}
.dd-stateIcon { color: var(--dsw-alias-label-secondary); }
.dd-stateIconError { color: var(--dsw-alias-state-error-primary); }
.dd-stateTitle {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
}
.dd-stateText {
  max-width: 56ch;
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 21px;
  overflow-wrap: anywhere;
}
.dd-stateHint {
  max-width: 56ch;
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dd-stateActions { display: flex; gap: 8px; margin-top: 8px; }

/* Spinner and motion */
.dd-spinner {
  flex: none;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: dd-spin .8s linear infinite;
}
@keyframes dd-spin {
  to { transform: rotate(360deg); }
}
@keyframes dd-pulse {
  0%, 100% { opacity: .35; }
  50% { opacity: .7; }
}
@keyframes dd-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .dd-spinner { animation-duration: 2.4s; }
  .dd-refreshedChip { animation: none; }
  .dd-skel,
  .dd-skelRing,
  .dd-aiDot[data-tone='warn'] { animation: none; }
  .dd-ringArc,
  .dd-bar,
  .dd-btn { transition: none; }
}

/* Narrow widths */
@media (max-width: 560px) {
  .dd-content { padding-left: 16px; padding-right: 16px; }
  .dd-header { flex-direction: column; align-items: stretch; gap: 12px; }
  .dd-headerActions { justify-content: flex-start; }
  .dd-hero { flex-direction: column; align-items: stretch; padding: 18px 16px 14px; }
  .dd-ringWrap { align-self: center; }
  .dd-freeValue { font-size: 30px; }
  .dd-status { flex-direction: column; align-items: stretch; }
  .dd-statusRefresh { align-self: flex-start; }
  .dd-card { padding: 16px; }
  .dd-bars { height: 60px; }
}
`;

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, LOCALE_DICTIONARIES);
        }, 'disk-doctor: locale dictionaries');

        const t = ctx.locale.bind(NS);

        const actions = {
          /** Return the main area to the current Conversation. */
          backToConversation() {
            try {
              const layout = ctx.get('layout');
              if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('conversation');
            } catch (error) {
              /* layout service unavailable: leave the page as it is */
            }
          },
          /** Show the Conversation of the Session an inspection just created. */
          openSession(sessionId) {
            try {
              const workspace = ctx.get('uiWorkspace');
              if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId);
            } catch (error) {
              /* workspace service unavailable: the report stays reachable in the panel */
            }
          },
          /** Read the active locale snapshot for Intl number formatting. */
          getLocaleSnapshot() {
            try {
              return ctx.locale.getLocale();
            } catch (error) {
              return undefined;
            }
          },
        };

        const Page = createPage(actions, t);

        ctx.effect(function () {
          return ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: function () {
                return t('panel.title');
              },
              locale: NS,
            }, DiskDoctorIcon);
          });
        }, 'disk-doctor: sidebar entry');

        ctx.effect(function () {
          return ctx.slots.inject('main', function () {
            return ctx.slots.register({
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            }, Page);
          });
        }, 'disk-doctor: main page');
      },
    };
  },
});
