import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { Jimp, compareHashes } from 'jimp';
import { connect } from 'puppeteer-real-browser';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DIST_DIR = path.join(__dirname, '../dist');
const SAVED_DIR = path.join(DATA_DIR, 'saved');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(SAVED_DIR)) {
  fs.mkdirSync(SAVED_DIR, { recursive: true });
}
const MANGA_DIR = path.join(SAVED_DIR, 'manga');
if (!fs.existsSync(MANGA_DIR)) {
  fs.mkdirSync(MANGA_DIR, { recursive: true });
}
// Series cover art, kept separate from chapter pages under MANGA_DIR - one
// file per series, named by series id so it survives a title/name change.
const COVERS_DIR = path.join(SAVED_DIR, 'covers');
if (!fs.existsSync(COVERS_DIR)) {
  fs.mkdirSync(COVERS_DIR, { recursive: true });
}
// Human-readable export target: <series title>/<chapter name>/, separate
// from the opaque id-keyed folders under MANGA_DIR that the scraper itself
// uses for storage/dedup bookkeeping.
const EXPORT_DIR = path.join(DATA_DIR, 'export');
if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

// Serve saved images statically
app.use('/api/saved-assets', express.static(SAVED_DIR));

// Initial Database Structure
const defaultDb = {
  monitors: [
    {
      id: "1",
      name: "Google Homepage",
      url: "https://www.google.com",
      interval: 30, // 30 seconds
      active: true,
      status: "unknown",
      lastCheck: null,
      lastResponseTime: null,
      lastError: null,
      checks: []
    },
    {
      id: "2",
      name: "GitHub Website",
      url: "https://github.com",
      interval: 60, // 60 seconds
      active: true,
      status: "unknown",
      lastCheck: null,
      lastResponseTime: null,
      lastError: null,
      checks: []
    }
  ],
  logs: [],
  saved: [],
  series: [],
  siteCrawls: [],
  settings: { puppeteerDomains: [] }
};

// ---------------------------------------------------------------------------
// Persistence: the whole app's state (monitors, logs, saved images, manga
// series/chapters, site crawls) is one JSON-shaped object, same as before -
// every route handler still just calls readDb()/writeDb(db) exactly like it
// always has. What changed is what's *underneath* those two functions:
//
//   - readDb() used to re-read and JSON.parse the entire db.json file on
//     every single call (even plain GETs) - it now just returns an
//     in-memory object, so reads are free.
//   - writeDb() used to fs.writeFileSync() the whole file as plain text,
//     which is not atomic - a crash mid-write left a truncated/corrupt file,
//     and the old readDb() reacted to that by silently resetting to an
//     empty default DB (losing everything). It now commits inside a SQLite
//     transaction (WAL mode), so a write either fully lands or doesn't
//     happen at all - no more partial/corrupt state possible.
//
// On first run after this change, any existing server/data/db.json is
// migrated in once and left on disk untouched (not deleted) as a safety net.
// ---------------------------------------------------------------------------

const SQLITE_FILE = path.join(DATA_DIR, 'app.db');
const sqliteDb = new Database(SQLITE_FILE);
sqliteDb.pragma('journal_mode = WAL');
sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS store (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
  )
`);
const selectStoreStmt = sqliteDb.prepare('SELECT data FROM store WHERE id = 1');
const upsertStoreStmt = sqliteDb.prepare(`
  INSERT INTO store (id, data) VALUES (1, ?)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data
`);

// In-memory copy of the whole app state - readDb() just returns this
// reference; writeDb() replaces it and persists to SQLite.
let dbCache = null;

function loadDbFromDisk() {
  const row = selectStoreStmt.get();
  if (row) {
    try {
      return JSON.parse(row.data);
    } catch (error) {
      // The DB itself is corrupt, not just a stale snapshot of it - this
      // should be effectively impossible with SQLite's atomic writes, so
      // fail loudly instead of silently discarding whatever is left.
      throw new Error(`SQLite store contains invalid JSON, refusing to silently wipe data: ${error.message}`);
    }
  }

  // First run against this SQLite file - migrate the legacy db.json in if
  // it's there, otherwise start fresh.
  if (fs.existsSync(DB_FILE)) {
    console.log('Migrating existing db.json into SQLite storage...');
    const legacyData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    upsertStoreStmt.run(JSON.stringify(legacyData));
    return legacyData;
  }

  const initial = JSON.parse(JSON.stringify(defaultDb));
  upsertStoreStmt.run(JSON.stringify(initial));
  return initial;
}

// Read Database
function readDb() {
  return dbCache;
}

// Write Database
function writeDb(data) {
  dbCache = data;
  try {
    upsertStoreStmt.run(JSON.stringify(data));
  } catch (error) {
    console.error('Error writing database:', error);
  }
}

dbCache = loadDbFromDisk();

// Polling Checking Logic
const isChecking = {};

// Node's global fetch (undici) wraps the real network failure in err.cause with a
// libuv/OpenSSL error code (ENOTFOUND, ECONNREFUSED, CERT_HAS_EXPIRED, ...).
// The default err.message is just "fetch failed", so map the code to something
// that actually explains which phase failed and why.
const NETWORK_ERROR_CODE_MESSAGES = {
  ENOTFOUND: 'DNS lookup failed - the domain does not exist or cannot be resolved',
  EAI_AGAIN: 'DNS lookup failed temporarily - the DNS server did not respond',
  ECONNREFUSED: 'Connection refused - nothing is listening on that host/port',
  ECONNRESET: 'Connection reset by the server while the request was in progress',
  EHOSTUNREACH: 'Host unreachable - no network route to the server',
  ENETUNREACH: 'Network unreachable',
  ETIMEDOUT: 'Connection attempt timed out at the network level',
  CERT_HAS_EXPIRED: 'SSL certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'SSL certificate is self-signed and untrusted',
  SELF_SIGNED_CERT_IN_CHAIN: 'SSL certificate chain contains a self-signed certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'SSL certificate chain could not be verified',
  ERR_TLS_CERT_ALTNAME_INVALID: 'SSL certificate hostname mismatch',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'SSL certificate issuer is not trusted'
};

function describeCheckError(err) {
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return 'Request timed out (10s) - server did not respond in time';
  }
  const code = err.cause?.code;
  if (code && NETWORK_ERROR_CODE_MESSAGES[code]) {
    return `${NETWORK_ERROR_CODE_MESSAGES[code]} (${code})`;
  }
  if (code) {
    return `${err.cause.message || err.message} (${code})`;
  }
  return err.message || 'Connection failed';
}

async function checkSite(monitor) {
  const startTime = performance.now();
  const timestamp = new Date().toISOString();
  let status = 'down';
  let responseTime = 0;
  let statusCode = null;
  let errorMsg = null;

  try {
    // 10 second timeout using AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(monitor.url, {
      method: 'GET',
      headers: {
        'User-Agent': 'UptimeRobot/1.0 (Status Checker Bot)'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    responseTime = Math.round(performance.now() - startTime);
    statusCode = response.status;
    
    // Status is UP if HTTP code is in the 2xx or 3xx range
    if (response.status >= 200 && response.status < 400) {
      status = 'up';
    } else {
      status = 'down';
      errorMsg = `HTTP Error Code: ${response.status}`;
    }
  } catch (err) {
    responseTime = Math.round(performance.now() - startTime);
    status = 'down';
    errorMsg = describeCheckError(err);
  }

  // Update DB state
  const db = readDb();
  const dbMonitor = db.monitors.find(m => m.id === monitor.id);

  if (dbMonitor) {
    const oldStatus = dbMonitor.status;
    dbMonitor.status = status;
    dbMonitor.lastCheck = timestamp;
    dbMonitor.lastResponseTime = status === 'up' ? responseTime : null;
    dbMonitor.lastError = status === 'down' ? errorMsg : null;

    // Record check history
    if (!dbMonitor.checks) dbMonitor.checks = [];
    dbMonitor.checks.push({
      timestamp,
      status,
      responseTime,
      statusCode,
      error: errorMsg
    });

    // Limit check history to last 50 entries
    if (dbMonitor.checks.length > 50) {
      dbMonitor.checks = dbMonitor.checks.slice(-50);
    }

    // Detect status transitions & log alert
    if (oldStatus !== 'unknown' && oldStatus !== status) {
      const logEvent = {
        id: Math.random().toString(36).substr(2, 9),
        monitorId: monitor.id,
        monitorName: monitor.name,
        url: monitor.url,
        from: oldStatus,
        to: status,
        timestamp,
        responseTime: status === 'up' ? responseTime : null,
        error: errorMsg
      };

      if (!db.logs) db.logs = [];
      db.logs.unshift(logEvent); // Prepend so latest is first

      // Limit logs to last 100 entries
      if (db.logs.length > 100) {
        db.logs = db.logs.slice(0, 100);
      }
    }

    writeDb(db);
  }
}

// Background scheduler tick (runs every 5 seconds)
async function startScheduler() {
  console.log('Uptime Monitor Scheduler Started...');
  setInterval(async () => {
    const db = readDb();
    const now = Date.now();

    for (const monitor of db.monitors) {
      if (!monitor.active) continue;

      const intervalMs = (monitor.interval || 60) * 1000;
      const lastCheckTime = monitor.lastCheck ? new Date(monitor.lastCheck).getTime() : 0;

      if ((now - lastCheckTime >= intervalMs || !monitor.lastCheck) && !isChecking[monitor.id]) {
        isChecking[monitor.id] = true;
        checkSite(monitor).finally(() => {
          isChecking[monitor.id] = false;
        });
      }
    }
  }, 5000);
}

// API Routes

// Get all monitors
app.get('/api/monitors', (req, res) => {
  const db = readDb();
  res.json(db.monitors);
});

// Add a monitor
app.post('/api/monitors', (req, res) => {
  const { name, url, interval } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL are required' });
  }

  // Format and validate URL
  let formattedUrl = url.trim();
  if (!/^https?:\/\//i.test(formattedUrl)) {
    formattedUrl = 'http://' + formattedUrl;
  }

  const db = readDb();
  const newMonitor = {
    id: Date.now().toString(),
    name: name ? name.trim() : formattedUrl,
    useStealth: !!useStealth,
    metadata: null,
    metadataFetchedAt: null,
    interval: parseInt(interval, 10) || 60,
    active: true,
    status: 'unknown',
    lastCheck: null,
    lastResponseTime: null,
    lastError: null,
    checks: []
  };

  db.monitors.push(newMonitor);
  writeDb(db);

  // Trigger check immediately in background
  isChecking[newMonitor.id] = true;
  checkSite(newMonitor).finally(() => {
    isChecking[newMonitor.id] = false;
  });

  res.status(201).json(newMonitor);
});

// Update a monitor
app.put('/api/monitors/:id', (req, res) => {
  const { id } = req.params;
  const { name, url, interval, active } = req.body;

  const db = readDb();
  const monitor = db.monitors.find(m => m.id === id);

  if (!monitor) {
    return res.status(404).json({ error: 'Monitor not found' });
  }

  if (name !== undefined) monitor.name = name.trim();
  if (url !== undefined) {
    let formattedUrl = url.trim();
    if (!/^https?:\/\//i.test(formattedUrl)) {
      formattedUrl = 'http://' + formattedUrl;
    }
    monitor.url = formattedUrl;
  }
  if (interval !== undefined) monitor.interval = parseInt(interval, 10) || 60;
  if (active !== undefined) monitor.active = !!active;

  // If reactivating, clear status to unknown and trigger immediate check
  if (active === true && !monitor.active) {
    monitor.status = 'unknown';
    isChecking[monitor.id] = true;
    checkSite(monitor).finally(() => {
      isChecking[monitor.id] = false;
    });
  }

  writeDb(db);
  res.json(monitor);
});

// Delete a monitor
app.delete('/api/monitors/:id', (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const initialLength = db.monitors.length;
  
  db.monitors = db.monitors.filter(m => m.id !== id);
  
  if (db.monitors.length === initialLength) {
    return res.status(404).json({ error: 'Monitor not found' });
  }

  // Clear any logs related to this monitor
  db.logs = db.logs.filter(l => l.monitorId !== id);

  writeDb(db);
  res.json({ message: 'Monitor deleted successfully' });
});

// Trigger check manually
app.post('/api/monitors/:id/check', async (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const monitor = db.monitors.find(m => m.id === id);

  if (!monitor) {
    return res.status(404).json({ error: 'Monitor not found' });
  }

  if (isChecking[id]) {
    return res.status(429).json({ error: 'Check already in progress' });
  }

  isChecking[id] = true;
  try {
    await checkSite(monitor);
    // Fetch fresh state to return
    const updatedDb = readDb();
    const updatedMonitor = updatedDb.monitors.find(m => m.id === id);
    res.json(updatedMonitor);
  } catch (error) {
    res.status(500).json({ error: 'Manual check failed' });
  } finally {
    isChecking[id] = false;
  }
});

// Matches a bare UI-chrome icon filename (a lightbox close button, nav
// arrows, a loading spinner, ...) with no other keyword to flag it by.
const UI_ICON_BASENAME_REGEX = /\/(close|back|next|prev|previous|share|download|zoom|search|menu|loading|loader|spinner|play|pause|arrow)[-_.]?\d*\.(png|svg|gif|jpe?g|webp)(\?|$)/i;

// Extracts, filters and type-classifies every image referenced by a page's HTML
// (both plain <img> tags and JS string-array image maps used by manga readers).
function extractImagesFromHtml(html, pageUrl) {
  const imagesByUrl = new Map(); // url -> alt text (first one seen wins)
  let match;

  // 0. Images wrapped inside an <a> that navigates elsewhere (a different
  // chapter, an outbound sponsor domain, ...) - see isNavigationHref - are
  // promo/nav chrome, not reader pages. Collect their src so they're
  // dropped below regardless of how innocuous the URL itself looks.
  const navLinkedUrls = new Set();
  const anchorRegex = /<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]{0,600}?)<\/a>/gi;
  let anchorMatch;
  while ((anchorMatch = anchorRegex.exec(html)) !== null) {
    if (!isNavigationHref(anchorMatch[1], pageUrl)) continue;
    const innerImgMatch = /<img\s+[^>]*src=["']([^"']+)["']/i.exec(anchorMatch[2]);
    if (!innerImgMatch) continue;
    try {
      navLinkedUrls.add(new URL(innerImgMatch[1].trim(), pageUrl).href);
    } catch (e) {
      navLinkedUrls.add(innerImgMatch[1].trim());
    }
  }

  // 1. Regex to extract img attributes. Most manga readers lazy-load pages
  // with JavaScript (an IntersectionObserver swaps the real URL in once it
  // scrolls into view) - since this is a plain HTML fetch with no browser
  // engine behind it, `src` is very often just a spinner/blank placeholder
  // at request time, and the REAL page URL sits in one of these data-*
  // attributes instead. Check them first and only fall back to `src` when
  // none are present, otherwise most pages get silently missed or a
  // placeholder gets downloaded in place of real art.
  const LAZY_SRC_ATTR_REGEX = /data-(?:src|original|original-src|lazy-src|lazy|echo|img|image|url|srcset|bg)=["']([^"']+)["']/i;
  const imgRegex = /<img\s+([^>]*)>/gi;
  while ((match = imgRegex.exec(html)) !== null) {
    const attrs = match[1];
    const lazyMatch = LAZY_SRC_ATTR_REGEX.exec(attrs);
    const srcMatch = /(?:^|\s)src=["']([^"']+)["']/i.exec(attrs);
    const src = (lazyMatch ? lazyMatch[1] : (srcMatch ? srcMatch[1] : '')).trim();
    if (!src || src.startsWith('data:')) continue;
    const altMatch = /alt=["']([^"']*)["']/i.exec(attrs);
    const alt = altMatch ? altMatch[1] : '';
    try {
      const absoluteUrl = new URL(src, pageUrl).href;
      if (!imagesByUrl.has(absoluteUrl)) imagesByUrl.set(absoluteUrl, alt);
    } catch (e) {
      if (!imagesByUrl.has(src)) imagesByUrl.set(src, alt);
    }
  }

  // 2. Regex to extract JS image array maps (like "/img/backcat/...")
  // Captures strings in quotes that end with image extensions
  const jsImgRegex = /["']([^"'\s>]+\.(?:jpg|jpeg|png|webp|gif|svg))["']/gi;
  while ((match = jsImgRegex.exec(html)) !== null) {
    const src = match[1].trim().replace(/\\/g, '');
    try {
      const absoluteUrl = new URL(src, pageUrl).href;
      if (!imagesByUrl.has(absoluteUrl)) imagesByUrl.set(absoluteUrl, '');
    } catch (e) {
      if (!imagesByUrl.has(src)) imagesByUrl.set(src, '');
    }
  }

  // Filter out static site assets (icons, loaders, ads, nav-linked promo cards, etc.)
  const filtered = [...imagesByUrl.entries()].filter(([url]) => {
    if (navLinkedUrls.has(url)) return false;
    const lower = url.toLowerCase();
    // Ignore theme-specific assets unless they look like chapter files
    if (lower.includes('/static/') || lower.includes('/theme/') || lower.includes('/assets/')) {
      if (!lower.includes('chapter') && !lower.includes('ep0') && !lower.includes('ep-') && !lower.includes('backcat')) {
        return false;
      }
    }
    if (lower.includes('logo') || lower.includes('favicon') || lower.includes('icon') || lower.includes('avatar') || lower.includes('profile_image') || lower.includes('twimg.com')) return false;
    if (lower.includes('ad-') || lower.includes('/ads/') || lower.includes('banner') || lower.includes('advertisement')) return false;
    if (lower.includes('play_w.png') || lower.includes('scroll-down.svg') || lower.includes('gamestore.gif')) return false;
    // Generic UI-chrome graphics (a lightbox "close" button, "next/prev"
    // arrows, loading spinners, ...) sometimes ship as their own file with
    // no other ad/theme signal - match on the filename itself.
    if (UI_ICON_BASENAME_REGEX.test(lower)) return false;
    // Lazy-load placeholder graphics (a blank/spinner shown before the real
    // data-src swaps in) - a page with no data-* lazy attribute at all and
    // just one of these as `src` means the real URL is injected by JS this
    // scraper can't run, not that this placeholder is actual page art.
    if (/\/(blank|placeholder|loading|lazy|spinner|transparent|1x1|pixel)\.(png|gif|svg|jpe?g|webp)(\?|$)/i.test(lower)) return false;
    return true;
  });

  return filtered.map(([url, alt]) => ({ url, type: classifyImageType(url, alt) }));
}

// Get website images (scrapes both HTML img tags and JS string arrays)
app.get('/api/monitors/:id/images', async (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const monitor = db.monitors.find(m => m.id === id);

  if (!monitor) {
    return res.status(404).json({ error: 'Monitor not found' });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(monitor.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const html = await response.text();
    res.json({ images: extractImagesFromHtml(html, monitor.url) });
  } catch (error) {
    console.error(`Error scraping images from ${monitor.url}:`, error);
    res.status(500).json({ error: `Failed to scrape images: ${error.message}` });
  }
});

// Fetches a URL as plain text with a timeout, returning null on any failure
// (missing file, network error, non-2xx status) instead of throwing - callers
// use this to probe for optional resources like robots.txt / sitemap.xml.

// Cloudflare's "Just a moment" interstitial can't be cleared by plain
// puppeteer + stealth: Cloudflare detects the DevTools Protocol attachment
// (the `Runtime.enable` leak) and the `--enable-automation` webdriver flag,
// neither of which the stealth plugin patches. puppeteer-real-browser drives
// the real installed Chrome through a patched (rebrowser) connection that
// hides those signals and, with `turnstile: true`, auto-clicks the challenge
// widget. A persistent profile dir keeps the resulting cf_clearance cookie
// across pages AND server restarts, so most requests never see a challenge at
// all (the cookie is IP+UA-bound, which is also why a VPN that changes the IP
// would invalidate it rather than help).
const CHROME_PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile');

// puppeteer launches a real Chrome bound to CHROME_PROFILE_DIR. If the server
// dies without a clean shutdown (crash, SIGKILL, `pkill node`), that Chrome
// keeps running and keeps an OS lock on the profile - so the NEXT connect()
// can't launch on it and fails with "connect ECONNREFUSED", which surfaces as
// a stray blank Chrome window and a crawl that never fetches anything. Kill
// any Chrome still holding OUR profile before (re)launching. The match is
// scoped to our profile path, so the user's own Chrome (a different profile)
// is never touched.
function killStaleProfileChrome() {
  try {
    spawnSync('pkill', ['-9', '-f', CHROME_PROFILE_DIR], { timeout: 5000 });
  } catch (e) {
    // pkill unavailable / nothing to kill - ignore
  }
}

let browserInstance = null;
let initialBlankPage = null; // the about:blank tab connect() opens; retired once real work starts
async function getBrowser() {
  if (browserInstance) return browserInstance;
  if (!fs.existsSync(CHROME_PROFILE_DIR)) fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  killStaleProfileChrome(); // free the profile from any leftover Chrome first
  const { browser, page } = await connect({
    headless: false,
    turnstile: true,
    customConfig: { userDataDir: CHROME_PROFILE_DIR },
    connectOption: { defaultViewport: null },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
  });
  browserInstance = browser;
  initialBlankPage = page || null;
  // `turnstile` is wired via browser.on('targetcreated'), so every page opened
  // from this singleton (below) gets the auto-solver too - no need to reconnect.
  browserInstance.on('disconnected', () => { browserInstance = null; initialBlankPage = null; });
  return browserInstance;
}

// Opens a fresh tab for a scrape and, once it exists, retires the leftover
// about:blank tab connect() created - closing that blank tab any earlier could
// quit Chrome while it's the only open tab.
async function newScrapePage() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  if (initialBlankPage) {
    const stale = initialBlankPage;
    initialBlankPage = null;
    stale.close().catch(() => {});
  }
  return page;
}

// Shut the automation Chrome down with the server so it doesn't linger and
// lock the profile (see killStaleProfileChrome). close() is best-effort; the
// pkill is the guarantee, and it runs synchronously so it completes before
// the process exits.
function shutdownBrowser() {
  try { if (browserInstance) browserInstance.close(); } catch (e) { /* ignore */ }
  killStaleProfileChrome();
}
process.on('SIGINT', () => { shutdownBrowser(); process.exit(); });
process.on('SIGTERM', () => { shutdownBrowser(); process.exit(); });

async function fetchTextWithPuppeteer(url, timeoutMs = 15000) {
  let page = null;
  try {
    page = await newScrapePage();
    // A goto timeout is NOT fatal here: while Cloudflare's turnstile is being
    // solved the page reloads itself, which can keep `domcontentloaded` from
    // settling before the deadline. Rather than bail (which showed up as
    // "ไม่สามารถเปิดหน้าได้"), swallow the navigation error and fall through to
    // the challenge-poll loop below - the tab is live and usually resolves
    // within the next few seconds.
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (navErr) {
      console.log(`[Puppeteer] navigation to ${url} didn't settle (${navErr.name}); polling for the real page anyway...`);
    }

    // While the turnstile is being solved the page reloads itself, which can
    // destroy the execution context mid-read and throw; treat any failed read
    // as "still loading" and keep polling rather than crashing the fetch.
    const readContent = () => page.content().catch(() => '');
    let html = await readContent();
    // turnstile:true is clicking the challenge in the background; we just poll
    // until the real page has loaded (or give up after 60s).
    let checks = 0;
    while (looksLikeCloudflareChallenge(html) && checks < 60) {
      console.log(`[Puppeteer] Cloudflare challenge on ${url}, waiting for auto-solve (${checks}/60)...`);
      await new Promise(r => setTimeout(r, 1000));
      html = await readContent();
      checks++;
    }

    if (checks > 0) {
      console.log(`[Puppeteer] Cloudflare challenge passed or timed out after ${checks}s on ${url}`);
    }

    const finalHtml = await readContent();
    // Remember the cookie AND the User-Agent this page was served with, keyed
    // by host, so browser-less fetches (page HTML + image downloads) can replay
    // the clearance without opening Chrome. cf_clearance is UA-bound, so the UA
    // must be captured here, not assumed.
    const domain = new URL(url).hostname;
    const cookies = await page.cookies().catch(() => []);
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
    rememberCloudflareClearance(domain, cookieString, userAgent);

    return finalHtml;
  } catch (e) {
    console.error('Puppeteer fetch error:', e);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Per-domain Cloudflare clearance earned by solving the challenge in the real
// browser once. cf_clearance is bound to the exact IP + User-Agent that earned
// it, so BOTH must be replayed together on later plain fetches - hence two maps
// keyed by hostname, always written and read as a pair.
const domainCookies = {};       // hostname -> "cf_clearance=...; ..." cookie header
const domainUserAgents = {};    // hostname -> the UA the browser used when solving

// Cloudflare's interstitial is localized ("Just a moment" / "รอสักครู่" / ...),
// so detect it by its challenge markup rather than the title text.
function looksLikeCloudflareChallenge(text) {
  if (!text) return false;
  return text.includes('Just a moment') || text.includes('รอสักครู่') ||
    text.includes('challenge-platform') || text.includes('cf-turnstile') ||
    text.includes('Verifying you are human');
}

// Records the cookie + UA a solved page produced, so plain fetches can reuse it.
function rememberCloudflareClearance(domain, cookieString, userAgent) {
  if (cookieString) domainCookies[domain] = cookieString;
  if (userAgent) domainUserAgents[domain] = userAgent;
}

// Header set for a browser-less asset fetch (image, page) that replays whatever
// Cloudflare clearance we hold for the host - the same UA that earned the
// cookie plus the cookie itself, so a Cloudflare-fronted image CDN serves us
// the same way the browser was served. Falls back to the default UA / no cookie
// for hosts we've never had to solve.
function clearanceHeaders(url, extra = {}) {
  let domain = '';
  try { domain = new URL(url).hostname; } catch (e) { /* keep domain empty */ }
  const headers = { 'User-Agent': domainUserAgents[domain] || DEFAULT_USER_AGENT, ...extra };
  if (domainCookies[domain]) headers['Cookie'] = domainCookies[domain];
  return headers;
}

// Plain (browser-less) fetch that replays a previously-earned cf_clearance for
// the host. Returns the body only when it's the REAL page; returns null when
// there's no clearance yet or Cloudflare challenged us again (cookie expired /
// IP changed) so the caller knows to fall back to the browser.
async function fetchWithClearanceOrNull(url, timeoutMs) {
  const domain = new URL(url).hostname;
  if (!domainCookies[domain]) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': domainUserAgents[domain] || DEFAULT_USER_AGENT,
        'Cookie': domainCookies[domain],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const body = await response.text();
    return looksLikeCloudflareChallenge(body) ? null : body;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchTextOrNull(url, timeoutMs = 8000, useStealth = false) {
  try {
    if (useStealth) {
      // "solve once, fetch many": try a browser-less fetch with the clearance
      // we already earned for this host first - the vast majority of requests
      // go through here and never open Chrome. Only when there's no clearance
      // yet, or it's expired (challenge came back), do we spin up the real
      // browser to (re)solve, which refreshes the cookie/UA for next time.
      const viaCookie = await fetchWithClearanceOrNull(url, timeoutMs + 5000);
      if (viaCookie) return viaCookie;
      return await fetchTextWithPuppeteer(url, timeoutMs + 5000);
    }

    const domain = new URL(url).hostname;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { 'User-Agent': domainUserAgents[domain] || DEFAULT_USER_AGENT };
    if (domainCookies[domain]) {
      headers['Cookie'] = domainCookies[domain];
    }

    const response = await fetch(url, {
      headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    return await response.text();
  } catch (e) {
    return null;
  }
}

function parseSitemapLocs(xml) {
  const locs = [];
  const locRegex = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    locs.push(match[1].trim());
  }
  return locs;
}

// Minimal robots.txt parser: groups consecutive "User-agent:" lines together,
// collecting the Disallow paths and Crawl-delay that follow until the next
// group starts. Only the "*" (or first) group is used - good enough to be a
// polite crawler without implementing the full robots.txt wildcard spec.
function parseRobotsRules(robotsText) {
  const groups = [];
  let current = null;
  let groupClosed = true; // forces the first "User-agent:" line to start a group

  for (const rawLine of robotsText.split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const sepIndex = line.indexOf(':');
    if (sepIndex === -1) continue;
    const key = line.slice(0, sepIndex).trim().toLowerCase();
    const value = line.slice(sepIndex + 1).trim();

    if (key === 'user-agent') {
      if (groupClosed) {
        current = { userAgents: [], disallow: [], crawlDelaySeconds: null };
        groups.push(current);
        groupClosed = false;
      }
      current.userAgents.push(value.toLowerCase());
    } else if (current) {
      groupClosed = true;
      if (key === 'disallow' && value) current.disallow.push(value);
      if (key === 'crawl-delay') {
        const seconds = parseFloat(value);
        if (!isNaN(seconds)) current.crawlDelaySeconds = seconds;
      }
    }
  }

  const group = groups.find(g => g.userAgents.includes('*')) || groups[0] || { disallow: [], crawlDelaySeconds: null };
  return { disallowPaths: group.disallow, crawlDelaySeconds: group.crawlDelaySeconds };
}

function isPathDisallowed(pageUrl, disallowPaths) {
  let pathname;
  try {
    pathname = new URL(pageUrl).pathname;
  } catch (e) {
    return false;
  }
  return disallowPaths.some(rule => pathname.startsWith(rule.replace(/\*+$/, '')));
}

// A sitemap can itself be a "sitemap index" pointing at other sitemap files
// (common on large sites that split pages by year/category). Only a bounded
// number of sub-sitemaps are followed to avoid runaway recursion. Every
// allowed page URL is scanned (no cap) - the jittered per-request delay and
// the 429/403 auto-stop below (see blockedEarly) are what actually protect
// the target site from being hammered, so a page-count cap isn't needed for
// that anymore. Large sites will just take longer to finish.
const MAX_SUB_SITEMAPS = 5;

async function discoverSitemapPages(monitorUrl) {
  const origin = new URL(monitorUrl).origin;
  const robotsText = await fetchTextOrNull(`${origin}/robots.txt`);
  const robotsRules = robotsText ? parseRobotsRules(robotsText) : { disallowPaths: [], crawlDelaySeconds: null };

  // Prefer whatever sitemap(s) the site itself declares in robots.txt
  let sitemapEntryUrls = [];
  if (robotsText) {
    for (const line of robotsText.split('\n')) {
      const match = line.match(/^\s*Sitemap:\s*(\S+)/i);
      if (match) sitemapEntryUrls.push(match[1].trim());
    }
  }
  // Fall back to the conventional location if robots.txt didn't name one
  if (sitemapEntryUrls.length === 0) {
    sitemapEntryUrls.push(`${origin}/sitemap.xml`);
  }

  const allPageUrls = [];
  let sitemapFound = false;

  for (const sitemapUrl of sitemapEntryUrls.slice(0, MAX_SUB_SITEMAPS)) {
    const xml = await fetchTextOrNull(sitemapUrl);
    if (!xml) continue;
    sitemapFound = true;
    const locs = parseSitemapLocs(xml);

    if (/<sitemapindex/i.test(xml)) {
      for (const subUrl of locs.slice(0, MAX_SUB_SITEMAPS)) {
        const subXml = await fetchTextOrNull(subUrl);
        if (subXml) allPageUrls.push(...parseSitemapLocs(subXml));
      }
    } else {
      allPageUrls.push(...locs);
    }
  }

  const uniquePageUrls = [...new Set(allPageUrls)];
  const allowedPageUrls = uniquePageUrls.filter(url => !isPathDisallowed(url, robotsRules.disallowPaths));

  return {
    sitemapFound,
    totalDiscovered: uniquePageUrls.length,
    totalAllowed: allowedPageUrls.length,
    pages: allowedPageUrls,
    crawlDelaySeconds: robotsRules.crawlDelaySeconds
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Randomized (jittered) delay between page requests - a perfectly constant
// gap between requests is itself a bot fingerprint, so a human-like random
// wait is safer than a fixed one. If the site published a Crawl-delay in
// robots.txt, that's treated as a floor and never gone below.
const MIN_PAGE_DELAY_MS = 400;
const MAX_PAGE_DELAY_MS = 1400;

function computeNextDelayMs(crawlDelaySeconds) {
  const jitterMs = MIN_PAGE_DELAY_MS + Math.random() * (MAX_PAGE_DELAY_MS - MIN_PAGE_DELAY_MS);
  const crawlDelayMs = crawlDelaySeconds ? crawlDelaySeconds * 1000 : 0;
  return Math.max(jitterMs, crawlDelayMs);
}

// Downloads one image, retrying transient failures. Cloudflare 5xx codes
// (525 = SSL handshake to origin failed, 520-524, plus 500/502/503/504) mean
// the CDN couldn't reach/complete a request to the ORIGIN server - a blip on
// their side, not ours - and clear on a retry a second later far more often
// than not, so losing the page over one is wasteful. Network errors/timeouts
// are retried the same way. 429/403 are NOT retried here: those mean we're
// being rate-limited/blocked, which the caller handles by backing off the
// whole chapter, so they're reported up as { blocked: true } instead.
async function fetchImageWithRetry(imageUrl, headers, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(imageUrl, { headers, signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.status === 429 || response.status === 403) {
        return { blocked: true, retryAfterMs: parseRetryAfterMs(response) };
      }
      if (response.status >= 500 && attempt < attempts) {
        console.log(`[Image] transient HTTP ${response.status} on ${imageUrl} - retry ${attempt}/${attempts - 1}`);
        await sleep(1000 * attempt + Math.random() * 500);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
      return { response };
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      if (attempt < attempts) {
        await sleep(1000 * attempt + Math.random() * 500);
        continue;
      }
    }
  }
  throw lastError || new Error('image download failed');
}

// Per-origin mutex: every scraping entry point (single chapter scrape,
// scrape-all, a whole-site crawl's discovery + per-series work) all touch
// the network independently, with no awareness of each other. Without this,
// a user running a whole-site crawl against go-manga.com while also
// clicking "Re-scrape" on some other chapter of the same site would send
// two independent streams of requests to that site at once - exactly the
// "many simultaneous connections from one IP" pattern anti-bot systems
// flag hardest. This serializes every manga-scraping request by origin, so
// only one request is ever in flight against a given site at a time,
// regardless of which feature (or how many concurrent crawls/scrapes)
// triggered it.
const originLocks = new Map(); // origin -> tail promise of the queue (never rejects)

function runExclusiveByOrigin(url, task) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch (e) {
    return task(); // not a real URL - nothing to serialize against
  }

  const previous = originLocks.get(origin) || Promise.resolve();
  const result = previous.then(task, task);
  originLocks.set(origin, result.then(() => {}, () => {}));
  return result;
}

// Parses a 429/403 response's Retry-After header (seconds, or an HTTP
// date) into a millisecond delay. Returns null when absent/unparseable -
// callers fall back to their own jittered backoff in that case. When a
// site bothers to tell us exactly how long to back off, that's a much
// better signal than our own guess.
function parseRetryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (!isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (!isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

// Fetches one page's status (reusing the same rich error diagnosis as the
// uptime checker) plus every image found on it.
async function fetchPageDetails(pageUrl, useStealth = false) {
  const startTime = performance.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    let html;
    let statusCode;
    if (useStealth) {
        // Cloudflare-fronted page: go through the clearance path (reuse the
        // cf_clearance cookie if we have one, only open the browser to
        // (re)solve). This is what a chapter page on dark-manga needs - a plain
        // fetch here is exactly what returned HTTP 403.
        html = await fetchTextOrNull(pageUrl, 15000, true);
        statusCode = html ? 200 : 500;
        if (!html) {
            return { url: pageUrl, status: 'down', statusCode, responseTime: Math.round(performance.now() - startTime), error: 'ไม่สามารถผ่าน Cloudflare ได้', images: [] };
        }
    } else {
        const response = await fetch(pageUrl, {
          // Replay any Cloudflare clearance we already hold for this host, so a
          // page that's quietly behind Cloudflare doesn't 403 on a bare fetch.
          headers: clearanceHeaders(pageUrl, {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        statusCode = response.status;
        html = (statusCode >= 200 && statusCode < 400) ? await response.text() : '';

        // A 403/503 - or a challenge body served with a 200 - from a bare fetch
        // almost always means the host is behind Cloudflare. Transparently retry
        // through the clearance/browser path so the user doesn't have to know to
        // tick "stealth" for that site; the first hit solves it, the rest reuse
        // the cookie.
        if (statusCode === 403 || statusCode === 503 || looksLikeCloudflareChallenge(html)) {
            const solved = await fetchTextOrNull(pageUrl, 15000, true);
            if (solved) {
                html = solved;
                statusCode = 200;
            } else {
                return { url: pageUrl, status: 'down', statusCode: statusCode || 500, responseTime: Math.round(performance.now() - startTime), error: 'ไม่สามารถผ่าน Cloudflare ได้', images: [] };
            }
        } else if (statusCode < 200 || statusCode >= 400) {
            return { url: pageUrl, status: 'down', statusCode, responseTime: Math.round(performance.now() - startTime), error: `HTTP Error Code: ${statusCode}`, images: [] };
        }
    }

    const responseTime = Math.round(performance.now() - startTime);
    return { url: pageUrl, status: 'up', statusCode, responseTime, error: null, images: extractImagesFromHtml(html, pageUrl) };
  } catch (err) {
    const responseTime = Math.round(performance.now() - startTime);
    return { url: pageUrl, status: 'down', statusCode: null, responseTime, error: describeCheckError(err), images: [] };
  }
}

// Scan every page a site's sitemap.xml declares (bounded), reporting each
// page's up/down status and the images found on it.
app.get('/api/monitors/:id/pages', async (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const monitor = db.monitors.find(m => m.id === id);

  if (!monitor) {
    return res.status(404).json({ error: 'Monitor not found' });
  }

  try {
    const discovery = await discoverSitemapPages(monitor.url);
    if (!discovery.sitemapFound) {
      return res.status(404).json({ error: 'ไม่พบ sitemap.xml สำหรับเว็บนี้ (เช็คทั้ง robots.txt และ /sitemap.xml แล้ว)' });
    }

    // Scan pages one at a time with a randomized delay between them (never
    // concurrently) - a burst of parallel requests is what got a real site
    // blocked during testing. Stop immediately if the site starts responding
    // with 429/403, rather than continuing to hammer a site that's blocking us.
    const pages = [];
    let blockedEarly = false;
    for (let i = 0; i < discovery.pages.length; i++) {
      if (i > 0) {
        await sleep(computeNextDelayMs(discovery.crawlDelaySeconds));
      }

      const detail = await fetchPageDetails(discovery.pages[i], monitor.useStealth);
      pages.push(detail);

      if (detail.statusCode === 429 || detail.statusCode === 403) {
        blockedEarly = true;
        break;
      }
    }

    res.json({
      totalDiscovered: discovery.totalDiscovered,
      totalAllowed: discovery.totalAllowed,
      processedCount: pages.length,
      limited: discovery.totalAllowed > pages.length,
      blockedEarly,
      pages
    });
  } catch (error) {
    console.error(`Error scanning pages for ${monitor.url}:`, error);
    res.status(500).json({ error: `Failed to scan site pages: ${error.message}` });
  }
});

// Helper to extract file extension
function getExtension(url, contentType) {
  if (contentType) {
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('gif')) return 'gif';
    if (contentType.includes('svg')) return 'svg';
    if (contentType.includes('webp')) return 'webp';
  }
  const extMatch = url.match(/\.([a-zA-Z0-9]+)(?:[\?#]|$)/);
  if (extMatch) {
    const ext = extMatch[1].toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  }
  return 'png';
}

// Heuristic classification of an image into ad / manga / content, based on its URL path
// and (when available) its <img alt="..."> text. No image-recognition is available, so
// this is a best-effort keyword guess and can misclassify. The URL check only inspects
// the path+query (never the hostname) - otherwise a site whose own domain happens to
// contain a keyword (e.g. "go-manga.com") would tag every single image on it, ads
// included, as that type. Alt text isn't hostname-scoped so it's checked as-is.
const MANGA_TYPE_KEYWORDS = ['chapter', 'backcat', 'manga', 'comic', 'toon'];
const MANGA_EPISODE_REGEX = /ep[-_]?\d/;
const AD_TYPE_KEYWORDS = [
  'ad-', '/ads/', 'banner', 'advertisement', 'promo', 'bonus', 'sponsor',
  'bet', 'ufa', 'casino', 'lsm', 'joker', 'slot', 'huay', 'lotto', 'crypto',
  'sa-game', 'sagame', 'sexy', 'gclub', 'baccarat', 'roulette', 'jackpot',
  'vip', 'deposit', 'withdraw', 'discord', 'facebook', 'fbcdn', 'cdninstagram',
  'twitter', 'line.me',
  // Thai gambling/lottery ad slogans - these are ad copy phrases (not single
  // common words) to keep the false-positive rate on real manga dialogue low.
  'อยากรวย', 'ก็ต้องเสี่ยง', 'ฝากถอนออโต้', 'ฝาก-ถอน', 'หวยออนไลน์', 'แทงหวย',
  'เว็บพนัน', 'คาสิโนออนไลน์', 'สมัครสมาชิกฟรี', 'เครดิตฟรี', 'ทางเข้าเล่น'
];

function classifyImageType(url, altText = '') {
  let pathPortion = url;
  try {
    const parsed = new URL(url);
    pathPortion = parsed.pathname + parsed.search;
  } catch (e) {
    // Not an absolute URL - fall back to classifying the raw string.
  }
  const lower = pathPortion.toLowerCase();
  const combined = `${lower} ${altText}`;
  if (AD_TYPE_KEYWORDS.some(k => combined.includes(k.toLowerCase()))) return 'ad';
  if (MANGA_TYPE_KEYWORDS.some(k => lower.includes(k)) || MANGA_EPISODE_REGEX.test(lower)) return 'manga';
  return 'content';
}

// True when an <a href> would navigate somewhere other than the current page
// (a different chapter, an outbound sponsor domain, ...). Images wrapped in
// links like that are promo/nav chrome ("next chapter" cards, banner ads),
// never actual reader pages - real pages are never individually hyperlinked
// elsewhere. Plain zoom/lightbox wrappers (href="#" or empty) are left alone.
function isNavigationHref(hrefRaw, pageUrl) {
  if (!hrefRaw) return false;
  const trimmed = hrefRaw.trim();
  if (!trimmed || trimmed === '#' || trimmed.toLowerCase().startsWith('javascript:')) return false;
  try {
    const resolved = new URL(trimmed, pageUrl);
    const current = new URL(pageUrl);
    if (resolved.origin !== current.origin) return true;
    return resolved.pathname.replace(/\/+$/, '') !== current.pathname.replace(/\/+$/, '');
  } catch (e) {
    return false;
  }
}

// Save selected website image
app.post('/api/images/save', async (req, res) => {
  const { monitorId, imageUrl } = req.body;
  if (!monitorId || !imageUrl) {
    return res.status(400).json({ error: 'monitorId and imageUrl are required' });
  }

  const db = readDb();
  const monitor = db.monitors.find(m => m.id === monitorId);
  if (!monitor) {
    return res.status(404).json({ error: 'Monitor not found' });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s download timeout

    let referer = '';
    try {
      referer = new URL(imageUrl).origin;
    } catch (e) {}

    const response = await fetch(imageUrl, {
      headers: clearanceHeaders(imageUrl, {
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': referer
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to fetch image: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    const ext = getExtension(imageUrl, contentType);
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    const randomSuffix = Math.random().toString(36).substr(2, 9);
    const filename = `${monitorId}_${randomSuffix}.${ext}`;
    const filePath = path.join(SAVED_DIR, filename);

    // Save physical file
    await fs.promises.writeFile(filePath, buffer);

    // Save DB Metadata
    const savedRecord = {
      id: Date.now().toString(),
      monitorId,
      monitorName: monitor.name,
      originalUrl: imageUrl,
      filename,
      type: classifyImageType(imageUrl),
      timestamp: new Date().toISOString()
    };

    if (!db.saved) db.saved = [];
    db.saved.push(savedRecord);
    writeDb(db);

    res.status(201).json(savedRecord);
  } catch (error) {
    console.error(`Error saving image from ${imageUrl}:`, error);
    res.status(500).json({ error: `Failed to save image: ${error.message}` });
  }
});

// Save multiple website images at once (Batch Save)
app.post('/api/images/save-all', async (req, res) => {
  const { monitorId, imageUrls } = req.body;
  if (!monitorId || !imageUrls || !Array.isArray(imageUrls)) {
    return res.status(400).json({ error: 'monitorId and imageUrls array are required' });
  }

  const db = readDb();
  const monitor = db.monitors.find(m => m.id === monitorId);
  if (!monitor) {
    return res.status(404).json({ error: 'Monitor not found' });
  }

  const savedRecords = [];
  const errors = [];
  const batchSize = 5; // Batch download 5 files at a time to prevent server spikes

  for (let i = 0; i < imageUrls.length; i += batchSize) {
    const batch = imageUrls.slice(i, i + batchSize);
    await Promise.all(batch.map(async (imageUrl) => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

        let referer = '';
        try {
          referer = new URL(imageUrl).origin;
        } catch (e) {}

        const headers = clearanceHeaders(imageUrl, {
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Referer': referer
        });

        const response = await fetch(imageUrl, {
          headers,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP Error ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        const ext = getExtension(imageUrl, contentType);
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        const randomSuffix = Math.random().toString(36).substr(2, 9);
        const filename = `${monitorId}_${randomSuffix}.${ext}`;
        const filePath = path.join(SAVED_DIR, filename);

        await fs.promises.writeFile(filePath, buffer);

        const savedRecord = {
          id: (Date.now() + Math.floor(Math.random() * 1000)).toString(),
          monitorId,
          monitorName: monitor.name,
          originalUrl: imageUrl,
          filename,
          type: classifyImageType(imageUrl),
          timestamp: new Date().toISOString()
        };
        
        savedRecords.push(savedRecord);
      } catch (err) {
        errors.push({ url: imageUrl, error: err.message });
      }
    }));
  }

  // Update DB once
  if (savedRecords.length > 0) {
    if (!db.saved) db.saved = [];
    db.saved.push(...savedRecords);
    writeDb(db);
  }

  res.status(200).json({
    savedCount: savedRecords.length,
    savedRecords,
    errorCount: errors.length,
    errors
  });
});

// Get all saved images
app.get('/api/images/saved', (req, res) => {
  const db = readDb();
  res.json(db.saved || []);
});

// Delete a specific set of saved images by id (multi-select bulk delete).
// Registered before the '/:id' route below, otherwise Express would match
// this path's "bulk" segment as an :id and shadow this handler.
app.delete('/api/images/saved/bulk', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  const db = readDb();
  if (!db.saved) db.saved = [];
  const idsSet = new Set(ids);
  const toDelete = db.saved.filter(item => idsSet.has(item.id));

  if (toDelete.length === 0) {
    return res.status(404).json({ error: 'No matching saved images found' });
  }

  toDelete.forEach(record => {
    const filePath = path.join(SAVED_DIR, record.filename);
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error(`Failed to delete file ${filePath}:`, err);
      }
    });
  });

  db.saved = db.saved.filter(item => !idsSet.has(item.id));
  writeDb(db);

  res.json({ message: `Successfully deleted ${toDelete.length} saved images` });
});

// Delete saved image from server
app.delete('/api/images/saved/:id', (req, res) => {
  const { id } = req.params;
  const db = readDb();
  
  if (!db.saved) db.saved = [];
  const index = db.saved.findIndex(item => item.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Saved image not found' });
  }

  const record = db.saved[index];
  const filePath = path.join(SAVED_DIR, record.filename);

  // Delete physical file in background
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error(`Failed to delete file ${filePath}:`, err);
    }
  });

  // Remove metadata
  db.saved.splice(index, 1);
  writeDb(db);

  res.json({ message: 'Saved image deleted successfully' });
});

// Delete a group of saved images by monitor ID
app.delete('/api/images/saved/group/:monitorId', (req, res) => {
  const { monitorId } = req.params;
  const db = readDb();
  
  if (!db.saved) db.saved = [];
  const toDelete = db.saved.filter(item => item.monitorId === monitorId);
  
  if (toDelete.length === 0) {
    return res.status(404).json({ error: 'No saved images found for this monitor' });
  }

  // Delete physical files
  toDelete.forEach(record => {
    const filePath = path.join(SAVED_DIR, record.filename);
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error(`Failed to delete file ${filePath}:`, err);
      }
    });
  });

  // Filter out metadata from DB
  db.saved = db.saved.filter(item => item.monitorId !== monitorId);
  writeDb(db);

  res.json({ message: `Successfully deleted ${toDelete.length} saved images for this group` });
});

// ---------------------------------------------------------------------------
// Manga Downloader: lets a user register a manga "series", split it into
// named chapters (each pointing at the chapter's page URL), and have the
// bot scrape+download ONLY the images heuristically classified as 'manga'
// (see classifyImageType) from each chapter page. Scraping is deliberately
// slow/sequential with jittered delays and a robots.txt check, same
// anti-block posture as the sitemap page scanner above - there is no overall
// time limit, a chapter can take as long as it needs.
// ---------------------------------------------------------------------------

const scrapingChapters = {}; // chapterId -> true while a scrape is in-flight

function findSeries(db, seriesId) {
  return (db.series || []).find(s => s.id === seriesId);
}

function findChapter(series, chapterId) {
  return (series.chapters || []).find(c => c.id === chapterId);
}

// Decodes the handful of HTML entities that actually show up in scraped text
// nodes (titles, table cells, meta descriptions) - not a general-purpose
// entity decoder, just enough for what these manga sites emit.
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(html) {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Maps a manga-theme info-table row label to a canonical metadata key. Sites
// running the same (very common) WordPress manga theme render this table in
// whatever language they're localized to - Thai on the sites this scraper
// has been pointed at so far - so rows are matched by keyword/substring
// rather than by exact label text or table position.
const INFO_LABEL_MAP = [
  [/status|สถานะ/i, 'status'],
  [/type|ประเภท/i, 'type'],
  [/released|release|ปล่อย/i, 'released'],
  [/author|นักเขียน/i, 'author'],
  [/artist|นักวาด/i, 'artist'],
  [/posted\s*by|updated\s*by|อัพเดทโดย/i, 'postedBy'],
  [/posted\s*on|published|เผยแพร่|แผยแพร่/i, 'publishedDate'],
  [/updated\s*on|last\s*updated|แก้ไขล่าสุด|อัปเดต|อัพเดท/i, 'lastUpdatedDate'],
  [/views|ยอดวิว/i, 'views']
];

// Scrapes SEO-relevant metadata (title, alt titles, synopsis, genres,
// author/artist, status, dates, rating, views, ...) off a manga series' own
// detail page - the same page discover-chapters walks for its chapter list.
// Best-effort: any field whose markup isn't found is simply left out rather
// than throwing, since exact class names/labels vary by site.
function extractSeriesMetadataFromHtml(html, pageUrl) {
  const meta = { raw: {} };

  const titleMatch = /<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (titleMatch) meta.title = stripTags(titleMatch[1]);

  const altMatch = /<div[^>]*class=["'][^"']*seriestualt[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (altMatch) {
    meta.altTitles = stripTags(altMatch[1]).split(',').map(s => s.trim()).filter(Boolean);
  }

  const synopsisMatch = /<div[^>]*itemprop=["']description["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (synopsisMatch) meta.synopsis = stripTags(synopsisMatch[1]);

  const coverMatch = /<div[^>]*class=["'][^"']*\bthumb\b[^"']*["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/i.exec(html);
  if (coverMatch) {
    try { meta.coverImageUrl = new URL(coverMatch[1], pageUrl).href; } catch (e) { meta.coverImageUrl = coverMatch[1]; }
  }

  const ratingMatch = /itemprop=["']ratingValue["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (ratingMatch) meta.rating = parseFloat(ratingMatch[1]) || ratingMatch[1];
  const ratingCountMatch = /itemprop=["']ratingCount["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (ratingCountMatch) meta.ratingCount = parseInt(ratingCountMatch[1], 10);

  const followersMatch = /<div[^>]*class=["']bmc["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (followersMatch) meta.followers = stripTags(followersMatch[1]);

  const genreBlockMatch = /<div[^>]*class=["'][^"']*seriestugenre[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (genreBlockMatch) {
    const genres = [];
    const aRegex = /<a[^>]*>([^<]+)<\/a>/gi;
    let aMatch;
    while ((aMatch = aRegex.exec(genreBlockMatch[1])) !== null) genres.push(decodeHtmlEntities(aMatch[1]).trim());
    if (genres.length > 0) meta.genres = genres;
  }

  const tableMatch = /<table[^>]*class=["'][^"']*infotable[^"']*["'][^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (tableMatch) {
    const rowRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableMatch[1])) !== null) {
      const label = stripTags(rowMatch[1]);
      const valueHtml = rowMatch[2];
      const value = stripTags(valueHtml);
      if (!label || !value) continue;
      meta.raw[label] = value;

      const mapped = INFO_LABEL_MAP.find(([re]) => re.test(label));
      if (!mapped) continue;
      meta[mapped[1]] = value;
      if (mapped[1] === 'publishedDate' || mapped[1] === 'lastUpdatedDate') {
        const isoMatch = /datetime=["']([^"']+)["']/i.exec(valueHtml);
        if (isoMatch) meta[`${mapped[1]}ISO`] = isoMatch[1];
      }
    }
  }

  // Fallback for the "sh-*" theme (bully-manga.com and similar) - a custom,
  // non-WordPress layout the selectors above don't match at all. Each field is
  // only filled when still missing, so this never clobbers a value the
  // WordPress-theme extraction already found.
  if (!meta.title) {
    const m = /<h1[^>]*class=["'][^"']*sh-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (m) meta.title = stripTags(m[1]);
  }
  if (!meta.synopsis) {
    const m = /<p[^>]*class=["'][^"']*sh-synopsis[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(html);
    if (m) meta.synopsis = stripTags(m[1]);
  }
  if (!meta.coverImageUrl) {
    const m = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html);
    if (m) { try { meta.coverImageUrl = new URL(m[1], pageUrl).href; } catch (e) { meta.coverImageUrl = m[1]; } }
  }
  if (meta.rating == null) {
    const m = /<span[^>]*class=["'][^"']*\bscore\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
    if (m) { const v = parseFloat(stripTags(m[1])); if (!Number.isNaN(v)) meta.rating = v; }
  }
  if (meta.views == null) {
    const m = /<div[^>]*class=["'][^"']*sh-views-chip[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
    if (m) { const v = stripTags(m[1]).replace(/[^\d]/g, ''); if (v) meta.views = v; }
  }
  if (!meta.type) {
    const m = /<span[^>]*class=["'][^"']*sh-badge-type[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
    if (m) meta.type = stripTags(m[1]);
  }
  if (!meta.status) {
    const m = /<span[^>]*class=["'][^"']*sh-badge-status[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
    if (m) meta.status = stripTags(m[1]);
  }
  if (!meta.genres) {
    const genreRegex = /<a[^>]*class=["'][^"']*sh-genre[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    const shGenres = [];
    let gm;
    while ((gm = genreRegex.exec(html)) !== null) {
      const g = stripTags(gm[1]);
      if (g) shGenres.push(g);
    }
    if (shGenres.length > 0) meta.genres = shGenres;
  }
  // Key/value "meta pills": <span class="sh-meta-k">อัปเดต</span><span class="sh-meta-v">2026-07-13 ...</span>
  const pillRegex = /<span[^>]*class=["'][^"']*sh-meta-k[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*<span[^>]*class=["'][^"']*sh-meta-v[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
  let pm;
  while ((pm = pillRegex.exec(html)) !== null) {
    const label = stripTags(pm[1]);
    const value = stripTags(pm[2]);
    if (!label || !value) continue;
    if (!(label in meta.raw)) meta.raw[label] = value;
    const mapped = INFO_LABEL_MAP.find(([re]) => re.test(label));
    if (mapped && !meta[mapped[1]]) meta[mapped[1]] = value;
  }

  return meta;
}

// Downloads a series' cover art exactly once. Guarded by whether a cover file
// already sits on disk for this series id - not by whether metadata was just
// (re-)fetched - so calling this after every SEO metadata refresh (which can
// happen many times over a series' life) never re-downloads the same cover.
async function downloadCoverImageIfMissing(series) {
  const coverUrl = series.metadata?.coverImageUrl;
  if (!coverUrl) return;

  const existingPath = series.metadata.coverImagePath;
  if (existingPath && fs.existsSync(path.join(SAVED_DIR, existingPath))) return;

  try {
    const download = await fetchImageWithRetry(coverUrl, clearanceHeaders(coverUrl, {
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }));
    if (download.blocked) return;

    const contentType = download.response.headers.get('content-type');
    const ext = getExtension(coverUrl, contentType);
    const buffer = Buffer.from(await download.response.arrayBuffer());
    const fileName = `${series.id}.${ext}`;
    fs.writeFileSync(path.join(COVERS_DIR, fileName), buffer);
    series.metadata.coverImagePath = `covers/${fileName}`;
  } catch (err) {
    console.error(`Failed to download cover image for series ${series.id}:`, err.message);
  }
}

// Turns a series/chapter name into a filesystem-safe folder name for export
// - strips characters that are invalid (or awkward) across macOS/Linux/
// Windows rather than just the strict minimum, since exported folders are
// meant to be browsed/shared directly.
function sanitizeForFilename(name, fallback) {
  const cleaned = (name || '')
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return cleaned || fallback;
}

// Pulls the first number out of a chapter name (e.g. "ตอนที่ 261 ..." -> 261)
// so exported chapter folders can be zero-padded and sort correctly - plain
// string sort would put "ตอนที่ 261" before "ตอนที่ 45".
function extractLeadingNumber(text) {
  const match = /(\d+(?:\.\d+)?)/.exec(text || '');
  return match ? parseFloat(match[1]) : null;
}

// Exact content-hash dedup (see contentHash above) only catches an ad/credit
// graphic that's re-uploaded byte-for-byte identical every chapter - a
// translator's promo slide that gets re-exported/re-compressed slightly
// differently each time slips through that with a different hash despite
// looking identical. A perceptual hash (Jimp's built-in DCT-based pHash)
// compares what the image actually looks like instead, so near-identical
// re-exports of the same graphic still match. compareHashes returns a
// 0 (identical) to 1 (unrelated) distance - anything under this is treated
// as "the same picture". Deliberately conservative (checked empirically
// against real chapter art from this scraper: unrelated manga pages came
// out at 0.27-0.63) to keep false positives on genuine, unique page art rare.
const PHASH_DISTANCE_THRESHOLD = 0.12;
// Ad/credit/translator-note images are conventionally spliced in at the very
// start or end of a chapter, never in the middle of the actual page
// sequence - restricting perceptual hashing to these positions keeps the
// (much slower than a content hash) image decode cost bounded to a handful
// of images per chapter instead of every single page.
function isPHashCandidatePosition(index, total) {
  return index === 0 || index >= total - 3;
}

// Computes a perceptual hash for image bytes, or null if the format can't be
// decoded (Jimp supports jpg/png/bmp/gif/tiff - notably not webp - and any
// corrupt/truncated file) - callers should treat null as "skip, don't
// compare" rather than an error, since this is a best-effort enhancement
// over the exact content-hash check, not a required step.
async function computePerceptualHash(bufferOrPath) {
  try {
    const image = await Jimp.read(bufferOrPath);
    return image.hash();
  } catch (err) {
    return null;
  }
}

// The aggregator burns its own branding/backlink banner onto the pages it
// serves - a red "GOD MANGA / อ่านมังงะออนไลน์ / www.god-manga.com" graphic
// that sits on a solid-white strip at the very top of a chapter's first
// image(s). It is NOT part of the scanlated artwork and shouldn't end up in
// the exported chapter. It's distinguishable from real page art by a very
// specific signature: a horizontal band of bright banner-red pixels that is
// flanked by pure-white margins ABOVE and BELOW (real webtoon art bleeds to
// the edges and is never preceded by a full-width white strip). This detects
// that signature at the top edge and crops the whole white+banner+white strip
// off, leaving the art untouched. It is deliberately conservative: it returns
// the buffer unchanged whenever the signature isn't a clean match, or when
// removing it would eat further into the image than a banner ever occupies -
// so a red-heavy top art panel is never mistaken for the banner.
const WATERMARK_MAX_STRIP_FRACTION = 0.12; // never crop more than 12% of the height...
const WATERMARK_MAX_STRIP_PX = 1000;       // ...nor more than this many pixels, whichever is smaller
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', bmp: 'image/bmp', gif: 'image/gif'
};

async function stripAggregatorBanner(buffer, ext) {
  // jimp can't re-encode webp/avif; skip those rather than corrupt the file.
  const mime = MIME_BY_EXT[(ext || '').toLowerCase()];
  if (!mime) return { buffer, cropped: false };

  let image;
  try {
    image = await Jimp.read(buffer);
  } catch (err) {
    return { buffer, cropped: false };
  }

  const w = image.bitmap.width;
  const h = image.bitmap.height;
  const d = image.bitmap.data;
  if (h < 200 || w < 100) return { buffer, cropped: false };

  const cap = Math.min(WATERMARK_MAX_STRIP_PX, Math.floor(h * WATERMARK_MAX_STRIP_FRACTION));

  // Per-row fractions of bright banner-red and of near-white pixels, sampled
  // every few columns for speed. Banner rows spike on red; the strip's
  // padding rows are almost entirely white.
  function rowStats(y) {
    let red = 0, white = 0, n = 0;
    for (let x = 0; x < w; x += 3) {
      const idx = (y * w + x) * 4;
      const r = d[idx], g = d[idx + 1], b = d[idx + 2];
      if (r > 150 && g < 90 && b < 90) red++;
      if (r > 244 && g > 244 && b > 244) white++;
      n++;
    }
    return { red: red / n, white: white / n };
  }

  // Locate the red banner band within the top [0, cap) region.
  let bandStart = -1, bandEnd = -1;
  for (let y = 0; y < cap; y++) {
    if (rowStats(y).red > 0.06) {
      if (bandStart < 0) bandStart = y;
      bandEnd = y;
    }
  }
  if (bandStart < 0 || bandEnd - bandStart < 20) return { buffer, cropped: false }; // no band / too thin

  // The banner floats on white: require a white margin ABOVE it (art would
  // instead run right up to the top edge). bandStart must not touch y=0.
  if (bandStart < 8) return { buffer, cropped: false };
  let whiteAbove = 0;
  for (let y = 0; y < bandStart; y++) if (rowStats(y).white > 0.9) whiteAbove++;
  if (whiteAbove < bandStart * 0.6) return { buffer, cropped: false };

  // Walk past the rest of the banner (the red block PLUS its dark URL text,
  // which isn't red) to the first SUSTAINED white gap separating it from the
  // artwork - the art begins right after that gap, and that's the crop line.
  // If no such gap turns up before the safety cap, the band is bleeding into
  // real art rather than being a clean banner, so refuse.
  let gapEndedAt = -1, gapRun = 0;
  for (let y = bandEnd + 1; y < cap && y < h; y++) {
    if (rowStats(y).white > 0.9) {
      gapRun++;
      if (gapRun >= 8) { // found the separating white gap; advance to where it ends
        let z = y + 1;
        while (z < h && rowStats(z).white > 0.9) z++;
        gapEndedAt = z;
        break;
      }
    } else {
      gapRun = 0;
    }
  }
  if (gapEndedAt < 0 || gapEndedAt > cap || gapEndedAt >= h) return { buffer, cropped: false };

  try {
    image.crop({ x: 0, y: gapEndedAt, w, h: h - gapEndedAt });
    const out = await image.getBuffer(mime);
    return { buffer: out, cropped: true };
  } catch (err) {
    return { buffer, cropped: false };
  }
}

// Caps chapter-page resolution and recompresses everything to JPEG - source
// sites routinely serve pages far wider than any screen needs for reading,
// and PNG's lossless encoding is enormously wasteful on photographic/halftone
// manga art (a scanned page rarely benefits from pixel-perfect PNG the way a
// screenshot or logo would). Skipped for formats Jimp can't safely round-trip
// (webp/avif/svg/gif - same limitation as stripAggregatorBanner above) and
// falls back to the original buffer/ext on any decode failure or if the
// "optimized" output somehow comes back larger.
const MAX_IMAGE_WIDTH_PX = 1600;
const JPEG_QUALITY = 85;

async function optimizeMangaImage(buffer, ext) {
  const mime = MIME_BY_EXT[(ext || '').toLowerCase()];
  if (!mime) return { buffer, ext };

  let image;
  try {
    image = await Jimp.read(buffer);
  } catch (err) {
    return { buffer, ext };
  }

  try {
    if (image.bitmap.width > MAX_IMAGE_WIDTH_PX) {
      image.resize({ w: MAX_IMAGE_WIDTH_PX });
    }
    const out = await image.getBuffer('image/jpeg', { quality: JPEG_QUALITY });
    if (out.length >= buffer.length) return { buffer, ext };
    return { buffer: out, ext: 'jpg' };
  } catch (err) {
    return { buffer, ext };
  }
}

// Runs `fn` over `items` with at most `limit` in flight at once. The
// duplicate-image sweep (see /api/series/:id/clean-duplicate-images) can
// have thousands of files to hash/decode on a large series - doing that one
// at a time back-to-back left it taking the better part of ten minutes with
// most of that time spent waiting on disk I/O and single-threaded image
// decode that could otherwise overlap.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Helpers for Deduplication
function normalizeForComparison(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[\W_]+/g, '');
}

function extractChapterNumber(str) {
  if (!str) return null;
  // Match "ตอนที่ 1.5", "Chapter 1", "ep 2", or just a number
  const match = str.match(/(?:ตอน(?:ที่)?|ch(?:apter)?|ep(?:isode)?)\s*[:.-]?\s*(\d+(?:\.\d+)?)/i) || str.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

function isSameChapter(c1Name, c2Name) {
  const n1 = extractChapterNumber(c1Name);
  const n2 = extractChapterNumber(c2Name);
  if (n1 !== null && n2 !== null && n1 === n2) {
    return true;
  }
  return normalizeForComparison(c1Name) === normalizeForComparison(c2Name);
}

// Finds gaps in a series' chapter numbering - e.g. tracked chapters go
// 1, 2, 3, 5, 6 with no 4 anywhere. Only whole-number chapters count toward
// continuity: a bonus/side chapter like "3.5" is optional extra content, not
// a hole in the main numbering, so it's never reported as missing and never
// creates a false gap around it. Best-effort: chapters whose name has no
// extractable number are ignored entirely, since there's nothing to place
// them at in the sequence.
function findChapterGaps(chapters) {
  const wholeNumbers = new Set();
  (chapters || []).forEach(c => {
    const n = extractChapterNumber(c.name);
    if (n !== null && Number.isInteger(n)) wholeNumbers.add(n);
  });

  if (wholeNumbers.size === 0) return { min: null, max: null, missing: [] };

  const min = Math.min(...wholeNumbers);
  const max = Math.max(...wholeNumbers);
  const missing = [];
  for (let n = min; n <= max; n++) {
    if (!wholeNumbers.has(n)) missing.push(n);
  }
  return { min, max, missing };
}

// Get global settings
app.get('/api/settings', (req, res) => {
  const db = readDb();
  if (!db.settings) db.settings = { puppeteerDomains: [] };
  // Auto-retry / auto-update both default ON when never set.
  if (db.settings.autoRetryEnabled === undefined) db.settings.autoRetryEnabled = true;
  if (db.settings.autoUpdateEnabled === undefined) db.settings.autoUpdateEnabled = true;
  res.json(db.settings);
});

// Update global settings
app.post('/api/settings', (req, res) => {
  const db = readDb();
  if (!db.settings) db.settings = { puppeteerDomains: [] };

  const { puppeteerDomains, autoRetryEnabled, autoUpdateEnabled } = req.body;
  if (Array.isArray(puppeteerDomains)) {
    db.settings.puppeteerDomains = puppeteerDomains;
  }
  if (typeof autoRetryEnabled === 'boolean') {
    db.settings.autoRetryEnabled = autoRetryEnabled;
  }
  if (typeof autoUpdateEnabled === 'boolean') {
    db.settings.autoUpdateEnabled = autoUpdateEnabled;
  }

  writeDb(db);
  res.json(db.settings);
});

// Get all manga series (with their chapters)
app.get('/api/series', (req, res) => {
  const db = readDb();
  res.json(db.series || []);
});

// Comparable "identity" tokens for a series: its display name plus, when it's
// a URL-shaped name (added by pasting a listing URL with no title typed in
// yet), the path slug too - normalizeForComparison already strips non-ASCII
// (Thai) text along with punctuation, so "Magic Emperor ราชาจอมเวทย์" and
// ".../magic-emperor/" both collapse down to a comparable "magicemperor".
function seriesIdentityTokens(series) {
  const tokens = new Set();
  const add = (str) => {
    const n = normalizeForComparison(str);
    if (n && n.length >= MIN_DUPLICATE_TOKEN_LENGTH) tokens.add(n);
  };
  add(series.name);
  add(series.metadata?.title);
  (series.metadata?.altTitles || []).forEach(add);
  [series.seriesUrl, ...(series.sourceUrls || [])].filter(Boolean).forEach(url => {
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      if (segments.length > 0) add(segments[segments.length - 1]);
    } catch (e) { /* not a real URL - nothing to extract */ }
  });
  return [...tokens];
}

// Below this, a normalized token is too generic/short to mean anything on its
// own ("app", "1") - only tokens at least this long are trusted as a
// meaningful title/slug fragment for duplicate detection.
const MIN_DUPLICATE_TOKEN_LENGTH = 6;

// Best-effort "this might already be tracked under a different name/site"
// check - one token containing another (in full) is a strong enough signal
// to warn about without blocking the add; a manga's title rarely fully
// contains another unrelated manga's title once punctuation/Thai text is
// stripped out.
function findPossibleDuplicateSeries(db, candidateSeries) {
  const candidateTokens = seriesIdentityTokens(candidateSeries);
  if (candidateTokens.length === 0) return [];

  return (db.series || [])
    .filter(s => s.id !== candidateSeries.id)
    .filter(s => {
      const existingTokens = seriesIdentityTokens(s);
      return existingTokens.some(et => candidateTokens.some(ct => et.includes(ct) || ct.includes(et)));
    })
    .map(s => ({ id: s.id, name: s.name }));
}

app.post('/api/series', (req, res) => {
  const { seriesUrl, name, useStealth } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Series name is required' });
  }

  const db = readDb();
  if (!db.series) db.series = [];

  const normalizedName = normalizeForComparison(name);
  const existingSeries = db.series.find(s => normalizeForComparison(s.name) === normalizedName);
  if (existingSeries) {
    return res.status(200).json(existingSeries);
  }

  const newSeries = {
    id: Date.now().toString(),
    name: name.trim(),
    useStealth: !!useStealth,
    metadata: null,
    metadataFetchedAt: null,
    createdAt: new Date().toISOString(),
    seriesUrl: seriesUrl ? seriesUrl.trim() : null,
    sourceUrls: [],
    chapters: []
  };

  const possibleDuplicates = findPossibleDuplicateSeries(db, newSeries);

  db.series.push(newSeries);
  writeDb(db);

  res.status(201).json({ ...newSeries, possibleDuplicates });
});

// Reports holes in a series' chapter numbering (e.g. has 1-255, 257-880 but
// no 256) so a stuck/incomplete source doesn't go unnoticed just because the
// chapters it does have all show "done".
app.get('/api/series/:id/chapter-gaps', (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }

  res.json(findChapterGaps(series.chapters));
});

// Delete a manga series (and every chapter/image saved under it)
app.delete('/api/series/:id', (req, res) => {
  const { id } = req.params;
  const db = readDb();
  if (!db.series) db.series = [];

  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }

  const seriesDir = path.join(MANGA_DIR, id);
  fs.rm(seriesDir, { recursive: true, force: true }, (err) => {
    if (err) console.error(`Failed to remove series folder ${seriesDir}:`, err);
  });

  db.series = db.series.filter(s => s.id !== id);
  writeDb(db);

  res.json({ message: 'Series deleted successfully' });
});

// Add a chapter (name + page URL) to a series
app.post('/api/series/:id/chapters', (req, res) => {
  const { id } = req.params;
  const { name, url } = req.body;
  if (!name || !name.trim() || !url || !url.trim()) {
    return res.status(400).json({ error: 'Chapter name and URL are required' });
  }

  let formattedUrl = url.trim();
  if (!/^https?:\/\//i.test(formattedUrl)) {
    formattedUrl = 'http://' + formattedUrl;
  }

  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }

  const newChapter = {
    id: Date.now().toString(),
    name: name.trim(),
    url: formattedUrl,
    status: 'pending', // pending -> scraping -> done | blocked | error
    images: [],
    error: null,
    scrapedAt: null,
    retryCount: 0
  };

  if (!series.chapters) series.chapters = [];
  series.chapters.push(newChapter);
  writeDb(db);

  res.status(201).json(newChapter);
});

// Delete a chapter (and its downloaded images) from a series
app.delete('/api/series/:id/chapters/:chapterId', (req, res) => {
  const { id, chapterId } = req.params;
  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }

  const chapter = findChapter(series, chapterId);
  if (!chapter) {
    return res.status(404).json({ error: 'Chapter not found' });
  }

  const chapterDir = path.join(MANGA_DIR, id, chapterId);
  fs.rm(chapterDir, { recursive: true, force: true }, (err) => {
    if (err) console.error(`Failed to remove chapter folder ${chapterDir}:`, err);
  });

  series.chapters = series.chapters.filter(c => c.id !== chapterId);
  writeDb(db);

  res.json({ message: 'Chapter deleted successfully' });
});

// Remove a single image from a chapter - for when the automatic ad/credit
// filters (URL-keyword and cross-chapter content-hash dedup) miss a one-off
// translator note or promo slide and a human has to review and strip it out
// by hand instead.
app.delete('/api/series/:id/chapters/:chapterId/images/:filename', (req, res) => {
  const { id, chapterId, filename } = req.params;
  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }
  const chapter = findChapter(series, chapterId);
  if (!chapter) {
    return res.status(404).json({ error: 'Chapter not found' });
  }
  const image = (chapter.images || []).find(img => img.filename === filename);
  if (!image) {
    return res.status(404).json({ error: 'Image not found in this chapter' });
  }

  fs.rm(path.join(MANGA_DIR, id, chapterId, filename), { force: true }, (err) => {
    if (err) console.error(`Failed to remove image file ${filename}:`, err);
  });
  chapter.images = chapter.images.filter(img => img.filename !== filename);
  writeDb(db);

  res.json({ message: 'Image deleted successfully', remainingCount: chapter.images.length });
});

// Core of chapter scraping, shared by the single-chapter route and the
// scrape-all-chapters route below. Mutates `chapter` in place and persists
// `db` itself; returns { httpStatus, error } (error is null on success).
// Sequential + jittered + robots.txt-aware, matching the polite-crawler
// posture used for the sitemap page scan.
// How many auto-retry attempts a chapter gets (from /scrape-all and the
// whole-site crawl's retry pass - see below) before it's left alone with
// whatever incomplete status it ended up with. A manual "Re-scrape" click
// from the UI always resets this and tries again regardless of the cap.
const MAX_CHAPTER_RETRIES = 3;

async function scrapeChapterCore(db, series, chapter) {
  // Serialize against every other scrape/crawl operation hitting this same
  // site (see runExclusiveByOrigin above) - this is the one function every
  // scraping entry point funnels through, so locking here is enough to stop
  // e.g. a whole-site crawl and a manual "Re-scrape" click on some other
  // chapter of the same site from ever running at the same time.
  const result = await runExclusiveByOrigin(chapter.url, () => scrapeChapterCoreAttempt(db, series, chapter));
  // Anything short of 'done' (partial/error/blocked) means the chapter came
  // out incomplete - track how many times that's happened so the automatic
  // retry passes know when to stop hammering a chapter that just won't go
  // through, instead of retrying it forever.
  chapter.retryCount = chapter.status === 'done' ? 0 : (chapter.retryCount || 0) + 1;
  writeDb(db);
  return result;
}

async function scrapeChapterCoreAttempt(db, series, chapter) {
  const seriesId = series.id;
  chapter.status = 'scraping';
  chapter.error = null;
  writeDb(db);

  try {
    // Respect robots.txt for the chapter's page before touching the site at all.
    const origin = new URL(chapter.url).origin;
    const robotsText = await fetchTextOrNull(`${origin}/robots.txt`);
    const robotsRules = robotsText ? parseRobotsRules(robotsText) : { disallowPaths: [], crawlDelaySeconds: null };

    if (isPathDisallowed(chapter.url, robotsRules.disallowPaths)) {
      chapter.status = 'blocked';
      chapter.error = 'robots.txt ของเว็บนี้ไม่อนุญาตให้เข้าหน้านี้';
      writeDb(db);
      return { httpStatus: 403, error: chapter.error };
    }

    const pageDetail = await fetchPageDetails(chapter.url, series.useStealth);
    if (pageDetail.status !== 'up') {
      chapter.status = 'error';
      chapter.error = pageDetail.error || 'ไม่สามารถเปิดหน้าตอนนี้ได้';
      writeDb(db);
      return { httpStatus: 502, error: chapter.error };
    }

    // This page was already identified as a manga chapter (typed by hand or
    // discovered from the series listing), so every image on it is treated
    // as a page unless it's flagged as an ad - real reader pages usually
    // serve pages as plain numbered files (001.jpg, 002.jpg) with no
    // "manga"/"chapter" keyword in the URL, so requiring that keyword (like
    // the homepage gallery classifier does) would silently drop almost all
    // of them and keep only a stray keyword-matched thumbnail.
    let mangaImages = pageDetail.images.filter(img => img.type !== 'ad');

    // Cross-chapter dedup: a real page is essentially never byte-identical
    // reused between two different chapters, but a site's own promo banner
    // or a UI icon (a lightbox "close" button, a "read more manga" ad slot
    // shaped like 728x400) often is - and its filename/keywords can look
    // completely innocuous. Track which chapter first served each image URL
    // on this series; the moment the same URL shows up under a second,
    // different chapter, it's confirmed to be a shared site asset rather
    // than chapter art, so it gets excluded here and on every future scrape.
    if (!series.seenAssetUrls) series.seenAssetUrls = {};
    if (!series.sharedAssetUrls) series.sharedAssetUrls = [];
    const sharedSet = new Set(series.sharedAssetUrls);
    // URL-based dedup (above) misses ad/credit graphics that a translator
    // re-uploads as a brand new file for every chapter - same picture, new
    // URL each time. Those can only be caught by hashing the actual
    // downloaded bytes; series.seenAssetHashes/sharedAssetHashes mirror the
    // URL-based tracking above but keyed by SHA-256 of the file content.
    if (!series.seenAssetHashes) series.seenAssetHashes = {};
    if (!series.sharedAssetHashes) series.sharedAssetHashes = [];
    const sharedHashSet = new Set(series.sharedAssetHashes);
    // Perceptual-hash log for the same reused-graphic problem but where the
    // re-upload isn't even byte-identical (see PHASH_DISTANCE_THRESHOLD
    // above) - only populated for first/last-page candidates, not every
    // image, to keep the decode cost down.
    if (!series.assetPHashLog) series.assetPHashLog = [];

    mangaImages.forEach(img => {
      const seenInChapter = series.seenAssetUrls[img.url];
      if (seenInChapter && seenInChapter !== chapter.id) {
        if (!sharedSet.has(img.url)) {
          sharedSet.add(img.url);
          series.sharedAssetUrls.push(img.url);
        }
      } else if (!seenInChapter) {
        series.seenAssetUrls[img.url] = chapter.id;
      }
    });

    mangaImages = mangaImages.filter(img => !sharedSet.has(img.url));

    if (mangaImages.length === 0) {
      chapter.status = 'error';
      chapter.error = 'ไม่พบรูปในหน้านี้ (รูปทั้งหมดถูกกรองว่าเป็นโฆษณาหรือรูปที่ใช้ซ้ำทั้งเว็บ)';
      writeDb(db);
      return { httpStatus: 404, error: chapter.error };
    }

    // Wipe any previous download for this chapter first, so a re-scrape
    // after the filters above catch something new doesn't leave stale
    // pages (e.g. yesterday's ad banner) sitting alongside the fresh set.
    const chapterDir = path.join(MANGA_DIR, seriesId, chapter.id);
    fs.rmSync(chapterDir, { recursive: true, force: true });
    fs.mkdirSync(chapterDir, { recursive: true });

    const downloaded = [];
    const chapterHashes = new Set(); // content hashes already kept in THIS scrape - catches in-chapter duplicate pages
    let blockedEarly = false;
    let retryAfterMs = null;
    let excludedAsSharedCount = 0; // hash-deduped ad/credit images - not a download failure

    for (let i = 0; i < mangaImages.length; i++) {
      if (i > 0) {
        await sleep(computeNextDelayMs(robotsRules.crawlDelaySeconds));
      }

      const imageUrl = mangaImages[i].url;
      try {
        const download = await fetchImageWithRetry(imageUrl, clearanceHeaders(imageUrl, {
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Referer': origin
        }));

        if (download.blocked) {
          blockedEarly = true;
          // Some sites tell us exactly how long to back off instead of
          // leaving it to guesswork - honor that over our own jittered delay.
          retryAfterMs = download.retryAfterMs;
          break;
        }
        const response = download.response;

        const contentType = response.headers.get('content-type');
        let ext = getExtension(imageUrl, contentType);
        const arrayBuffer = await response.arrayBuffer();
        let buffer = Buffer.from(arrayBuffer);

        // Crop off the aggregator's branding/backlink banner (a red
        // "GOD MANGA / god-manga.com" graphic on a solid-white strip at the
        // top of the page) before the bytes are hashed or saved - it's site
        // furniture, not page art, so it must never reach the exported
        // chapter. No-op on pages that don't carry it. Hashing the CLEANED
        // bytes keeps re-scrapes deterministic and lets the cross-chapter
        // dedup below still match.
        try {
          buffer = (await stripAggregatorBanner(buffer, ext)).buffer;
        } catch (err) {
          // any decode/encode failure: fall back to the untouched original
        }

        // Downsize oversized pages and recompress to JPEG before it ever
        // touches disk - happens before hashing too, same reasoning as the
        // banner strip above (re-scrapes stay deterministic).
        try {
          const optimized = await optimizeMangaImage(buffer, ext);
          buffer = optimized.buffer;
          ext = optimized.ext;
        } catch (err) {
          // any decode/encode failure: fall back to the untouched original
        }

        const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

        // The site sometimes serves the exact same page file twice within one
        // chapter (a duplicated splash/banner slide). The cross-chapter checks
        // below only fire when a hash reappears under a *different* chapter, so
        // an in-chapter repeat would slip through and get saved twice - drop it.
        if (chapterHashes.has(contentHash)) {
          continue;
        }
        chapterHashes.add(contentHash);

        // Same cross-chapter-reuse check as the URL-based one above, but by
        // content hash - catches a translator's credit slide/ad banner even
        // when it's re-uploaded under a fresh URL every chapter. A hash seen
        // under a different chapter id already confirms it's reused site
        // furniture, not unique page art, so skip saving it at all.
        const seenInChapter = series.seenAssetHashes[contentHash];
        if ((seenInChapter && seenInChapter !== chapter.id) || sharedHashSet.has(contentHash)) {
          if (!sharedHashSet.has(contentHash)) {
            sharedHashSet.add(contentHash);
            series.sharedAssetHashes.push(contentHash);
          }
          excludedAsSharedCount++;
          continue;
        }
        if (!seenInChapter) {
          series.seenAssetHashes[contentHash] = chapter.id;
        }

        // Perceptual-hash check, only for first/last-page candidates (see
        // isPHashCandidatePosition) - catches a reused ad/credit graphic
        // that's visually the same but wasn't byte-identical, which the
        // exact contentHash check above just let through.
        let pHash = null;
        if (isPHashCandidatePosition(i, mangaImages.length)) {
          pHash = await computePerceptualHash(buffer);
          if (pHash) {
            const nearMatch = series.assetPHashLog.find(entry =>
              entry.chapterId !== chapter.id && compareHashes(entry.hash, pHash) <= PHASH_DISTANCE_THRESHOLD
            );
            if (nearMatch) {
              excludedAsSharedCount++;
              continue;
            }
            series.assetPHashLog.push({ hash: pHash, chapterId: chapter.id });
          }
        }

        const filename = `${String(i + 1).padStart(3, '0')}.${ext}`;
        const filePath = path.join(chapterDir, filename);
        await fs.promises.writeFile(filePath, buffer);

        downloaded.push({
          order: i + 1,
          filename,
          relativePath: `manga/${seriesId}/${chapter.id}/${filename}`,
          originalUrl: imageUrl,
          contentHash,
          ...(pHash ? { pHash } : {})
        });
      } catch (err) {
        console.error(`Failed to download manga image ${imageUrl}:`, err);
      }
    }

    chapter.images = downloaded;
    const expectedCount = mangaImages.length - excludedAsSharedCount;
    if (blockedEarly && downloaded.length === 0) {
      chapter.status = 'blocked';
    } else if (expectedCount === 0) {
      // Every image on the page turned out to be a reused ad/credit graphic
      // (byte-identical to something already downloaded elsewhere) - there's
      // no actual chapter art here, so this is an error, not a done chapter
      // with zero pages.
      chapter.status = 'error';
    } else {
      chapter.status = downloaded.length < expectedCount ? 'partial' : 'done';
    }
    chapter.error = blockedEarly
      ? 'เว็บเริ่มบล็อก (429/403) ระหว่างโหลดรูป ระบบหยุดให้อัตโนมัติ - โหลดได้บางส่วน'
      : (expectedCount === 0 ? 'ทุกรูปในหน้านี้ถูกกรองว่าเป็นรูปโฆษณา/เครดิตที่ใช้ซ้ำ' : null);
    chapter.scrapedAt = new Date().toISOString();

    writeDb(db);
    return { httpStatus: 200, error: null, blockedEarly, retryAfterMs };
  } catch (error) {
    console.error(`Error scraping chapter ${chapter.id}:`, error);
    chapter.status = 'error';
    chapter.error = error.message || 'เกิดข้อผิดพลาดระหว่างดึงข้อมูล';
    writeDb(db);
    return { httpStatus: 500, error: chapter.error };
  }
}

// Scrape a single chapter's page for manga images only, and download every
// one of them to disk.
app.post('/api/series/:id/chapters/:chapterId/scrape', async (req, res) => {
  const { id, chapterId } = req.params;
  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }
  const chapter = findChapter(series, chapterId);
  if (!chapter) {
    return res.status(404).json({ error: 'Chapter not found' });
  }
  if (scrapingChapters[chapterId]) {
    return res.status(429).json({ error: 'This chapter is already being scraped' });
  }

  scrapingChapters[chapterId] = true;
  try {
    const result = await scrapeChapterCore(db, series, chapter);
    if (result.error) {
      return res.status(result.httpStatus).json({ error: result.error });
    }
    res.json(chapter);
  } finally {
    scrapingChapters[chapterId] = false;
  }
});

// Extracts every "chapter link" from a series' listing page: an <a href>
// whose target sits under the same path as the listing page itself (manga
// sites nest chapter URLs under their series slug) or whose text/URL
// contains an explicit chapter/episode keyword. This lets a user hand over
// just the one series page instead of typing every chapter URL by hand.
// Pulls a chapter number out of a URL path, preferring an explicit chapter
// token (ep0014 / chapter-14 / episode_14 / ตอนที่-14) over a bare trailing
// number - the token is far less likely to grab an unrelated digit that
// happens to sit in the slug (a year, a volume, ...) than "first number
// anywhere" would.
function chapterNumberFromPath(decodedPath) {
  const tokenMatch = decodedPath.match(/(?:ep|episode|chapter|ตอน(?:ที่)?)[-_.\s]*(\d+(?:\.\d+)?)/i);
  if (tokenMatch) return parseFloat(tokenMatch[1]);
  const tailMatch = decodedPath.match(/[-/](\d+(?:\.\d+)?)\/?$/);
  return tailMatch ? parseFloat(tailMatch[1]) : null;
}

// Link labels that are page furniture pointing AT a chapter (the "read first /
// latest chapter" buttons, prev/next arrows) rather than a real chapter list
// entry - we still keep the URL, but its text must not become the chapter's
// name, and a real list entry for the same URL should win over it.
const CHAPTER_NAV_LABEL_REGEX = /^(อ่าน(ตอน)?(แรก|ล่าสุด|ต่อ)|ตอน(แรก|ล่าสุด|ก่อน(หน้า)?|ถัดไป)|บท(ก่อน(หน้า)?|ถัดไป)|กลับ|first|last|prev(ious)?|next|latest|newest|oldest|read\s*(first|last|now))\b/i;

// Strips a trailing "N สัปดาห์ / 3 วัน / 2 hours ago" freshness stamp that
// these listings tack onto each chapter row, so it never lands in the name (or,
// worse, gets read as the chapter number).
function cleanChapterName(text) {
  return text
    .replace(/\s*\d+\s*(สัปดาห์|วัน|ชั่วโมง|นาที|เดือน|ปี|weeks?|days?|hrs?|hours?|mins?|minutes?|months?|years?)\s*(ที่แล้ว|ago)?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function discoverChapterLinksFromHtml(html, pageUrl) {
  const cleanedHtml = stripNavChrome(html);
  const seriesPath = new URL(pageUrl).pathname.replace(/\/+$/, '');
  const CHAPTER_KEYWORD_REGEX = /(chapter|ตอน|ep[-_.]?\d|episode)/i;
  const NUMBER_REGEX = /(\d+(?:\.\d+)?)/;

  // Capture the whole opening <a ...> tag so per-chapter data-* attributes
  // (e.g. bully-manga's data-title="14") are available for a clean number/name.
  const linkRegex = /<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi;
  const seen = new Map();
  let match;

  while ((match = linkRegex.exec(cleanedHtml)) !== null) {
    const attrs = match[1];
    const hrefMatch = /href=["']([^"']+)["']/i.exec(attrs);
    if (!hrefMatch) continue;
    const rawHref = hrefMatch[1].trim();
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) continue;

    let absoluteUrl;
    try {
      absoluteUrl = new URL(rawHref, pageUrl);
    } catch (e) {
      continue;
    }
    if (absoluteUrl.origin !== new URL(pageUrl).origin) continue;

    const linkPath = absoluteUrl.pathname.replace(/\/+$/, '');
    if (linkPath === seriesPath) continue; // link back to the listing page itself

    const text = match[2].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
    let decodedLinkPath = linkPath;
    try { decodedLinkPath = decodeURIComponent(linkPath); } catch(e) {}

    // Extract series slug
    const seriesSlugMatch = seriesPath.match(/\/([^\/]+)$/);
    const seriesSlug = seriesSlugMatch ? seriesSlugMatch[1] : null;
    let decodedSeriesSlug = seriesSlug;
    try { if (seriesSlug) decodedSeriesSlug = decodeURIComponent(seriesSlug); } catch (e) {}

    let isSameSeries = false;
    if (seriesPath !== '' && seriesPath !== '/') {
      // 1. Nested: /series/ -> /series/chapter-1
      if (linkPath.startsWith(`${seriesPath}/`) || decodedLinkPath.startsWith(`${seriesPath}/`)) {
        isSameSeries = true;
      }
      // 2. Flat with dash: /series -> /series-chapter-1
      else if (linkPath.startsWith(`${seriesPath}-`) || decodedLinkPath.startsWith(`${seriesPath}-`)) {
        isSameSeries = true;
      }
      // 3. Different base path but shares slug: /manga/series -> /chapter/series-1
      else if (seriesSlug && (
        linkPath.includes(`/${seriesSlug}-`) || decodedLinkPath.includes(`/${decodedSeriesSlug}-`) ||
        linkPath.includes(`/${seriesSlug}/`) || decodedLinkPath.includes(`/${decodedSeriesSlug}/`) ||
        linkPath.endsWith(`/${seriesSlug}`) || decodedLinkPath.endsWith(`/${decodedSeriesSlug}`)
      )) {
        isSameSeries = true;
      }
    } else {
      // If no valid series path, default to accepting anything that looks like a chapter (fallback)
      isSameSeries = true;
    }

    const looksLikeChapter = CHAPTER_KEYWORD_REGEX.test(text) || CHAPTER_KEYWORD_REGEX.test(decodedLinkPath);
    if (!isSameSeries || !looksLikeChapter) continue;

    const href = absoluteUrl.href;

    // Chapter number: prefer an explicit data-* attribute (grid layouts like
    // bully-manga expose the clean number there), then the URL's chapter token,
    // then a number in the link text as a last resort.
    const dataAttrMatch = /data-(?:title|ep|chapter|num|number)=["'](\d+(?:\.\d+)?)["']/i.exec(attrs);
    const cleanedText = cleanChapterName(text);
    const number = dataAttrMatch ? parseFloat(dataAttrMatch[1])
      : (chapterNumberFromPath(decodedLinkPath)
        ?? (cleanedText.match(NUMBER_REGEX) ? parseFloat(cleanedText.match(NUMBER_REGEX)[1]) : null));

    // Name + priority. A "read first/latest" nav button must never name the
    // chapter (priority 0); a clean data-attr grid cell is most trustworthy
    // (priority 3); a normal text label that reads like a chapter is priority 2;
    // a bare number-only fallback is priority 1. On a duplicate URL the highest
    // priority wins, so the real list entry beats the nav button.
    const isNav = CHAPTER_NAV_LABEL_REGEX.test(cleanedText);
    let name, priority;
    if (dataAttrMatch && number !== null) {
      name = `ตอนที่ ${number}`;
      priority = 3;
    } else if (!isNav && cleanedText && CHAPTER_KEYWORD_REGEX.test(cleanedText)) {
      name = cleanedText;
      priority = 2;
    } else if (number !== null) {
      name = `ตอนที่ ${number}`;
      priority = isNav ? 0 : 1;
    } else {
      name = cleanedText || href;
      priority = 0;
    }

    const existing = seen.get(href);
    if (existing && existing.priority >= priority) continue;
    seen.set(href, { url: href, name, number, priority });
  }

  const results = [...seen.values()].map(({ url, name, number }) => ({ url, name, number }));
  const allNumbered = results.length > 0 && results.every(r => r.number !== null);
  if (allNumbered) {
    results.sort((a, b) => a.number - b.number);
  }
  return results;
}

// Path segments that are almost never a manga series' own page - nav/legal/
// account/taxonomy pages a listing page is full of.
const NON_SERIES_PATH_REGEX = /^(page|tag|tags|category|categories|genre|genres|author|authors|feed|wp-json|wp-admin|wp-login|wp-content|login|register|signup|search|about|about-us|contact|contact-us|privacy|privacy-policy|terms|terms-of-service|dmca|sitemap|rss|home|advertise|faq)$/i;
// A bare hit on one of these words with NO slug after it (e.g. "/manga/",
// "/bookmark/") is the site's own catalog/account root, not a specific
// series - but "/manga/<slug>/" (two segments) is exactly the common
// convention real series pages use, so this is only checked when the link
// has nothing after the word.
const CATALOG_ROOT_WORDS_REGEX = /^(manga|mangas|series|comic|comics|title|titles|story|stories|read|list|lists|bookmark|bookmarks|library|archive|archives|popular|latest|updates|new|ongoing|completed|all|all-manga)$/i;
const CONTENT_PREFIX_REGEX = /^(manga|mangas|series|comic|comics|title|titles|story|stories)$/i;
const CHAPTER_LIKE_PATH_REGEX = /(chapter|ตอน|ep[-_.]?\d|episode)/i;
// Generic nav/account link labels (English and Thai) - a real series title
// is never just "Bookmark" or "หมวดหมู่อื่นๆ" (other categories).
// "อ่านเรื่องนี้ →" / "อ่านต่อ" / "Read now" etc. are hero/CTA buttons that
// point at a real series URL but whose LABEL is the call to action, not the
// title - drop them so a series never gets named "อ่านเรื่องนี้" (the real
// series is still discovered from its poster card elsewhere on the page).
const NON_SERIES_NAME_REGEX = /^(home|login|log\s*in|register|sign\s*up|sign\s*in|logout|log\s*out|bookmark(s)?|all\s*manga|all|genre(s)?|categor(y|ies)|about(\s*us)?|contact(\s*us)?|privacy(\s*policy)?|terms([\s-](of[\s-]service|and[\s-]conditions))?|dmca|faq|advertise|search|read\s*(now|this|more).*|หมวดหมู่.*|ทั้งหมด|บุ๊คมาร์ค|เข้าสู่ระบบ|สมัครสมาชิก|ติดต่อเรา|เกี่ยวกับเรา|ค้นหา|รายการโปรด|หน้าแรก|อ่านเรื่อง.*|อ่านต่อ.*|อ่านเลย.*|อ่านตอน.*|นโยบาย.*|ข้อตกลง.*)$/i;

// Strips repeated site-wide chrome (nav/header/footer/sidebar) out of a page
// before link discovery runs over it - this chrome repeats on every page of
// a site and is the single biggest source of nav items masquerading as
// "series" (menu tabs like "All Manga" / "Bookmark" / genre lists).
function stripNavChrome(html) {
  return html.replace(/<(header|nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

// Extracts every plausible "series page" link from a site's homepage/listing
// page: a same-origin link with a short, slug-like path that isn't obviously
// a nav/legal/taxonomy page and doesn't itself look like a chapter link.
// Heuristic and best-effort by nature (see discoverChapterLinksFromHtml) -
// there's no universal "this is a manga series" marker to check for.
function discoverSeriesLinksFromHtml(html, pageUrl) {
  const cleanedHtml = stripNavChrome(html);
  const currentOrigin = new URL(pageUrl).origin;
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  const seen = new Map();
  let match;

  while ((match = linkRegex.exec(cleanedHtml)) !== null) {
    const rawHref = match[1].trim();
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) continue;

    let absoluteUrl;
    try {
      absoluteUrl = new URL(rawHref, pageUrl);
    } catch (e) {
      continue;
    }
    if (absoluteUrl.origin !== currentOrigin) continue;

    const segments = absoluteUrl.pathname.split('/').filter(Boolean);
    if (segments.length === 0 || segments.length > 2) continue;
    if (segments.some(seg => NON_SERIES_PATH_REGEX.test(seg))) continue;
    if (segments.length === 1 && CATALOG_ROOT_WORDS_REGEX.test(segments[0])) continue;
    if (/^\d+$/.test(segments[segments.length - 1])) continue; // page/2, ?p=3 style pure-numeric segments

    const text = match[2].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
    if (text.length < 2) continue; // icon-only links (social buttons, etc.)
    if (NON_SERIES_NAME_REGEX.test(text)) continue;
    if (CHAPTER_LIKE_PATH_REGEX.test(text) || CHAPTER_LIKE_PATH_REGEX.test(absoluteUrl.pathname)) continue;

    const href = absoluteUrl.href;
    if (!seen.has(href)) seen.set(href, { url: href, name: text, segments });
  }

  const results = [...seen.values()];

  // If the page has any link following a known "/manga/<slug>/" (or /series/,
  // /comic/, ...) convention, that's a high-confidence signal for how this
  // particular site structures series URLs - trust only those and drop
  // everything else discovered on the page, since anything else was noise
  // that slipped past the filters above.
  const prefixed = results.filter(r => r.segments.length === 2 && CONTENT_PREFIX_REGEX.test(r.segments[0]));
  const chosen = prefixed.length > 0 ? prefixed : results;
  return chosen.map(({ url, name }) => ({ url, name }));
}

// Finds the "next page" link on a paginated listing page (rel="next", or a
// link whose own text is exactly a next-page marker). Returns null once
// there's no more pagination to follow.
function findNextListingPageUrl(html, pageUrl) {
  const relNextMatch = /<a\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']next["'][^>]*>/i.exec(html)
    || /<a\s+[^>]*rel=["']next["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(html);
  if (relNextMatch) {
    try { return new URL(relNextMatch[1], pageUrl).href; } catch (e) { /* fall through */ }
  }

  const NEXT_TEXT_REGEX = /^(next|ถัดไป|»|>|next\s*»|หน้าถัดไป)$/i;
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const text = match[2].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (NEXT_TEXT_REGEX.test(text)) {
      try { return new URL(match[1].trim(), pageUrl).href; } catch (e) { continue; }
    }
  }

  // JS-driven pagers (next/prev <button>s that page client-side, e.g.
  // bully-manga's "หน้า 1 / 40" grid or its homepage "หน้า 1" feed) expose no
  // <a href> to follow, but the pages still live at predictable URLs. Only act
  // when there's a real next control on the page, so a lone "หน้า"/"page" word
  // elsewhere never triggers phantom pagination.
  const hasNextControl = /id=["']nextBtn["']|ถัดไป|หน้าถัดไป|class=["'][^"']*(?:pagination|pager|pg-)/i.test(html);
  if (hasNextControl) {
    // A disabled next button = we're on the last page.
    const nextDisabled = /<button[^>]*id=["']nextBtn["'][^>]*\bdisabled\b/i.test(html)
      || /<button[^>]*\bdisabled\b[^>]*id=["']nextBtn["']/i.test(html);
    if (nextDisabled) return null;

    const currentMatch = /(?:หน้า|page)\s*(?:<[^>]*>\s*)?(\d+)/i.exec(html);
    const current = currentMatch ? parseInt(currentMatch[1], 10) : null;
    if (current !== null && current >= 1) {
      // Stop at the last page when a total is shown ("หน้า X / Y").
      const totalMatch = /(?:หน้า|page)\s*(?:<[^>]*>\s*)?\d+(?:\s*<\/[^>]*>)?\s*(?:\/|of|จาก)\s*(\d+)/i.exec(html);
      if (totalMatch && current >= parseInt(totalMatch[1], 10)) return null;

      const nextPageNum = current + 1;
      // Prefer the site's OWN next-page URL, lifted from its pager JS
      // (`location.href = `/page/${page + 1}``) - the path convention differs by
      // section (bully-manga's homepage is /page/N, its catalog is /genres/all/N),
      // so a blind numeric-segment bump would 404 on the homepage.
      const tplMatch = /location\.href\s*=\s*[`"']([^`"'${]*)\$\{\s*[a-zA-Z_$][\w$]*\s*\+\s*1\s*\}([^`"']*)[`"']/.exec(html);
      if (tplMatch) {
        try { return new URL(`${tplMatch[1]}${nextPageNum}${tplMatch[2]}`, pageUrl).href; } catch (e) { /* fall through */ }
      }
      // Fallback: increment/append a trailing numeric path segment.
      try {
        const nextUrl = new URL(pageUrl);
        const segments = nextUrl.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
        if (segments.length > 0 && /^\d+$/.test(segments[segments.length - 1])) {
          segments[segments.length - 1] = String(nextPageNum);
        } else {
          segments.push(String(nextPageNum));
        }
        nextUrl.pathname = '/' + segments.join('/');
        return nextUrl.href;
      } catch (e) { /* fall through */ }
    }
  }
  return null;
}

// Discover every chapter link from a series' "all chapters" listing page and
// add the ones that aren't already tracked. The user only has to paste one
// URL (the page shown in their screenshot with the full episode list)
// instead of adding each chapter by hand.
app.post('/api/series/:id/discover-chapters', async (req, res) => {
  const { id } = req.params;
  const { url } = req.body;
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'Series listing page URL is required' });
  }

  let formattedUrl = url.trim();
  if (!/^https?:\/\//i.test(formattedUrl)) {
    formattedUrl = 'http://' + formattedUrl;
  }

  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }

  try {
    const result = await discoverAndAddNewChapters(db, series, formattedUrl);

    if (result.disallowed) {
      return res.status(403).json({ error: 'robots.txt ของเว็บนี้ไม่อนุญาตให้เข้าหน้านี้' });
    }
    if (result.fetchFailed) {
      return res.status(502).json({ error: 'ไม่สามารถเปิดหรืออ่านเนื้อหาหน้ารวมตอนนี้ได้' });
    }
    if (result.discoveredCount === 0) {
      return res.status(404).json({ error: 'ไม่พบลิงก์ตอนในหน้านี้ ลองตรวจสอบว่านี่เป็นหน้ารวมตอนจริงหรือไม่' });
    }

    writeDb(db);

    // Same as check-updates: don't just list what was found, actually download
    // it too - otherwise a freshly-discovered series just sits there pending
    // until someone remembers to click "Scrape ทุกตอนที่ยังไม่เสร็จ".
    let scrape = { scrapedCount: 0, blockedEarly: false };
    if (!scrapingSeries[id]) {
      scrapingSeries[id] = true;
      try {
        scrape = await runScrapeAllForSeries(db, series);
        writeDb(db);
      } finally {
        scrapingSeries[id] = false;
      }
    }

    res.json({
      discoveredCount: result.discoveredCount,
      addedCount: result.addedCount,
      skippedCount: result.discoveredCount - result.addedCount,
      addedChapters: [],
      ...scrape
    });
  } catch (error) {
    console.error(`Error discovering chapters from ${formattedUrl}:`, error);
    res.status(500).json({ error: error.message || 'เกิดข้อผิดพลาดระหว่างค้นหาตอน' });
  }
});

// Shared by fetch-metadata and export below (both need to politely re-fetch
// a series' own detail page) - checks robots.txt first, same posture as
// discover-chapters above.
async function fetchSeriesPageRespectingRobots(pageUrl, useStealth = false) {
  return runExclusiveByOrigin(pageUrl, async () => {
    const origin = new URL(pageUrl).origin;
    const robotsText = await fetchTextOrNull(`${origin}/robots.txt`);
    const robotsRules = robotsText ? parseRobotsRules(robotsText) : { disallowPaths: [], crawlDelaySeconds: null };
    if (isPathDisallowed(pageUrl, robotsRules.disallowPaths)) {
      return { disallowed: true, html: null };
    }
    return { disallowed: false, html: await fetchTextOrNull(pageUrl, 15000, useStealth) };
  });
}

// Re-fetches a series' listing page and adds any chapters that aren't tracked
// yet - i.e. newly released episodes. Crucially it NEVER re-downloads or resets
// a chapter that's already 'done'; it only appends brand-new chapters (as
// 'pending') and re-arms not-yet-finished ones. Shared by the manual
// /discover-chapters endpoint and the automatic update-checker watchdog, so
// both behave identically. Returns { discoveredCount, addedCount, disallowed,
// fetchFailed }.
async function discoverAndAddNewChapters(db, series, listingUrl) {
  const { disallowed, html } = await fetchSeriesPageRespectingRobots(listingUrl, series.useStealth);
  if (disallowed) return { discoveredCount: 0, addedCount: 0, disallowed: true };
  if (!html) return { discoveredCount: 0, addedCount: 0, fetchFailed: true };

  if (!series.metadata) {
    series.metadata = extractSeriesMetadataFromHtml(html, listingUrl);
    series.metadataFetchedAt = new Date().toISOString();
    await downloadCoverImageIfMissing(series);
  }

  const discovered = discoverChapterLinksFromHtml(html, listingUrl);
  if (!series.chapters) series.chapters = [];
  const existingUrls = new Set(series.chapters.map(c => c.url));

  let addedCount = 0;
  discovered.forEach((item, index) => {
    if (existingUrls.has(item.url)) return; // already tracked by URL - skip

    const existingSameChapter = series.chapters.find(c => isSameChapter(c.name, item.name));
    if (existingSameChapter) {
      // Same chapter number under a slightly different URL: only re-arm it if it
      // never finished. A chapter already downloaded ('done') is left untouched.
      if (existingSameChapter.status !== 'done') {
        existingSameChapter.url = item.url;
        existingSameChapter.status = 'pending';
        existingSameChapter.error = null;
        existingSameChapter.retryCount = 0;
        addedCount++;
      }
      return;
    }

    series.chapters.push({
      id: `${Date.now()}_${index}`,
      name: item.name,
      url: item.url,
      status: 'pending',
      images: [],
      error: null,
      scrapedAt: null,
      retryCount: 0
    });
    addedCount++;
  });

  series.sourceUrls = [...new Set([...(series.sourceUrls || []), series.seriesUrl, listingUrl].filter(Boolean))];
  if (!series.seriesUrl) series.seriesUrl = listingUrl;

  return { discoveredCount: discovered.length, addedCount };
}

// Scrapes (or re-scrapes) a series' SEO metadata from its own detail page -
// the same page discover-chapters points at - and stores it on the series
// record. Body may optionally override which URL to use; otherwise falls
// back to the series' already-known listing/detail page.
app.post('/api/series/:id/fetch-metadata', async (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }

  const targetUrl = (req.body && req.body.url && req.body.url.trim()) || series.seriesUrl;
  if (!targetUrl) {
    return res.status(400).json({ error: 'ไม่มี URL หน้าเรื่องนี้ กรุณาค้นหาตอนอัตโนมัติก่อน หรือระบุ URL' });
  }

  try {
    const { disallowed, html } = await fetchSeriesPageRespectingRobots(targetUrl, series.useStealth);
    if (disallowed) {
      return res.status(403).json({ error: 'robots.txt ของเว็บนี้ไม่อนุญาตให้เข้าหน้านี้' });
    }
    if (!html) {
      return res.status(502).json({ error: 'ไม่สามารถเปิดหรืออ่านเนื้อหาหน้าเรื่องนี้ได้' });
    }

    series.metadata = extractSeriesMetadataFromHtml(html, targetUrl);
    series.metadataFetchedAt = new Date().toISOString();
    await downloadCoverImageIfMissing(series);
    writeDb(db);

    res.json({ metadata: series.metadata, metadataFetchedAt: series.metadataFetchedAt });
  } catch (error) {
    console.error(`Error fetching SEO metadata from ${targetUrl}:`, error);
    res.status(500).json({ error: error.message || 'เกิดข้อผิดพลาดระหว่างดึงข้อมูลเรื่อง' });
  }
});

let downloadingCovers = false; // guards against two bulk backfills running at once

// Backfills cover art for every series that's missing one: series that
// already have a coverImageUrl cached just get the file downloaded, and
// series with no metadata yet (but a known seriesUrl) get a best-effort
// metadata fetch first to discover their cover URL. downloadCoverImageIfMissing()
// is itself a no-op per series once its cover exists on disk, so calling this
// repeatedly (from the watchdog on a timer, or the manual button) is always
// safe and cheap.
async function backfillCoverImages(db) {
  let downloaded = 0;
  let skipped = 0;

  for (const series of db.series || []) {
    if (!series.metadata && series.seriesUrl) {
      try {
        const { disallowed, html } = await fetchSeriesPageRespectingRobots(series.seriesUrl, series.useStealth);
        if (!disallowed && html) {
          series.metadata = extractSeriesMetadataFromHtml(html, series.seriesUrl);
          series.metadataFetchedAt = new Date().toISOString();
        }
      } catch (err) {
        console.error(`Cover backfill: failed to fetch metadata for series ${series.id}:`, err.message);
      }
    }

    if (!series.metadata?.coverImageUrl) {
      skipped++;
      continue;
    }

    const hadPath = series.metadata.coverImagePath;
    await downloadCoverImageIfMissing(series);
    if (!hadPath && series.metadata.coverImagePath) downloaded++;
  }

  return { checked: (db.series || []).length, downloaded, skipped };
}

app.post('/api/series/download-covers', async (req, res) => {
  const db = readDb();
  if (downloadingCovers) {
    return res.status(429).json({ error: 'กำลังดาวน์โหลดปกอยู่แล้ว รอสักครู่' });
  }

  downloadingCovers = true;
  try {
    const result = await backfillCoverImages(db);
    writeDb(db);
    res.json(result);
  } catch (error) {
    console.error('Error backfilling cover images:', error);
    res.status(500).json({ error: error.message || 'เกิดข้อผิดพลาดระหว่างดาวน์โหลดปก' });
  } finally {
    downloadingCovers = false;
  }
});

const cleaningSeries = {}; // seriesId -> true while a duplicate-image sweep is in-flight

// Retroactively finds and strips reused ad/credit-slide images out of
// already-downloaded chapters by content, not URL. The per-chapter scraper
// (see contentHash tracking above) only catches these going forward once a
// hash has shown up under a second chapter - chapters downloaded before that
// point (or before this feature existed at all, so they have no stored hash
// yet) still have the images sitting in them. This hashes every image of
// every chapter once, and any hash that turns out to repeat across 2+
// different chapters is treated as confirmed shared site furniture and
// removed from all of them.
app.post('/api/series/:id/clean-duplicate-images', async (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }
  if (cleaningSeries[id]) {
    return res.status(429).json({ error: 'กำลังตรวจสอบรูปซ้ำของเรื่องนี้อยู่แล้ว' });
  }

  cleaningSeries[id] = true;
  try {
    const chapters = (series.chapters || []).filter(c => (c.images || []).length > 0);

    // Backfill contentHash for any image downloaded before this feature
    // existed (or before the hash was stored on it) - this is disk I/O per
    // file, not CPU work, so running a batch of these concurrently instead
    // of one at a time cuts wall time enormously on a series with thousands
    // of images.
    const allImageEntries = chapters.flatMap(chapter => chapter.images.map(image => ({ chapter, image })));
    await mapWithConcurrency(allImageEntries.filter(e => !e.image.contentHash), 24, async ({ chapter, image }) => {
      try {
        const buffer = await fs.promises.readFile(path.join(MANGA_DIR, id, chapter.id, image.filename));
        image.contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
      } catch (err) {
        // file missing on disk - nothing to hash/compare, leave contentHash unset
      }
    });

    // Group every image in the series by hash.
    const hashToEntries = new Map(); // hash -> [{ chapter, image }]
    for (const { chapter, image } of allImageEntries) {
      if (!image.contentHash) continue;
      if (!hashToEntries.has(image.contentHash)) hashToEntries.set(image.contentHash, []);
      hashToEntries.get(image.contentHash).push({ chapter, image });
    }

    if (!series.sharedAssetHashes) series.sharedAssetHashes = [];
    const sharedHashSet = new Set(series.sharedAssetHashes);

    let imagesRemoved = 0;
    const affectedChapterIds = new Set();
    for (const [hash, entries] of hashToEntries.entries()) {
      const distinctChapterIds = new Set(entries.map(e => e.chapter.id));
      if (distinctChapterIds.size < 2) continue; // only ever appeared in one chapter - real page art

      if (!sharedHashSet.has(hash)) {
        sharedHashSet.add(hash);
        series.sharedAssetHashes.push(hash);
      }
      for (const { chapter, image } of entries) {
        fs.rm(path.join(MANGA_DIR, id, chapter.id, image.filename), { force: true }, () => {});
        chapter.images = chapter.images.filter(img => img.filename !== image.filename);
        affectedChapterIds.add(chapter.id);
        imagesRemoved++;
      }
    }

    // Phase 2: perceptual-hash near-duplicate clustering, for reused
    // ad/credit graphics that survived phase 1 because they weren't
    // byte-identical (re-compressed/re-exported slightly differently each
    // time). Only first/last-page candidates are checked - see
    // isPHashCandidatePosition - both because that's where this kind of
    // image conventionally lives and to keep the (much slower) image-decode
    // cost bounded on series with hundreds of chapters.
    const candidates = [];
    for (const chapter of chapters) {
      const total = chapter.images.length;
      chapter.images.forEach((image, index) => {
        if (isPHashCandidatePosition(index, total)) candidates.push({ chapter, image });
      });
    }
    // Image decode is CPU-bound (unlike the file-read-only hashing above) so
    // this won't parallelize as cleanly on a single core, but Jimp's decode
    // still yields on I/O internally - a modest concurrency limit keeps
    // throughput up without spawning worker threads.
    await mapWithConcurrency(candidates.filter(c => !c.image.pHash), 8, async ({ chapter, image }) => {
      image.pHash = await computePerceptualHash(path.join(MANGA_DIR, id, chapter.id, image.filename));
    });
    const hashedCandidates = candidates.filter(c => c.image.pHash);

    // Union-find: cluster every candidate whose perceptual hash is within
    // PHASH_DISTANCE_THRESHOLD of another's into the same group, so a chain
    // of slightly-different re-exports of the same graphic all end up
    // together even if the first and last in the chain aren't themselves
    // close enough to directly match.
    const parent = hashedCandidates.map((_, i) => i);
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function union(i, j) { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; }
    for (let i = 0; i < hashedCandidates.length; i++) {
      for (let j = i + 1; j < hashedCandidates.length; j++) {
        if (compareHashes(hashedCandidates[i].image.pHash, hashedCandidates[j].image.pHash) <= PHASH_DISTANCE_THRESHOLD) {
          union(i, j);
        }
      }
    }

    const clusters = new Map(); // root index -> entries
    hashedCandidates.forEach((entry, i) => {
      const root = find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(entry);
    });

    let nearDuplicatesRemoved = 0;
    for (const entries of clusters.values()) {
      const distinctChapterIds = new Set(entries.map(e => e.chapter.id));
      if (distinctChapterIds.size < 2) continue; // only ever appeared in one chapter - real page art

      for (const { chapter, image } of entries) {
        fs.rm(path.join(MANGA_DIR, id, chapter.id, image.filename), { force: true }, () => {});
        chapter.images = chapter.images.filter(img => img.filename !== image.filename);
        affectedChapterIds.add(chapter.id);
        nearDuplicatesRemoved++;
      }
    }

    writeDb(db);
    res.json({
      chaptersScanned: chapters.length,
      chaptersAffected: affectedChapterIds.size,
      imagesRemoved: imagesRemoved + nearDuplicatesRemoved,
      exactDuplicatesRemoved: imagesRemoved,
      nearDuplicatesRemoved
    });
  } catch (error) {
    console.error(`Error cleaning duplicate images for series ${id}:`, error);
    res.status(500).json({ error: error.message || 'เกิดข้อผิดพลาดระหว่างตรวจสอบรูปซ้ำ' });
  } finally {
    cleaningSeries[id] = false;
  }
});

const exportingSeries = {}; // seriesId -> true while an export is in-flight

// Copies every finished ("done") chapter of a series out of the opaque
// id-keyed storage folders under MANGA_DIR into a human-readable
// <series title>/<chapter name>/ tree under EXPORT_DIR, alongside a
// metadata.json carrying the series' SEO fields (scraped on demand if not
// already cached) - meant to be handed off/archived/used for a public-
// facing site, unlike the working storage folders which are keyed by
// opaque ids.
app.post('/api/series/:id/export', async (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }
  if (exportingSeries[id]) {
    return res.status(429).json({ error: 'กำลัง export เรื่องนี้อยู่แล้ว' });
  }

  const doneChapters = (series.chapters || []).filter(c => c.status === 'done');
  if (doneChapters.length === 0) {
    return res.status(400).json({ error: 'ยังไม่มีตอนที่โหลดเสร็จสำหรับเรื่องนี้' });
  }

  exportingSeries[id] = true;
  try {
    // Best-effort refresh of SEO metadata if it hasn't been fetched yet, so
    // export always produces a metadata.json even for series added before
    // this existed - a failure here shouldn't block exporting the files
    // themselves.
    if (!series.metadata && series.seriesUrl) {
      try {
        const { disallowed, html } = await fetchSeriesPageRespectingRobots(series.seriesUrl, series.useStealth);
        if (!disallowed && html) {
          series.metadata = extractSeriesMetadataFromHtml(html, series.seriesUrl);
          series.metadataFetchedAt = new Date().toISOString();
          await downloadCoverImageIfMissing(series);
        }
      } catch (err) {
        console.error(`Export: failed to fetch SEO metadata for series ${id}:`, err);
      }
    }

    const seriesFolderName = sanitizeForFilename(series.metadata?.title || series.name, `series-${id}`);
    const seriesExportDir = path.join(EXPORT_DIR, seriesFolderName);
    await fs.promises.mkdir(seriesExportDir, { recursive: true });

    const exportedChapters = [];
    for (let i = 0; i < doneChapters.length; i++) {
      const chapter = doneChapters[i];
      const number = extractLeadingNumber(chapter.name);
      const paddedNumber = String(Math.trunc(number !== null ? number : i + 1)).padStart(4, '0');
      const chapterFolderName = `${paddedNumber}_${sanitizeForFilename(chapter.name, `chapter-${chapter.id}`)}`;
      const chapterExportDir = path.join(seriesExportDir, chapterFolderName);
      await fs.promises.mkdir(chapterExportDir, { recursive: true });

      let copiedCount = 0;
      for (const image of chapter.images || []) {
        try {
          await fs.promises.copyFile(path.join(SAVED_DIR, image.relativePath), path.join(chapterExportDir, image.filename));
          copiedCount++;
        } catch (err) {
          console.error(`Export: failed to copy ${image.relativePath}:`, err);
        }
      }

      exportedChapters.push({
        id: chapter.id,
        name: chapter.name,
        number,
        url: chapter.url,
        folder: chapterFolderName,
        imageCount: copiedCount
      });
    }

    const metadataJson = {
      seriesId: series.id,
      name: series.metadata?.title || series.name,
      seriesUrl: series.seriesUrl,
      exportedAt: new Date().toISOString(),
      metadataFetchedAt: series.metadataFetchedAt || null,
      seo: series.metadata || null,
      totalChaptersInSeries: (series.chapters || []).length,
      exportedChapterCount: exportedChapters.length,
      chapters: exportedChapters
    };
    await fs.promises.writeFile(path.join(seriesExportDir, 'metadata.json'), JSON.stringify(metadataJson, null, 2), 'utf-8');

    writeDb(db);

    res.json({
      seriesFolderName,
      exportPath: path.relative(DATA_DIR, seriesExportDir),
      exportedChapterCount: exportedChapters.length,
      metadata: series.metadata || null
    });
  } catch (error) {
    console.error(`Error exporting series ${id}:`, error);
    res.status(500).json({ error: error.message || 'เกิดข้อผิดพลาดระหว่าง export' });
  } finally {
    exportingSeries[id] = false;
  }
});

const scrapingSeries = {}; // seriesId -> true while a bulk scrape-all is in-flight

// Scrape every not-yet-downloaded chapter in a series, one after another,
// with the same jittered delay between chapters as between images within a
// chapter. Stops early if a chapter comes back blocked, so a site that
// starts rate-limiting doesn't get hammered with every remaining chapter.
//
// This makes several rounds (up to MAX_CHAPTER_RETRIES) rather than just
// one pass: a chapter that comes out partial/error (a network hiccup, a
// page that briefly 500'd, ...) is automatically retried in the next round
// instead of being left incomplete forever - only a manual "Re-scrape"
// click bypasses this retry budget once it's exhausted.
// Downloads every not-yet-done chapter of a series, retrying incomplete ones
// across up to MAX_CHAPTER_RETRIES rounds (a longer, gentler gap between
// rounds). Shared by /scrape-all and /retry-problem-chapters. Assumes the
// caller holds the scrapingSeries[id] lock. Returns { scrapedCount, blockedEarly }.
async function runScrapeAllForSeries(db, series) {
  const findEligible = () => (series.chapters || []).filter(
    c => c.status !== 'done' && (c.retryCount || 0) < MAX_CHAPTER_RETRIES && !scrapingChapters[c.id]
  );

  let scrapedCount = 0;
  let blockedEarly = false;
  let lastRetryAfterMs = null;

  for (let round = 0; round < MAX_CHAPTER_RETRIES; round++) {
    const chaptersToScrape = findEligible();
    if (chaptersToScrape.length === 0) break;

    if (round > 0) {
      // A longer, gentler gap before retrying anything that failed the
      // first time - a transient block/hiccup needs more than a second
      // to clear, and this also naturally slows down retries against a
      // site that's still actively rate-limiting. If the site told us via
      // Retry-After exactly how long to wait, that takes priority over
      // our own guess.
      await sleep(Math.max(computeNextDelayMs(null) * 3, lastRetryAfterMs || 0));
      lastRetryAfterMs = null;
    }

    let blockedThisRound = false;
    for (let i = 0; i < chaptersToScrape.length; i++) {
      if (i > 0) {
        await sleep(computeNextDelayMs(null));
      }

      const chapter = chaptersToScrape[i];
      scrapingChapters[chapter.id] = true;
      let result;
      try {
        result = await scrapeChapterCore(db, series, chapter);
      } finally {
        scrapingChapters[chapter.id] = false;
      }
      if (result.retryAfterMs) lastRetryAfterMs = result.retryAfterMs;

      scrapedCount++;
      if (chapter.status === 'blocked') {
        blockedThisRound = true;
        break;
      }
    }

    if (blockedThisRound && !lastRetryAfterMs) {
      // Blocked with no explicit signal for how long to wait - an
      // ambiguous 429/403 is treated as "stop touching this site right
      // now" rather than guessing at a backoff. If the site DID send a
      // Retry-After, that's an explicit "come back after N seconds"
      // instruction, safe to honor and let the next round retry -
      // handled by the delay above instead of aborting here.
      blockedEarly = true;
      break;
    }
  }

  // Reflects the final state after every round (including one that ran out of
  // retries while still blocked), not just whether a round broke out early.
  blockedEarly = blockedEarly || (series.chapters || []).some(c => c.status === 'blocked');
  return { scrapedCount, blockedEarly };
}

app.post('/api/series/:id/scrape-all', async (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }
  if (scrapingSeries[id]) {
    return res.status(429).json({ error: 'This series is already being scraped' });
  }

  const eligible = (series.chapters || []).filter(
    c => c.status !== 'done' && (c.retryCount || 0) < MAX_CHAPTER_RETRIES && !scrapingChapters[c.id]
  );
  if (eligible.length === 0) {
    return res.json({ scrapedCount: 0, blockedEarly: false, message: 'ไม่มีตอนที่ต้องโหลดเพิ่ม' });
  }

  scrapingSeries[id] = true;
  try {
    const result = await runScrapeAllForSeries(db, series);
    res.json(result);
  } finally {
    scrapingSeries[id] = false;
  }
});

// Re-download the chapters that ended up incomplete (error / partial / blocked),
// INCLUDING the ones that already used up their automatic retry budget - the
// retry cap only stops the unattended passes from hammering forever; an
// explicit click here means "try these again now", so it resets their counter
// first and then runs the same download-with-retries loop as /scrape-all.
app.post('/api/series/:id/retry-problem-chapters', async (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }
  if (scrapingSeries[id]) {
    return res.status(429).json({ error: 'This series is already being scraped' });
  }

  const problemChapters = (series.chapters || []).filter(c => c.status !== 'done' && !scrapingChapters[c.id]);
  if (problemChapters.length === 0) {
    return res.json({ scrapedCount: 0, blockedEarly: false, message: 'ไม่มีตอนที่มีปัญหาให้ลองใหม่' });
  }
  // Clear the retry budget so chapters stuck at the cap become eligible again.
  problemChapters.forEach(c => { c.retryCount = 0; });
  writeDb(db);

  scrapingSeries[id] = true;
  try {
    const result = await runScrapeAllForSeries(db, series);
    res.json({ ...result, retriedProblemCount: problemChapters.length });
  } finally {
    scrapingSeries[id] = false;
  }
});

// Manually check a series for newly-released chapters and download just the new
// ones (same thing the auto-update watchdog does on a schedule). Never touches
// chapters already downloaded.
app.post('/api/series/:id/check-updates', async (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const series = findSeries(db, id);
  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }
  if (!series.seriesUrl) {
    return res.status(400).json({ error: 'ซีรีส์นี้ไม่มี URL หน้ารวมตอน เลยเช็คตอนใหม่ให้ไม่ได้' });
  }
  if (scrapingSeries[id]) {
    return res.status(429).json({ error: 'This series is already being scraped' });
  }

  scrapingSeries[id] = true;
  try {
    const result = await discoverAndAddNewChapters(db, series, series.seriesUrl);
    series.lastUpdateCheckAt = new Date().toISOString();
    writeDb(db);

    if (result.disallowed) return res.status(403).json({ error: 'robots.txt ของเว็บนี้ไม่อนุญาตให้เข้าหน้านี้' });
    if (result.fetchFailed) return res.status(502).json({ error: 'เปิดหน้ารวมตอนไม่ได้' });

    // Not gated on result.addedCount: a chapter added on a previous check that
    // never finished downloading (still 'pending'/errored) won't show up as
    // "new" here since it's already tracked by URL, but it still needs to be
    // downloaded - runScrapeAllForSeries is a no-op if nothing is eligible.
    const scrape = await runScrapeAllForSeries(db, series);
    writeDb(db);
    res.json({ newChapters: result.addedCount, ...scrape });
  } catch (error) {
    res.status(500).json({ error: error.message || 'เกิดข้อผิดพลาดระหว่างเช็คตอนใหม่' });
  } finally {
    scrapingSeries[id] = false;
  }
});

// ---------------------------------------------------------------------------
// Whole-site crawl: hand over just a site's root/listing URL and the bot
// works through it entirely unattended - finds every series link on the
// listing (following pagination), then for each series discovers its
// chapters and downloads every one of them, exactly like the manual
// discover+scrape-all flow above but chained end-to-end and self-driving.
//
// This runs as a plain in-process background loop, not tied to any HTTP
// request/response, so it keeps going after the browser tab closes - only
// stopping when told to (or the whole Node process exits). Progress is
// persisted to disk after every step, so a server restart resumes a
// "running" crawl close to where it left off (series/chapters already
// marked done are never re-downloaded - see the `status !== 'done'` and
// seriesUrl-dedup checks below and in scrapeChapterCore).
// ---------------------------------------------------------------------------

const MAX_LISTING_PAGES = 60;
const MAX_DISCOVERED_SERIES_PER_CRAWL = 500;
const MAX_CONSECUTIVE_BLOCKED_SERIES = 3;
// After the normal per-chapter retries are spent, the crawl keeps doing full
// "recheck" sweeps over any chapters that are STILL incomplete - lifting the
// per-chapter retry cap and waiting an escalating cooldown between sweeps - so
// a series briefly blocked by a 429/403 gets picked back up automatically
// instead of staying stuck. Bounded so genuinely-dead chapters (404 art, etc.)
// don't loop the crawl forever.
const MAX_RECHECK_ROUNDS = 5;
const RECHECK_COOLDOWN_BASE_MS = 3 * 60 * 1000; // 3, 6, 9, 12, 15 min between rounds

function findCrawl(db, crawlId) {
  return (db.siteCrawls || []).find(c => c.id === crawlId);
}

// id -> { stopRequested: boolean } - the fast in-memory signal the loop
// checks between every unit of work; the persisted `status` field on the
// crawl record is for display/durability, this is what actually stops it.
const crawlControl = {};

async function runSiteCrawl(crawlId) {
  if (!crawlControl[crawlId]) crawlControl[crawlId] = { stopRequested: false };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (crawlControl[crawlId].stopRequested) return;

    const db = readDb();
    const crawl = findCrawl(db, crawlId);
    if (!crawl || crawl.status !== 'running') return;

    // Phase 1: keep discovering series links across listing pages until
    // pagination runs out, a page adds nothing new, or the safety caps hit.
    if (!crawl.discoveryDone) {
      const pageUrl = crawl.nextListingPageUrl || crawl.siteUrl;
      if (!pageUrl || crawl.visitedListingPages.includes(pageUrl) || crawl.visitedListingPages.length >= MAX_LISTING_PAGES) {
        crawl.discoveryDone = true;
        writeDb(db);
        continue;
      }

      let robotsRules = { disallowPaths: [], crawlDelaySeconds: null };
      let pageOrigin;
      try {
        pageOrigin = new URL(pageUrl).origin;
      } catch (e) {
        crawl.status = 'error';
        crawl.lastError = `URL ไม่ถูกต้อง: ${pageUrl}`;
        writeDb(db);
        return;
      }

      // Serialize against every other scrape/crawl currently touching this
      // same site (see runExclusiveByOrigin) - a listing-page fetch here
      // shouldn't race a chapter download in progress for the same host.
      const { disallowed, html } = await runExclusiveByOrigin(pageUrl, async () => {
        const robotsText = await fetchTextOrNull(`${pageOrigin}/robots.txt`, 8000, false);
        robotsRules = robotsText ? parseRobotsRules(robotsText) : robotsRules;
        if (isPathDisallowed(pageUrl, robotsRules.disallowPaths)) {
          return { disallowed: true, html: null };
        }
        return { disallowed: false, html: await fetchTextOrNull(pageUrl, 15000, crawl.useStealth) };
      });

      if (disallowed) {
        crawl.lastError = `robots.txt ไม่อนุญาตให้เข้าหน้า ${pageUrl} - หยุดค้นหาเรื่องเพิ่มเติม`;
        crawl.discoveryDone = true;
        writeDb(db);
        continue;
      }

      crawl.visitedListingPages.push(pageUrl);

      if (!html) {
        crawl.lastError = `ไม่สามารถเปิดหน้า ${pageUrl} ได้`;
        crawl.discoveryDone = true;
        writeDb(db);
        continue;
      }

      const seriesLinks = discoverSeriesLinksFromHtml(html, pageUrl);
      const existingUrls = new Set(crawl.discoveredSeries.map(s => s.url));
      let newCount = 0;
      for (const link of seriesLinks) {
        if (existingUrls.has(link.url) || crawl.discoveredSeries.length >= MAX_DISCOVERED_SERIES_PER_CRAWL) continue;
        crawl.discoveredSeries.push(link);
        existingUrls.add(link.url);
        newCount++;
      }

      const nextPage = findNextListingPageUrl(html, pageUrl);
      crawl.nextListingPageUrl = (nextPage && !crawl.visitedListingPages.includes(nextPage)) ? nextPage : null;
      if (!crawl.nextListingPageUrl || newCount === 0) {
        crawl.discoveryDone = true;
      }
      crawl.updatedAt = new Date().toISOString();
      writeDb(db);

      await sleep(computeNextDelayMs(robotsRules.crawlDelaySeconds));
      continue;
    }

    // Phase 2: process discovered series one at a time.
    const nextLink = crawl.discoveredSeries.find(s => !crawl.processedSeriesUrls.includes(s.url));
    if (!nextLink) {
      // Phase 3: retry pass. Every series has been attempted once, but some
      // chapters may have come out partial/error/blocked (a transient
      // network hiccup, a brief rate-limit, ...) - go back over every
      // series this crawl touched and give any chapter that hasn't
      // exhausted its retry budget another try, one chapter per loop
      // iteration, instead of leaving them incomplete forever.
      const crawlSeriesUrls = new Set(crawl.discoveredSeries.map(s => s.url));
      let retryChapter = null;
      let retrySeries = null;
      for (const s of (db.series || [])) {
        if (!crawlSeriesUrls.has(s.seriesUrl)) continue;
        const found = (s.chapters || []).find(c => c.status !== 'done' && (c.retryCount || 0) < MAX_CHAPTER_RETRIES);
        if (found) {
          retryChapter = found;
          retrySeries = s;
          break;
        }
      }

      if (!retryChapter) {
        // No chapter is under the per-chapter retry cap anymore. If chapters
        // are STILL incomplete (usually ones a 429/403 block stopped short),
        // don't give up: wait an escalating cooldown to let the site recover,
        // lift the retry cap on those chapters, and sweep again - up to
        // MAX_RECHECK_ROUNDS times - so a series doesn't stay stuck for long
        // while the crawl has already moved on. Only when everything is done,
        // or the recheck budget is spent, does the crawl actually finish.
        const incompleteChapters = [];
        for (const s of (db.series || [])) {
          if (!crawlSeriesUrls.has(s.seriesUrl)) continue;
          for (const c of (s.chapters || [])) {
            if (c.status !== 'done') incompleteChapters.push(c);
          }
        }

        if (incompleteChapters.length === 0 || (crawl.recheckRound || 0) >= MAX_RECHECK_ROUNDS) {
          crawl.status = 'done';
          crawl.currentSeriesUrl = null;
          crawl.currentSeriesName = null;
          crawl.updatedAt = new Date().toISOString();
          writeDb(db);
          return;
        }

        crawl.recheckRound = (crawl.recheckRound || 0) + 1;
        crawl.lastError = `รอบตรวจซ้ำ ${crawl.recheckRound}/${MAX_RECHECK_ROUNDS}: ยังมี ${incompleteChapters.length} ตอนที่ไม่ครบ กำลังพัก cooldown แล้วลองใหม่`;
        incompleteChapters.forEach(c => { c.retryCount = 0; }); // give them a fresh retry budget
        crawl.consecutiveBlockedSeries = 0; // fresh block budget after the cooldown
        crawl.currentSeriesUrl = null;
        crawl.currentSeriesName = null;
        crawl.updatedAt = new Date().toISOString();
        writeDb(db);

        // Escalating cooldown between recheck rounds (3, 6, 9, ... minutes) so a
        // rate-limiting site gets progressively more time to recover. Sleep in
        // short steps so a stop request still lands promptly.
        const cooldownMs = RECHECK_COOLDOWN_BASE_MS * crawl.recheckRound;
        for (let waited = 0; waited < cooldownMs; waited += 3000) {
          if (crawlControl[crawlId].stopRequested) {
            crawl.status = 'stopped';
            crawl.updatedAt = new Date().toISOString();
            writeDb(db);
            return;
          }
          await sleep(Math.min(3000, cooldownMs - waited));
        }
        continue;
      }

      crawl.currentSeriesUrl = retrySeries.seriesUrl;
      crawl.currentSeriesName = retrySeries.name;
      writeDb(db);

      scrapingChapters[retryChapter.id] = true;
      let retryResult;
      try {
        retryResult = await scrapeChapterCore(db, retrySeries, retryChapter);
      } finally {
        scrapingChapters[retryChapter.id] = false;
      }

      crawl.stats.chaptersDownloaded += 1;
      let retryDelayFloorMs = 0;
      if (retryChapter.status === 'blocked') {
        retryDelayFloorMs = retryResult.retryAfterMs || 0;
        crawl.consecutiveBlockedSeries = (crawl.consecutiveBlockedSeries || 0) + 1;
        if (crawl.consecutiveBlockedSeries >= MAX_CONSECUTIVE_BLOCKED_SERIES) {
          crawl.status = 'stopped';
          crawl.lastError = `เว็บบล็อกติดต่อกันหลายครั้งระหว่างลองใหม่ ระบบเลยหยุดให้อัตโนมัติ`;
        }
      } else {
        crawl.consecutiveBlockedSeries = 0;
      }
      crawl.updatedAt = new Date().toISOString();
      writeDb(db);

      // A gentler gap between retry attempts than the normal inter-chapter
      // delay, matching /scrape-all's retry pacing above - or however long
      // the site's own Retry-After said, if it was longer.
      await sleep(Math.max(computeNextDelayMs(null) * 3, retryDelayFloorMs));
      continue;
    }

    crawl.currentSeriesUrl = nextLink.url;
    crawl.currentSeriesName = nextLink.name;
    writeDb(db);

    if (!db.series) db.series = [];
    // Dedup against series already tracked (from a prior crawl, or added by
    // hand) so re-running a crawl never creates a duplicate series entry.
    // Also dedup by name across sites
    const normalizedNextName = normalizeForComparison(nextLink.name || nextLink.url);
    let series = db.series.find(s => s.seriesUrl === nextLink.url || normalizeForComparison(s.name) === normalizedNextName);
    
    if (!series) {
      series = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: nextLink.name || nextLink.url,
        createdAt: new Date().toISOString(),
        seriesUrl: nextLink.url,
        sourceUrls: [nextLink.url],
        chapters: []
      };
      db.series.push(series);
    } else {
      series.sourceUrls = [...new Set([...(series.sourceUrls || []), series.seriesUrl, nextLink.url].filter(Boolean))];
    }

    let seriesRobotsRules = { disallowPaths: [], crawlDelaySeconds: null };
    try {
      // Serialize against every other scrape/crawl currently touching this
      // same site (see runExclusiveByOrigin).
      await runExclusiveByOrigin(nextLink.url, async () => {
      const origin = new URL(nextLink.url).origin;
      const robotsText = await fetchTextOrNull(`${origin}/robots.txt`, 8000, false);
      seriesRobotsRules = robotsText ? parseRobotsRules(robotsText) : seriesRobotsRules;

      if (!isPathDisallowed(nextLink.url, seriesRobotsRules.disallowPaths)) {
        const html = await fetchTextOrNull(nextLink.url, 15000, crawl.useStealth);
        if (html) {
          if (!series.metadata) {
            series.metadata = extractSeriesMetadataFromHtml(html, nextLink.url);
            series.metadataFetchedAt = new Date().toISOString();
            await downloadCoverImageIfMissing(series);
          }

          const discoveredChapters = discoverChapterLinksFromHtml(html, nextLink.url);
          const existingChapterUrls = new Set(series.chapters.map(c => c.url));
          discoveredChapters.forEach((item, idx) => {
            if (existingChapterUrls.has(item.url)) return;
            
            const existingSameChapter = series.chapters.find(c => isSameChapter(c.name, item.name));
            if (existingSameChapter) {
              if (existingSameChapter.status !== 'done') {
                existingSameChapter.url = item.url;
                existingSameChapter.status = 'pending';
                existingSameChapter.error = null;
                existingSameChapter.retryCount = 0;
              }
              return;
            }
            
            series.chapters.push({
              id: `${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}`,
              name: item.name,
              url: item.url,
              status: 'pending',
              images: [],
              error: null,
              scrapedAt: null,
              retryCount: 0
            });
          });
        }
      }
      });
    } catch (e) {
      crawl.lastError = `หาตอนของเรื่อง "${nextLink.name}" ไม่สำเร็จ: ${e.message}`;
    }
    writeDb(db);
    await sleep(computeNextDelayMs(seriesRobotsRules.crawlDelaySeconds));

    // Scrape every not-yet-done chapter of this series, then keep sweeping the
    // ones that came out incomplete until they either finish or use up their
    // retry budget - so a transient failure (a 525 blip, a brief rate-limit) is
    // fixed right here, before moving to the next series, instead of waiting for
    // the end-of-crawl retry pass which on a big site could be hours away. Each
    // failed scrape bumps retryCount (see scrapeChapterCore), so a chapter drops
    // out of `pending` after MAX_CHAPTER_RETRIES sweeps - the loop can't spin.
    // The stop signal is checked before every chapter so a stop lands promptly.
    let seriesBlocked = false;
    let seriesRetryAfterMs = null;
    let firstChapterOfSeries = true;
    while (!seriesBlocked) {
      const pending = series.chapters.filter(
        c => c.status !== 'done' && (c.retryCount || 0) < MAX_CHAPTER_RETRIES
      );
      if (pending.length === 0) break;

      for (const chapter of pending) {
        if (crawlControl[crawlId].stopRequested) {
          crawl.status = 'stopped';
          crawl.updatedAt = new Date().toISOString();
          writeDb(db);
          return;
        }
        if (!firstChapterOfSeries) await sleep(computeNextDelayMs(null));
        firstChapterOfSeries = false;

        scrapingChapters[chapter.id] = true;
        let result;
        try {
          result = await scrapeChapterCore(db, series, chapter);
        } finally {
          scrapingChapters[chapter.id] = false;
        }

        crawl.stats.chaptersDownloaded += 1;
        if (chapter.status === 'blocked') {
          seriesBlocked = true;
          seriesRetryAfterMs = result.retryAfterMs || null;
          break;
        }
      }
    }

    crawl.processedSeriesUrls.push(nextLink.url);
    crawl.stats.seriesProcessed += 1;
    crawl.consecutiveBlockedSeries = seriesBlocked ? (crawl.consecutiveBlockedSeries || 0) + 1 : 0;
    crawl.currentSeriesUrl = null;
    crawl.currentSeriesName = null;
    crawl.updatedAt = new Date().toISOString();

    // A site that's blocked several series in a row is actively rate-limiting
    // this crawler - stop entirely rather than keep hammering it series after
    // series; the user can resume by hand once things have cooled down.
    if (crawl.consecutiveBlockedSeries >= MAX_CONSECUTIVE_BLOCKED_SERIES) {
      crawl.status = 'stopped';
      crawl.lastError = `เว็บบล็อกติดต่อกัน ${crawl.consecutiveBlockedSeries} เรื่อง ระบบเลยหยุดให้อัตโนมัติ`;
    }
    writeDb(db);

    await sleep(Math.max(computeNextDelayMs(null) * 2, seriesRetryAfterMs || 0));
  }
}

// Start a whole-site crawl: discover every series on the site, then every
// chapter of every series, downloading manga-only images throughout. Kicks
// the background loop off and returns immediately - use GET /api/site-crawls
// to poll progress.
app.post('/api/site-crawls', (req, res) => {
  const { url, useStealth } = req.body;
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'Site URL is required' });
  }

  let formattedUrl = url.trim();
  if (!/^https?:\/\//i.test(formattedUrl)) {
    formattedUrl = 'http://' + formattedUrl;
  }

  const db = readDb();
  if (!db.siteCrawls) db.siteCrawls = [];

  try {
    const targetOrigin = new URL(formattedUrl).origin;
    const existingCrawl = db.siteCrawls.find(c => {
      try { return new URL(c.siteUrl).origin === targetOrigin; } catch { return false; }
    });

    if (existingCrawl) {
      existingCrawl.useStealth = !!useStealth;
      if (existingCrawl.status !== 'running') {
        existingCrawl.status = 'running';
        existingCrawl.lastError = null;
        writeDb(db);
        runSiteCrawl(existingCrawl.id).catch(console.error);
      }
      return res.status(200).json({ message: 'Resumed existing crawl', crawlId: existingCrawl.id });
    }
  } catch (e) {
    // If URL parsing fails, proceed to create a new one (it will likely fail later, but safe fallback)
  }

  const newCrawl = {
    id: Date.now().toString(),
    siteUrl: formattedUrl,
    useStealth: !!useStealth,
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    discoveryDone: false,
    visitedListingPages: [],
    nextListingPageUrl: null,
    discoveredSeries: [],
    processedSeriesUrls: [],
    currentSeriesUrl: null,
    currentSeriesName: null,
    consecutiveBlockedSeries: 0,
    recheckRound: 0,
    lastError: null,
    stats: { seriesProcessed: 0, chaptersDownloaded: 0 }
  };

  db.siteCrawls.push(newCrawl);
  writeDb(db);

  crawlControl[newCrawl.id] = { stopRequested: false };
  runSiteCrawl(newCrawl.id).catch(err => {
    console.error(`Site crawl ${newCrawl.id} crashed:`, err);
    const latestDb = readDb();
    const crawl = findCrawl(latestDb, newCrawl.id);
    if (crawl) {
      crawl.status = 'error';
      crawl.lastError = err.message || 'เกิดข้อผิดพลาดไม่ทราบสาเหตุ';
      writeDb(latestDb);
    }
  });

  res.status(201).json(newCrawl);
});

// List every crawl job (running, stopped, done, error) with progress stats
app.get('/api/site-crawls', (req, res) => {
  const db = readDb();
  res.json(db.siteCrawls || []);
});

// Stop a running crawl. The in-memory flag makes the loop bail out before
// its next unit of work (next listing page, or next chapter within the
// series it's currently on).
app.post('/api/site-crawls/:id/stop', (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const crawl = findCrawl(db, id);
  if (!crawl) {
    return res.status(404).json({ error: 'Crawl not found' });
  }

  if (!crawlControl[id]) crawlControl[id] = { stopRequested: false };
  crawlControl[id].stopRequested = true;
  crawl.status = 'stopped';
  crawl.updatedAt = new Date().toISOString();
  writeDb(db);

  res.json(crawl);
});

// Resume a stopped/errored crawl from wherever it left off.
app.post('/api/site-crawls/:id/resume', (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const crawl = findCrawl(db, id);
  if (!crawl) {
    return res.status(404).json({ error: 'Crawl not found' });
  }
  if (crawl.status === 'running') {
    return res.status(429).json({ error: 'Crawl is already running' });
  }

  crawl.status = 'running';
  crawl.lastError = null;
  crawl.consecutiveBlockedSeries = 0;
  crawl.updatedAt = new Date().toISOString();
  writeDb(db);

  crawlControl[id] = { stopRequested: false };
  runSiteCrawl(id).catch(err => {
    console.error(`Site crawl ${id} crashed:`, err);
    const latestDb = readDb();
    const c = findCrawl(latestDb, id);
    if (c) {
      c.status = 'error';
      c.lastError = err.message || 'เกิดข้อผิดพลาดไม่ทราบสาเหตุ';
      writeDb(latestDb);
    }
  });

  res.json(crawl);
});

// Remove a crawl job record. Series/chapters it already downloaded are left
// alone - they're regular series entries at this point, manage them from
// the normal series list.
app.delete('/api/site-crawls/:id', (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const initialLength = (db.siteCrawls || []).length;
  db.siteCrawls = (db.siteCrawls || []).filter(c => c.id !== id);

  if (db.siteCrawls.length === initialLength) {
    return res.status(404).json({ error: 'Crawl not found' });
  }

  if (crawlControl[id]) crawlControl[id].stopRequested = true;
  writeDb(db);

  res.json({ message: 'Crawl deleted successfully' });
});

// Get alert logs
app.get('/api/logs', (req, res) => {
  const db = readDb();
  res.json(db.logs || []);
});

// Clear alert logs
app.post('/api/logs/clear', (req, res) => {
  const db = readDb();
  db.logs = [];
  writeDb(db);
  res.json({ message: 'Logs cleared successfully' });
});

// Get aggregate stats
app.get('/api/stats', (req, res) => {
  const db = readDb();
  const monitors = db.monitors;

  const total = monitors.length;
  const up = monitors.filter(m => m.status === 'up').length;
  const down = monitors.filter(m => m.status === 'down').length;
  const unknown = monitors.filter(m => m.status === 'unknown').length;

  // Calculate average response time for active online sites
  const upSitesWithResponse = monitors.filter(m => m.status === 'up' && m.lastResponseTime);
  const avgResponseTime = upSitesWithResponse.length > 0
    ? Math.round(upSitesWithResponse.reduce((sum, m) => sum + m.lastResponseTime, 0) / upSitesWithResponse.length)
    : 0;

  res.json({
    total,
    up,
    down,
    unknown,
    avgResponseTime
  });
});

// Serve built frontend files in production
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get('*', (req, res) => {
    // If it's not an API call, serve the index.html
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    }
  });
}

// Resume any site crawls that were still "running" when the server last
// stopped (a restart, a crash, ...) - progress already made is persisted in
// db.json, so this picks up wherever it left off instead of starting over.
function resumeRunningSiteCrawls() {
  const db = readDb();
  (db.siteCrawls || []).forEach(crawl => {
    if (crawl.status !== 'running') return;
    crawlControl[crawl.id] = { stopRequested: false };
    runSiteCrawl(crawl.id).catch(err => {
      console.error(`Resumed site crawl ${crawl.id} crashed:`, err);
      const latestDb = readDb();
      const c = findCrawl(latestDb, crawl.id);
      if (c) {
        c.status = 'error';
        c.lastError = err.message || 'เกิดข้อผิดพลาดไม่ทราบสาเหตุ';
        writeDb(latestDb);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Auto-retry watchdog: a standing background job so the user never has to click
// "retry problem chapters" by hand. Every tick it sweeps ALL series, and for
// any that still have incomplete chapters (error / partial / blocked) - and
// that aren't already being scraped and haven't been auto-retried too recently
// - it lifts the retry cap on those chapters and re-runs the same download loop
// as /scrape-all. So a chapter a 429/403 briefly blocked heals itself once the
// site cools off, without the crawl having to stay parked on it. On by default;
// toggle with settings.autoRetryEnabled.
// ---------------------------------------------------------------------------
const AUTO_RETRY_TICK_MS = 10 * 60 * 1000;      // how often the watchdog wakes up
// Per-series cooldown ESCALATES the longer a series stays stuck: retry soon at
// first (a transient 429/403 block usually clears within minutes), then back
// off geometrically toward a 2-hour ceiling so a stubborn series keeps getting
// retried forever - automatically, gently, no manual clicks - without hammering
// the source. Cooldown = min(BASE * 2^streak, MAX): 10m, 20m, 40m, 80m, 2h, 2h…
const AUTO_RETRY_BASE_COOLDOWN_MS = 10 * 60 * 1000;   // first retry ~10 min after a failure
const AUTO_RETRY_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000; // ...capped at every 2 hours forever
let autoRetryRunning = false;

async function autoRetryProblemChaptersSweep() {
  if (autoRetryRunning) return; // never overlap two sweeps
  const settingsDb = readDb();
  if (settingsDb.settings && settingsDb.settings.autoRetryEnabled === false) return;

  autoRetryRunning = true;
  try {
    const seriesIds = (readDb().series || []).map(s => s.id);
    for (const seriesId of seriesIds) {
      // Re-read fresh each time - a scrape/crawl running in parallel may have
      // changed this series (or another one) since the sweep started.
      const db = readDb();
      const series = findSeries(db, seriesId);
      if (!series) continue;
      if (scrapingSeries[seriesId]) continue; // a scrape/crawl already owns it

      const problems = (series.chapters || []).filter(
        c => c.status !== 'done' && !scrapingChapters[c.id]
      );
      if (problems.length === 0) {
        // Nothing wrong anymore - clear the back-off streak so a future problem
        // gets retried promptly again rather than starting at a long cooldown.
        if (series.autoRetryStreak) { series.autoRetryStreak = 0; writeDb(db); }
        continue;
      }

      // Escalating back-off: the more consecutive sweeps this series has stayed
      // stuck, the longer we wait before the next retry (10m → 20m → … → 2h cap).
      const streak = series.autoRetryStreak || 0;
      const cooldown = Math.min(AUTO_RETRY_BASE_COOLDOWN_MS * Math.pow(2, streak), AUTO_RETRY_MAX_COOLDOWN_MS);
      const lastAt = series.lastAutoRetryAt ? new Date(series.lastAutoRetryAt).getTime() : 0;
      if (Date.now() - lastAt < cooldown) continue;

      scrapingSeries[seriesId] = true;
      try {
        problems.forEach(c => { c.retryCount = 0; }); // fresh retry budget
        series.lastAutoRetryAt = new Date().toISOString();
        writeDb(db);
        console.log(`[AutoRetry] retrying ${problems.length} problem chapter(s) in "${series.name}" (streak ${streak}, next in ~${Math.round(Math.min(AUTO_RETRY_BASE_COOLDOWN_MS * Math.pow(2, streak + 1), AUTO_RETRY_MAX_COOLDOWN_MS) / 60000)}m if still stuck)`);
        await runScrapeAllForSeries(db, series);
        // Bump the streak if it's still not fully done (keeps backing off toward
        // the 2h ceiling); reset to 0 the moment everything downloaded.
        const stillStuck = (series.chapters || []).some(c => c.status !== 'done');
        series.autoRetryStreak = stillStuck ? streak + 1 : 0;
        writeDb(db);
      } catch (err) {
        console.error(`[AutoRetry] series ${seriesId} failed:`, err);
      } finally {
        scrapingSeries[seriesId] = false;
      }
    }
  } finally {
    autoRetryRunning = false;
  }
}

function startAutoRetryWatchdog() {
  console.log('Auto-retry watchdog started...');
  setInterval(() => { autoRetryProblemChaptersSweep().catch(console.error); }, AUTO_RETRY_TICK_MS);
}

// ---------------------------------------------------------------------------
// Auto-update watchdog: keeps already-downloaded series current. Periodically
// re-checks each series' own listing page for chapters that have been released
// since it was last scraped, and if any turned up, downloads just those new
// ones (never re-downloading what's already 'done'). This is what makes a
// "complete" series pick up new episodes on its own, no clicking required.
// On by default; toggle with settings.autoUpdateEnabled.
// ---------------------------------------------------------------------------
const AUTO_UPDATE_TICK_MS = 3 * 60 * 60 * 1000;         // sweep every 3 hours
const AUTO_UPDATE_SERIES_COOLDOWN_MS = 3 * 60 * 60 * 1000; // ...and re-check a given series at most that often
let autoUpdateRunning = false;

async function autoUpdateCheckSweep() {
  if (autoUpdateRunning) return;
  const settingsDb = readDb();
  if (settingsDb.settings && settingsDb.settings.autoUpdateEnabled === false) return;

  autoUpdateRunning = true;
  try {
    const seriesIds = (readDb().series || []).map(s => s.id);
    for (const seriesId of seriesIds) {
      const db = readDb();
      const series = findSeries(db, seriesId);
      if (!series || !series.seriesUrl) continue;
      if (scrapingSeries[seriesId]) continue; // busy being scraped/retried

      const lastAt = series.lastUpdateCheckAt ? new Date(series.lastUpdateCheckAt).getTime() : 0;
      if (Date.now() - lastAt < AUTO_UPDATE_SERIES_COOLDOWN_MS) continue;

      let added = 0;
      try {
        const result = await discoverAndAddNewChapters(db, series, series.seriesUrl);
        added = result.addedCount || 0;
        series.lastUpdateCheckAt = new Date().toISOString();
        writeDb(db);
      } catch (err) {
        console.error(`[AutoUpdate] discover failed for "${series.name}":`, err);
        continue;
      }

      if (added > 0 && !scrapingSeries[seriesId]) {
        console.log(`[AutoUpdate] "${series.name}": found ${added} new chapter(s), downloading...`);
        scrapingSeries[seriesId] = true;
        try {
          await runScrapeAllForSeries(db, series);
          writeDb(db);
        } catch (err) {
          console.error(`[AutoUpdate] download failed for "${series.name}":`, err);
        } finally {
          scrapingSeries[seriesId] = false;
        }
      }
    }
  } finally {
    autoUpdateRunning = false;
  }
}

function startAutoUpdateWatchdog() {
  console.log('Auto-update watchdog started...');
  // First sweep 2 minutes after boot (let resumed crawls settle), then every tick.
  setTimeout(() => { autoUpdateCheckSweep().catch(console.error); }, 2 * 60 * 1000);
  setInterval(() => { autoUpdateCheckSweep().catch(console.error); }, AUTO_UPDATE_TICK_MS);
}

// Cover-art watchdog: same idea as the auto-retry/auto-update watchdogs above -
// periodically backfills cover art for any series still missing one, so a
// freshly-added series (or one whose cover download failed transiently) gets
// its cover without anyone having to remember to click "ดาวน์โหลดปกทั้งหมด".
const COVER_BACKFILL_TICK_MS = 30 * 60 * 1000; // sweep every 30 minutes

function startCoverBackfillWatchdog() {
  console.log('Cover backfill watchdog started...');
  const runSweep = async () => {
    if (downloadingCovers) return; // manual button already running one
    downloadingCovers = true;
    try {
      const db = readDb();
      const result = await backfillCoverImages(db);
      if (result.downloaded > 0) {
        writeDb(db);
        console.log(`[CoverBackfill] downloaded ${result.downloaded} new cover(s)`);
      }
    } catch (err) {
      console.error('[CoverBackfill] sweep failed:', err);
    } finally {
      downloadingCovers = false;
    }
  };
  setTimeout(runSweep, 60 * 1000); // first sweep 1 minute after boot
  setInterval(runSweep, COVER_BACKFILL_TICK_MS);
}

// Start Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  startScheduler();
  resumeRunningSiteCrawls();
  startAutoRetryWatchdog();
  startAutoUpdateWatchdog();
  startCoverBackfillWatchdog();
});
