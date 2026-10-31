'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  computePace,
  segmentSignal,
  segmentCooldown,
  monthlyCooldown,
  paceBar,
} = require('./pace');

const QUOTA_PROVIDER = 'opencode-go';
// A short cache only absorbs duplicate reads between the host's 30s polls; it
// must stay under the poll interval so a window reset shows up right away.
const CACHE_MS = 25 * 1000;

const RU = {
  cap: (n) => `лимит ${n}`,
  under: (pp, tail) => `Недорасход ${pp} — можно добрать до нормы.${tail ? ` ${tail}` : ''}`,
  slightlyOver: (pp, tail) => `Чуть выше нормы на ${pp} — лучше выровнять темп.${tail ? ` ${tail}` : ''}`,
  over: (pp, tail) => `Перерасход ${pp} — притормозить.${tail ? ` ${tail}` : ''}`,
  projectedToReset: (pct, nearlyFull) => `При текущем темпе к сбросу ~${pct}${nearlyFull ? ' — почти весь бюджет' : ' — есть запас'}.`,
  runsOut: (date, days) => `При текущем темпе лимит кончится ~${date}, за ${days} до сброса.`,
  exhausted: 'Лимит уже исчерпан.',
  summaryOver: (used, norm, pp, tail, left) => `Месяц: ${used} из 100%, норма ${norm} — перерасход ${pp}${tail ? ` ${tail}` : ''} Сейчас в запасе ${left} лимита.`,
  summarySlightOver: (used, norm, pp, tail, left) => `Месяц: ${used} из 100%, норма ${norm} — чуть выше нормы на ${pp}${tail ? ` ${tail}` : ''} Сейчас в запасе ${left} лимита.`,
  summaryUnder: (used, norm, pp, tail, left) => `Месяц: ${used} из 100%, норма ${norm} — недорасход ${pp} В запасе ${left} лимита.${tail ? ` ${tail}` : ''}`,
  summaryInNorm: (used, norm, left) => `Месяц: ${used} из 100%, норма ${norm} — в норме. В запасе ${left} лимита.`,
  tipOver: (used, norm, pp, tail, left) => `${used} / норма ${norm} — перерасход ${pp}${tail ? ` ${tail}` : ''} В запасе ${left}.`,
  tipUnder: (used, norm, pp, left) => `${used} / норма ${norm} — недорасход ${pp} В запасе ${left}.`,
  tipInNorm: (used, norm, left) => `${used} / норма ${norm} — в норме. В запасе ${left}.`,
  nearTip: (used, monthlyShare) => `${used} лимита окна${monthlyShare ? ` (это ${monthlyShare} месяца)` : ''}. Близко к лимиту окна.`,
  overTip: (used) => `${used} лимита окна. Лимит окна исчерпан.`,
  tipSpent: 'Лимит исчерпан.',
  tipReset: (reset) => `Сброс ${reset}.`,
  monthlyTooltip: ({ reset, norm, used, delta }) => `Сброс ${reset}. Норма к этому моменту ${norm}. Израсходовано ${used} (${delta}).`,
  segmentTooltip: ({ used, monthlyShare, normal }) => `${used} лимита окна${monthlyShare ? ` (это ${monthlyShare} месяца)` : ''}.${normal ? ` Всплеск: выше месячной нормы ${normal}.` : ''}`,
  endNormalWeek: (value) => `Норма к концу недели ${value}.`,
  endNormalWindow: (value) => `Норма к концу окна ${value}.`,
  cooldownNormal: (duration) => `до нормы ~${duration} без трат`,
  cooldownReset: (duration) => `до сброса ~${duration}`,
  cooldownNone: 'уже в норме',
  min: 'мин',
  hour: 'ч',
  day: 'дн',
  quietTooltip: ({ used, normalNow, fullNormal }) => (normalNow
    ? `${used} лимита окна. Норма сейчас ${normalNow}${fullNormal ? `; к концу окна ${fullNormal}` : ''}.`
    : `${used} лимита окна.`),
  overheatTooltip: ({ used, normalNow, fullNormal, delta, projectedFull }) => `${used} лимита окна. Норма сейчас ${normalNow} — выше на ${delta}; к концу окна ${fullNormal}.${projectedFull ? ` При таком темпе полное окно ~${projectedFull}.` : ''}`,
  overheat: 'перегрев',
  burstBadge: 'всплеск',
  nearBadge: 'лимит',
  overBadge: 'исчерпан',
  burst: (label, used, monthlyShare, norm) => `${label} ${used} — всплеск: ${monthlyShare} месяца, выше нормы ${norm}`,
  overheatReason: (label, used, normalNow, delta, fullNormal) => `${label} ${used} — выше нормы ${normalNow} на ${delta}; к концу окна ${fullNormal}`,
  nearCap: (label, used) => `${label} ${used} — близко к лимиту окна`,
  overCap: (label, used) => `${label} ${used} — лимит окна исчерпан`,
  slowDown: 'Притормози, чтобы не выесть месяц.',
  stale: (error) => `OpenChamber не обновил данные: ${error}. Показаны последние известные.`,
  error: (error) => `Не удалось получить данные OpenCode Go: ${error}.`,
  notConfigured: 'OpenCode Go не подключён в OpenChamber.',
  noMonthly: 'OpenCode Go не вернул месячное окно.',
  noData: 'OpenCode Go не вернул окна использования.',
  days: (n) => `${n} ${pluralRu(n, ['день', 'дня', 'дней'])}`,
  pp: 'п.п.',
};

const EN = {
  cap: (n) => `cap ${n}`,
  under: (pp, tail) => `Under the pace by ${pp} — room to spend more.${tail ? ` ${tail}` : ''}`,
  slightlyOver: (pp, tail) => `A little above the pace by ${pp} — ease off a touch.${tail ? ` ${tail}` : ''}`,
  over: (pp, tail) => `Over the pace by ${pp} — slow down.${tail ? ` ${tail}` : ''}`,
  projectedToReset: (pct, nearlyFull) => `At the current pace, ~${pct} by reset${nearlyFull ? ' — almost the whole budget' : ' — budget left'}.`,
  runsOut: (date, days) => `At the current pace the limit runs out ~${date}, ${days} before reset.`,
  exhausted: 'The limit is already used up.',
  summaryOver: (used, norm, pp, tail, left) => `Month: ${used} of 100%, normal ${norm} — ${pp} over.${tail ? ` ${tail}` : ''} ${left} of the limit left now.`,
  summarySlightOver: (used, norm, pp, tail, left) => `Month: ${used} of 100%, normal ${norm} — slightly above the pace by ${pp}.${tail ? ` ${tail}` : ''} ${left} of the limit left now.`,
  summaryUnder: (used, norm, pp, tail, left) => `Month: ${used} of 100%, normal ${norm} — ${pp} under. ${left} of the limit left.${tail ? ` ${tail}` : ''}`,
  summaryInNorm: (used, norm, left) => `Month: ${used} of 100%, normal ${norm} — on pace. ${left} of the limit left.`,
  tipOver: (used, norm, pp, tail, left) => `${used} / normal ${norm} — ${pp} over.${tail ? ` ${tail}` : ''} ${left} left.`,
  tipUnder: (used, norm, pp, left) => `${used} / normal ${norm} — ${pp} under. ${left} left.`,
  tipInNorm: (used, norm, left) => `${used} / normal ${norm} — on pace. ${left} left.`,
  nearTip: (used, monthlyShare) => `${used} of the window cap${monthlyShare ? ` (${monthlyShare} of the month)` : ''}. Close to the window cap.`,
  overTip: (used) => `${used} of the window cap. Window cap reached.`,
  tipSpent: 'Limit used up.',
  tipReset: (reset) => `Resets ${reset}.`,
  monthlyTooltip: ({ reset, norm, used, delta }) => `Resets ${reset}. Normal by now ${norm}. Used ${used} (${delta}).`,
  segmentTooltip: ({ used, monthlyShare, normal }) => `${used} of the window cap${monthlyShare ? ` (${monthlyShare} of the month)` : ''}.${normal ? ` Burst: above the monthly pace of ${normal}.` : ''}`,
  endNormalWeek: (value) => `Normal by the end of the week: ${value}.`,
  endNormalWindow: (value) => `Normal by the end of the window: ${value}.`,
  cooldownNormal: (duration) => `~${duration} without spending to reach normal`,
  cooldownReset: (duration) => `resets in ~${duration}`,
  cooldownNone: 'already on pace',
  min: 'm',
  hour: 'h',
  day: 'd',
  quietTooltip: ({ used, normalNow, fullNormal }) => (normalNow
    ? `${used} of the window cap. Normal now ${normalNow}${fullNormal ? `; ${fullNormal} by the end of the window` : ''}.`
    : `${used} of the window cap.`),
  overheatTooltip: ({ used, normalNow, fullNormal, delta, projectedFull }) => `${used} of the window cap. Normal now ${normalNow} — ${delta} above${fullNormal ? `; ${fullNormal} by the end of the window` : ''}.${projectedFull ? ` At this rate the full window is ~${projectedFull}.` : ''}`,
  overheat: 'overheat',
  burstBadge: 'burst',
  nearBadge: 'cap',
  overBadge: 'used up',
  burst: (label, used, monthlyShare, norm) => `${label} ${used} — burst: ${monthlyShare} of the month, above the ${norm} pace`,
  overheatReason: (label, used, normalNow, delta, fullNormal) => `${label} ${used} — ${delta} above the normal now (${normalNow})${fullNormal ? `; ${fullNormal} by the end of the window` : ''}`,
  nearCap: (label, used) => `${label} ${used} — close to the window cap`,
  overCap: (label, used) => `${label} ${used} — window cap reached`,
  slowDown: 'Slow down so the month lasts.',
  stale: (error) => `OpenChamber did not refresh: ${error}. Showing the last known values.`,
  error: (error) => `Could not read OpenCode Go usage: ${error}.`,
  notConfigured: 'OpenCode Go is not connected in OpenChamber.',
  noMonthly: 'OpenCode Go reported no monthly meter.',
  noData: 'OpenCode Go reported no usage windows.',
  days: (n) => `${n} day${n === 1 ? '' : 's'}`,
  pp: 'pp',
};

function pluralRu(value, forms) {
  const n = Math.abs(Math.round(value)) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

function stringsFor(locale) {
  return String(locale || 'en').toLowerCase().startsWith('ru') ? RU : EN;
}

function clip(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Small shares need a decimal; 0.9% should not become "<1%". */
function formatPrecisePercent(value) {
  if (!Number.isFinite(value)) return '—';
  if (value > 0 && value < 0.1) return '<0.1%';
  if (value > 0 && value < 10) return `${value.toFixed(1)}%`;
  if (value >= 999.5) return '>999%';
  return `${Math.round(value)}%`;
}

/** Cooldown durations: 5-minute precision under an hour, 15 above it. */
function formatCooldown(ms, strings) {
  let minutes = Math.max(0, Math.ceil(ms / 60000));
  if (minutes < 60) {
    minutes = Math.ceil(minutes / 5) * 5;
    return `${minutes} ${strings.min}`;
  }

  minutes = Math.ceil(minutes / 15) * 15;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes
      ? `${hours} ${strings.hour} ${restMinutes} ${strings.min}`
      : `${hours} ${strings.hour}`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours
    ? `${days} ${strings.day} ${restHours} ${strings.hour}`
    : `${days} ${strings.day}`;
}

function cooldownSuffix(cooldown, strings) {
  if (!cooldown) return '';
  if (cooldown.kind === 'none') return ` · ${strings.cooldownNone}`;
  const duration = formatCooldown(cooldown.ms, strings);
  return cooldown.kind === 'reset'
    ? ` · ${strings.cooldownReset(duration)}`
    : ` · ${strings.cooldownNormal(duration)}`;
}

function formatPp(value, strings) {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs)) return `— ${strings.pp}`;
  const number = abs > 0 && abs < 1 ? abs.toFixed(1) : String(Math.round(abs));
  return `${number} ${strings.pp}`;
}

function signedPp(value, strings) {
  return `${value >= 0 ? '+' : '-'}${formatPp(Math.abs(value), strings)}`;
}

function formatReset(timestamp, locale) {
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return new Intl.DateTimeFormat('en', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  }
}

function note(id, text, tone = 'muted') {
  return { kind: 'note', id, text: clip(text, 300), tone };
}

const NBSP = '\u00a0';

/** Display width in digit units, used to pad the value column. */
function valueUnits(text) {
  let units = 0;
  for (const ch of String(text)) {
    units += ch === ' ' || ch === NBSP || ch === '.' || ch === '/' ? 0.5 : 1;
  }
  return units;
}

/**
 * The host lays a line out as label (fixed 96px), bar (flex), value (shrink-0),
 * so a wider value shortens the bar. Left-pad every value with NBSPs (about
 * half a digit each) to the widest one: the bars then end in one column, the
 * numbers stay right-aligned, and two extra spaces keep them off the bar.
 */
function alignValues(rows) {
  const lines = rows.filter((row) => row.kind === 'line' && typeof row.value === 'string' && row.value !== '');
  if (lines.length === 0) return;

  const widest = Math.max(...lines.map((row) => valueUnits(row.value)));
  for (const row of lines) {
    const pad = Math.max(0, Math.round((widest - valueUnits(row.value)) * 2)) + 2;
    row.value = `${NBSP.repeat(pad)}${row.value}`;
  }
}

function monthlyTooltipTail(pace, strings) {
  if (pace.usedPercent >= 99.5) return strings.tipSpent;

  return '';
}

function monthlyRow(pace, strings, locale) {
  const used = formatPrecisePercent(pace.usedPercent);
  const norm = formatPrecisePercent(pace.normalPercent);
  const bar = paceBar({ usedPercent: pace.usedPercent, normalPercent: pace.normalPercent });
  const tone = bar.tone;
  const left = formatPrecisePercent(Math.max(0, 100 - pace.usedPercent));
  const tail = monthlyTooltipTail(pace, strings);

  const summary = pace.delta > 0
    ? strings.tipOver(used, norm, formatPp(pace.delta, strings), tail, left)
    : pace.delta < -1
      ? strings.tipUnder(used, norm, formatPp(-pace.delta, strings), left)
      : strings.tipInNorm(used, norm, left);

  const cooldown = monthlyCooldown({
    usedPercent: pace.usedPercent,
    normalNow: pace.normalPercent,
    elapsedFraction: pace.elapsedFraction,
    lengthMs: pace.length,
  });
  const tooltip = `${summary.replace(/\.$/, '')}${cooldownSuffix(cooldown, strings)}. ${strings.tipReset(formatReset(pace.reset, locale))}`;

  return {
    kind: 'line',
    id: 'monthly',
    label: 'Monthly',
    dot: tone === 'muted' ? undefined : tone,
    content: { kind: 'bar', value: bar.value, tone },
    value: `${used} / ${norm}`,
    valueTone: tone === 'warning' || tone === 'error' ? tone : undefined,
    tooltip: clip(tooltip, 200),
  };
}

function segmentRow(key, pace, signal, strings) {
  const used = formatPrecisePercent(pace.usedPercent);
  const normalNow = signal.normalNow !== null ? formatPrecisePercent(signal.normalNow) : '';
  const fullNormal = signal.fullWindowNormal !== null ? formatPrecisePercent(signal.fullWindowNormal) : '';
  const cooldown = segmentCooldown({
    usedPercent: pace.usedPercent,
    normalNow: signal.normalNow,
    fullWindowNormal: signal.fullWindowNormal,
    elapsedFraction: pace.elapsedFraction,
    lengthMs: pace.length,
  });
  const base = fullNormal
    ? (key === 'weekly' ? strings.endNormalWeek(fullNormal) : strings.endNormalWindow(fullNormal)).replace(/\.$/, '')
    : '';
  const tooltip = base ? `${base}${cooldownSuffix(cooldown, strings)}.` : undefined;

  // One right-aligned "used / normal" cell instead of a separate badge: the
  // host gives the label a fixed 96px and the bar takes what is left, so the
  // badge was eating a third of the track.
  const value = normalNow ? `${used} / ${normalNow}` : used;
  const bar = paceBar({ usedPercent: pace.usedPercent, normalPercent: signal.normalNow });
  const tone = signal.overCap || signal.nearCap
    ? 'error'
    : bar
      ? bar.tone
      : 'muted';
  const dot = tone === 'muted'
    ? (normalNow ? 'success' : undefined)
    : tone;

  return {
    kind: 'line',
    id: key === '5h' ? 'five-hour' : 'weekly',
    label: key === '5h' ? '5-Hour' : 'Weekly',
    dot,
    content: {
      kind: 'bar',
      value: bar ? bar.value : pace.usedPercent,
      tone,
    },
    value,
    valueTone: tone === 'warning' || tone === 'error' ? tone : undefined,
    tooltip: tooltip ? clip(tooltip, 200) : undefined,
  };
}

function buildView({ quota = null, locale = 'en', stale = false, error = null, now = Date.now() } = {}) {
  const strings = stringsFor(locale);
  const rows = [];

  if (!quota && error) {
    rows.push(note('error', strings.error(error), 'error'));
    return { rows };
  }

  if (quota && quota.ok === false) {
    if (quota.configured === false) {
      rows.push(note('not-configured', strings.notConfigured, 'muted'));
    } else {
      rows.push(note('error', strings.error(quota.error || 'unknown error'), 'error'));
    }
    if (!quota.usage || !quota.usage.windows || Object.keys(quota.usage.windows).length === 0) {
      return { rows };
    }
  }

  const windows = quota && quota.usage && quota.usage.windows ? quota.usage.windows : {};

  const monthlyWindow = windows.monthly;
  const monthlyPace = monthlyWindow
    ? computePace({
      key: 'monthly',
      resetAt: monthlyWindow.resetAt,
      usedPercent: monthlyWindow.usedPercent,
      now,
    })
    : null;

  const monthlyNormalPercent = monthlyPace ? monthlyPace.normalPercent : null;
  const monthlyUsedPercent = monthlyPace ? monthlyPace.usedPercent : null;
  const remainingMonthMs = monthlyPace ? Math.max(0, monthlyPace.reset - now) : null;

  const segments = [];
  for (const key of ['5h', 'weekly']) {
    const window = windows[key];
    if (!window) continue;
    const pace = computePace({
      key,
      resetAt: window.resetAt,
      usedPercent: window.usedPercent,
      now,
    });
    if (!pace) continue;

    const remainingWindows = remainingMonthMs !== null
      ? remainingMonthMs / pace.length
      : 0;

    const signal = segmentSignal({
      usedPercent: pace.usedPercent,
      monthlySharePercent: pace.monthlySharePercent,
      monthlyNormalPercent,
      monthlyUsedPercent,
      remainingWindows,
      elapsedFraction: pace.elapsedFraction,
      minBurstMonthlyPercent: key === '5h' ? 5 : 10,
    });
    segments.push({
      key,
      pace,
      signal,
    });
  }

  for (const segment of segments) {
    rows.push(segmentRow(segment.key, segment.pace, segment.signal, strings));
  }

  if (monthlyPace) {
    rows.push(monthlyRow(monthlyPace, strings, locale));
  } else if (!quota || quota.ok !== false) {
    rows.push(note('no-monthly', strings.noMonthly, 'muted'));
  }

  if (stale) {
    rows.push(note('stale', strings.stale(error || 'unknown error'), 'warning'));
  }

  if (rows.length === 0) {
    rows.push(note('no-data', strings.noData, 'muted'));
  }

  alignValues(rows);
  return { rows };
}

/* --------------------------------------------------------------------------
 * OpenChamber quota bridge
 * ------------------------------------------------------------------------ */

function settingsPath() {
  const dataDir = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  return path.join(dataDir, 'settings.json');
}

function readSettings() {
  const file = settingsPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const hint = error && error.code === 'ENOENT'
      ? `Settings file not found: ${file}`
      : `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`;
    throw new Error(hint);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Settings file is not valid JSON: ${file}`);
  }
}

function resolveRoute() {
  const settings = readSettings();
  return {
    token: String(settings.desktopLocalClientToken || '').trim(),
    ports: [
      Number(settings.desktopLocalPort),
      Number(process.env.OPENCHAMBER_PORT),
      3000,
      3001,
      8080,
    ].filter((port, index, list) => Number.isInteger(port) && port > 0 && list.indexOf(port) === index),
  };
}

let cachedUiPassword;
let authCache = { baseUrl: null, token: null, at: 0 };

/**
 * A web/WSL server has no `desktopLocalClientToken` in settings.json. It runs
 * with OPENCHAMBER_UI_PASSWORD in its own environment; the guest service runs
 * as the same user and can read that environment from /proc, then sign in for
 * a short-lived client token.
 */
function readProcessUiPassword() {
  if (process.platform !== 'linux') return null;

  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
  } catch {
    return null;
  }

  const readEnv = (pid) => {
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      const line = env.split('\0').find((entry) => entry.startsWith('OPENCHAMBER_UI_PASSWORD='));
      return line ? line.slice('OPENCHAMBER_UI_PASSWORD='.length) : null;
    } catch {
      return null;
    }
  };

  // Prefer the server process itself, so another shell's stale value wins
  // neither at startup nor after a restart.
  for (const pid of pids) {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!/@openchamber\/web|openchamber.*serve/i.test(cmdline)) continue;
      const password = readEnv(pid);
      if (password) return password;
    } catch {
      // The process ended while being inspected.
    }
  }

  for (const pid of pids) {
    const password = readEnv(pid);
    if (password) return password;
  }
  return null;
}

function readUiPassword() {
  if (cachedUiPassword !== undefined) return cachedUiPassword;
  const fromEnv = String(process.env.OPENCHAMBER_UI_PASSWORD || '').trim();
  cachedUiPassword = fromEnv || readProcessUiPassword() || null;
  return cachedUiPassword;
}

async function loginClientToken(baseUrl, password) {
  const response = await fetch(`${baseUrl}/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      password,
      trustDevice: true,
      issueClientToken: true,
      clientLabel: 'usage-pace',
    }),
    signal: AbortSignal.timeout(6000),
  });

  if (!response.ok) {
    throw new Error(`OpenChamber UI login failed (HTTP ${response.status})`);
  }

  const body = await response.json().catch(() => null);
  if (!body || typeof body.clientToken !== 'string' || !body.clientToken) {
    throw new Error('OpenChamber UI login did not return a client token');
  }
  return body.clientToken;
}

async function authTokenFor(baseUrl, settingsToken, forceLogin = false) {
  if (!forceLogin && settingsToken) return settingsToken;

  if (!forceLogin
    && authCache.baseUrl === baseUrl
    && authCache.token
    && Date.now() - authCache.at < 60 * 60 * 1000) {
    return authCache.token;
  }

  const password = readUiPassword();
  if (!password) {
    throw new Error('No OpenChamber UI token or OPENCHAMBER_UI_PASSWORD was found for the local server');
  }

  const token = await loginClientToken(baseUrl, password);
  authCache = { baseUrl, token, at: Date.now() };
  return token;
}

function requestQuota(baseUrl, token) {
  return fetch(`${baseUrl}/api/quota/${QUOTA_PROVIDER}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'openchamber-usage-pace/1.0',
    },
    signal: AbortSignal.timeout(6000),
  });
}

async function fetchQuota() {
  const { token: settingsToken, ports } = resolveRoute();
  let lastError = null;

  for (const port of ports) {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      let token = await authTokenFor(baseUrl, settingsToken);
      let response = await requestQuota(baseUrl, token);

      // A desktop token can expire, and a web/WSL login token can be revoked.
      // Read the password again and retry once with a fresh client token.
      if (response.status === 401) {
        authCache = { baseUrl: null, token: null, at: 0 };
        cachedUiPassword = undefined;
        token = await authTokenFor(baseUrl, '', true);
        response = await requestQuota(baseUrl, token);
      }

      if (response.status === 401) {
        throw new Error('OpenChamber rejected the local request (401). Check the UI password or client token.');
      }
      if (!response.ok) {
        throw new Error(`OpenChamber quota API returned HTTP ${response.status}`);
      }

      const body = await response.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        throw new Error('OpenChamber returned an unreadable quota response');
      }
      return body;
    } catch (error) {
      lastError = error;
      const refused = error && (error.name === 'TypeError' || error.cause?.code === 'ECONNREFUSED');
      if (refused) continue;
      throw error;
    }
  }

  throw lastError || new Error('OpenChamber is not reachable on localhost');
}

let cache = { at: 0, quota: null };

async function getQuota(force = false) {
  if (!force && cache.quota && Date.now() - cache.at < CACHE_MS) {
    return { quota: cache.quota, stale: false, error: null };
  }

  try {
    const quota = await fetchQuota();
    if (quota.ok !== false) {
      cache = { at: Date.now(), quota };
    }
    return { quota, stale: false, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cache.quota) {
      return { quota: cache.quota, stale: true, error: message };
    }
    return { quota: null, stale: false, error: message };
  }
}

/* --------------------------------------------------------------------------
 * Local service
 * ------------------------------------------------------------------------ */

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function startServer() {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  const token = String(process.env.OPENCHAMBER_SERVICE_TOKEN || '');

  if (!Number.isInteger(port) || port <= 0 || !token) {
    console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      const locale = url.searchParams.get('locale') || 'en';
      const { quota, stale, error } = await getQuota(false);
      sendJson(res, 200, buildView({ quota, locale, stale, error }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/status') {
      // No controls in this version. Keep the route for a future refresh button.
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'not-found' });
  });

  server.on('error', (error) => {
    console.error('usage-pace service error:', error.message);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`usage-pace service listening on 127.0.0.1:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildView,
  valueUnits,
  fetchQuota,
  getQuota,
  readSettings,
  resolveRoute,
  settingsPath,
};
