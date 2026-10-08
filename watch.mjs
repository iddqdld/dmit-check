// Usage: node watch.mjs [--once|--test-alert|--selftest]  (no flag = watch loop)
// Env: INTERVAL_SEC=<seconds, floor 120, default 300>  HEADFUL=1 to show Chrome
// Writes last-page.txt and alerts.log next to this file.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CART_URL = 'https://www.dmit.io/cart.php?region=tokyo&network=premium&generation=as3&language=english';
const PLAN = 'TYO.AS3.Pro.TINY';
const PRICE = '21.90';
const PORT = 9333;
const CHROME_DIR = '/mnt/c/Program Files (x86)/Google/Chrome/Application';
const CHROME_EXE = `${CHROME_DIR}/chrome.exe`;
const PROFILE_WSL = '/mnt/c/Users/asiat/AppData/Local/dmit-watch/chrome-profile';
const BASE_SEC = Math.max(120, Number(process.env.INTERVAL_SEC) || 300); // 2 min floor
const BACKOFF_CAP_SEC = 3600;
const BLIND_AFTER = 6; // consecutive UNKNOWN results before a "watcher blind" alert
const PAGE_WAIT_MS = 30_000; // time for the Cloudflare check and the cart JS to finish
const HEADFUL = process.env.HEADFUL === '1';
const LAST_PAGE = path.join(DIR, 'last-page.txt');
const ALERTS_LOG = path.join(DIR, 'alerts.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function classify(text) {
  const lc = String(text ?? '').toLowerCase();
  const blocked = [
    'just a moment',
    'attention required',
    'you have been blocked',
    'verify you are human',
    'verifying you are human',
    'checking your browser',
  ];
  for (const phrase of blocked) {
    if (lc.includes(phrase)) return { stock: 'UNKNOWN', reason: 'blocked' };
  }
  const i = lc.indexOf('tyo.as3.pro.tiny');
  if (i === -1) return { stock: 'UNKNOWN', reason: 'plan-missing' };
  const from = i + PLAN.length;
  const ends = [lc.indexOf('tyo.as3.pro.', from), lc.indexOf('total due today', from)]
    .filter((n) => n !== -1);
  const end = ends.length ? Math.min(...ends) : lc.length;
  const seg = lc.slice(i, end);
  if (seg.includes('out of stock') || seg.includes('sold out')) {
    return { stock: 'OUT', reason: 'out-of-stock-label' };
  }
  if (seg.includes(PRICE)) return { stock: 'IN', reason: 'orderable' };
  return { stock: 'UNKNOWN', reason: 'no-price' };
}

function selftest() {
  const cases = [
    [
      'TYO.AS3.Pro.TINY 1 vCore $21.90 USD Monthly Out of Stock TYO.AS3.Pro.STARTER $45.90 Add to Cart',
      { stock: 'OUT', reason: 'out-of-stock-label' },
    ],
    [
      'TYO.AS3.Pro.TINY 1 vCore $21.90 USD Monthly Add to Cart TYO.AS3.Pro.STARTER $45.90 Out of Stock',
      { stock: 'IN', reason: 'orderable' },
    ],
    [
      'TYO.AS3.Pro.TINY $21.90 Add to Cart Total Due Today Unavailable Out of Stock',
      { stock: 'IN', reason: 'orderable' },
    ],
    [
      'Attention Required! - Cloudflare. Sorry, you have been blocked',
      { stock: 'UNKNOWN', reason: 'blocked' },
    ],
    ['Hong Kong cart page', { stock: 'UNKNOWN', reason: 'plan-missing' }],
    [
      'TYO.AS3.Pro.TINY 1 vCore Order TYO.AS3.Pro.STARTER',
      { stock: 'UNKNOWN', reason: 'no-price' },
    ],
  ];
  for (const [text, expected] of cases) assert.deepEqual(classify(text), expected);
  console.log('selftest ok');
}

async function ensureChrome() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return;
  } catch {}
  mkdirSync(PROFILE_WSL, { recursive: true });
  const profileWin = execFileSync('wslpath', ['-w', PROFILE_WSL]).toString().trim();
  const args = [
    `--user-data-dir=${profileWin}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1366,900',
  ];
  if (!HEADFUL) {
    const versions = readdirSync(CHROME_DIR).filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n));
    if (!versions.length) throw new Error('chrome version dir not found');
    const major = Math.max(...versions.map((n) => Number(n.split('.')[0])));
    args.push('--headless=new');
    args.push(
      `--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    );
  }
  args.push('about:blank');
  spawn(CHROME_EXE, args, { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {}
  }
  throw new Error('chrome debug port 9333 not reachable from WSL');
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('cdp socket error')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('cdp socket closed'));
    pending.clear();
  });
  return {
    send(method, params = {}) {
      const myId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(myId);
          reject(new Error(`cdp timeout: ${method}`));
        }, 15_000);
        pending.set(myId, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
    close() {
      try { ws.close(); } catch {}
    },
  };
}

async function readPage() {
  const listRes = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await listRes.json();
  let target = targets.find((t) => t.type === 'page');
  if (!target) {
    const newRes = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    target = await newRes.json();
  }
  const client = await cdp(target.webSocketDebuggerUrl);
  try {
    await client.send('Page.navigate', { url: CART_URL });
    const expr = 'document.body ? document.body.innerText : ""';
    let text = '';
    const deadline = Date.now() + PAGE_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(1000);
      let cur = '';
      try {
        const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        cur = r?.result?.value ?? '';
      } catch {
        // The Cloudflare check reloads the page and destroys the JS context.
        continue;
      }
      if (cur) text = cur;
      if (text.toLowerCase().includes(PLAN.toLowerCase())) break;
    }
    if (text.toLowerCase().includes(PLAN.toLowerCase())) {
      await sleep(2000); // the cart can still be drawing the stock labels
      try {
        const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        const cur = r?.result?.value;
        if (cur) text = cur;
      } catch {}
    }
    return text;
  } finally {
    client.close();
  }
}

async function check() {
  try {
    await ensureChrome();
    const text = await readPage();
    writeFileSync(LAST_PAGE, text);
    return classify(text);
  } catch (err) {
    return { stock: 'UNKNOWN', reason: 'error: ' + err.message };
  }
}

async function closeChrome() {
  const attempt = (async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
    const info = await r.json();
    const client = await cdp(info.webSocketDebuggerUrl);
    try {
      await client.send('Browser.close');
    } finally {
      client.close();
    }
  })().catch(() => {});
  await Promise.race([attempt, sleep(3000)]);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function alert(title, body) {
  const line = `${new Date().toISOString()} ALERT ${title} — ${body}`;
  console.log(line);
  appendFileSync(ALERTS_LOG, line + '\n');

  const xml =
    `<toast scenario="reminder" activationType="protocol" launch="${xmlEscape(CART_URL)}">` +
    `<visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text>` +
    `<text>${xmlEscape(body)}</text></binding></visual>` +
    `<actions><action content="Open cart" activationType="protocol" arguments="${xmlEscape(CART_URL)}"/>` +
    `<action content="Dismiss" activationType="system" arguments="dismiss"/></actions></toast>`;
  const xmlPs = xml.replace(/'/g, "''");
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml('${xmlPs}')`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join('; ');

  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (err, stdout, stderr) => {
      if (err) {
        console.error(`toast failed: ${stderr || err.message}`);
        spawn('wslview', [CART_URL], { detached: true, stdio: 'ignore' }).unref();
      }
      resolve();
    });
  });
}

async function loop() {
  const shutdown = async () => {
    await closeChrome();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  let last = 'OUT';
  let unknownStreak = 0;
  let blockedStreak = 0;
  for (;;) {
    const r = await check();
    if (r.stock === 'IN' && last !== 'IN') {
      await alert(
        'DMIT TYO TINY IN STOCK',
        'TYO.AS3.Pro.TINY $21.90/mo is orderable. Open the cart now.',
      );
    }
    if (r.stock === 'IN' || r.stock === 'OUT') {
      last = r.stock;
      unknownStreak = 0;
      blockedStreak = 0;
    } else {
      unknownStreak += 1;
      if (unknownStreak === BLIND_AFTER) {
        await alert(
          'DMIT watcher blind',
          `${BLIND_AFTER} checks in a row gave no answer. Last reason: ${r.reason}. See last-page.txt.`,
        );
      }
      if (r.reason === 'blocked') blockedStreak += 1;
      else blockedStreak = 0;
    }
    const delaySec =
      Math.min(BASE_SEC * 2 ** blockedStreak, BACKOFF_CAP_SEC) * (0.8 + Math.random() * 0.4);
    console.log(
      `${new Date().toISOString()} ${r.stock} ${r.reason} next=${Math.round(delaySec)}s`,
    );
    await sleep(delaySec * 1000);
  }
}

const flag = process.argv[2];
if (flag === '--selftest') {
  selftest();
} else if (flag === '--once') {
  const result = await check();
  console.log(JSON.stringify(result));
  await closeChrome();
  process.exit(0);
} else if (flag === '--test-alert') {
  await alert('DMIT TYO TINY IN STOCK (test)', 'Test alert. The button opens the Tokyo cart.');
} else {
  await loop();
}
