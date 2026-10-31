'use strict';

// The three OpenCode Go meters are nested. A meter's `usedPercent` is its own
// share of its own limit, not a share of the month:
//   5h     limit = 20% of the monthly allowance
//   weekly limit = 50% of the monthly allowance
//   monthly limit = 100%
// Only the monthly meter describes a monthly pace. The other two describe how
// much of their own guardrail is used.
const FIXED_WINDOWS = {
  '5h': { label: '5-Hour', lengthMs: 5 * 60 * 60 * 1000, monthlySharePercent: 20 },
  weekly: { label: 'Weekly', lengthMs: 7 * 24 * 60 * 60 * 1000, monthlySharePercent: 50 },
  monthly: { label: 'Monthly', monthlySharePercent: 100 },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * The start of the monthly cycle, one calendar month before the reset.
 * Keeps the wall-clock time and clamps the day for short months, so a reset
 * on the 31st starts on the 30th (or 28th/29th) when that month is shorter.
 */
function subtractMonth(timestamp) {
  const date = new Date(timestamp);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() - 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return date.getTime();
}

function windowStart(key, resetAt) {
  const config = FIXED_WINDOWS[key];
  if (!config) throw new Error(`Unknown window: ${key}`);
  return key === 'monthly' ? subtractMonth(resetAt) : resetAt - config.lengthMs;
}

/**
 * How much of the window has passed, next to how much of that window is used.
 * `normalPercent` is the monthly pace target and is meaningful for the
 * monthly meter only; it is never shown as a target for 5h/weekly.
 */
function computePace({ key, resetAt, usedPercent, now = Date.now() }) {
  const config = FIXED_WINDOWS[key];
  const reset = Number(resetAt);
  const usedInput = Number(usedPercent);
  if (!config || !Number.isFinite(reset) || reset <= 0 || !Number.isFinite(usedInput)) {
    return null;
  }

  const start = windowStart(key, reset);
  const length = reset - start;
  if (!Number.isFinite(length) || length <= 0) return null;

  const elapsed = clamp(now - start, 0, length);
  const used = clamp(usedInput, 0, 100);
  const elapsedFraction = elapsed / length;
  const normalPercent = elapsedFraction * 100;
  const delta = used - normalPercent;
  const projectedPercent = elapsedFraction > 0 && used > 0 ? used / elapsedFraction : null;
  const projectedEnd = projectedPercent !== null && used > 0
    ? start + elapsed / (used / 100)
    : null;

  return {
    key,
    start,
    reset,
    length,
    elapsed,
    elapsedFraction,
    usedPercent: used,
    normalPercent,
    delta,
    projectedPercent,
    projectedEnd,
    monthlySharePercent: config.monthlySharePercent,
  };
}

/**
 * Why a 5h/weekly row appears.
 *
 * `usedPercent` is the share of that window's own limit (100 = window cap).
 * `monthlyShare` converts it to a share of the monthly allowance:
 * 5h × 20%, weekly × 50%.
 *
 * - overheat: if every remaining window until the monthly reset ended with
 *   this same percentage, the month would pass 100%. The projection adds the
 *   month already spent, so it answers "will we run out before the reset?".
 *   This is an orange warning, not a violation of the window cap.
 * - burst: the window alone has already spent more of the month than the
 *   monthly pace allows by now, with an absolute floor to avoid noise.
 * - nearCap / overCap: 80% / 100% of the window's own limit. These are red.
 */
function segmentSignal({
  usedPercent,
  monthlySharePercent,
  monthlyNormalPercent,
  monthlyUsedPercent,
  remainingWindows,
  elapsedFraction,
  minBurstMonthlyPercent = 0,
}) {
  const used = clamp(Number(usedPercent), 0, 100);
  const capShare = clamp(Number(monthlySharePercent), 0, 100);
  const normal = Number.isFinite(Number(monthlyNormalPercent))
    ? Number(monthlyNormalPercent)
    : null;
  const monthlyUsed = Number.isFinite(Number(monthlyUsedPercent))
    ? clamp(Number(monthlyUsedPercent), 0, 100)
    : null;
  const remaining = Number.isFinite(Number(remainingWindows))
    ? Math.max(0, Number(remainingWindows))
    : 0;
  const elapsed = Number.isFinite(Number(elapsedFraction))
    ? clamp(Number(elapsedFraction), 0, 1)
    : null;

  // How much of this window may be used by now so that the remaining monthly
  // budget lasts exactly until the monthly reset. This is the number the row
  // shows as "normal" and the threshold overheat compares against.
  const leftOfMonth = monthlyUsed !== null ? Math.max(0, 100 - monthlyUsed) : null;
  const fullWindowNormal = leftOfMonth !== null && remaining > 0 && capShare > 0
    ? clamp(leftOfMonth / ((capShare / 100) * remaining), 0, 100)
    : null;
  const normalNow = fullWindowNormal !== null && elapsed !== null
    ? clamp(fullWindowNormal * elapsed, 0, 100)
    : null;

  const monthlyShare = used * capShare / 100;
  const projectedFullWindow = elapsed !== null && elapsed > 0
    ? used / elapsed
    : null;
  const projectedMonthly = projectedFullWindow !== null && monthlyUsed !== null
    ? monthlyUsed + (projectedFullWindow * capShare / 100) * remaining
    : null;

  // `used > normalNow` is the same as "the current rate projected to the
  // whole window would pass fullWindowNormal".
  const overheat = normalNow !== null && remaining > 0 && used > normalNow + 1e-9;
  const burst = normal !== null
    && monthlyShare > Math.max(normal + 1, minBurstMonthlyPercent);
  const nearCap = used >= 80;
  const overCap = used >= 100;

  const reason = overCap
    ? 'overCap'
    : nearCap
      ? 'nearCap'
      : overheat
        ? 'overheat'
        : burst
          ? 'burst'
          : null;

  return {
    show: reason !== null,
    burst,
    overheat,
    nearCap,
    overCap,
    reason,
    tone: nearCap || overCap ? 'error' : 'warning',
    monthlyShare,
    monthlyUsedPercent: monthlyUsed,
    projectedMonthly,
    projectedFullWindow,
    normalNow,
    fullWindowNormal,
    remainingWindows: remaining,
  };
}

/**
 * Time without spending until the current window's usage is back at its
 * normal now. If the window resets first, the answer is the time to reset.
 */
function segmentCooldown({
  usedPercent,
  normalNow,
  fullWindowNormal,
  elapsedFraction,
  lengthMs,
}) {
  const used = Number(usedPercent);
  const normal = Number(normalNow);
  const full = Number(fullWindowNormal);
  const elapsed = Number(elapsedFraction);
  const length = Number(lengthMs);
  if (![used, normal, full, elapsed, length].every(Number.isFinite) || length <= 0) {
    return null;
  }

  const remaining = Math.max(0, length * (1 - clamp(elapsed, 0, 1)));
  if (used <= normal) return { kind: 'none', ms: 0 };
  if (full <= 0 || used > full) return { kind: 'reset', ms: remaining };

  const timeToNormal = (used / full - elapsed) * length;
  if (!Number.isFinite(timeToNormal) || timeToNormal >= remaining) {
    return { kind: 'reset', ms: remaining };
  }
  return { kind: 'normal', ms: Math.max(0, timeToNormal) };
}

/**
 * Time without spending until the monthly normal line (which reaches 100%
 * at the reset) catches up to the current monthly usage.
 */
function monthlyCooldown({ usedPercent, normalNow, elapsedFraction, lengthMs }) {
  const used = Number(usedPercent);
  const normal = Number(normalNow);
  const elapsed = Number(elapsedFraction);
  const length = Number(lengthMs);
  if (![used, normal, elapsed, length].every(Number.isFinite) || length <= 0) {
    return null;
  }

  const remaining = Math.max(0, length * (1 - clamp(elapsed, 0, 1)));
  if (used <= normal) return { kind: 'none', ms: 0 };
  if (used >= 100 || normal >= 100) return { kind: 'reset', ms: remaining };

  const timeToNormal = ((used - normal) / (100 - normal)) * remaining;
  if (!Number.isFinite(timeToNormal) || timeToNormal >= remaining) {
    return { kind: 'reset', ms: remaining };
  }
  return { kind: 'normal', ms: Math.max(0, timeToNormal) };
}

/** Smallest normal the bar scales against, in percent. */
const BAR_FLOOR_PERCENT = 1;

/**
 * The row bar fills to the normal line instead of 100%: at the normal it is
 * full and green. Above the normal it stays full and turns warning, then
 * error once usage is twice the normal. Without a normal it keeps the plain
 * usage fill and a muted tone.
 */
function paceBar({ usedPercent, normalPercent }) {
  const used = Number(usedPercent);
  const hasNormal = normalPercent !== null && normalPercent !== undefined && normalPercent !== '';
  const normal = Number(normalPercent);
  if (!Number.isFinite(used)) return null;
  if (!hasNormal || !Number.isFinite(normal) || normal < 0) {
    return { value: clamp(used, 0, 100), tone: 'muted' };
  }

  // Right after a reset the normal is a sliver of a percent; scaling against
  // 1% keeps the first minutes of a window from painting a full red bar.
  const scale = Math.max(normal, BAR_FLOOR_PERCENT);
  if (used <= scale) {
    return { value: clamp((used / scale) * 100, 0, 100), tone: 'success' };
  }
  return { value: 100, tone: used >= scale * 2 ? 'error' : 'warning' };
}

module.exports = {
  FIXED_WINDOWS,
  clamp,
  subtractMonth,
  windowStart,
  computePace,
  segmentSignal,
  segmentCooldown,
  monthlyCooldown,
  paceBar,
};
