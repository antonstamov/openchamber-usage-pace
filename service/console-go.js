'use strict';

/**
 * Direct OpenCode Go quota read, mirroring the host's built-in
 * `opencode-go` provider (`packages/web/server/lib/quota/providers/
 * opencode-go.js`). The only difference is the credential source: the host
 * hands the service the OpenCode entries it holds for `opencode-go` and
 * `opencode` with `usage.read`, instead of the provider reading OpenCode's
 * own store. Selection, endpoints, fallbacks and error classes match, so the
 * extension card and the pace rows agree with the native card.
 *
 * Deliberately left out: Console budgets (read from the running OpenCode,
 * which a service cannot reach; the host shows them on the Usage page only)
 * and the legacy credential-file cleanup (host-side concern).
 */

const API_KEY_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const CONSOLE_STATUS_URL = 'https://opencode.ai/console/api/go/status';
const CONSOLE_BILLING_STATUS_URL = 'https://opencode.ai/console/api/billing/status';
const MICRO_CENTS_PER_DOLLAR = 100_000_000;
const CONSOLE_SERVER = 'https://opencode.ai/console';
const CONSOLE_INTEGRATION_ID = 'opencode';
const ORGANIZATION_ID_PATTERN = /^(?:org|wrk)_[A-Za-z0-9]+$/;
const CONSOLE_PRODUCTS = new Set(['go', 'go-plus', 'go-teams']);
const NO_CONSOLE_SUBSCRIPTION = 'No active OpenCode Go subscription on the selected Console account';
const API_KEY_EXPIRED = 'OpenCode Go key expired. Connect an OpenCode Console account on the OpenCode card in Providers.';
const REQUEST_TIMEOUT_MS = 15_000;

const API_KEY_WINDOW_FIELDS = {
  '5h': 'rolling',
  weekly: 'weekly',
  monthly: 'monthly',
};

const CONSOLE_WINDOW_METERS = {
  '5h': 'fiveHour',
  weekly: 'week',
  monthly: 'month',
};

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asObject(value) {
  return value && typeof value === 'object' ? value : null;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toTimestamp(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function formatMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value.toFixed(2);
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

function toUsageWindow({ usedPercent, windowSeconds, resetAt, valueLabel }) {
  const window = { usedPercent, windowSeconds: windowSeconds ?? null, resetAt: resetAt ?? null };
  if (valueLabel) window.valueLabel = valueLabel;
  return window;
}

function parseOpenCodeGoUsage(payload) {
  const usage = asObject(payload) ? asObject(payload.usage) : null;
  if (!usage) return {};
  const windows = {};
  for (const [key, field] of Object.entries(API_KEY_WINDOW_FIELDS)) {
    const entry = asObject(usage[field]);
    if (!entry) continue;
    const usedPercent = toNumber(entry.percent);
    const resetAt = toTimestamp(entry.resetsAt);
    if (usedPercent === null || resetAt === null) continue;
    windows[key] = toUsageWindow({ usedPercent: clampPercent(usedPercent), resetAt, windowSeconds: null });
  }
  return windows;
}

function toMicroCents(value) {
  const amount = toNumber(value);
  if (amount === null || amount < 0) return null;
  return amount;
}

function parseConsoleGoUsage(payload) {
  const access = asObject(payload) ? asObject(payload.access) : null;
  const meters = access ? asObject(access.meters) : null;
  if (!meters) return {};
  const windows = {};
  for (const [key, meterName] of Object.entries(CONSOLE_WINDOW_METERS)) {
    const meter = asObject(meters[meterName]);
    if (!meter) continue;
    const limit = toMicroCents(meter.limitMicroCents);
    const used = toMicroCents(meter.usedMicroCents);
    const resetAt = toTimestamp(meter.resetsAt);
    if (limit === null || limit <= 0 || used === null || resetAt === null) continue;
    windows[key] = toUsageWindow({
      usedPercent: clampPercent((used / limit) * 100),
      resetAt,
      windowSeconds: null,
    });
  }
  return windows;
}

function parseConsoleBillingBalance(payload) {
  const microCents = toMicroCents(asObject(payload)?.availableMicroCents);
  if (microCents === null) return null;
  return microCents / MICRO_CENTS_PER_DOLLAR;
}

async function isExpiredKeyResponse(response) {
  const payload = asObject(await response.json().catch(() => null));
  return asObject(payload?.error)?.code === 'api_key_expired';
}

async function fetchOpenCodeGoUsage(apiKey, fetchImpl, { consoleKey = false } = {}) {
  const response = await fetchImpl(API_KEY_USAGE_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'x-opencode-session': 'openchamber-usage',
      'User-Agent': 'OpenChamber quota provider',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 403 && consoleKey) throw new Error(NO_CONSOLE_SUBSCRIPTION);
  if (response.status === 401 && await isExpiredKeyResponse(response)) throw new Error(API_KEY_EXPIRED);
  if (response.status === 401 || response.status === 403) {
    throw new Error('OpenCode Go authentication failed');
  }
  if (!response.ok) throw new Error(`OpenCode Go usage API returned HTTP ${response.status}`);
  const windows = parseOpenCodeGoUsage(await response.json().catch(() => null));
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
}

async function fetchConsoleGoUsageWithKey(apiKey, fetchImpl) {
  try {
    const response = await fetchImpl(CONSOLE_STATUS_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'OpenChamber quota provider',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    if (!asObject(payload) || !CONSOLE_PRODUCTS.has(payload.product)) return null;
    const windows = parseConsoleGoUsage(payload);
    return Object.keys(windows).length > 0 ? windows : null;
  } catch {
    return null;
  }
}

function isConsoleSignInExpired(expires) {
  return expires !== null && expires > 0 && expires <= Date.now();
}

async function fetchConsoleGoUsage({ access, orgID, expires }, fetchImpl) {
  if (isConsoleSignInExpired(expires)) {
    throw new Error('OpenCode Console sign-in expired. Sign in again in Providers.');
  }
  const response = await fetchImpl(CONSOLE_STATUS_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${access}`,
      'x-org-id': orgID,
      'User-Agent': 'OpenChamber quota provider',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('OpenCode Console sign-in expired. Sign in again in Providers.');
  }
  if (!response.ok) throw new Error(`OpenCode Console Go status API returned HTTP ${response.status}`);
  const payload = await response.json().catch(() => null);
  if (!asObject(payload)) throw new Error('OpenCode Console Go status returned an unreadable response');
  if (!CONSOLE_PRODUCTS.has(payload.product)) {
    throw new Error(NO_CONSOLE_SUBSCRIPTION);
  }
  const windows = parseConsoleGoUsage(payload);
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
}

async function fetchConsoleBillingBalance({ access, orgID }, fetchImpl) {
  try {
    const response = await fetchImpl(CONSOLE_BILLING_STATUS_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${access}`,
        'x-org-id': orgID,
        'User-Agent': 'OpenChamber quota provider',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseConsoleBillingBalance(await response.json().catch(() => null));
  } catch {
    return null;
  }
}

function getAuthEntry(credentials, aliases) {
  if (!credentials || typeof credentials !== 'object') return null;
  for (const alias of aliases) {
    if (credentials[alias]) return credentials[alias];
  }
  return null;
}

function normalizeAuthEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return { token: entry };
  if (typeof entry === 'object') return entry;
  return null;
}

function readKey(entry) {
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
}

function getApiKey(credentials) {
  const own = readKey(normalizeAuthEntry(getAuthEntry(credentials, ['opencode-go'])));
  if (own) return { key: own, consoleKey: false };
  const consoleEntry = normalizeAuthEntry(getAuthEntry(credentials, [CONSOLE_INTEGRATION_ID]));
  if (!consoleEntry || consoleEntry.type === 'oauth') return null;
  const key = readKey(consoleEntry);
  return key ? { key, consoleKey: true } : null;
}

function getConsoleCredential(credentials) {
  const entry = normalizeAuthEntry(getAuthEntry(credentials, [CONSOLE_INTEGRATION_ID]));
  if (!entry || entry.type !== 'oauth') return null;
  const access = asNonEmptyString(entry.access);
  const orgID = asNonEmptyString(entry.orgID);
  if (!access || entry.server !== CONSOLE_SERVER || !orgID || !ORGANIZATION_ID_PATTERN.test(orgID)) return null;
  const expires = toNumber(entry.expires);
  return { access, orgID, expires };
}

function isConfigured(credentials) {
  return Boolean(getConsoleCredential(credentials) || getApiKey(credentials));
}

function buildResult({ ok, configured, usage, error }) {
  const result = { ok, configured, usage: usage ?? null };
  if (error) result.error = error;
  return result;
}

/**
 * Read the quota for the handed credentials. Never throws: failures are
 * `ok: false` results, like the built-in provider.
 */
async function fetchGoQuota(credentials, fetchImpl = fetch) {
  try {
    // A Console sign-in serves OpenCode Go once it exists; the `opencode-go`
    // API key is the fallback for accounts without one, and for a Console
    // read that fails. An API key on `opencode` cannot coexist with the
    // sign-in: one credential is active per integration.
    const consoleCredential = getConsoleCredential(credentials);
    const apiKey = getApiKey(credentials);
    let consoleFailure = null;
    if (consoleCredential) {
      try {
        const balanceRead = isConsoleSignInExpired(consoleCredential.expires)
          ? Promise.resolve(null)
          : fetchConsoleBillingBalance(consoleCredential, fetchImpl);
        const windows = await fetchConsoleGoUsage(consoleCredential, fetchImpl);
        const balance = await balanceRead;
        const usageWindows = balance === null
          ? windows
          : {
            ...windows,
            credits_balance: toUsageWindow({
              usedPercent: null,
              windowSeconds: null,
              resetAt: null,
              valueLabel: `$${formatMoney(balance)}`,
            }),
          };
        return buildResult({ ok: true, configured: true, usage: { windows: usageWindows } });
      } catch (consoleError) {
        if (!apiKey) throw consoleError;
        consoleFailure = consoleError;
      }
    }
    if (!apiKey) {
      return buildResult({ ok: false, configured: false, error: 'Not configured' });
    }
    const windows = await fetchConsoleGoUsageWithKey(apiKey.key, fetchImpl)
      ?? await fetchOpenCodeGoUsage(apiKey.key, fetchImpl, { consoleKey: apiKey.consoleKey }).catch((keyError) => {
        throw consoleFailure && keyError.message === API_KEY_EXPIRED ? consoleFailure : keyError;
      });
    return buildResult({ ok: true, configured: true, usage: { windows } });
  } catch (error) {
    return buildResult({
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
}

module.exports = {
  fetchGoQuota,
  isConfigured,
  getApiKey,
  getConsoleCredential,
  parseOpenCodeGoUsage,
  parseConsoleGoUsage,
  parseConsoleBillingBalance,
  fetchOpenCodeGoUsage,
  fetchConsoleGoUsage,
  fetchConsoleBillingBalance,
  NO_CONSOLE_SUBSCRIPTION,
  API_KEY_EXPIRED,
};
