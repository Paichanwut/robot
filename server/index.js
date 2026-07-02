import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
  saved: []
};

// Read Database
function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      writeDb(defaultDb);
      return defaultDb;
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading database, resetting to default:', error);
    return defaultDb;
  }
}

// Write Database
function writeDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing database:', error);
  }
}

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
    name: name.trim(),
    url: formattedUrl,
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

// Extracts, filters and type-classifies every image referenced by a page's HTML
// (both plain <img> tags and JS string-array image maps used by manga readers).
function extractImagesFromHtml(html, pageUrl) {
  const images = [];
  let match;

  // 1. Regex to extract standard img src attributes
  const imgRegex = /<img\s+[^>]*src=["']([^"']+)["']/gi;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1].trim();
    if (src && !src.startsWith('data:')) {
      try {
        images.push(new URL(src, pageUrl).href);
      } catch (e) {
        images.push(src);
      }
    }
  }

  // 2. Regex to extract JS image array maps (like "/img/backcat/...")
  // Captures strings in quotes that end with image extensions
  const jsImgRegex = /["']([^"'\s>]+\.(?:jpg|jpeg|png|webp|gif|svg))["']/gi;
  while ((match = jsImgRegex.exec(html)) !== null) {
    const src = match[1].trim();
    try {
      images.push(new URL(src, pageUrl).href);
    } catch (e) {
      images.push(src);
    }
  }

  // Filter out static site assets (icons, loaders, ads, etc.)
  const filteredImages = images.filter(url => {
    const lower = url.toLowerCase();
    // Ignore theme-specific assets unless they look like chapter files
    if (lower.includes('/static/') || lower.includes('/theme/') || lower.includes('/assets/')) {
      if (!lower.includes('chapter') && !lower.includes('ep0') && !lower.includes('ep-') && !lower.includes('backcat')) {
        return false;
      }
    }
    if (lower.includes('logo') || lower.includes('favicon') || lower.includes('icon') || lower.includes('avatar')) return false;
    if (lower.includes('ad-') || lower.includes('/ads/') || lower.includes('banner') || lower.includes('advertisement')) return false;
    if (lower.includes('play_w.png') || lower.includes('scroll-down.svg') || lower.includes('gamestore.gif')) return false;
    return true;
  });

  // Remove duplicates
  const uniqueImages = [...new Set(filteredImages)];
  return uniqueImages.map(url => ({ url, type: classifyImageType(url) }));
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
async function fetchTextOrNull(url, timeoutMs = 8000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
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

// Fetches one page's status (reusing the same rich error diagnosis as the
// uptime checker) plus every image found on it.
async function fetchPageDetails(pageUrl) {
  const startTime = performance.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const responseTime = Math.round(performance.now() - startTime);
    const statusCode = response.status;

    if (statusCode < 200 || statusCode >= 400) {
      return { url: pageUrl, status: 'down', statusCode, responseTime, error: `HTTP Error Code: ${statusCode}`, images: [] };
    }

    const html = await response.text();
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

      const detail = await fetchPageDetails(discovery.pages[i]);
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

// Heuristic classification of an image into ad / manga / content, based on its URL path.
// No image-recognition is available, so this is a best-effort keyword guess and can misclassify.
// Only the path+query is inspected (never the hostname) - otherwise a site whose own domain
// happens to contain a keyword (e.g. "go-manga.com") would tag every single image on it,
// ads included, as that type.
const MANGA_TYPE_KEYWORDS = ['chapter', 'backcat', 'manga', 'comic', 'toon'];
const MANGA_EPISODE_REGEX = /ep[-_]?\d/;
const AD_TYPE_KEYWORDS = [
  'ad-', '/ads/', 'banner', 'advertisement', 'promo', 'bonus', 'sponsor',
  'bet', 'ufa', 'casino', 'lsm', 'joker', 'slot', 'huay', 'lotto', 'crypto',
  'sa-game', 'sagame', 'sexy', 'gclub', 'baccarat', 'roulette', 'jackpot',
  'vip', 'deposit', 'withdraw', 'discord', 'facebook', 'fbcdn', 'cdninstagram',
  'twitter', 'line.me'
];

function classifyImageType(url) {
  let pathPortion = url;
  try {
    const parsed = new URL(url);
    pathPortion = parsed.pathname + parsed.search;
  } catch (e) {
    // Not an absolute URL - fall back to classifying the raw string.
  }
  const lower = pathPortion.toLowerCase();
  if (AD_TYPE_KEYWORDS.some(k => lower.includes(k))) return 'ad';
  if (MANGA_TYPE_KEYWORDS.some(k => lower.includes(k)) || MANGA_EPISODE_REGEX.test(lower)) return 'manga';
  return 'content';
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

// Start Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  startScheduler();
});
