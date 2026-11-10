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
const { fetchGoQuota } = require('./console-go');
// A short cache only absorbs duplicate reads between the host's 30s polls; it
// must stay under the poll interval so a window reset shows up right away.
const CACHE_MS = 25 * 1000;
// Startup race pad: on (re)start the host's first GET /status routinely lands
// milliseconds before the POST /quota that shares the credentials (seen live:
// 1 ms apart). Hold a credential-less read briefly so it picks up credentials
// that are already on their way instead of flashing "waiting". Well under the
// host's 20 s service budget.
const CREDENTIAL_WAIT_MS = 1000;
const CREDENTIAL_WAIT_STEP_MS = 50;

const RU = {
  label5h: '5 часов',
  labelWeekly: 'Еженедельно',
  labelMonthly: 'Ежемесячно',
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
  stale: (error) => `OpenChamber не обновил данные: ${cleanTail(error)}. Показаны последние известные.`,
  error: (error) => `Не удалось получить данные OpenCode Go: ${cleanTail(error)}.`,
  notConfigured: 'OpenCode Go не подключён в OpenChamber.',
  waiting: 'Откройте страницу Usage, чтобы OpenChamber передал кред OpenCode Go.',
  noMonthly: 'OpenCode Go не вернул месячное окно.',
  noData: 'OpenCode Go не вернул окна использования.',
  days: (n) => `${n} ${pluralRu(n, ['день', 'дня', 'дней'])}`,
  pp: 'п.п.',
};

const EN = {
  label5h: '5-Hour',
  labelWeekly: 'Weekly',
  labelMonthly: 'Monthly',
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
  stale: (error) => `OpenChamber did not refresh: ${cleanTail(error)}. Showing the last known values.`,
  error: (error) => `Could not read OpenCode Go usage: ${cleanTail(error)}.`,
  notConfigured: 'OpenCode Go is not connected in OpenChamber.',
  waiting: 'Open the Usage page once so OpenChamber shares the OpenCode Go credential.',
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

/** The interpolated detail may already end with a period (the waiting copy does). */
function cleanTail(text) {
  return String(text || '').replace(/[\s.…]+$/u, '');
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
    label: strings.labelMonthly,
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
    label: key === '5h' ? strings.label5h : strings.labelWeekly,
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

function buildView({ quota = null, locale = 'en', stale = false, error = null, waiting = false, now = Date.now() } = {}) {
  const strings = stringsFor(locale);
  const rows = [];

  if (!quota && error) {
    // Waiting for the first shared credential is a normal cold start (the
    // service keeps credentials in memory only), not a failure: keep it muted.
    if (waiting) {
      rows.push(note('waiting', strings.waiting, 'muted'));
      return { rows };
    }
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
    if (waiting) {
      rows.push(note('stale-waiting', strings.waiting, 'muted'));
    } else {
      rows.push(note('stale', strings.stale(error || 'unknown error'), 'warning'));
    }
  }

  if (rows.length === 0) {
    rows.push(note('no-data', strings.noData, 'muted'));
  }

  alignValues(rows);
  return { rows };
}

/* --------------------------------------------------------------------------
 * Direct quota source
 *
 * The numbers come from the OpenCode Console API, read with the credential
 * the host hands the service on every `usage.read`. Nothing is discovered
 * about the host itself: no settings file, no ports, no passwords.
 * ------------------------------------------------------------------------ */

let lastCredentials = null;
let quotaCache = { at: 0, result: null };

/* --------------------------------------------------------------------------
 * Diagnostics (D): the service keeps credentials and the quota in memory
 * only, so any restart wipes both and /status answers "waiting" until the
 * next POST /quota. These counters (visible on GET /health, no secrets)
 * tell a restart-driven waiting flash apart from a host that stopped
 * sharing credentials with a live service.
 * ------------------------------------------------------------------------ */

const stats = {
  startedAt: Date.now(),
  statusGets: 0,
  quotaPosts: 0,
  quotaWithCreds: 0,
  statusWaiting: 0,
  fetchOk: 0,
  fetchFail: 0,
  lastQuotaAt: 0,
  lastFetchAt: 0,
  lastFetchOkAt: 0,
  lastFetchError: null,
};
let lastCredKeys = '';
let wasWaiting = false;
let waitingSince = 0;

/* --------------------------------------------------------------------------
 * File log: the host does not persist guest-service stdout anywhere
 * retrievable (its main.log carries no service output), and an idle service
 * is stopped, wiping memory. So diagnostics also go to a small rotating
 * file with no secrets — the only post-hoc trace of restarts and waiting
 * flashes. Writes are synchronous and rare (transitions only), so a kill
 * cannot lose buffered lines.
 * ------------------------------------------------------------------------ */

const LOG_MAX_BYTES = 200 * 1024;
const LOG_PATH = process.env.USAGE_PACE_LOG_PATH
  || path.join(os.tmpdir(), 'openchamber-usage-pace.log');
let fileLogEnabled = false;

function serviceLog(message) {
  console.log(`usage-pace: ${message}`);
  if (!fileLogEnabled) return;
  try {
    try {
      if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) {
        try { fs.rmSync(`${LOG_PATH}.1`, { force: true }); } catch { /* ignore */ }
        fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
      }
    } catch { /* fall through to append */ }
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [pid=${process.pid}] ${message}\n`);
  } catch { /* logging must never break the service */ }
}

/**
 * The latest credential map the host handed over (`input.credentials` of
 * `usage.read`), kept for the host-driven `/status` polls between card
 * refreshes. Credentials are read fresh on every `usage.read`, like the
 * built-in provider does, so an account switch never shows stale numbers.
 */
function storeCredentials(input) {
  if (input && typeof input === 'object'
    && input.credentials && typeof input.credentials === 'object'
    && Object.keys(input.credentials).length > 0) {
    lastCredentials = input.credentials;
    // Provider ids only, never credential values.
    const keys = Object.keys(input.credentials).sort().join(',');
    if (keys !== lastCredKeys) {
      lastCredKeys = keys;
      serviceLog(`credentials shared for [${keys}]`);
    }
  }
}

/**
 * Resolve once shared credentials appear, or when the timeout elapses.
 * Only the polling GET /status path waits (force=false); the POST /quota
 * path just stored credentials and never needs it.
 */
function waitForCredentials(timeoutMs) {
  if (lastCredentials) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (lastCredentials || Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve(Boolean(lastCredentials));
      }
    }, CREDENTIAL_WAIT_STEP_MS);
  });
}

async function getQuota(force = false) {
  if (!force && quotaCache.result && Date.now() - quotaCache.at < CACHE_MS) {
    return { quota: quotaCache.result, stale: false, error: null, waiting: false };
  }

  if (!lastCredentials && !force) {
    const found = await waitForCredentials(CREDENTIAL_WAIT_MS);
    if (found) serviceLog('picked up shared credentials while waiting');
  }

  if (!lastCredentials) {
    if (quotaCache.result) {
      return { quota: quotaCache.result, stale: true, error: 'CREDENTIAL_NOT_SHARED', waiting: true };
    }
    return { quota: null, stale: false, error: 'CREDENTIAL_NOT_SHARED', waiting: true };
  }

  try {
    const result = await fetchGoQuota(lastCredentials);
    stats.lastFetchAt = Date.now();
    if (result.ok) {
      quotaCache = { at: Date.now(), result };
      stats.fetchOk += 1;
      stats.lastFetchOkAt = Date.now();
      stats.lastFetchError = null;
      return { quota: result, stale: false, error: null, waiting: false };
    }
    stats.fetchFail += 1;
    if (stats.lastFetchError !== result.error) {
      stats.lastFetchError = result.error;
      serviceLog(`quota fetch failed: ${result.error}`);
    }
    if (quotaCache.result) {
      return { quota: quotaCache.result, stale: true, error: result.error, waiting: false };
    }
    return { quota: result, stale: false, error: result.error, waiting: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stats.lastFetchAt = Date.now();
    stats.fetchFail += 1;
    if (stats.lastFetchError !== message) {
      stats.lastFetchError = message;
      serviceLog(`quota fetch failed: ${message}`);
    }
    if (quotaCache.result) {
      return { quota: quotaCache.result, stale: true, error: message, waiting: false };
    }
    return { quota: null, stale: false, error: message, waiting: false };
  }
}

/* --------------------------------------------------------------------------
 * Extension quota provider role (`provides: ["quota"]`)
 *
 * The host draws a standard card for the extension and asks it for usage
 * with POST /quota (`usage.read`), handing it the OpenCode credential it
 * holds for `opencode-go`. The numbers themselves still come from the
 * host's own quota endpoint (the same bridge as /status): this keeps one
 * fetch implementation while the card stays a host-rendered built-in twin.
 * ------------------------------------------------------------------------ */

const QUOTA_WINDOWS_MAX = 32;
const QUOTA_NAME_MAX = 128;
const QUOTA_LABEL_MAX = 128;
const QUOTA_RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeWindowName(name) {
  return typeof name === 'string'
    && name.length >= 1
    && name.length <= QUOTA_NAME_MAX
    && !QUOTA_RESERVED_NAMES.has(name);
}

/**
 * Pick only the keys the host's `quotaProviderSchemasV1` accepts (it is
 * strict: derived fields like `remainingPercent` would fail the parse).
 */
function mapQuotaWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const mapped = {
    usedPercent: typeof window.usedPercent === 'number'
      && Number.isFinite(window.usedPercent)
      && window.usedPercent >= 0
      ? window.usedPercent
      : null,
    windowSeconds: Number.isInteger(window.windowSeconds) && window.windowSeconds > 0
      ? window.windowSeconds
      : null,
    resetAt: Number.isInteger(window.resetAt) && window.resetAt >= 0 && window.resetAt <= Number.MAX_SAFE_INTEGER
      ? window.resetAt
      : (typeof window.resetAt === 'number' && Number.isFinite(window.resetAt) && window.resetAt >= 0
        ? Math.floor(window.resetAt)
        : null),
  };
  if (typeof window.valueLabel === 'string' && window.valueLabel.trim() !== '') {
    mapped.valueLabel = window.valueLabel.slice(0, QUOTA_LABEL_MAX);
  }
  if (typeof window.creditsUsed === 'number' && Number.isFinite(window.creditsUsed) && window.creditsUsed >= 0) {
    mapped.creditsUsed = window.creditsUsed;
  }
  return mapped;
}

function mapQuotaToUsageData(quota) {
  if (!quota || typeof quota !== 'object') {
    return { ok: false, configured: true, error: 'OpenChamber returned an unreadable quota response', usage: null };
  }
  if (quota.configured === false) {
    return {
      ok: false,
      configured: false,
      error: String(quota.error || 'OpenCode Go is not connected in OpenChamber'),
      usage: null,
    };
  }
  const source = quota.usage && typeof quota.usage === 'object' ? quota.usage.windows : null;
  const windows = {};
  if (source && typeof source === 'object') {
    for (const name of Object.keys(source).slice(0, QUOTA_WINDOWS_MAX)) {
      if (!isSafeWindowName(name)) continue;
      const mapped = mapQuotaWindow(source[name]);
      if (mapped) windows[name] = mapped;
    }
  }
  if (Object.keys(windows).length === 0) {
    return {
      ok: false,
      configured: typeof quota.configured === 'boolean' ? quota.configured : true,
      error: String((quota.ok === false && quota.error) || 'OpenCode Go returned no usage windows'),
      usage: null,
    };
  }
  const data = {
    ok: quota.ok !== false,
    configured: true,
    usage: { windows },
  };
  if (quota.ok === false && quota.error) data.error = String(quota.error);
  return data;
}

function parseUsageRead(body) {
  let parsed = body;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { error: 'Request body is not valid JSON' };
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { error: 'Request body must be a JSON object' };
  }
  if (parsed.method !== 'usage.read') {
    return { error: `Unsupported method: ${String(parsed.method || '(missing)')}` };
  }
  return { input: parsed.input && typeof parsed.input === 'object' ? parsed.input : {} };
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
  fileLogEnabled = true;

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, stats });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      const locale = url.searchParams.get('locale') || 'en';
      const { quota, stale, error, waiting } = await getQuota(false);
      stats.statusGets += 1;
      if (waiting) {
        stats.statusWaiting += 1;
        if (!wasWaiting) {
          waitingSince = Date.now();
          const sinceQuota = stats.lastQuotaAt
            ? `, last POST /quota ${Math.round((Date.now() - stats.lastQuotaAt) / 1000)}s ago`
            : ', no POST /quota since start';
          serviceLog(`/status waiting for shared credentials${sinceQuota}`);
        }
      } else if (wasWaiting) {
        serviceLog(`/status recovered after ${Math.round((Date.now() - waitingSince) / 1000)}s of waiting`);
      }
      wasWaiting = waiting;
      const strings = stringsFor(locale);
      sendJson(res, 200, buildView({ quota, locale, stale, error: waiting ? strings.waiting : error, waiting }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/status') {
      // No controls in this version. Keep the route for a future refresh button.
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/quota') {
      // Extension quota provider role: the host posts `usage.read` with the
      // OpenCode credentials it holds. The numbers come straight from the
      // OpenCode Console API; the host itself is never contacted.
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 65536) req.destroy();
      });
      req.on('end', async () => {
        const parsed = parseUsageRead(raw);
        if (parsed.error) {
          sendJson(res, 400, { ok: false, error: { message: parsed.error } });
          return;
        }
        storeCredentials(parsed.input);
        stats.quotaPosts += 1;
        if (parsed.input && parsed.input.credentials
          && typeof parsed.input.credentials === 'object'
          && Object.keys(parsed.input.credentials).length > 0) {
          stats.quotaWithCreds += 1;
          stats.lastQuotaAt = Date.now();
        }
        try {
          const { quota, waiting } = await getQuota(true);
          const data = mapQuotaToUsageData(quota);
          if (waiting) {
            data.error = 'OpenChamber has not shared the OpenCode Go credential yet.';
          }
          sendJson(res, 200, { ok: true, data });
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          });
        }
      });
      return;
    }

    sendJson(res, 404, { error: 'not-found' });
  });

  server.on('error', (error) => {
    serviceLog(`service error: ${error.message}`);
    console.error('usage-pace service error:', error.message);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    serviceLog(`service started listening on 127.0.0.1:${port}`);
    console.log(`usage-pace service started (pid=${process.pid}) listening on 127.0.0.1:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildView,
  valueUnits,
  stringsFor,
  getQuota,
  waitForCredentials,
  storeCredentials,
  mapQuotaWindow,
  mapQuotaToUsageData,
  parseUsageRead,
  stats,
};
