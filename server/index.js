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

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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
  logs: []
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
    if (err.name === 'AbortError') {
      errorMsg = 'Request timed out (10s)';
    } else {
      errorMsg = err.message || 'Connection failed';
    }
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

// Get website images
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
        'User-Agent': 'UptimeRobot/1.0 (Status Checker Bot)'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const html = await response.text();

    // Regex to extract all img src attributes
    const imgRegex = /<img\s+[^>]*src=["']([^"']+)["']/gi;
    const images = [];
    let match;

    while ((match = imgRegex.exec(html)) !== null) {
      const src = match[1].trim();
      if (!src) continue;
      
      // Ignore base64 data URIs as they might bloat the UI
      if (src.startsWith('data:')) continue;

      try {
        const absoluteUrl = new URL(src, monitor.url).href;
        images.push(absoluteUrl);
      } catch (e) {
        images.push(src);
      }
    }

    // Remove duplicates and limit to 10 images
    const uniqueImages = [...new Set(images)].slice(0, 10);
    res.json({ images: uniqueImages });
  } catch (error) {
    console.error(`Error scraping images from ${monitor.url}:`, error);
    res.status(500).json({ error: `Failed to scrape images: ${error.message}` });
  }
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
