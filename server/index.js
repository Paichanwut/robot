import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { Jimp, compareHashes } from 'jimp';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

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

let browserInstance = null;
async function getBrowser() {
  if (browserInstance) return browserInstance;
  browserInstance = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800']
  });
  return browserInstance;
}

process.on('SIGINT', async () => {
  if (browserInstance) await browserInstance.close();
  process.exit();
});

async function fetchTextWithPuppeteer(url, timeoutMs = 15000) {
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    
    let html = await page.content();
    let title = await page.title();
    
    let checks = 0;
    while ((title.includes('Just a moment') || html.includes('challenge-platform') || html.includes('Cloudflare')) && checks < 60) {
      console.log(`[Puppeteer] Cloudflare detected on ${url}, waiting for user interaction (${checks}/60)...`);
      await new Promise(r => setTimeout(r, 1000));
      html = await page.content();
      title = await page.title();
      checks++;
    }
    
    if (checks > 0) {
      console.log(`[Puppeteer] Cloudflare challenge passed or timed out after ${checks}s on ${url}`);
    }
    
    const finalHtml = await page.content();
    // Also save cookies to the global map for this domain so we can use them to download images
    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const domain = new URL(url).hostname;
    if (cookieString) {
      domainCookies[domain] = cookieString;
    }

    return finalHtml;
  } catch (e) {
    console.error('Puppeteer fetch error:', e);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

const domainCookies = {}; // Store cookies for image fetching

async function fetchTextOrNull(url, timeoutMs = 8000, useStealth = false) {
  try {
    if (useStealth) {
      return await fetchTextWithPuppeteer(url, timeoutMs + 5000);
    }

    const domain = new URL(url).hostname;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
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
        html = await fetchTextWithPuppeteer(pageUrl, 20000);
        statusCode = html ? 200 : 500;
    } else {
        const response = await fetch(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
          },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        statusCode = response.status;
        if (statusCode < 200 || statusCode >= 400) {
            return { url: pageUrl, status: 'down', statusCode, responseTime: Math.round(performance.now() - startTime), error: `HTTP Error Code: ${statusCode}`, images: [] };
        }
        html = await response.text();
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': referer
      },
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

        const domain = new URL(imageUrl).hostname;
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Referer': referer
        };
        if (domainCookies[domain]) {
          headers['Cookie'] = domainCookies[domain];
        }

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
  [/updated\s*on|last\s*updated|แก้ไขล่าสุด/i, 'lastUpdatedDate'],
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

  return meta;
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

// Get global settings
app.get('/api/settings', (req, res) => {
  const db = readDb();
  if (!db.settings) db.settings = { puppeteerDomains: [] };
  res.json(db.settings);
});

// Update global settings
app.post('/api/settings', (req, res) => {
  const db = readDb();
  if (!db.settings) db.settings = { puppeteerDomains: [] };
  
  const { puppeteerDomains } = req.body;
  if (Array.isArray(puppeteerDomains)) {
    db.settings.puppeteerDomains = puppeteerDomains;
  }
  
  writeDb(db);
  res.json(db.settings);
});

// Get all manga series (with their chapters)
app.get('/api/series', (req, res) => {
  const db = readDb();
  res.json(db.series || []);
});

// Create a new manga series (or return existing if matched by name)
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

  db.series.push(newSeries);
  writeDb(db);

  res.status(201).json(newSeries);
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

    const pageDetail = await fetchPageDetails(chapter.url);
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
    let blockedEarly = false;
    let retryAfterMs = null;
    let excludedAsSharedCount = 0; // hash-deduped ad/credit images - not a download failure

    for (let i = 0; i < mangaImages.length; i++) {
      if (i > 0) {
        await sleep(computeNextDelayMs(robotsRules.crawlDelaySeconds));
      }

      const imageUrl = mangaImages[i].url;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(imageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Referer': origin
          },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.status === 429 || response.status === 403) {
          blockedEarly = true;
          // Some sites tell us exactly how long to back off instead of
          // leaving it to guesswork - honor that over our own jittered delay.
          retryAfterMs = parseRetryAfterMs(response);
          break;
        }
        if (!response.ok) {
          throw new Error(`HTTP Error ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        const ext = getExtension(imageUrl, contentType);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

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
function discoverChapterLinksFromHtml(html, pageUrl) {
  const cleanedHtml = stripNavChrome(html);
  const seriesPath = new URL(pageUrl).pathname.replace(/\/+$/, '');
  const CHAPTER_KEYWORD_REGEX = /(chapter|ตอน|ep[-_.]?\d|episode)/i;
  const NUMBER_REGEX = /(\d+(?:\.\d+)?)/;

  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
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
    if (seen.has(href)) continue;

    const numberMatch = (text.match(NUMBER_REGEX) || linkPath.match(NUMBER_REGEX));
    const number = numberMatch ? parseFloat(numberMatch[1]) : null;
    const name = text || (number !== null ? `ตอนที่ ${number}` : href);

    seen.set(href, { url: href, name, number });
  }

  const results = [...seen.values()];
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
const NON_SERIES_NAME_REGEX = /^(home|login|log\s*in|register|sign\s*up|sign\s*in|logout|log\s*out|bookmark(s)?|all\s*manga|all|genre(s)?|categor(y|ies)|about(\s*us)?|contact(\s*us)?|privacy(\s*policy)?|terms([\s-](of[\s-]service|and[\s-]conditions))?|dmca|faq|advertise|search|หมวดหมู่.*|ทั้งหมด|บุ๊คมาร์ค|เข้าสู่ระบบ|สมัครสมาชิก|ติดต่อเรา|เกี่ยวกับเรา|ค้นหา|รายการโปรด|หน้าแรก|นโยบาย.*|ข้อตกลง.*)$/i;

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
    // Serialize against every other scrape/crawl currently touching this
    // same site (see runExclusiveByOrigin) - discovery is a burst of a
    // couple requests, no reason to let it race a chapter download in
    // progress for the same host.
    const { disallowed, html } = await runExclusiveByOrigin(formattedUrl, async () => {
      const origin = new URL(formattedUrl).origin;
      const robotsText = await fetchTextOrNull(`${origin}/robots.txt`);
      const robotsRules = robotsText ? parseRobotsRules(robotsText) : { disallowPaths: [], crawlDelaySeconds: null };

      if (isPathDisallowed(formattedUrl, robotsRules.disallowPaths)) {
        return { disallowed: true, html: null };
      }

      return { disallowed: false, html: await fetchTextOrNull(formattedUrl, 15000) };
    });

    if (disallowed) {
      return res.status(403).json({ error: 'robots.txt ของเว็บนี้ไม่อนุญาตให้เข้าหน้านี้' });
    }
    if (!html) {
      return res.status(502).json({ error: 'ไม่สามารถเปิดหรืออ่านเนื้อหาหน้ารวมตอนนี้ได้' });
    }

    if (!series.metadata) {
      series.metadata = extractSeriesMetadataFromHtml(html, formattedUrl);
      series.metadataFetchedAt = new Date().toISOString();
    }

    const discovered = discoverChapterLinksFromHtml(html, formattedUrl);
    if (discovered.length === 0) {
      return res.status(404).json({ error: 'ไม่พบลิงก์ตอนในหน้านี้ ลองตรวจสอบว่านี่เป็นหน้ารวมตอนจริงหรือไม่' });
    }

    if (!series.chapters) series.chapters = [];
    const existingUrls = new Set(series.chapters.map(c => c.url));

    let addedCount = 0;
    discovered.forEach((item, index) => {
      if (existingUrls.has(item.url)) return;
      
      const existingSameChapter = series.chapters.find(c => isSameChapter(c.name, item.name));
      if (existingSameChapter) {
        if (existingSameChapter.status !== 'done') {
          existingSameChapter.url = item.url;
          existingSameChapter.status = 'pending';
          existingSameChapter.error = null;
          existingSameChapter.retryCount = 0;
          addedCount++;
        }
        return;
      }

      const newChapter = {
        id: `${Date.now()}_${index}`,
        name: item.name,
        url: item.url,
        status: 'pending',
        images: [],
        error: null,
        scrapedAt: null,
        retryCount: 0
      };
      series.chapters.push(newChapter);
      addedCount++;
    });

    series.sourceUrls = [...new Set([...(series.sourceUrls || []), series.seriesUrl, formattedUrl].filter(Boolean))];
    if (!series.seriesUrl) series.seriesUrl = formattedUrl;
    
    writeDb(db);

    res.json({
      discoveredCount: discovered.length,
      addedCount: addedCount,
      skippedCount: discovered.length - addedCount,
      addedChapters: []
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
    writeDb(db);

    res.json({ metadata: series.metadata, metadataFetchedAt: series.metadataFetchedAt });
  } catch (error) {
    console.error(`Error fetching SEO metadata from ${targetUrl}:`, error);
    res.status(500).json({ error: error.message || 'เกิดข้อผิดพลาดระหว่างดึงข้อมูลเรื่อง' });
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

  const findEligible = () => (series.chapters || []).filter(
    c => c.status !== 'done' && (c.retryCount || 0) < MAX_CHAPTER_RETRIES && !scrapingChapters[c.id]
  );

  if (findEligible().length === 0) {
    return res.json({ scrapedCount: 0, blockedEarly: false, message: 'ไม่มีตอนที่ต้องโหลดเพิ่ม' });
  }

  scrapingSeries[id] = true;
  let scrapedCount = 0;
  let blockedEarly = false;
  let lastRetryAfterMs = null;

  try {
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

    // Reflects the final state after every round (including one that ran
    // out of retries while still blocked), not just whether a round broke
    // out early above.
    blockedEarly = blockedEarly || (series.chapters || []).some(c => c.status === 'blocked');
    res.json({ scrapedCount, blockedEarly });
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
        crawl.status = 'done';
        crawl.currentSeriesUrl = null;
        crawl.currentSeriesName = null;
        crawl.updatedAt = new Date().toISOString();
        writeDb(db);
        return;
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

    // Scrape every not-yet-downloaded chapter of this series, checking the
    // stop signal (cheap in-memory read) before every single chapter so a
    // stop request lands promptly even mid-series.
    const chaptersToScrape = series.chapters.filter(c => c.status !== 'done');
    let seriesBlocked = false;
    let seriesRetryAfterMs = null;
    for (let i = 0; i < chaptersToScrape.length; i++) {
      if (crawlControl[crawlId].stopRequested) {
        crawl.status = 'stopped';
        crawl.updatedAt = new Date().toISOString();
        writeDb(db);
        return;
      }
      if (i > 0) await sleep(computeNextDelayMs(null));

      const chapter = chaptersToScrape[i];
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

// Start Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  startScheduler();
  resumeRunningSiteCrawls();
});
