# dmit-watch

This script watches the DMIT plan `TYO.AS3.Pro.TINY` (Tokyo Premium, $21.90/mo) and tells you when it is back in stock.

It starts your Windows Chrome in the background with its own profile, then reads the Tokyo Premium cart page. It needs Node 24 and runs in WSL. It uses no npm packages.

## Quick start

1. Go to the folder: `cd ~/dmit-watch`.
2. Do one test check: `node watch.mjs --once`. The output must show `"stock":"OUT"` or `"stock":"IN"`.
3. Show a test notification: `node watch.mjs --test-alert`.
4. Start the watcher: `nohup node watch.mjs >> watch.log 2>&1 &`.
5. See the checks: `tail -f watch.log`.
6. See the alerts: `tail -f alerts.log`.
7. Stop the watcher: `pkill -f 'node watch.mjs'`.

If step 2 shows `"reason":"blocked"`, run `HEADFUL=1 node watch.mjs --once`. If Chrome shows a Cloudflare check, click it once.

## Commands

| Command | What it does |
|---|---|
| `node watch.mjs` | Checks the page every 5 minutes until you stop it. |
| `node watch.mjs --once` | Does one check, prints the result, and closes Chrome. |
| `node watch.mjs --test-alert` | Shows a test notification. |
| `node watch.mjs --selftest` | Tests the stock parser on sample text. |

## Settings

| Variable | Meaning |
|---|---|
| `INTERVAL_SEC` | Seconds between checks. The default is 300, and the minimum is 120. |
| `HEADFUL=1` | Shows the Chrome window. Use it if Cloudflare blocks headless Chrome. |

## Run in the background

```bash
nohup node watch.mjs >> watch.log 2>&1 &
pkill -f 'node watch.mjs'   # stop it; this also closes Chrome
```

## Output

- `alerts.log` gets one line for each alert. Each alert also shows a Windows notification.
- `last-page.txt` holds the page text from the last check.
