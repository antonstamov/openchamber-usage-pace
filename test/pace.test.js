'use strict';

const assert = require('node:assert/strict');

const {
  computePace,
  subtractMonth,
  segmentSignal,
  segmentCooldown,
  monthlyCooldown,
  paceBar,
} = require('../service/pace');
const { buildView, valueUnits } = require('../service/main');

const shown = (value) => String(value).replace(/\u00a0/g, '');

const checks = [];
function test(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
    console.log(`ok - ${name}`);
  } catch (error) {
    checks.push({ name, ok: false, error });
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

test('monthly window starts one calendar month before reset', () => {
  const reset = new Date(2026, 10, 24, 14, 59, 0).getTime();
  const start = new Date(subtractMonth(reset));
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 9); // October
  assert.equal(start.getDate(), 24);
  assert.equal(start.getHours(), 14);
  assert.equal(start.getMinutes(), 59);
});

test('month-end reset clamps the start day', () => {
  const reset = new Date(2026, 2, 31, 12, 0, 0).getTime(); // 31 March
  const start = new Date(subtractMonth(reset));
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 1); // February
  assert.equal(start.getDate(), 28);
  assert.equal(start.getHours(), 12);
});

test('weekly normal is half of the window at its midpoint', () => {
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const reset = now + 3.5 * DAY;
  const pace = computePace({ key: 'weekly', resetAt: reset, usedPercent: 2.4, now });
  assert.ok(pace);
  assert.ok(Math.abs(pace.normalPercent - 50) < 0.001);
  assert.ok(Math.abs(pace.delta - (-47.6)) < 0.001);
});

test('five-hour normal is half of the window at its midpoint', () => {
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const reset = now + 2.5 * HOUR;
  const pace = computePace({ key: '5h', resetAt: reset, usedPercent: 2, now });
  assert.ok(pace);
  assert.ok(Math.abs(pace.normalPercent - 50) < 0.001);
});

test('monthly normal is the elapsed share of the calendar cycle', () => {
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const reset = new Date(2026, 10, 24, 14, 59, 0).getTime();
  const pace = computePace({ key: 'monthly', resetAt: reset, usedPercent: 20.2, now });
  assert.ok(pace);
  assert.ok(pace.normalPercent > 5.9 && pace.normalPercent < 6.2);
  assert.ok(pace.delta > 13.9 && pace.delta < 14.3);
  assert.ok(pace.projectedPercent > 300);
  assert.ok(pace.projectedEnd < reset);
});

test('a reset in the past reads as a full window', () => {
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const reset = now - DAY;
  const pace = computePace({ key: 'weekly', resetAt: reset, usedPercent: 10, now });
  assert.ok(pace);
  assert.equal(pace.normalPercent, 100);
});

test('a reset beyond one window reads as the start of the window', () => {
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const reset = now + 40 * DAY;
  const pace = computePace({ key: 'monthly', resetAt: reset, usedPercent: 0, now });
  assert.ok(pace);
  assert.equal(pace.normalPercent, 0);
});

test('5h burst appears above the monthly pace', () => {
  const signal = segmentSignal({
    usedPercent: 40,
    monthlySharePercent: 20,
    monthlyNormalPercent: 6,
    monthlyUsedPercent: 0,
    remainingWindows: 10,
    elapsedFraction: 0.9,
    minBurstMonthlyPercent: 5,
  });
  // 40% of the 5h cap = 8% of the month; 10 windows left = 80% by reset.
  assert.equal(signal.monthlyShare, 8);
  assert.equal(signal.show, true);
  assert.equal(signal.burst, true);
  assert.equal(signal.overheat, false);
  assert.equal(signal.reason, 'burst');
  assert.equal(signal.nearCap, false);
  assert.equal(signal.tone, 'warning');
});

test('5h normal now is the cumulative share of the remaining monthly budget', () => {
  const signal = segmentSignal({
    usedPercent: 4.6,
    monthlySharePercent: 20,
    monthlyNormalPercent: 6,
    monthlyUsedPercent: 20.9,
    remainingWindows: 139,
    elapsedFraction: 0.6,
    minBurstMonthlyPercent: 5,
  });
  // 4.6% of the 5h cap = 0.92% of the month; 139 windows left ~ 128%.
  assert.ok(Math.abs(signal.monthlyShare - 0.92) < 0.001);
  assert.ok(signal.fullWindowNormal > 2.8 && signal.fullWindowNormal < 2.9);
  assert.ok(signal.normalNow > 1.65 && signal.normalNow < 1.75);
  assert.ok(signal.projectedMonthly > 200);
  assert.equal(signal.burst, false);
  assert.equal(signal.overheat, true);
  assert.equal(signal.reason, 'overheat');
  assert.equal(signal.tone, 'warning');
});

test('5h near its hard cap is an error even when the month is under', () => {
  const signal = segmentSignal({
    usedPercent: 85,
    monthlySharePercent: 20,
    monthlyNormalPercent: 30,
    monthlyUsedPercent: 0,
    remainingWindows: 1,
    elapsedFraction: 0.5,
    minBurstMonthlyPercent: 5,
  });
  assert.equal(signal.show, true);
  assert.equal(signal.nearCap, true);
  assert.equal(signal.reason, 'nearCap');
  assert.equal(signal.tone, 'error');
});

test('a quiet 5h row stays hidden', () => {
  const signal = segmentSignal({
    usedPercent: 1,
    monthlySharePercent: 20,
    monthlyNormalPercent: 6,
    monthlyUsedPercent: 20.9,
    remainingWindows: 139,
    elapsedFraction: 0.6,
    minBurstMonthlyPercent: 5,
  });
  assert.equal(signal.show, false);
});

test('weekly burst needs a meaningful absolute monthly share', () => {
  const quiet = segmentSignal({
    usedPercent: 9,
    monthlySharePercent: 50,
    monthlyNormalPercent: 6,
    monthlyUsedPercent: 0,
    remainingWindows: 4.14,
    elapsedFraction: 0.5,
    minBurstMonthlyPercent: 10,
  });
  const burst = segmentSignal({
    usedPercent: 22,
    monthlySharePercent: 50,
    monthlyNormalPercent: 6,
    monthlyUsedPercent: 0,
    remainingWindows: 4.14,
    elapsedFraction: 0.5,
    minBurstMonthlyPercent: 10,
  });
  assert.equal(quiet.show, false);
  assert.equal(burst.show, true);
  assert.equal(burst.monthlyShare, 11);
  assert.equal(burst.overheat, false);
  assert.equal(burst.reason, 'burst');
  assert.equal(burst.tone, 'warning');
});

test('weekly normal now is the cumulative share of the remaining monthly budget', () => {
  const signal = segmentSignal({
    usedPercent: 50,
    monthlySharePercent: 50,
    monthlyNormalPercent: 30,
    monthlyUsedPercent: 20,
    remainingWindows: 4.14,
    elapsedFraction: 0.5,
    minBurstMonthlyPercent: 10,
  });
  // 50% of the weekly cap = 25% of the month; 4.14 weeks left = ~123%.
  assert.ok(Math.abs(signal.monthlyShare - 25) < 0.001);
  assert.ok(signal.fullWindowNormal > 38 && signal.fullWindowNormal < 39);
  assert.ok(signal.normalNow > 19 && signal.normalNow < 20);
  assert.ok(signal.projectedMonthly > 200);
  assert.equal(signal.burst, false);
  assert.equal(signal.overheat, true);
  assert.equal(signal.reason, 'overheat');
  assert.equal(signal.tone, 'warning');
});

test('monthly cooldown is the time for the normal line to catch up', () => {
  const cooldown = monthlyCooldown({
    usedPercent: 22,
    normalNow: 7,
    elapsedFraction: 0.225,
    lengthMs: 31 * DAY,
  });
  assert.ok(cooldown);
  assert.equal(cooldown.kind, 'normal');
  assert.ok(cooldown.ms > 3.5 * DAY && cooldown.ms < 4.2 * DAY);
});

test('monthly cooldown is zero when already under the normal', () => {
  const cooldown = monthlyCooldown({
    usedPercent: 2,
    normalNow: 7,
    elapsedFraction: 0.225,
    lengthMs: 31 * DAY,
  });
  assert.deepEqual(cooldown, { kind: 'none', ms: 0 });
});

test('segment cooldown is the time for the window normal to catch up', () => {
  const cooldown = segmentCooldown({
    usedPercent: 6,
    normalNow: 4,
    fullWindowNormal: 38,
    elapsedFraction: 0.105,
    lengthMs: 7 * DAY,
  });
  assert.ok(cooldown);
  assert.equal(cooldown.kind, 'normal');
  assert.ok(cooldown.ms > 8 * HOUR && cooldown.ms < 10 * HOUR);
});

test('segment cooldown falls back to the reset when the normal cannot catch up', () => {
  const cooldown = segmentCooldown({
    usedPercent: 6,
    normalNow: 2.3,
    fullWindowNormal: 2.8,
    elapsedFraction: 0.96,
    lengthMs: 5 * HOUR,
  });
  assert.ok(cooldown);
  assert.equal(cooldown.kind, 'reset');
  assert.ok(cooldown.ms > 0);
});

test('segment cooldown is zero when already under the normal', () => {
  const cooldown = segmentCooldown({
    usedPercent: 1,
    normalNow: 2.7,
    fullWindowNormal: 38,
    elapsedFraction: 0.07,
    lengthMs: 7 * DAY,
  });
  assert.deepEqual(cooldown, { kind: 'none', ms: 0 });
});

test('the bar fills to the normal, not to 100%', () => {
  const bar = paceBar({ usedPercent: 1, normalPercent: 2 });
  assert.equal(bar.value, 50);
  assert.equal(bar.tone, 'success');
});

test('a tiny norm scales against 1% instead of a sliver', () => {
  const quiet = paceBar({ usedPercent: 0.4, normalPercent: 0.05 });
  assert.equal(quiet.value, 40);
  assert.equal(quiet.tone, 'success');

  const hot = paceBar({ usedPercent: 2.5, normalPercent: 0.05 });
  assert.equal(hot.value, 100);
  assert.equal(hot.tone, 'error');
});

test('an overheated bar is full and orange', () => {
  const bar = paceBar({ usedPercent: 3, normalPercent: 2 });
  assert.equal(bar.value, 100);
  assert.equal(bar.tone, 'warning');
});

test('twice the normal turns the bar red', () => {
  const bar = paceBar({ usedPercent: 4, normalPercent: 2 });
  assert.equal(bar.value, 100);
  assert.equal(bar.tone, 'error');
});

test('a bar without a normal keeps the plain usage fill', () => {
  const bar = paceBar({ usedPercent: 12, normalPercent: null });
  assert.equal(bar.value, 12);
  assert.equal(bar.tone, 'muted');
});

function quotaFixture({ monthly = 20.2, fiveHour = 1, weekly = 2.4 } = {}) {
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  return {
    now,
    quota: {
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      ok: true,
      configured: true,
      usage: {
        windows: {
          monthly: {
            usedPercent: monthly,
            resetAt: new Date(2026, 10, 24, 14, 59, 0).getTime(),
          },
          '5h': {
            usedPercent: fiveHour,
            resetAt: now + 2.5 * HOUR,
          },
          weekly: {
            usedPercent: weekly,
            resetAt: now + 3.5 * DAY,
          },
        },
      },
    },
  };
}

test('all three windows are shown with their normal, even when quiet', () => {
  const { now, quota } = quotaFixture();
  const view = buildView({ quota, now });
  assert.deepEqual(
    view.rows.map((row) => row.id),
    ['five-hour', 'weekly', 'monthly'],
  );

  const fiveHour = view.rows.find((row) => row.id === 'five-hour');
  assert.ok(fiveHour);
  assert.equal(fiveHour.badge, undefined);
  assert.equal(fiveHour.dot, 'success');
  assert.equal(fiveHour.label, '5-Hour');
  assert.equal(shown(fiveHour.value), '1.0% / 1.4%');
  assert.equal(fiveHour.valueTone, undefined);
  assert.equal(fiveHour.content.tone, 'success');
  assert.ok(fiveHour.content.value > 60 && fiveHour.content.value < 80);
  assert.equal(fiveHour.tooltip, 'Normal by the end of the window: 2.9% · already on pace.');

  const weekly = view.rows.find((row) => row.id === 'weekly');
  assert.ok(weekly);
  assert.equal(weekly.label, 'Weekly');
  assert.equal(weekly.badge, undefined);
  assert.equal(weekly.dot, 'success');
  assert.equal(shown(weekly.value), '2.4% / 19%');
  assert.equal(weekly.content.tone, 'success');
  assert.equal(weekly.tooltip, 'Normal by the end of the week: 38% · already on pace.');

  const monthly = view.rows.find((row) => row.id === 'monthly');
  assert.ok(monthly);
  assert.equal(monthly.label, 'Monthly');
  assert.equal(monthly.badge, undefined);
  assert.equal(shown(monthly.value), '20% / 6.1%');
  assert.equal(monthly.valueTone, 'error');
  assert.equal(monthly.dot, 'error');
  assert.match(monthly.tooltip, /20% \/ normal 6.1% — 14 pp over/);
  assert.doesNotMatch(monthly.tooltip, /by reset/);
  assert.match(monthly.tooltip, /80% left/);
});

test('russian copy follows the host locale', () => {
  const { now, quota } = quotaFixture();
  const view = buildView({ quota, locale: 'ru', now });
  assert.deepEqual(
    view.rows.map((row) => row.id),
    ['five-hour', 'weekly', 'monthly'],
  );

  const fiveHour = view.rows.find((row) => row.id === 'five-hour');
  assert.ok(fiveHour);
  assert.equal(fiveHour.dot, 'success');
  assert.equal(fiveHour.label, '5 часов');
  assert.equal(shown(fiveHour.value), '1.0% / 1.4%');
  assert.equal(fiveHour.tooltip, 'Норма к концу окна 2.9% · уже в норме.');

  const weekly = view.rows.find((row) => row.id === 'weekly');
  assert.ok(weekly);
  assert.equal(weekly.label, 'Еженедельно');
  assert.equal(weekly.tooltip, 'Норма к концу недели 38% · уже в норме.');

  const monthly = view.rows.find((row) => row.id === 'monthly');
  assert.ok(monthly);
  assert.equal(monthly.label, 'Ежемесячно');
  assert.equal(shown(monthly.value), '20% / 6.1%');
  assert.match(monthly.tooltip, /20% \/ норма 6.1% — перерасход 14 п\.п\./);
  assert.doesNotMatch(monthly.tooltip, /by reset|К сбросу/);
  assert.match(monthly.tooltip, /В запасе 80%/);
});

test('russian under-consumption and overheat copy', () => {
  const under = quotaFixture({ monthly: 2 });
  const underView = buildView({ quota: under.quota, locale: 'ru', now: under.now });
  const underMonthly = underView.rows.find((row) => row.id === 'monthly');
  assert.ok(underMonthly);
  assert.match(underMonthly.tooltip, /2.0% \/ норма 6.1% — недорасход 4 п\.п\./);
  assert.match(underMonthly.tooltip, /В запасе 98%/);

  const hot = quotaFixture({ monthly: 20.9, fiveHour: 2, weekly: 3.1 });
  const hotView = buildView({ quota: hot.quota, locale: 'ru', now: hot.now });
  const fiveHour = hotView.rows.find((row) => row.id === 'five-hour');
  assert.ok(fiveHour);
  assert.equal(fiveHour.tooltip, 'Норма к концу окна 2.8% · до нормы ~1 ч 15 мин без трат.');
  const hotMonthly = hotView.rows.find((row) => row.id === 'monthly');
  assert.ok(hotMonthly);
  assert.match(hotMonthly.tooltip, /21% \/ норма 6.1% — перерасход 15 п\.п\./);
  assert.match(hotMonthly.tooltip, /В запасе 79%/);
});

test('russian near-cap and not-configured copy', () => {
  const { now, quota } = quotaFixture({ monthly: 2, fiveHour: 85 });
  const view = buildView({ quota, locale: 'ru', now });
  const fiveHour = view.rows.find((row) => row.id === 'five-hour');
  assert.ok(fiveHour);
  assert.equal(fiveHour.dot, 'error');
  assert.equal(fiveHour.tooltip, 'Норма к концу окна 3.5% · до сброса ~2 ч 30 мин.');

  const missing = buildView({
    quota: {
      providerId: 'opencode-go',
      ok: false,
      configured: false,
      usage: null,
    },
    locale: 'ru',
    now: Date.now(),
  });
  assert.equal(missing.rows.length, 1);
  assert.match(missing.rows[0].text, /не подключён/);
});

test('a sub-1 percent keeps one decimal', () => {
  const { now, quota } = quotaFixture({ fiveHour: 0.67 });
  const view = buildView({ quota, now });
  const fiveHour = view.rows.find((row) => row.id === 'five-hour');
  assert.ok(fiveHour);
  assert.equal(shown(fiveHour.value), '0.7% / 1.4%');
});

test('the value column is padded to one width across rows', () => {
  const { now, quota } = quotaFixture();
  const view = buildView({ quota, now });
  const lines = view.rows.filter((row) => row.kind === 'line');
  assert.equal(new Set(lines.map((row) => valueUnits(row.value))).size, 1);
  for (const row of lines) {
    assert.ok(row.value.startsWith('\u00a0\u00a0'));
  }
});

test('under-consumption shows the monthly headroom in its tooltip', () => {
  const { now, quota } = quotaFixture({ monthly: 2 });
  const view = buildView({ quota, now });
  const monthly = view.rows.find((row) => row.id === 'monthly');
  assert.ok(monthly);
  assert.equal(monthly.valueTone, undefined);
  assert.equal(monthly.dot, 'success');
  assert.ok(monthly.content.value > 30 && monthly.content.value < 35);
  assert.equal(monthly.content.tone, 'success');
  assert.match(monthly.tooltip, /2.0% \/ normal 6.1% — 4 pp under/);
  assert.match(monthly.tooltip, /98% left/);
});

test('the current 5h pace is above the cumulative normal', () => {
  const { now, quota } = quotaFixture({ monthly: 20.9, fiveHour: 2, weekly: 3.1 });
  const view = buildView({ quota, now });
  assert.deepEqual(
    view.rows.map((row) => row.id),
    ['five-hour', 'weekly', 'monthly'],
  );
  const fiveHour = view.rows.find((row) => row.id === 'five-hour');
  assert.ok(fiveHour);
  assert.equal(fiveHour.badge, undefined);
  assert.equal(fiveHour.dot, 'warning');
  assert.equal(shown(fiveHour.value), '2.0% / 1.4%');
  assert.equal(fiveHour.valueTone, 'warning');
  assert.equal(fiveHour.tooltip, 'Normal by the end of the window: 2.8% · ~1 h 15 m without spending to reach normal.');

  const quietWeekly = view.rows.find((row) => row.id === 'weekly');
  assert.ok(quietWeekly);
  assert.equal(quietWeekly.badge, undefined);
  assert.equal(quietWeekly.dot, 'success');
  assert.equal(shown(quietWeekly.value), '3.1% / 19%');

  const monthly = view.rows.find((row) => row.id === 'monthly');
  assert.ok(monthly);
  assert.match(monthly.tooltip, /21% \/ normal 6.1% — 15 pp over/);
  assert.match(monthly.tooltip, /79% left/);
});

test('a near-cap 5h row is red and wins over overheat', () => {
  const { now, quota } = quotaFixture({ monthly: 2, fiveHour: 85 });
  const view = buildView({ quota, now });
  const fiveHour = view.rows.find((row) => row.id === 'five-hour');
  assert.ok(fiveHour);
  assert.equal(fiveHour.badge, undefined);
  assert.equal(fiveHour.dot, 'error');
  assert.equal(shown(fiveHour.value), '85% / 1.8%');
  assert.equal(fiveHour.valueTone, 'error');
  assert.equal(fiveHour.tooltip, 'Normal by the end of the window: 3.5% · resets in ~2 h 30 m.');
});

test('not configured shows a clear note', () => {
  const view = buildView({
    quota: {
      providerId: 'opencode-go',
      ok: false,
      configured: false,
      usage: null,
    },
    now: Date.now(),
  });
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].kind, 'note');
  assert.match(view.rows[0].text, /not connected/);
});

test('stale data keeps rows and adds a warning', () => {
  const { now, quota } = quotaFixture();
  const view = buildView({ quota, now, stale: true, error: 'timeout' });
  assert.equal(view.rows.at(-1).id, 'stale');
  assert.equal(view.rows.at(-1).tone, 'warning');
  assert.match(view.rows.at(-1).text, /timeout/);
});

test('missing monthly meter keeps the segment rows and reports the missing meter', () => {
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const view = buildView({
    quota: {
      ok: true,
      configured: true,
      usage: { windows: { weekly: { usedPercent: 20, resetAt: now + 3.5 * DAY } } },
    },
    now,
  });
  assert.deepEqual(view.rows.map((row) => row.id), ['weekly', 'no-monthly']);
  assert.equal(view.rows[0].badge, undefined);
  assert.match(view.rows[1].text, /no monthly meter/i);
});

test('monthly tooltip copy', () => {
  const { now, quota } = quotaFixture({ monthly: 2 });
  const view = buildView({ quota, now });
  const monthly = view.rows.find((row) => row.id === 'monthly');
  assert.ok(monthly);
  assert.match(monthly.tooltip, /2.0% \/ normal 6.1% — 4 pp under/);
  assert.match(monthly.tooltip, /98% left/);
});

test('waiting for shared credentials shows a muted note, not an error', () => {
  const ru = buildView({ quota: null, locale: 'ru', error: 'CREDENTIAL_NOT_SHARED', waiting: true, now: Date.now() });
  assert.equal(ru.rows.length, 1);
  assert.equal(ru.rows[0].kind, 'note');
  assert.equal(ru.rows[0].id, 'waiting');
  assert.equal(ru.rows[0].tone, 'muted');
  assert.match(ru.rows[0].text, /Usage/);

  const en = buildView({ quota: null, locale: 'en', error: 'CREDENTIAL_NOT_SHARED', waiting: true, now: Date.now() });
  assert.equal(en.rows[0].id, 'waiting');
  assert.equal(en.rows[0].tone, 'muted');
  assert.match(en.rows[0].text, /Usage/);
});

test('a real fetch error still shows a red note without a double period', () => {
  const view = buildView({ quota: null, locale: 'ru', error: 'timeout.', now: Date.now() });
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].id, 'error');
  assert.equal(view.rows[0].tone, 'error');
  assert.ok(!view.rows[0].text.endsWith('..'));
  assert.match(view.rows[0].text, /Не удалось получить данные OpenCode Go: timeout\./);
});

test('stale data while waiting for credentials shows a muted hint', () => {
  const { now, quota } = quotaFixture();
  const view = buildView({ quota, now, stale: true, error: 'CREDENTIAL_NOT_SHARED', waiting: true });
  assert.equal(view.rows.at(-1).id, 'stale-waiting');
  assert.equal(view.rows.at(-1).tone, 'muted');
  assert.match(view.rows.at(-1).text, /Usage/);
});

const failed = checks.filter((check) => !check.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  process.exitCode = 1;
}
