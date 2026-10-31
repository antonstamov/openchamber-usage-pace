# OpenCode Go usage pace

An OpenChamber extension for OpenCode Go: shows the **monthly spend pace** and signals when the 5-hour or weekly window overheats.

OpenChamber core is not patched. The extension adds a native **OpenCode Go usage pace** section to Work Status plus a tiny local service that reads OpenChamber's existing quota endpoint.

## What it shows

The visible part is only three rows: `5-Hour`, `Weekly`, `Monthly`. All text and details live in the row tooltips (hover or tap).

- **Monthly — always.** The row: `current% / normal%`. The tooltip: over/under in pp, remaining budget share, cooldown, reset time.
- **5-Hour and Weekly — always.** Their percents are a share of the **window's own cap**, not of the month: the 5h cap is 20% of monthly, the Weekly cap is 50%.
  - The row value is `current% / normal_now%`: how much of the window could be spent **by now** so the remaining monthly budget lasts until reset.
  - The bar fills **to the normal**: on pace — green, above normal — full orange, at 2× normal and above — full red.
  - The tooltip holds **only the full normal by end of window/week** plus cooldown. No deltas or projections.
  - **"Overheat"** means that at the window's current pace the monthly budget runs out before reset. Computed with the already-spent month and remaining time taken into account.
  - **"Burst"** — the window alone already spent more than the current monthly pace (in monthly equivalent, with an absolute floor).
  - **"Cap"** — ≥80% of the window's own cap spent. "Used up" — 100%. Shown in red.

## Pace math

For the monthly window:

```text
normal = elapsed share of the calendar cycle × 100%
```

The cycle runs from the reset date minus one calendar month. Example: reset `Nov 24 14:59` → start `Oct 24 14:59`. Short months clamp the day (March 31 reset → February 28 start).

### Normal and overheat for 5h / Weekly

```text
budget_left       = 100% − month_spent
windows_left      = (month_reset − now) / window_length

full_window_normal = budget_left / (window_share_of_month × windows_left)
normal_now         = full_window_normal × window_elapsed_share

overheat = window_percent_now > normal_now
```

Window share of the month: **20%** for 5h, **50%** for Weekly. The `normal` in the row is `normal_now`; the full end-of-window normal is shown in the tooltip.

Current percent and all three normals are formatted identically: below 10% — one decimal (`1.1% / 1.1%`, `7.4%`, `2.8%`), from 10% — integer (`19%`, `38%`). Below 0.1% — `<0.1%`. So the row color always agrees with the shown numbers: orange means the first number is really above the second.

Example at 21% monthly spend with 79% left:

- 5h at 60% elapsed: full normal 2.8% → normal now 1.7%; 2% is already above — overheat.
- Weekly day one, ~7% elapsed: full normal 38% → normal now 2.7%; 5% is above — overheat.
- Weekly mid-week, 50% elapsed: normal now 19%; 5% is below — on pace.

That is why day one of the week shows the normal for the current moment, not 38%.

### Cooldown

Cooldown is the time **without spending** until the normal catches up to the current percent. Computed for all three rows:

- **Monthly:** the normal grows to 100% by reset; `t = (spent − normal) / (100 − normal) × remaining`.
- **5-Hour / Weekly:** the normal grows to the window's full normal; `t = (spent / full_normal − elapsed) × window_length`.
- If the current percent is above the window's full normal, the normal never catches up before reset — the time to reset is shown.
- If already on pace — `already on pace`.

In tooltips:

```text
Normal by the end of the week: 38% · ~9 h without spending to reach normal
Normal by the end of the window: 2.8% · resets in ~50 m
22% / normal 7.4% — 15 pp over. 78% left · ...
```

### Bar

The bar fills to the normal, not to 100%:

- spent ≤ normal → `spent / normal`, green;
- spent > normal → full, orange;
- spent ≥ 2× normal → full, red;
- a normal below 1% counts as 1% — otherwise the first minutes after a window reset would paint the bar red over hundredths of a percent.

This is an approximation: OpenChamber only accepts theme tones (`success`, `warning`, `error`), so there is no smooth gradient — the color flips at the `2× normal` boundary. The tooltip and cooldown show the exact overrun.

The normal sits in the same right-hand field as the percent: `8% / 2.8%`. A separate badge was removed — the host gives the label a fixed 96 px, and a badge ate about a third of the bar.

The number column is aligned: rows are left-padded with non-breaking spaces to the widest one, so all bars end on one `x` and numbers stay right-aligned. Two extra spaces keep them off the bar. Width is counted in "digit units": `0.5` for space, dot and slash, `1` for digits, `%` and `<`.

### Refresh

- The host reads `/status` every **30 seconds** while the section is visible and expanded.
- The service caches the quota API response for **25 seconds** — shorter than the poll interval, so the cache only absorbs concurrent reads and never delays a window reset.
- OpenChamber's native **Usage** block refreshes quotas every **180 seconds** (`QMe = 180 * 1e3` in the client) plus on runtime switch and after credential edits.

So the extension usually shows fresher numbers than Usage: after a 5-hour window reset the row updates within ~30 seconds, while Usage may hold the old values for up to 3 minutes.

## Install

1. Open `Settings → Extensions`.
2. Paste the folder path `E:\personal\openchamber-usage-pace` and press **Add**.
3. Allow **Run a local service** (the service runs with user privileges).
4. Open Work Status and drag the **OpenCode Go usage pace** section under `Usage` if it appeared below.

The extension adds no rail icon: it has no panel of its own, only the Work Status section.

### WSL

On WSL install through that server's UI, not the Windows client:

```bash
# Windows-disk path inside WSL (check that /mnt/e is mounted)
/mnt/e/personal/openchamber-usage-pace
```

In the WSL UI open `Settings → Extensions`, paste that path, allow the local service. If `/mnt/e` is not mounted, copy the folder inside WSL and install from there.

## How it works

```text
status section (rendered by OpenChamber)
        ↑ GET /status
local service (service/main.js)
        ↑ GET /api/quota/opencode-go
OpenChamber on 127.0.0.1
```

- The service reads `~/.config/openchamber/settings.json`: `desktopLocalPort` and `desktopLocalClientToken`.
- It calls `GET http://127.0.0.1:<port>/api/quota/opencode-go`.
- It caches the successful response for 25 seconds. The section polls every 30 seconds.
- No API keys are copied, nothing leaves the machine. The service only reads settings and talks to localhost.
- Copy language follows the host UI locale: the host requests `/status?locale=ru` for Russian, anything else (or missing) renders English.

### WSL and web server

In web mode (`openchamber serve`) `settings.json` has no `desktopLocalClientToken`. Then the service:

1. Finds the OpenChamber process on Linux and reads `OPENCHAMBER_UI_PASSWORD` from its environment (`/proc`, same user).
2. Logs in at `/auth/session` and gets a client token.
3. Caches the token for an hour; retries login on 401.

The password is never stored on disk. If the server runs as another user and `/proc` is unavailable, a `desktopLocalClientToken` is needed, or run as the same user.

## Limits

- The extension uses OpenChamber's internal `/api/quota/opencode-go` route. If an OpenChamber update changes it, the section shows "no data". That is the price of not patching core.
- The month is a calendar cycle back from the reset date. If OpenCode Go moves to rolling 30 days, adjust `subtractMonth()` in `service/pace.js`.
- The service does not inherit user environment variables, so the default `~/.config/openchamber/settings.json` path is required. For a non-standard path use `OPENCHAMBER_DATA_DIR` (read in `service/main.js`).
- The extension supports OpenChamber `>= 2.5.0`.

## Threshold tuning

In `service/main.js`, in the `segmentSignal` call:

```js
minBurstMonthlyPercent: key === '5h' ? 5 : 10
```

This is the minimum monthly share at which a window can count as a "burst": 5 pp for 5h, 10 pp for a week.

In `service/pace.js`, in `segmentSignal`:

```js
const overheat = normalNow !== null && remaining > 0 && used > normalNow + 1e-9;
const nearCap = used >= 80;
```

- `normalNow` is the threshold: `full_window_normal × window_elapsed_share`. It accounts for the already-spent month and remaining time.
- `1e-9` is only float protection. If orange warnings are too frequent, use a tolerance instead, e.g. `used > normalNow + 1` (1 pp).
- `80` is the red "cap" threshold in percent of the window's own cap. Change to `90` to turn red later.

## Development

```powershell
node test/pace.test.js
```

Tests cover monthly-cycle math, month boundaries, projection, signal thresholds and row assembly.

Check a live response without installing:

```powershell
node -e "require('./service/main').getQuota().then(r => console.log(JSON.stringify(require('./service/main').buildView({quota:r.quota, stale:r.stale, error:r.error}), null, 2)))"
```

Run the service manually:

```powershell
$env:OPENCHAMBER_SERVICE_PORT='45999'
$env:OPENCHAMBER_SERVICE_TOKEN='test-token'
node service/main.js
```

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:45999/status' -Headers @{Authorization='Bearer test-token'} | ConvertTo-Json -Depth 6
```

## Files

```text
package.json          extension manifest
service/pace.js       window math, normals and signals
service/main.js       local HTTP service and status section assembly
test/pace.test.js     tests
README.md             this file
```
