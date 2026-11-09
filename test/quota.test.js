'use strict';

const assert = require('node:assert/strict');

const {
  mapQuotaToUsageData,
  parseUsageRead,
} = require('../service/main');
const {
  fetchGoQuota,
  isConfigured,
  parseOpenCodeGoUsage,
  parseConsoleGoUsage,
  parseConsoleBillingBalance,
  NO_CONSOLE_SUBSCRIPTION,
  API_KEY_EXPIRED,
} = require('../service/console-go');

const checks = [];
function test(name, fn) {
  const run = async () => {
    try {
      await fn();
      checks.push({ name, ok: true });
      console.log(`ok - ${name}`);
    } catch (error) {
      checks.push({ name, ok: false, error });
      console.error(`not ok - ${name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  };
  pending.push(run());
}
const pending = [];

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const consoleMeter = (used, limit, resetsAt) => ({
  limitMicroCents: String(limit),
  usedMicroCents: String(used),
  resetsAt,
});
const consoleStatus = (overrides = {}) => ({
  product: 'go',
  access: {
    meters: {
      fiveHour: consoleMeter(45_000_000, 1_000_000_000, NOW + 4 * HOUR),
      week: consoleMeter(350_000_000, 1_000_000_000, NOW + 3 * 24 * HOUR),
      month: consoleMeter(450_000_000, 1_000_000_000, NOW + 10 * 24 * HOUR),
    },
  },
  ...overrides,
});
const usageApi = () => ({
  usage: {
    rolling: { percent: 4.5, resetsAt: NOW + 4 * HOUR },
    weekly: { percent: 35, resetsAt: NOW + 3 * 24 * HOUR },
    monthly: { percent: 45, resetsAt: NOW + 10 * 24 * HOUR },
  },
});

const response = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

/** Route stub fetch by URL fragment. */
const stubFetch = (routes) => async (url) => {
  for (const [fragment, answer] of routes) {
    if (String(url).includes(fragment)) {
      return typeof answer === 'function' ? answer(url) : answer;
    }
  }
  throw new Error(`unexpected request: ${url}`);
};

const signIn = (overrides = {}) => ({
  type: 'oauth',
  access: 'console-access-token',
  orgID: 'wrk_abc123',
  server: 'https://opencode.ai/console',
  expires: NOW + HOUR,
  ...overrides,
});

test('console usage parses micro-cent meters', () => {
  const windows = parseConsoleGoUsage(consoleStatus());
  assert.equal(windows['5h'].usedPercent, 4.5);
  assert.equal(windows.weekly.usedPercent, 35);
  assert.equal(windows.monthly.usedPercent, 45);
  assert.equal(windows.monthly.resetAt, consoleStatus().access.meters.month.resetsAt);
});

test('console usage skips unusable meters only', () => {
  const payload = consoleStatus();
  payload.access.meters.week = { limitMicroCents: '0', usedMicroCents: '5', resetsAt: NOW + HOUR };
  delete payload.access.meters.month;
  const windows = parseConsoleGoUsage(payload);
  assert.deepEqual(Object.keys(windows), ['5h']);
});

test('billing balance parses micro-cents to dollars', () => {
  assert.equal(parseConsoleBillingBalance({ availableMicroCents: '250000000' }), 2.5);
  assert.equal(parseConsoleBillingBalance({ availableMicroCents: '-5' }), null);
  assert.equal(parseConsoleBillingBalance({}), null);
});

test('usage API parses floored percent windows', () => {
  const windows = parseOpenCodeGoUsage(usageApi());
  assert.equal(windows['5h'].usedPercent, 4.5);
  assert.equal(windows.weekly.usedPercent, 35);
  assert.equal(windows.monthly.usedPercent, 45);
});

test('console sign-in wins over the api key', async () => {
  const credentials = {
    'opencode-go': { type: 'api', key: 'oc_sk_key' },
    opencode: signIn(),
  };
  assert.equal(isConfigured(credentials), true);
  const fetchImpl = stubFetch([
    ['/console/api/go/status', response(200, consoleStatus())],
    ['/console/api/billing/status', response(200, { availableMicroCents: '250000000' })],
  ]);
  const result = await fetchGoQuota(credentials, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.usage.windows.monthly.usedPercent, 45);
  assert.equal(result.usage.windows.credits_balance.valueLabel, '$2.50');
});

test('failed balance read drops the credits row, not the refresh', async () => {
  const fetchImpl = stubFetch([
    ['/console/api/go/status', response(200, consoleStatus())],
    ['/console/api/billing/status', response(500, {})],
  ]);
  const result = await fetchGoQuota({ opencode: signIn() }, fetchImpl);
  assert.equal(result.ok, true);
  assert.ok(!('credits_balance' in result.usage.windows));
});

test('console failure falls back to the api key', async () => {
  const fetchImpl = stubFetch([
    ['/console/api/go/status', (url) => (url.includes('/billing/') ? response(200, {}) : response(500, {}))],
    ['/zen/go/v1/usage', response(200, usageApi())],
  ]);
  const result = await fetchGoQuota({
    opencode: signIn(),
    'opencode-go': { type: 'api', key: 'oc_sk_key' },
  }, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.usage.windows.monthly.usedPercent, 45);
});

test('expired console sign-in reports sign-in again', async () => {
  const result = await fetchGoQuota({ opencode: signIn({ expires: NOW - 1000 }) }, stubFetch([]));
  assert.equal(result.ok, false);
  assert.match(result.error, /sign in again/i);
});

test('expired api key names the console account', async () => {
  const fetchImpl = stubFetch([
    ['/console/api/go/status', response(500, {})],
    ['/zen/go/v1/usage', response(401, { error: { code: 'api_key_expired' } })],
  ]);
  const result = await fetchGoQuota({ 'opencode-go': { type: 'api', key: 'oc_sk_old' } }, fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.error, API_KEY_EXPIRED);
});

test('workspace key without go reports no subscription', async () => {
  const fetchImpl = stubFetch([
    ['/console/api/go/status', response(500, {})],
    ['/zen/go/v1/usage', response(403, {})],
  ]);
  const result = await fetchGoQuota({ opencode: { type: 'api', key: 'oc_sk_plain' } }, fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.error, NO_CONSOLE_SUBSCRIPTION);
});

test('no credential is not configured', async () => {
  assert.equal(isConfigured({}), false);
  const result = await fetchGoQuota({}, stubFetch([]));
  assert.deepEqual(result, { ok: false, configured: false, error: 'Not configured', usage: null });
});

test('non-console oauth is ignored', async () => {
  const credentials = { opencode: { type: 'oauth', access: 'x', orgID: 'org_1', server: 'https://other.example' } };
  assert.equal(isConfigured(credentials), false);
});

test('usage data maps handed windows one to one', () => {
  const data = mapQuotaToUsageData({
    ok: true,
    configured: true,
    usage: {
      windows: {
        monthly: { usedPercent: 45, windowSeconds: null, resetAt: 1792487940000 },
        credits_balance: { usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: '$2.50' },
      },
    },
  });
  assert.equal(data.ok, true);
  assert.equal(data.usage.windows.monthly.usedPercent, 45);
  assert.equal(data.usage.windows.credits_balance.valueLabel, '$2.50');
});

test('usage data skips reserved window names and caps at 32', () => {
  const windows = { monthly: { usedPercent: 1, windowSeconds: null, resetAt: 1 } };
  for (let i = 0; i < 40; i += 1) windows[`w${i}`] = { usedPercent: 1, windowSeconds: null, resetAt: 1 };
  windows.__proto__ = { usedPercent: 99, windowSeconds: null, resetAt: 1 };
  const data = mapQuotaToUsageData({ ok: true, configured: true, usage: { windows } });
  assert.equal(Object.keys(data.usage.windows).length, 32);
  assert.ok(!('__proto__' in data.usage.windows) || data.usage.windows.__proto__?.usedPercent !== 99);
});

test('failed quota without windows answers usage null', () => {
  const data = mapQuotaToUsageData({ ok: false, configured: true, error: 'boom', usage: null });
  assert.deepEqual(data, { ok: false, configured: true, error: 'boom', usage: null });
});

test('usage.read body validates', () => {
  const good = parseUsageRead(JSON.stringify({ v: 1, method: 'usage.read', input: { credentials: {} } }));
  assert.deepEqual(good.input, { credentials: {} });
  assert.ok(parseUsageRead(JSON.stringify({ method: 'sessions.list' })).error);
  assert.ok(parseUsageRead('not json').error);
});

(async () => {
  await Promise.all(pending);
  const failed = checks.filter((check) => !check.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
})();
