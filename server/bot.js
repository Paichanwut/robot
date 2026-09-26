import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { Jimp, compareHashes } from 'jimp';
import { connect } from 'puppeteer-real-browser';
import { spawnSync } from 'child_process';
import { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths - only the SQLite DB, Chrome profile, and lock file live on local
// disk now; page/cover images go straight to R2 (see below), never touching
// disk here at all.
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// R2 (Cloudflare's S3-compatible object storage) - where every page/cover
// image is uploaded. Credentials come from the environment (see .env.example)
// rather than being hardcoded; run with `npm start` (loads .env if present)
// or export them in the shell yourself.
// ---------------------------------------------------------------------------

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'solo';

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  throw new Error(
    'Missing R2 credentials. Copy .env.example to .env and fill in R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY, ' +
    'or export them in the shell before running.'
  );
}

// The SDK's default NodeHttpHandler has NO timeout at all - a stalled TCP
// connection (network blip, R2 hiccup) hangs the in-flight r2.send() call
// forever with no error and no log line, wedging the whole crawl (it's
// single-threaded/sequential) until something outside the process notices.
// This happened - see git history. Bounding both the connect phase and the
// overall request turns that silent-forever hang into a normal rejection
// that uploadToR2/deleteR2Prefix's own retry loops already know how to handle.
//
// throwOnRequestTimeout is NOT optional here despite the misleading name -
// without it, requestTimeout does nothing but print a one-line warning and
// let the request keep hanging forever anyway (see
// @smithy/node-http-handler/dist-es/set-request-timeout.js: the timer only
// calls req.destroy()/reject() when this flag is set; otherwise it just
// logs). This was caught live - a container spent ~20 hours spewing
// "exceeded the configured 30000 ms requestTimeout" warnings with zero
// actual progress before this was set.
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  requestHandler: new NodeHttpHandler({ connectionTimeout: 10000, requestTimeout: 30000, throwOnRequestTimeout: true })
});

const R2_CONTENT_TYPE_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif'
};

const R2_UPLOAD_RETRIES = 3;

// Uploads one object with a few retries (short backoff) so a single flaky
// request doesn't cost a full chapter re-scrape - see scrapeChapterCoreAttempt,
// which still falls back to re-downloading from the source and retrying the
// whole chapter (up to MAX_CHAPTER_RETRIES) if every attempt here fails.
// Attached to every object as S3 "Custom Metadata" (x-amz-meta-* headers,
// separate from any EXIF/XMP baked into the file bytes - see
// stripWebpMetadata/stripSvgMetadata and optimizeMangaImage above for that)
// so every file in the bucket is unambiguously ours, not the source site's.
const R2_OBJECT_METADATA = {
  source: 'solo-manga.com',
  copyright: 'solo-manga.com',
  publisher: 'Solo Manga'
};

async function uploadToR2(key, buffer, ext) {
  const contentType = R2_CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream';
  let lastError;
  for (let attempt = 1; attempt <= R2_UPLOAD_RETRIES; attempt++) {
    try {
      await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType, Metadata: R2_OBJECT_METADATA }));
      return;
    } catch (err) {
      lastError = err;
      if (attempt < R2_UPLOAD_RETRIES) await sleep(500 * attempt);
    }
  }
  throw new Error(`R2 upload failed for ${key} after ${R2_UPLOAD_RETRIES} attempts: ${lastError.message}`);
}

async function r2ObjectExists(key) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (err) {
    return false;
  }
}

// Deletes every object under a prefix (R2 has no real directories - a
// chapter "folder" is just a shared key prefix) so a re-scrape that wipes
// and re-downloads a chapter doesn't leave yesterday's now-unwanted pages
// (e.g. a page count that shrank after ad-filtering changed) orphaned in
// the bucket.
async function deleteR2Prefix(prefix) {
  let continuationToken;
  do {
    const list = await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: continuationToken }));
    const objects = (list.Contents || []).map(o => ({ Key: o.Key }));
    if (objects.length > 0) {
      await r2.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: objects } }));
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}

// ---------------------------------------------------------------------------
// Website DB sync (MySQL) - a *separate* database from the bot's own SQLite
// tracking DB (server/data/app.db). Only "clean" public-facing fields are
// written here (title, cover, page images, ...) - never the bot's internal
// scrape-state (retryCount, dedup hashes, robots.txt state, chapter status
// pending/error/blocked, ...), which stays in SQLite only. See db/schema.mysql.sql.
// ---------------------------------------------------------------------------

const MYSQL_HOST = process.env.MYSQL_HOST;
const MYSQL_PORT = process.env.MYSQL_PORT || 3306;
const MYSQL_USER = process.env.MYSQL_USER;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD;
const MYSQL_DATABASE = process.env.MYSQL_DATABASE;

if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_PASSWORD || !MYSQL_DATABASE) {
  throw new Error(
    'Missing MySQL credentials. Copy .env.example to .env and fill in MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE, ' +
    'or export them in the shell before running.'
  );
}

const mysqlPool = mysql.createPool({
  host: MYSQL_HOST,
  port: Number(MYSQL_PORT),
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  connectionLimit: 5
});

// Turns a title into a URL-safe slug. Falls back to the bot's own series id
// when the title has no ASCII-alphanumeric content at all (an all-Thai
// title) - an empty/non-unique slug would otherwise violate the UNIQUE
// constraint on series.slug the moment a second such series showed up.
function slugify(text, fallback) {
  const slug = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function normalizeSeriesStatus(rawStatus) {
  const s = (rawStatus || '').toLowerCase();
  if (/completed|จบ/i.test(s)) return 'completed';
  if (/hiatus|พัก/i.test(s)) return 'hiatus';
  return 'ongoing';
}

// Canonicalizes a scraped story-format label ("Manhwa"/"Manhua"/"Manga"/
// "Novel") to consistent Title Case - different source sites render this
// badge's text with different CSS/casing conventions (e.g. some literally
// write "MANHWA" in the markup, others "Manhwa"), so series.type ended up
// inconsistently cased depending on which site a series was scraped from.
// Harmless for the is_published/type lookups in solo/api (MySQL's ci
// collation matches regardless of case) but confusing in the back office
// dropdown and inconsistent in the public API's story_type field. Unknown
// values are left as-is (trimmed) rather than dropped, in case a source
// site uses a real category this list hasn't seen yet.
const STORY_TYPE_CANONICAL = { manhwa: 'Manhwa', manhua: 'Manhua', manga: 'Manga', novel: 'Novel' };
function normalizeStoryType(rawType) {
  const trimmed = (rawType || '').trim();
  if (!trimmed) return null;
  return STORY_TYPE_CANONICAL[trimmed.toLowerCase()] || trimmed;
}

// Parses a human-formatted view count ("3.5M", "49,226", "12.3K") into a
// real integer for storage - source sites show this either as plain digits
// or abbreviated with a K/M/B suffix, and naively stripping non-digits
// would turn "3.5M" into "35", silently dropping the multiplier.
function parseHumanNumber(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/,/g, '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*([kmb])?/i.exec(cleaned);
  if (!match) return null;
  const n = parseFloat(match[1]);
  const suffix = (match[2] || '').toLowerCase();
  const multiplier = suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : suffix === 'b' ? 1e9 : 1;
  return Math.round(n * multiplier);
}

// "ep<NNNN>" chapter-slug suffix matching the convention seen on the source
// sites themselves (e.g. bully-manga.com/<series>-ep0148) - whole numbers
// are zero-padded to 4 digits; a fractional chapter (12.5, a "special")
// keeps its decimal as a dash instead (ep0012-5) since padStart on a
// decimal string would produce something nonsensical like "012.5".
function chapterSlugSuffix(number) {
  if (Number.isInteger(number)) return `ep${String(number).padStart(4, '0')}`;
  const [whole, frac] = String(number).split('.');
  return `ep${whole.padStart(4, '0')}-${frac}`;
}

const MYSQL_SYNC_RETRIES = 3;
const MYSQL_QUERY_TIMEOUT_MS = 20000;

// Runs `fn(conn)` with a fresh pooled connection, retrying a few times on
// failure (mirrors uploadToR2's posture) - a sync failure is logged and
// swallowed by the caller, not fatal to the scrape itself, since the image
// is already safely in R2 and the bot's own SQLite already has the chapter
// marked 'done' by the time this runs.
//
// Bounded with its own timeout because a mysql2 connection that goes dark
// mid-query (route to MYSQL_HOST breaks after the connection is already
// established) hangs the `await conn.execute(...)` forever with no error -
// same class of bug as the R2 client hanging with no request timeout (see
// NodeHttpHandler above). Left unbounded, one stuck query never releases
// its pool connection either, so repeated hangs quietly exhaust the whole
// 5-connection pool. A timed-out connection is destroyed rather than
// released back to the pool - its socket may still have a stale server
// response in flight, unsafe to hand to the next borrower.
async function withMysqlRetry(fn) {
  let lastError;
  for (let attempt = 1; attempt <= MYSQL_SYNC_RETRIES; attempt++) {
    const conn = await mysqlPool.getConnection();
    let timedOut = false;
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`mysql operation timed out after ${MYSQL_QUERY_TIMEOUT_MS}ms`));
      }, MYSQL_QUERY_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([fn(conn), timeoutPromise]);
      clearTimeout(timer);
      conn.release();
      return result;
    } catch (err) {
      clearTimeout(timer);
      if (timedOut) conn.destroy(); else conn.release();
      lastError = err;
      if (attempt < MYSQL_SYNC_RETRIES) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

// Upserts the series row + its genre links. Returns the MySQL row id (not
// the bot's own source_series_id) for use by syncChapterToWebsiteDb below.
async function syncSeriesToWebsiteDb(conn, series) {
  const meta = series.metadata || {};
  const title = meta.title || series.name;
  const slug = slugify(title, series.id);

  // Upserts by slug, not source_series_id - two different bot-tracked series
  // (from two different sites) that turn out to be the same manga end up
  // with the same slug (same title), and are meant to converge onto ONE
  // website series row (see backfillMissingChaptersFromSiblings). Matching
  // by source_series_id instead would create a second row per site and
  // then throw on the slug UNIQUE constraint the moment their titles
  // matched, since MySQL still enforces uniqueness on the OTHER column
  // even when the conflict is detected via a different one.
  //
  // is_edited/is_published are deliberately absent from both the column
  // list and ON DUPLICATE KEY UPDATE below - they're admin-only flags (see
  // db/schema.mysql.sql). Adding them here would reset an admin's
  // edit/publish decision every time this series re-syncs on a new chapter.
  //
  // Same reasoning extends to the editorial content columns themselves
  // (title/alt_titles/description/author/status/type): once an admin has
  // edited a series (is_edited=1), every later resync must leave THOSE
  // columns alone too, or the admin's rewritten synopsis/title gets quietly
  // clobbered back to whatever the bot originally scraped the next time a
  // new chapter comes in and triggers a sync. Guarded with IF(is_edited=0, ...)
  // rather than dropping them from the UPDATE entirely, since a
  // not-yet-edited series should still pick up fresher scrapes (e.g. the
  // source site correcting a typo) right up until an admin steps in.
  // rating/cover_image_key/source_view_count stay unconditional - they're
  // reference metrics from the source site, not editorial content.
  await conn.execute(
    `INSERT INTO series (source_series_id, slug, title, alt_titles, description, author, status, type, rating, cover_image_key, source_view_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       source_series_id = VALUES(source_series_id),
       title = IF(is_edited = 0, VALUES(title), title),
       alt_titles = IF(is_edited = 0, VALUES(alt_titles), alt_titles),
       description = IF(is_edited = 0, VALUES(description), description),
       author = IF(is_edited = 0, VALUES(author), author),
       status = IF(is_edited = 0, VALUES(status), status),
       type = IF(is_edited = 0, VALUES(type), type),
       rating = COALESCE(VALUES(rating), rating),
       cover_image_key = COALESCE(VALUES(cover_image_key), cover_image_key),
       source_view_count = COALESCE(VALUES(source_view_count), source_view_count)`,
    [
      series.id,
      slug,
      title,
      JSON.stringify(meta.altTitles || []),
      meta.synopsis || null,
      meta.author || meta.artist || null,
      normalizeSeriesStatus(meta.status),
      normalizeStoryType(meta.type),
      typeof meta.rating === 'number' ? meta.rating : (parseFloat(meta.rating) || null),
      meta.coverImagePath || null,
      parseHumanNumber(meta.views)
    ]
  );

  // Looked up by source_series_id, not the slug just computed above - slug
  // is deliberately left out of the UPDATE clause (URLs shouldn't churn), so
  // once a title correction (e.g. a decode fix) changes what slugify(title)
  // produces, that freshly-computed slug no longer matches the row's actual
  // (unchanged) stored slug and a slug-based lookup here would find nothing.
  // source_series_id, by contrast, IS set unconditionally in both the INSERT
  // and the UPDATE clause above to this exact series' id, so it always
  // identifies the row this call just touched - including the merge case
  // from the comment above, where the row's source_series_id ends up as
  // whichever series last synced into it.
  const [[row]] = await conn.execute('SELECT id FROM series WHERE source_series_id = ?', [series.id]);
  const seriesRowId = row.id;

  // Each entry is { name, slug, enName } from extractGenreLinks - name is
  // whatever the site displayed (often Thai), slug/enName are resolved
  // English identity (from the site's own href, or the GENRE_TH_TO_EN
  // glossary) when available. Plain strings (metadata cached in bot's own
  // SQLite before this shape existed - won't get the new shape again until
  // that series' page is re-fetched) are re-resolved against the glossary
  // right here too, not just at scrape time - otherwise a series that
  // hasn't been re-scraped keeps re-creating the same hash-slugged
  // duplicate every single sync, forever.
  const genreEntries = (meta.genres || []).map(g => {
    if (typeof g !== 'string') return g;
    const enName = GENRE_TH_TO_EN[g] || null;
    return { name: g, slug: enName ? slugify(enName, null) : null, enName };
  });
  await conn.execute('DELETE FROM series_genres WHERE series_id = ?', [seriesRowId]);
  for (const g of genreEntries) {
    const displayName = g.enName || g.name;
    // Only a genre with no resolved English identity at all falls back to a
    // transliterated slug - the one case left unmerged with its English/Thai
    // counterpart is a genre this scraper has never seen paired with an
    // English term anywhere (not in the glossary, no href on any site). Still
    // derived from the actual name (readable-ish) rather than an opaque hash
    // - a human can replace it with a real GENRE_TH_TO_EN entry once the
    // correct English term is known.
    const genreSlug = g.slug || slugify(transliterateThai(g.name), null) || slugify(g.name, `genre-${crypto.createHash('sha256').update(g.name).digest('hex').slice(0, 10)}`);
    const nameTh = /[฀-๿]/.test(g.name) && g.name !== displayName ? g.name : null;
    await conn.execute(
      'INSERT INTO genres (slug, name, name_th) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), name_th = COALESCE(VALUES(name_th), name_th)',
      [genreSlug, displayName, nameTh]
    );
    const [[genreRow]] = await conn.execute('SELECT id FROM genres WHERE slug = ?', [genreSlug]);
    await conn.execute('INSERT IGNORE INTO series_genres (series_id, genre_id) VALUES (?, ?)', [seriesRowId, genreRow.id]);
  }

  return seriesRowId;
}

// Upserts one chapter (by series_id+number, see UNIQUE KEY uniq_series_number
// in db/schema.mysql.sql) and fully replaces its page list - same
// wipe-then-reinsert posture as the R2 chapter folder above, so a re-scrape
// that drops a page (ad-filtering caught something new) doesn't leave a
// stale row behind.
async function syncChapterToWebsiteDb(seriesRowId, seriesSlug, chapterNumber, chapterTitle, images) {
  const chapterSlug = `${seriesSlug}-${chapterSlugSuffix(chapterNumber)}`;
  await withMysqlRetry(async (conn) => {
    await conn.execute(
      `INSERT INTO chapters (series_id, source_chapter_id, slug, number, title)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE source_chapter_id = VALUES(source_chapter_id), slug = VALUES(slug), title = VALUES(title)`,
      [seriesRowId, null, chapterSlug, chapterNumber, chapterTitle]
    );
    const [[chapterRow]] = await conn.execute(
      'SELECT id FROM chapters WHERE series_id = ? AND number = ?',
      [seriesRowId, chapterNumber]
    );
    const chapterRowId = chapterRow.id;

    await conn.execute('DELETE FROM chapter_pages WHERE chapter_id = ?', [chapterRowId]);
    if (images.length > 0) {
      const values = images.map(img => [chapterRowId, img.order, img.relativePath]);
      await conn.query('INSERT INTO chapter_pages (chapter_id, page_number, image_key) VALUES ?', [values]);
    }
  });
}

// Single entry point called once a chapter finishes downloading (status
// 'done') - upserts the series (with fresh metadata/cover/genres) and this
// chapter's pages. Best-effort: logs and returns on failure rather than
// throwing, so a MySQL hiccup never undoes work already safely in R2/SQLite.
async function syncChapterToWebsiteDbSafe(series, chapter) {
  try {
    const seriesSlug = slugify(series.metadata?.title || series.name, series.id);
    await withMysqlRetry(conn => syncSeriesToWebsiteDb(conn, series)).then(seriesRowId => {
      const chapterNumber = extractLeadingNumber(chapter.name) ?? (chapter.orderIndex ?? 0) + 1;
      return syncChapterToWebsiteDb(seriesRowId, seriesSlug, chapterNumber, chapter.name, chapter.images || []);
    });
  } catch (err) {
    console.error(`[sync-db] failed to sync chapter "${chapter.name}" of "${series.name}" to MySQL after retries:`, err.message);
  }
}

// Initial Database Structure
const defaultDb = {
  series: [],
  siteCrawls: []
};

// ---------------------------------------------------------------------------
// Persistence, two tiers:
//
//  1. "store" - one JSON blob row, exactly as before, for site-crawls state.
//     Small, never grows past a few MB, never showed a size or
//     write-contention problem - left alone.
//
//  2. Manga data (series/chapters/images) - real relational tables, not part
//     of the blob. This is the part that actually grows without bound (tens
//     of thousands of image rows) and the part where a write used to mean
//     "re-serialize and overwrite EVERYTHING, for every series, on every
//     single chapter/image saved" - the exact mechanism behind a real
//     incident where one process's write clobbered another's unrelated
//     change moments earlier just because both held a full-collection
//     snapshot. saveSeries(series) below writes only that one series' rows;
//     it can never touch another series' data no matter what else is
//     concurrently mutating it.
//
// Business logic is unchanged: findSeries()/discoverAndAddNewChapters()/
// scrapeChapterCore()/etc. still work on plain nested JS objects
// (`series.chapters.push(...)`, `chapter.status = 'done'`) exactly like
// before. readDb().series is just that same in-memory array, kept in sync
// with the tables through saveSeries()/deleteSeriesRow() instead of one
// blob-wide writeDb().
// ---------------------------------------------------------------------------

const SQLITE_FILE = path.join(DATA_DIR, 'app.db');
const sqliteDb = new Database(SQLITE_FILE);
sqliteDb.pragma('journal_mode = WAL');
sqliteDb.pragma('foreign_keys = ON');
sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS store (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS series (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    seriesUrl TEXT,
    useStealth INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    metadataFetchedAt TEXT,
    lastUpdateCheckAt TEXT,
    lastAutoRetryAt TEXT,
    autoRetryStreak INTEGER NOT NULL DEFAULT 0,
    metadataJson TEXT,
    sourceUrlsJson TEXT,
    dedupStateJson TEXT
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    seriesId TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    orderIndex INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    scrapedAt TEXT,
    retryCount INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_chapters_series ON chapters(seriesId);

  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapterId TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    orderIndex INTEGER NOT NULL,
    filename TEXT NOT NULL,
    relativePath TEXT NOT NULL,
    originalUrl TEXT,
    contentHash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_images_chapter ON images(chapterId);
  -- Used by the low-image-count cross-check below (finds whether a page
  -- image already exists under a different chapter, system-wide) - without
  -- this, that lookup would full-scan the whole images table.
  CREATE INDEX IF NOT EXISTS idx_images_contenthash ON images(contentHash);
`);
const selectStoreStmt = sqliteDb.prepare('SELECT data FROM store WHERE id = 1');
const upsertStoreStmt = sqliteDb.prepare(`
  INSERT INTO store (id, data) VALUES (1, ?)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data
`);

// In-memory copy of the non-series app state - readDb() just returns this
// reference (with a fresh `series` array attached); writeDb() replaces it
// and persists to SQLite. Series data itself lives in seriesCache below.
let dbCache = null;

function loadDbFromDisk() {
  const row = selectStoreStmt.get();
  if (row) {
    try {
      const data = JSON.parse(row.data);
      delete data.series; // now lives in the series/chapters/images tables
      return data;
    } catch (error) {
      // The DB itself is corrupt, not just a stale snapshot of it - this
      // should be effectively impossible with SQLite's atomic writes, so
      // fail loudly instead of silently discarding whatever is left.
      throw new Error(`SQLite store contains invalid JSON, refusing to silently wipe data: ${error.message}`);
    }
  }

  // First run against this SQLite file - migrate the legacy db.json in if
  // it's there, otherwise start fresh. Legacy `series` (if any) is
  // intentionally NOT migrated into the new tables - manga data starts
  // clean under the new schema; re-run discover/check-updates per series
  // to repopulate it.
  if (fs.existsSync(DB_FILE)) {
    console.log('Migrating existing db.json into SQLite storage (series left out - starts fresh under the new schema)...');
    const legacyData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    delete legacyData.series;
    upsertStoreStmt.run(JSON.stringify(legacyData));
    return legacyData;
  }

  const initial = JSON.parse(JSON.stringify(defaultDb));
  delete initial.series;
  upsertStoreStmt.run(JSON.stringify(initial));
  return initial;
}

// --- Series/chapters/images repository -------------------------------------

const selectSeriesRowsStmt = sqliteDb.prepare('SELECT * FROM series ORDER BY createdAt');
const selectAllChaptersStmt = sqliteDb.prepare('SELECT * FROM chapters ORDER BY seriesId, orderIndex');
const selectAllImagesStmt = sqliteDb.prepare('SELECT * FROM images ORDER BY chapterId, orderIndex');
const deleteSeriesStmt = sqliteDb.prepare('DELETE FROM series WHERE id = ?');
const deleteChaptersForSeriesStmt = sqliteDb.prepare('DELETE FROM chapters WHERE seriesId = ?');
const upsertSeriesStmt = sqliteDb.prepare(`
  INSERT INTO series (id, name, seriesUrl, useStealth, createdAt, metadataFetchedAt, lastUpdateCheckAt, lastAutoRetryAt, autoRetryStreak, metadataJson, sourceUrlsJson, dedupStateJson)
  VALUES (@id, @name, @seriesUrl, @useStealth, @createdAt, @metadataFetchedAt, @lastUpdateCheckAt, @lastAutoRetryAt, @autoRetryStreak, @metadataJson, @sourceUrlsJson, @dedupStateJson)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, seriesUrl = excluded.seriesUrl, useStealth = excluded.useStealth,
    metadataFetchedAt = excluded.metadataFetchedAt, lastUpdateCheckAt = excluded.lastUpdateCheckAt,
    lastAutoRetryAt = excluded.lastAutoRetryAt, autoRetryStreak = excluded.autoRetryStreak,
    metadataJson = excluded.metadataJson, sourceUrlsJson = excluded.sourceUrlsJson, dedupStateJson = excluded.dedupStateJson
`);
const insertChapterStmt = sqliteDb.prepare(`
  INSERT INTO chapters (id, seriesId, orderIndex, name, url, status, error, scrapedAt, retryCount)
  VALUES (@id, @seriesId, @orderIndex, @name, @url, @status, @error, @scrapedAt, @retryCount)
`);
const insertImageStmt = sqliteDb.prepare(`
  INSERT INTO images (chapterId, orderIndex, filename, relativePath, originalUrl, contentHash)
  VALUES (@chapterId, @orderIndex, @filename, @relativePath, @originalUrl, @contentHash)
`);
// Used only by the low-image-count safety net in scrapeChapterCoreAttempt -
// finds another chapter (any series) that already has this exact image
// content saved, system-wide (not just within the current series' own
// in-memory dedup bookkeeping).
const findOtherChapterWithHashStmt = sqliteDb.prepare(
  'SELECT chapterId FROM images WHERE contentHash = ? AND chapterId != ? LIMIT 1'
);

// Dedup-bookkeeping maps the scraper keeps per series (seenAssetUrls,
// seenAssetHashes, sharedAssetUrls, sharedAssetHashes, assetPHashLog) are
// scraper-internal indexes, never queried relationally - kept as one JSON
// blob column on the series row rather than their own tables.
const DEDUP_STATE_FIELDS = ['seenAssetUrls', 'seenAssetHashes', 'sharedAssetUrls', 'sharedAssetHashes', 'assetPHashLog'];
// Bumped whenever a change to the dedup logic above can make OLD blacklist
// entries wrong (e.g. the threshold=2->3 change here: entries added under
// the old logic were blacklisted off a single repeat and may be false
// positives under the new one). runDedupSchemaMigration() below compares
// each series' saved version against this at every startup and, if it's
// behind, wipes just the derived blacklists (sharedAssetUrls/Hashes,
// assetPHashLog) so they rebuild from scratch under the current logic -
// no manual `reset-dedup` needed for a logic-change rollout like this one.
const DEDUP_SCHEMA_VERSION = 2;

// Loads every series, chapter, and image with exactly 3 queries total
// (not N+1 per series/chapter) and assembles the same nested shape the rest
// of the codebase already expects: series.chapters[i].images[j].
function buildSeriesTree() {
  const seriesRows = selectSeriesRowsStmt.all();
  const chapterRows = selectAllChaptersStmt.all();
  const imageRows = selectAllImagesStmt.all();

  const imagesByChapter = new Map();
  imageRows.forEach(img => {
    if (!imagesByChapter.has(img.chapterId)) imagesByChapter.set(img.chapterId, []);
    imagesByChapter.get(img.chapterId).push({
      order: img.orderIndex,
      filename: img.filename,
      relativePath: img.relativePath,
      originalUrl: img.originalUrl,
      contentHash: img.contentHash
    });
  });

  const chaptersBySeries = new Map();
  chapterRows.forEach(ch => {
    if (!chaptersBySeries.has(ch.seriesId)) chaptersBySeries.set(ch.seriesId, []);
    chaptersBySeries.get(ch.seriesId).push({
      id: ch.id,
      name: ch.name,
      url: ch.url,
      status: ch.status,
      error: ch.error,
      scrapedAt: ch.scrapedAt,
      retryCount: ch.retryCount || 0,
      images: imagesByChapter.get(ch.id) || []
    });
  });

  return seriesRows.map(row => {
    const metadata = row.metadataJson ? JSON.parse(row.metadataJson) : null;
    const sourceUrls = row.sourceUrlsJson ? JSON.parse(row.sourceUrlsJson) : [];
    const dedupState = row.dedupStateJson ? JSON.parse(row.dedupStateJson) : {};

    const series = {
      id: row.id,
      name: row.name,
      seriesUrl: row.seriesUrl,
      useStealth: !!row.useStealth,
      createdAt: row.createdAt,
      metadataFetchedAt: row.metadataFetchedAt,
      lastUpdateCheckAt: row.lastUpdateCheckAt,
      lastAutoRetryAt: row.lastAutoRetryAt,
      autoRetryStreak: row.autoRetryStreak || 0,
      metadata,
      sourceUrls,
      chapters: chaptersBySeries.get(row.id) || []
    };
    DEDUP_STATE_FIELDS.forEach(field => {
      series[field] = dedupState[field] ?? (field === 'seenAssetUrls' || field === 'seenAssetHashes' ? {} : []);
    });
    // Missing entirely = data written before this versioning existed = version 1.
    series.dedupSchemaVersion = dedupState.dedupSchemaVersion || 1;
    return series;
  });
}

// In-memory copy of series/chapters/images, same role dbCache plays for the
// rest of the app state: business logic reads/mutates this array directly;
// saveSeries()/deleteSeriesRow() below are the only things that touch SQL.
let seriesCache = [];

// Persists exactly one series (and only that one) - upserts its row, then
// fully replaces its chapters+images (delete-then-reinsert is simplest and
// correct; even a 900-chapter series is a sub-millisecond transaction, and
// it never touches any OTHER series' rows no matter what else wrote
// concurrently). Call this instead of writeDb() after mutating a series.
const saveSeriesTxn = sqliteDb.transaction((series) => {
  const dedupState = {};
  DEDUP_STATE_FIELDS.forEach(field => { dedupState[field] = series[field]; });
  dedupState.dedupSchemaVersion = series.dedupSchemaVersion || DEDUP_SCHEMA_VERSION;

  upsertSeriesStmt.run({
    id: series.id,
    name: series.name,
    seriesUrl: series.seriesUrl || null,
    useStealth: series.useStealth ? 1 : 0,
    createdAt: series.createdAt,
    metadataFetchedAt: series.metadataFetchedAt || null,
    lastUpdateCheckAt: series.lastUpdateCheckAt || null,
    lastAutoRetryAt: series.lastAutoRetryAt || null,
    autoRetryStreak: series.autoRetryStreak || 0,
    metadataJson: series.metadata ? JSON.stringify(series.metadata) : null,
    sourceUrlsJson: JSON.stringify(series.sourceUrls || []),
    dedupStateJson: JSON.stringify(dedupState)
  });

  deleteChaptersForSeriesStmt.run(series.id); // cascades to this series' images via FK

  (series.chapters || []).forEach((chapter, index) => {
    insertChapterStmt.run({
      id: chapter.id,
      seriesId: series.id,
      orderIndex: index,
      name: chapter.name,
      url: chapter.url,
      status: chapter.status || 'pending',
      error: chapter.error || null,
      scrapedAt: chapter.scrapedAt || null,
      retryCount: chapter.retryCount || 0
    });
    (chapter.images || []).forEach((img, imgIndex) => {
      insertImageStmt.run({
        chapterId: chapter.id,
        orderIndex: img.order ?? imgIndex,
        filename: img.filename,
        relativePath: img.relativePath,
        originalUrl: img.originalUrl || null,
        contentHash: img.contentHash || null
      });
    });
  });
});

function saveSeries(series) {
  saveSeriesTxn(series);
  const idx = seriesCache.findIndex(s => s.id === series.id);
  if (idx >= 0) seriesCache[idx] = series;
  else seriesCache.push(series);
}

function deleteSeriesRow(id) {
  deleteSeriesStmt.run(id); // cascades to this series' chapters + images
  seriesCache = seriesCache.filter(s => s.id !== id);
}

// Updates only the series row itself (metadata, dedup-state bookkeeping,
// timestamps, retry streak) - never touches its chapters/images. Use this
// instead of saveSeries() whenever chapters weren't structurally added,
// removed, or reordered, so a large series' scrape doesn't pay to
// delete-and-reinsert everything just to persist one small field.
const updateSeriesRowStmt = sqliteDb.prepare(`
  UPDATE series SET
    name=@name, seriesUrl=@seriesUrl, useStealth=@useStealth,
    metadataFetchedAt=@metadataFetchedAt, lastUpdateCheckAt=@lastUpdateCheckAt,
    lastAutoRetryAt=@lastAutoRetryAt, autoRetryStreak=@autoRetryStreak,
    metadataJson=@metadataJson, sourceUrlsJson=@sourceUrlsJson, dedupStateJson=@dedupStateJson
  WHERE id=@id
`);

function saveSeriesMetadata(series) {
  const dedupState = {};
  DEDUP_STATE_FIELDS.forEach(field => { dedupState[field] = series[field]; });
  dedupState.dedupSchemaVersion = series.dedupSchemaVersion || DEDUP_SCHEMA_VERSION;

  updateSeriesRowStmt.run({
    id: series.id,
    name: series.name,
    seriesUrl: series.seriesUrl || null,
    useStealth: series.useStealth ? 1 : 0,
    metadataFetchedAt: series.metadataFetchedAt || null,
    lastUpdateCheckAt: series.lastUpdateCheckAt || null,
    lastAutoRetryAt: series.lastAutoRetryAt || null,
    autoRetryStreak: series.autoRetryStreak || 0,
    metadataJson: series.metadata ? JSON.stringify(series.metadata) : null,
    sourceUrlsJson: JSON.stringify(series.sourceUrls || []),
    dedupStateJson: JSON.stringify(dedupState)
  });
}

// Updates one chapter's own fields plus its images - never touches sibling
// chapters. This is what a per-chapter scrape status transition should call:
// re-syncing the WHOLE series (all its other chapters/images) just because
// one chapter went pending -> scraping -> done would make a large series
// (hundreds of chapters, thousands of images) expensive to scrape one
// chapter at a time.
const updateChapterRowStmt = sqliteDb.prepare(`
  UPDATE chapters SET status=@status, error=@error, scrapedAt=@scrapedAt, retryCount=@retryCount
  WHERE id=@id
`);
const deleteImagesForChapterStmt = sqliteDb.prepare('DELETE FROM images WHERE chapterId = ?');

const updateChapterTxn = sqliteDb.transaction((chapter) => {
  updateChapterRowStmt.run({
    id: chapter.id,
    status: chapter.status || 'pending',
    error: chapter.error || null,
    scrapedAt: chapter.scrapedAt || null,
    retryCount: chapter.retryCount || 0
  });
  deleteImagesForChapterStmt.run(chapter.id);
  (chapter.images || []).forEach((img, imgIndex) => {
    insertImageStmt.run({
      chapterId: chapter.id,
      orderIndex: img.order ?? imgIndex,
      filename: img.filename,
      relativePath: img.relativePath,
      originalUrl: img.originalUrl || null,
      contentHash: img.contentHash || null
    });
  });
});

function updateChapter(chapter) {
  updateChapterTxn(chapter);
}

// Read Database - series is always the live in-memory array (seriesCache);
// everything else comes from the blob-backed dbCache.
function readDb() {
  dbCache.series = seriesCache;
  return dbCache;
}

// Write Database - persists the non-series app state (siteCrawls) to the
// blob. Series changes must go through saveSeries()/deleteSeriesRow()
// instead - see the migration note above.
function writeDb(data) {
  dbCache = data;
  try {
    const { series, ...withoutSeries } = data;
    upsertStoreStmt.run(JSON.stringify(withoutSeries));
  } catch (error) {
    console.error('Error writing database:', error);
  }
}

// Runs once at every process startup, before anything scrapes. For any
// series whose saved dedup state predates DEDUP_SCHEMA_VERSION, wipes the
// DERIVED blacklists (sharedAssetUrls/Hashes, assetPHashLog) - built under
// whatever the old logic was and possibly wrong under the current one - so
// they rebuild from a clean slate. seenAssetUrls/seenAssetHashes (the raw
// per-chapter sighting log) are left alone; scrapeChapterCoreAttempt already
// normalizes their old string-shaped entries to {lastChapterId, count} on
// first use. This makes a dedup-logic change like the threshold=2->3 one
// self-healing on next deploy - no manual `reset-dedup` run required.
//
// A chapter that hit either of these two errors (URL-based filter emptied
// the page, or hash/pHash-based filter emptied it after download) is
// exactly the failure mode this migration exists to undo - false-positive
// shared-asset filtering under the old logic. Match on the error text (not
// just status:'error') so chapters that failed for an unrelated reason
// keep their retry count.
const SHARED_ASSET_ERROR_TEXTS = [
  'ถูกกรองว่าเป็นโฆษณาหรือรูปที่ใช้ซ้ำทั้งเว็บ',
  'ทุกรูปในหน้านี้ถูกกรองว่าเป็นรูปโฆษณา/เครดิตที่ใช้ซ้ำ'
];

function runDedupSchemaMigration() {
  let migratedSeries = 0;
  let unstuckChapters = 0;
  seriesCache.forEach(series => {
    if ((series.dedupSchemaVersion || 1) >= DEDUP_SCHEMA_VERSION) return;
    series.sharedAssetUrls = [];
    series.sharedAssetHashes = [];
    series.assetPHashLog = [];
    series.dedupSchemaVersion = DEDUP_SCHEMA_VERSION;
    saveSeriesMetadata(series);
    migratedSeries++;

    // These chapters exhausted MAX_CHAPTER_RETRIES against a blacklist that
    // just got wiped above, so the normal retry pass (which skips anything
    // at/over the retry cap) would otherwise never touch them again -
    // resetting retryCount here is what actually lets them re-scrape.
    (series.chapters || []).forEach(chapter => {
      if (chapter.status === 'error' && SHARED_ASSET_ERROR_TEXTS.some(text => chapter.error?.includes(text)) && (chapter.retryCount || 0) > 0) {
        chapter.retryCount = 0;
        updateChapter(chapter);
        unstuckChapters++;
      }
    });
  });
  if (migratedSeries > 0) {
    console.log(`[dedup-migration] reset shared-asset blacklist for ${migratedSeries} series, unstuck ${unstuckChapters} chapter(s) for retry (schema v${DEDUP_SCHEMA_VERSION})`);
  }
}

dbCache = loadDbFromDisk();
seriesCache = buildSeriesTree();
runDedupSchemaMigration();

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
    if (AD_TOKEN_REGEX.test(lower) || lower.includes('banner') || lower.includes('advertisement')) return false;
    if (lower.includes('play_w.png') || lower.includes('scroll-down.svg') || lower.includes('gamestore.gif')) return false;
    // Generic UI-chrome graphics (a lightbox "close" button, "next/prev"
    // arrows, loading spinners, ...) sometimes ship as their own file with
    // no other ad/theme signal - match on the filename itself.
    if (UI_ICON_BASENAME_REGEX.test(lower)) return false;
    // Lazy-load placeholder graphics (a blank/spinner shown before the real
    // data-src swaps in) - a page with no data-* lazy attribute at all and
    // just one of these as `src` means the real URL is injected by JS this
    // scraper can't run, not that this placeholder is actual page art.
    if (/\/(blank|placeholder|loading|lazy|spinner|transparent|1x1|pixel|readerarea)\.(png|gif|svg|jpe?g|webp)(\?|$)/i.test(lower)) return false;
    return true;
  });

  return filtered.map(([url, alt]) => ({ url, type: classifyImageType(url, alt) }));
}

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
    // --disable-dev-shm-usage: makes Chrome use /tmp instead of /dev/shm for
    // its shared memory - Docker's default 64MB /dev/shm is too small for a
    // real (non-headless) Chrome and causes exactly the renderer
    // hangs/crashes behind the "navigation didn't settle" warnings seen in
    // production. Paired with shm_size: '1gb' in docker-compose.yml (the
    // faster fix when available); this flag is the fallback for any host
    // that doesn't let us raise shm_size.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'],
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
// Without releaseLock() here, a `docker stop` (SIGTERM) always leaves a
// stale lock file behind - the next run then has to sit through the full
// LOCK_STALE_MS wait (or someone has to delete it by hand) before it's
// allowed to steal it, even though the previous holder is provably gone.
process.on('SIGINT', () => { shutdownBrowser(); releaseLock(); process.exit(); });
process.on('SIGTERM', () => { shutdownBrowser(); releaseLock(); process.exit(); });

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

    // Some manga-reader themes (confirmed on go-manga.com/up-manga.com's
    // shared "mangareader" WordPress theme) render the actual page <img>
    // tags into #readerarea via client-side JS AFTER domcontentloaded - the
    // element exists in the server HTML but starts empty, so reading the
    // DOM immediately (as above) captures it before the real images ever
    // appear. Worse, the theme's own JS re-renders #readerarea's contents
    // in what looks like batches/passes - a single "wait for any children"
    // check can resolve right as a re-render briefly empties or partially
    // fills it, capturing far fewer real (data-src-bearing) images than the
    // chapter actually has. Poll instead: keep checking the count of
    // images with a real data-src until it stops growing across two checks
    // in a row (settled), not just the first non-empty sighting. No-op
    // (loop just idles out) on any page without this element at all.
    const hasReaderArea = await page.$('#readerarea').then(Boolean).catch(() => false);
    if (hasReaderArea) {
      let lastCount = -1;
      for (let i = 0; i < 12; i++) {
        const count = await page.$$eval('#readerarea img[data-src]', els => els.length).catch(() => 0);
        if (count > 0 && count === lastCount) break;
        lastCount = count;
        await new Promise(r => setTimeout(r, 500));
      }
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

async function fetchTextOrNull(url, timeoutMs = 8000, useStealth = false, forceFullRender = false) {
  try {
    if (useStealth) {
      // "solve once, fetch many": try a browser-less fetch with the clearance
      // we already earned for this host first - the vast majority of requests
      // go through here and never open Chrome. Only when there's no clearance
      // yet, or it's expired (challenge came back), do we spin up the real
      // browser to (re)solve, which refreshes the cookie/UA for next time.
      //
      // forceFullRender skips this shortcut entirely - a plain cookie-replay
      // fetch never executes JS, so a page whose real content is injected
      // client-side (a chapter reader that populates #readerarea after load,
      // not a Cloudflare challenge at all - see fetchTextWithPuppeteer) would
      // otherwise silently come back looking "successful" but empty, forever,
      // once this host's clearance cookie is cached from any earlier request.
      if (!forceFullRender) {
        const viaCookie = await fetchWithClearanceOrNull(url, timeoutMs + 5000);
        if (viaCookie) return viaCookie;
      }
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
// Error codes worth retrying automatically - a blip at the network/DNS
// layer, not a real property of the target (a domain that genuinely
// doesn't exist, or a bad TLS cert, will fail identically on retry, so
// those are excluded and left to error out immediately as before).
const TRANSIENT_NETWORK_ERROR_CODES = new Set(['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

// A container's DNS resolver can go temporarily unresponsive under load
// (EAI_AGAIN) for a few seconds - seen in production causing a burst of
// otherwise-healthy chapters to error out together. Retry a couple of
// times with a short backoff before giving up, so one resolver hiccup
// doesn't cost this chapter a whole retry-budget slot.
async function fetchPageDetails(pageUrl, useStealth = false, attempt = 1) {
  const result = await fetchPageDetailsOnce(pageUrl, useStealth);
  if (result.status === 'down' && attempt < 3) {
    const code = result.errorCode;
    if (code && TRANSIENT_NETWORK_ERROR_CODES.has(code)) {
      console.warn(`[fetch] ${pageUrl}: transient network error (${code}), retrying (${attempt}/2)...`);
      await sleep(2000 * attempt);
      return fetchPageDetails(pageUrl, useStealth, attempt + 1);
    }
  }
  delete result.errorCode;
  return result;
}

async function fetchPageDetailsOnce(pageUrl, useStealth = false) {
  const startTime = performance.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    let html;
    let statusCode;
    if (useStealth) {
        // forceFullRender: true - this is a chapter's own page, whose real
        // content some reader themes (see fetchTextWithPuppeteer) inject via
        // client-side JS rather than serving in the initial HTML. A
        // cookie-replay fetch can't run that JS, so it must always go
        // through the real browser here, not just when Cloudflare is
        // involved - a plain fetch (or a JS-blind "clearance" replay) is
        // exactly what returned HTTP 403 on dark-manga, or a silently empty
        // reader area on go-manga/up-manga.
        html = await fetchTextOrNull(pageUrl, 15000, true, true);
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
    return { url: pageUrl, status: 'down', statusCode: null, responseTime, error: describeCheckError(err), errorCode: err.cause?.code || null, images: [] };
  }
}

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
// A bare substring check for "ad-" (still used further down for '/ads/') is
// too broad on its own - real manga titles/filenames routinely contain "ad"
// immediately before a hyphenated word boundary (e.g. "Bad-Born-Blood",
// "Dead-End", "Load-Out"), which would misclassify every page of those
// series as an ad. Require "ad"/"ads" to be its own path/word segment
// (bounded by /, _, ., -, or the string edges) instead of a raw substring.
const AD_TOKEN_REGEX = /(?:^|[/_.-])ads?(?:[/_.-]|$)/i;
const AD_TYPE_KEYWORDS = [
  '/ads/', 'banner', 'advertisement', 'promo', 'bonus', 'sponsor',
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
  if (AD_TOKEN_REGEX.test(combined) || AD_TYPE_KEYWORDS.some(k => combined.includes(k.toLowerCase()))) return 'ad';
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

// Decodes HTML entities that show up in scraped text nodes (titles, table
// cells, meta descriptions). Handles the common named entities directly,
// PLUS every numeric (&#8217;) and hex (&#x2019;) entity generically - a
// WordPress title's smart quotes/dashes (&#8216; &#8217; &#8220; &#8221;
// &#8211; &#8212; ...) come through as numeric entities, and a fixed list
// of named-only replacements (the previous version of this function) left
// those completely undecoded in the stored title. &amp; is decoded LAST -
// decoding it first would turn a deliberately double-escaped literal (a
// source using `&amp;lt;` to display the literal text "&lt;") into `<`
// instead of leaving the intended literal text alone.
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/gi, '&');
}

function stripTags(html) {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Hand-built Thai -> canonical-English-slug glossary for genre/tag terms
// this scraper has actually seen paired with an English equivalent across
// the tracked sites so far (either directly, when one series lists both the
// English and Thai term for the same genre, or via a source site's own
// href-encoded slug - see extractGenreLinks). Used only as a last resort
// when a genre link carries no href-derived slug of its own - keeps a Thai
// tag from becoming a second, disconnected row from its English counterpart
// (e.g. "แฟนตาซี" landing on a different genre row than "Fantasy").
const GENRE_TH_TO_EN = {
  'ดราม่า': 'Drama', 'ผจญภัย': 'Adventure', 'แฟนตาซี': 'Fantasy', 'ต่างโลก': 'Isekai',
  'มังงะเกาหลี': 'Manhwa', 'มังงะจีน': 'Manhua', 'ตลก': 'Comedy', 'โรแมนซ์': 'Romance',
  'โชโจ': 'Shoujo', 'โชเน็น': 'Shounen', 'ลึกลับ': 'Mystery', 'เกิดใหม่': 'Reincarnation',
  'ชีวิตประจำวัน': 'Slice of Life', 'จิตวิทยา': 'Psychological', 'เหนือธรรมชาติ': 'Supernatural',
  'ต่อสู้': 'Action', 'สยองขวัญ': 'Horror', 'ผู้ใหญ่': 'Adult', 'ฮาเร็ม': 'Harem',
  'เวทมนตร์': 'Magic', 'ล้างแค้น': 'Revenge', 'ไซไฟ': 'Sci-fi', 'โศกนาฏกรรม': 'Tragedy',
  'ระบบ': 'System', 'ดันเจี้ยน': 'Dungeon', 'ย้อนยุค': 'Historical', 'ย้อนเวลา': 'Time Travel',
  'ศิลปะการต่อสู้-แอคชั่น': 'Martial Arts'
};

// Rough Thai -> Latin letter-for-letter transliteration, used only as a slug
// source for a genre/tag with no English name anywhere (not in
// GENRE_TH_TO_EN, no href on any site that's carried it) - not a proper
// romanization (real Thai transliteration reorders vowels around the
// consonant they attach to, which this doesn't attempt), just enough to
// turn e.g. "พระเอกเทพ" into a readable-ish "phraexkethph" slug instead of
// an opaque content hash. A human can still add a real GENRE_TH_TO_EN entry
// later to replace it with the actual English term once one is known.
const THAI_TRANSLITERATION_MAP = {
  'ก': 'k', 'ข': 'kh', 'ฃ': 'kh', 'ค': 'kh', 'ฅ': 'kh', 'ฆ': 'kh', 'ง': 'ng',
  'จ': 'ch', 'ฉ': 'ch', 'ช': 'ch', 'ซ': 's', 'ฌ': 'ch', 'ญ': 'y',
  'ฎ': 'd', 'ฏ': 't', 'ฐ': 'th', 'ฑ': 'th', 'ฒ': 'th', 'ณ': 'n',
  'ด': 'd', 'ต': 't', 'ถ': 'th', 'ท': 'th', 'ธ': 'th', 'น': 'n',
  'บ': 'b', 'ป': 'p', 'ผ': 'ph', 'ฝ': 'f', 'พ': 'ph', 'ฟ': 'f', 'ภ': 'ph', 'ม': 'm',
  'ย': 'y', 'ร': 'r', 'ฤ': 'rue', 'ล': 'l', 'ฦ': 'lue', 'ว': 'w',
  'ศ': 's', 'ษ': 's', 'ส': 's', 'ห': 'h', 'ฬ': 'l', 'อ': '', 'ฮ': 'h',
  'ะ': 'a', 'ั': 'a', 'า': 'a', 'ำ': 'am', 'ิ': 'i', 'ี': 'i', 'ึ': 'ue', 'ื': 'ue',
  'ุ': 'u', 'ู': 'u', 'เ': 'e', 'แ': 'ae', 'โ': 'o', 'ใ': 'ai', 'ไ': 'ai',
  '่': '', '้': '', '๊': '', '๋': '', '์': '', 'ๅ': '', 'ฯ': '', 'ๆ': ''
};

function transliterateThai(text) {
  return (text || '').split('').map(ch => THAI_TRANSLITERATION_MAP[ch] ?? ch).join('');
}

// Extracts every genre <a> tag matching optional className, returning
// { name, slug } pairs. Prefers the source site's own href for the slug
// (the last URL path segment, e.g. href="/genres/Isekai" -> slug "isekai")
// over inventing one, since that's the site's own canonical English term
// for the genre even when the link's visible text is shown in Thai - see
// bully-manga.com/genres/Supernatural for a tag whose link text is
// "เหนือธรรมชาติ" but whose href already says "Supernatural". Falls back to
// the GENRE_TH_TO_EN glossary, then leaves slug unset (resolved later, at
// sync time, via a content hash) when neither is available.
function extractGenreLinks(html, className) {
  const pattern = className
    ? new RegExp(`<a[^>]*class=["'][^"']*${className}[^"']*["'][^>]*href=["']([^"']*)["'][^>]*>([\\s\\S]*?)<\\/a>`, 'gi')
    : /<a[^>]*href=["']([^"']*)["'][^>]*>([^<]+)<\/a>/gi;
  const results = [];
  let m;
  while ((m = pattern.exec(html)) !== null) {
    const name = decodeHtmlEntities(stripTags(m[2]));
    if (!name) continue;
    let slug = null;
    let enName = null;
    try {
      const segments = new URL(m[1], 'http://x').pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last && /[a-z]/i.test(last)) {
        enName = decodeURIComponent(last).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        slug = slugify(decodeURIComponent(last), null);
      }
    } catch (e) { /* not a usable URL - fall through to the glossary/hash below */ }
    if (!slug && GENRE_TH_TO_EN[name]) {
      enName = GENRE_TH_TO_EN[name];
      slug = slugify(enName, null);
    }
    results.push({ name, slug, enName });
  }
  return results;
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
    const genres = extractGenreLinks(genreBlockMatch[1]);
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
      // views is often rendered by a client-side view-counter plugin that
      // leaves a placeholder glyph ("?", a loading icon, ...) in the
      // server-rendered HTML this scraper actually sees - only keep it when
      // it's recognizably a number (plain digits, or "3.5M"/"12K" style).
      if (mapped[1] === 'views') {
        if (/\d/.test(value)) meta.views = value;
        continue;
      }
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
    // Keep the raw "3.5M"/"49,226" text as-is (not digits-only) - stripping
    // everything but digits would turn "3.5M" into "35", silently losing the
    // thousand/million multiplier. parseHumanNumber (used at sync time)
    // handles the K/M suffix properly.
    if (m) { const v = stripTags(m[1]); if (/\d/.test(v)) meta.views = v; }
  }
  if (!meta.type) {
    const m = /<span[^>]*class=["'][^"']*sh-badge-type[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
    if (m) meta.type = normalizeStoryType(stripTags(m[1]));
  }
  if (!meta.status) {
    const m = /<span[^>]*class=["'][^"']*sh-badge-status[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
    if (m) meta.status = stripTags(m[1]);
  }
  if (!meta.genres) {
    const shGenres = extractGenreLinks(html, 'sh-genre');
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

// Some WordPress manga-theme sites (go-manga.com and likely its siblings on
// the same theme - up-manga.com, dark-manga.com) render the real page-view
// count via a client-side AJAX call that fires *after* page load - the
// server-rendered HTML this scraper actually fetches only ever has a "?"
// placeholder in <span class="ts-views-count">?</span>, so no amount of
// regex-tweaking on that HTML will ever find a real number there.
//
// The theme's own function.js does this instead (found by reading it):
//   POST {origin}/wp-admin/admin-ajax.php
//   body: action=dynamic_view_ajax&post_id=<id>
//   -> { "views": "2.1M", ... }
// <id> is the WordPress post id, already sitting in the page's own HTML as
// `ts_dynamic_ajax_view(<id>)` - so this replicates that one AJAX call
// directly over plain HTTP, no real browser needed, and gets the actual
// number instead of the placeholder.
async function fetchDynamicViewCount(pageUrl, html) {
  const idMatch = /ts_dynamic_ajax_view\((\d+)\)/.exec(html);
  if (!idMatch) return null;
  try {
    const origin = new URL(pageUrl).origin;
    const response = await fetch(`${origin}/wp-admin/admin-ajax.php`, {
      method: 'POST',
      headers: clearanceHeaders(pageUrl, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': pageUrl
      }),
      body: `action=dynamic_view_ajax&post_id=${idMatch[1]}`
    });
    if (!response.ok) return null;
    const data = await response.json();
    return (data && typeof data.views === 'string' && /\d/.test(data.views)) ? data.views : null;
  } catch (e) {
    return null; // theme without this endpoint, network hiccup, ... - views just stays whatever extractSeriesMetadataFromHtml found
  }
}

// Downloads a series' cover art exactly once. Guarded by whether a cover
// object already exists in R2 for this series id - not by whether metadata
// was just (re-)fetched - so calling this after every SEO metadata refresh
// (which can happen many times over a series' life) never re-uploads the
// same cover.
async function downloadCoverImageIfMissing(series) {
  const coverUrl = series.metadata?.coverImageUrl;
  if (!coverUrl) return;

  const existingPath = series.metadata.coverImagePath;
  if (existingPath && await r2ObjectExists(existingPath)) return;

  try {
    const download = await fetchImageWithRetry(coverUrl, clearanceHeaders(coverUrl, {
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }));
    if (download.blocked) return;

    const contentType = download.response.headers.get('content-type');
    let ext = getExtension(coverUrl, contentType);
    let buffer = Buffer.from(await download.response.arrayBuffer());

    // Covers skip the chapter-page pipeline entirely, so scrub the source
    // site's metadata here too - same reasoning as the chapter-page loop
    // above: jpg/png/gif/bmp lose it for free via the Jimp round-trip,
    // webp/svg need it stripped directly.
    try {
      const optimized = await optimizeMangaImage(buffer, ext);
      buffer = optimized.buffer;
      ext = optimized.ext;
    } catch (err) {
      // any decode/encode failure: fall back to the untouched original
    }
    try {
      if (ext === 'webp') buffer = stripWebpMetadata(buffer);
      else if (ext === 'svg') buffer = stripSvgMetadata(buffer);
    } catch (err) {
      // malformed container: leave buffer untouched rather than risk corrupting it
    }

    // Plain <title>_cover.<ext> - no id suffix. Trade-off: two series that
    // happen to share the exact same title would overwrite each other's
    // cover in the shared cover/ folder, but that's rare enough for this
    // use case that dropping the suffix for readability wins.
    const seriesTitle = sanitizeForFilename(series.metadata?.title || series.name, series.id);
    const fileName = `${seriesTitle}_cover.${ext}`;
    const key = `cover/${fileName}`;
    await uploadToR2(key, buffer, ext);
    series.metadata.coverImagePath = key;
  } catch (err) {
    console.error(`Failed to upload cover image for series ${series.id}:`, err.message);
  }
}

// Turns a series/chapter title into a safe path segment for R2 keys (cover
// and manga-page paths both go through this) - strips characters that are
// invalid (or awkward) across macOS/Linux/Windows/URLs, and collapses
// whitespace to underscores rather than leaving raw spaces in the key
// (spaces in an R2 key mean every URL needs %20-encoding to round-trip
// correctly, which is easy to get wrong further down the pipeline).
//
// Also drops every non-ASCII character (Thai, CJK, ...) - discovered
// 2026-09-20 that apibo.solo-manga.com (the back office's own API, a
// separate service we don't control) silently fails to return a chapter's
// pages whenever its image_key contains non-ASCII characters (confirmed:
// R2 has the file, MySQL has the row, only apibo's response breaks - e.g.
// chapter 8726 "Lookism_ลูกคิซึม_..." never responds, while an all-ASCII
// chapter on the same endpoint works fine). R2/MySQL/solo/api all handle
// UTF-8 keys correctly, so this is purely a workaround for that other
// service's bug, not a storage requirement - keeps titleForFile ASCII-only
// so newly scraped chapters never hit it. Falls back to the caller's id
// (same as slugify's fallback) if the title is ASCII-empty (e.g. an
// all-Thai title), so two different all-Thai titles never collide on the
// same R2 prefix.
function sanitizeForFilename(name, fallback) {
  const cleaned = (name || '')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '_')
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
// How many DISTINCT chapters must serve the exact same image URL before it's
// blacklisted as a shared site asset (see the cross-chapter dedup below) - 2
// (i.e. "seen twice") was too aggressive: a title/credits/afterword page can
// legitimately repeat once across two chapters without being site furniture.
const SHARED_ASSET_CHAPTER_THRESHOLD = 3;
// A chapter finishing with this many pages or fewer gets the extra,
// system-wide, zero-threshold reused-image check in scrapeChapterCoreAttempt
// (see LOW_IMAGE_COUNT_SAFETY_THRESHOLD usage there) - below this a false
// dedup positive costs a large fraction of the whole chapter, so it's worth
// the (rare, since it only fires on already-small chapters) extra DB lookup.
const LOW_IMAGE_COUNT_SAFETY_THRESHOLD = 5;
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

// Strips embedded metadata (EXIF/XMP) from formats that skip the Jimp
// decode/encode round-trip above - that round-trip already drops metadata
// for jpg/png/gif/bmp for free (Jimp's encoders never write EXIF/XMP back),
// but webp and svg pass through untouched, so the source site's metadata
// would otherwise ride along all the way into R2.
function stripWebpMetadata(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return buffer;
  }

  const chunks = [];
  let offset = 12;
  let changed = false;
  while (offset + 8 <= buffer.length) {
    const fourCC = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const paddedSize = size + (size % 2);
    const dataStart = offset + 8;
    if (dataStart + paddedSize > buffer.length) break; // truncated/malformed - stop and keep what parsed cleanly

    if (fourCC === 'EXIF' || fourCC === 'XMP ') {
      changed = true;
    } else if (fourCC === 'VP8X') {
      const data = Buffer.from(buffer.subarray(dataStart, dataStart + size));
      const before = data[0];
      data[0] = before & ~0x08 & ~0x04; // clear the Exif (bit 3) and XMP (bit 2) flag bits
      if (data[0] !== before) changed = true;
      chunks.push({ fourCC, data });
    } else {
      chunks.push({ fourCC, data: buffer.subarray(dataStart, dataStart + size) });
    }
    offset = dataStart + paddedSize;
  }
  if (!changed) return buffer;

  const bodyLength = chunks.reduce((sum, c) => sum + 8 + c.data.length + (c.data.length % 2), 0);
  const out = Buffer.alloc(12 + bodyLength);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(4 + bodyLength, 4);
  out.write('WEBP', 8, 'ascii');
  let pos = 12;
  for (const c of chunks) {
    out.write(c.fourCC, pos, 'ascii');
    out.writeUInt32LE(c.data.length, pos + 4);
    c.data.copy(out, pos + 8);
    pos += 8 + c.data.length;
    if (c.data.length % 2) out[pos++] = 0; // pad byte
  }
  return out;
}

function stripSvgMetadata(buffer) {
  const text = buffer.toString('utf8');
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, '');
  return cleaned === text ? buffer : Buffer.from(cleaned, 'utf8');
}

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

// Cross-site gap-filling: when another tracked series is identified (same
// heuristic as findPossibleDuplicateSeries above) as the same manga on a
// different site, and it has a finished chapter this series doesn't have,
// clone that chapter's URL in here as a new pending chapter - the normal
// scrape pipeline then downloads it from the sibling's own site. Since R2
// folder paths are title-based (see scrapeChapterCoreAttempt), a chapter
// filled in this way lands in the exact same manga/<title>/ep<N>/ folder
// either series would have used on its own - the two sources converge into
// one complete set instead of two separate, each-partial copies.
async function backfillMissingChaptersFromSiblings(db, series) {
  const siblingRefs = findPossibleDuplicateSeries(db, series);
  if (siblingRefs.length === 0) return 0;

  const haveNumbers = new Set(
    (series.chapters || []).map(c => extractLeadingNumber(c.name)).filter(n => n !== null)
  );

  let addedCount = 0;
  for (const ref of siblingRefs) {
    const sibling = findSeries(db, ref.id);
    if (!sibling) continue;

    for (const siblingChapter of sibling.chapters || []) {
      if (siblingChapter.status !== 'done') continue; // only borrow chapters the sibling actually finished
      const num = extractLeadingNumber(siblingChapter.name);
      if (num === null || haveNumbers.has(num)) continue;

      if (!series.chapters) series.chapters = [];
      series.chapters.push({
        id: `${Date.now()}_${addedCount}_gapfill`,
        name: siblingChapter.name,
        url: siblingChapter.url,
        status: 'pending',
        images: [],
        error: null,
        scrapedAt: null,
        retryCount: 0
      });
      haveNumbers.add(num);
      addedCount++;
    }
  }

  if (addedCount > 0) {
    console.log(`[gap-fill] "${series.name}": queued ${addedCount} chapter(s) found on a sibling site but missing here`);
    saveSeries(series);
  }
  return addedCount;
}



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

// How often (in series processed) a whole-site crawl prints its "found X /
// done Y / Z left" progress summary - see runSiteCrawl. Kept infrequent on
// purpose: a line per series would flood the log on a big site for no real
// benefit.
const SITE_PROGRESS_LOG_EVERY = 20;

// How long a fully-scraped tracked series is left alone before it's due for
// another "did a new chapter come out" check - see the nextLink priority
// pick in runSiteCrawl. Deliberately not too short: re-fetching a series
// page that basically never changes wastes a request against the same
// per-site rate budget that new-chapter downloads compete for.
const SERIES_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

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
  updateChapter(chapter);
  // The dedup bookkeeping (seenAssetUrls/Hashes etc.) on `series` may have
  // picked up new entries during this chapter's scrape - persist just the
  // series row, not its (possibly huge) chapter/image collection.
  saveSeriesMetadata(series);
  // Publish to the website DB only once a chapter is actually complete -
  // partial/error/blocked chapters stay bot-internal until a later retry
  // round finishes them.
  if (chapter.status === 'done') {
    await syncChapterToWebsiteDbSafe(series, chapter);
  }
  return result;
}

async function scrapeChapterCoreAttempt(db, series, chapter) {
  const seriesId = series.id;
  chapter.status = 'scraping';
  chapter.error = null;
  updateChapter(chapter);
  console.log(`[scrape] starting "${series.name}" / "${chapter.name}" (${chapter.id}) - ${chapter.url}`);

  try {
    // Respect robots.txt for the chapter's page before touching the site at all.
    const origin = new URL(chapter.url).origin;
    const robotsText = await fetchTextOrNull(`${origin}/robots.txt`);
    const robotsRules = robotsText ? parseRobotsRules(robotsText) : { disallowPaths: [], crawlDelaySeconds: null };

    if (isPathDisallowed(chapter.url, robotsRules.disallowPaths)) {
      chapter.status = 'blocked';
      chapter.error = 'robots.txt ของเว็บนี้ไม่อนุญาตให้เข้าหน้านี้';
      updateChapter(chapter);
      return { httpStatus: 403, error: chapter.error };
    }

    const pageDetail = await fetchPageDetails(chapter.url, series.useStealth);
    if (pageDetail.status !== 'up') {
      chapter.status = 'error';
      chapter.error = pageDetail.error || 'ไม่สามารถเปิดหน้าตอนนี้ได้';
      updateChapter(chapter);
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
    console.log(`[scrape] "${chapter.name}": ${pageDetail.images.length} image(s) on page, ${mangaImages.length} after ad filter`);

    // Cross-chapter dedup: a real page is essentially never byte-identical
    // reused between two different chapters, but a site's own promo banner
    // or a UI icon (a lightbox "close" button, a "read more manga" ad slot
    // shaped like 728x400) often is - and its filename/keywords can look
    // completely innocuous. Track how many DISTINCT chapters have served each
    // image URL on this series; only once the same URL has shown up under
    // SHARED_ASSET_CHAPTER_THRESHOLD or more different chapters is it
    // confirmed to be a shared site asset rather than chapter art (a single
    // repeat is not enough - a title/credits/afterword page can legitimately
    // reuse the same file across two chapters), so it gets excluded here and
    // on every future scrape.
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
      let seen = series.seenAssetUrls[img.url];
      // Back-compat: older dedupStateJson stored just the first chapter id
      // (a string) instead of {lastChapterId, count} - normalize on read.
      if (typeof seen === 'string') seen = { lastChapterId: seen, count: 1 };

      if (seen) {
        if (seen.lastChapterId !== chapter.id) {
          seen.count += 1;
          seen.lastChapterId = chapter.id;
        }
        series.seenAssetUrls[img.url] = seen;
        if (seen.count >= SHARED_ASSET_CHAPTER_THRESHOLD && !sharedSet.has(img.url)) {
          sharedSet.add(img.url);
          series.sharedAssetUrls.push(img.url);
        }
      } else {
        series.seenAssetUrls[img.url] = { lastChapterId: chapter.id, count: 1 };
      }
    });

    // NOTE: deliberately no "fall back to unfiltered if this empties the
    // page" here. That was tried and reverted - in production it forced
    // through a page's favicon/wallpaper furniture as if it were chapter
    // art on a chapter where the source site itself had no real images to
    // serve (confirmed by a reader comment on the site saying exactly that).
    // An all-excluded page is NOT reliably a filter false positive, so it
    // must still surface as an error for a human to check, not be papered
    // over automatically.
    mangaImages = mangaImages.filter(img => !sharedSet.has(img.url));

    console.log(`[scrape] "${chapter.name}": ${mangaImages.length} image(s) after shared-asset filter`);

    if (mangaImages.length === 0) {
      chapter.status = 'error';
      chapter.error = 'ไม่พบรูปในหน้านี้ (รูปทั้งหมดถูกกรองว่าเป็นโฆษณาหรือรูปที่ใช้ซ้ำทั้งเว็บ)';
      updateChapter(chapter);
      return { httpStatus: 404, error: chapter.error };
    }

    // Human-readable page filenames AND folder path - <series title>_ep
    // <chapter number>_<page number>.<ext> under manga/<series title>/
    // ep<chapter number>/ - no id suffixes anywhere. Trade-off (consistent
    // with the cover filename above): two series that happen to share the
    // exact same title would collide into the same manga/<title>/ folder.
    // Accepted as rare enough for this use case in exchange for clean names.
    const seriesTitleForFile = sanitizeForFilename(series.metadata?.title || series.name, seriesId);
    const chapterNumber = extractLeadingNumber(chapter.name);
    const chapterLabel = chapterNumber !== null ? String(chapterNumber) : String(chapter.orderIndex + 1);

    // Wipe any previous upload for this chapter first, so a re-scrape after
    // the filters above catch something new doesn't leave stale pages (e.g.
    // yesterday's ad banner) orphaned in R2 under the old key prefix.
    const chapterKeyPrefix = `manga/${seriesTitleForFile}/ep${chapterLabel}/`;
    await deleteR2Prefix(chapterKeyPrefix);

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

        // jpg/png/gif/bmp already lost their metadata for free in the Jimp
        // round-trip above; webp/svg never went through Jimp at all, so scrub
        // their metadata containers directly here before anything gets hashed
        // or uploaded - a source site's EXIF/XMP must never reach our storage.
        try {
          if (ext === 'webp') buffer = stripWebpMetadata(buffer);
          else if (ext === 'svg') buffer = stripSvgMetadata(buffer);
        } catch (err) {
          // malformed container: leave buffer untouched rather than risk corrupting it
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
        // when it's re-uploaded under a fresh URL every chapter. Same
        // distinct-chapter counter/threshold as the URL check above (see
        // SHARED_ASSET_CHAPTER_THRESHOLD) - one repeat isn't enough.
        let seenHash = series.seenAssetHashes[contentHash];
        if (typeof seenHash === 'string') seenHash = { lastChapterId: seenHash, count: 1 };

        let isSharedHash = sharedHashSet.has(contentHash);
        if (seenHash) {
          if (seenHash.lastChapterId !== chapter.id) {
            seenHash.count += 1;
            seenHash.lastChapterId = chapter.id;
          }
          series.seenAssetHashes[contentHash] = seenHash;
          if (seenHash.count >= SHARED_ASSET_CHAPTER_THRESHOLD && !isSharedHash) {
            sharedHashSet.add(contentHash);
            series.sharedAssetHashes.push(contentHash);
            isSharedHash = true;
          }
        } else {
          series.seenAssetHashes[contentHash] = { lastChapterId: chapter.id, count: 1 };
        }

        // Perceptual-hash check, only for first/last-page candidates (see
        // isPHashCandidatePosition) - catches a reused ad/credit graphic
        // that's visually the same but wasn't byte-identical, which the
        // exact contentHash check above just let through. Same
        // distinct-chapter threshold as above: count how many OTHER
        // chapters logged a near-identical image, don't exclude on a single
        // prior sighting.
        let pHash = null;
        let isSharedPHash = false;
        if (isPHashCandidatePosition(i, mangaImages.length)) {
          pHash = await computePerceptualHash(buffer);
          if (pHash) {
            const nearMatchChapterIds = new Set(
              series.assetPHashLog
                .filter(entry => entry.chapterId !== chapter.id && compareHashes(entry.hash, pHash) <= PHASH_DISTANCE_THRESHOLD)
                .map(entry => entry.chapterId)
            );
            if (nearMatchChapterIds.size >= SHARED_ASSET_CHAPTER_THRESHOLD) {
              isSharedPHash = true;
            } else {
              series.assetPHashLog.push({ hash: pHash, chapterId: chapter.id });
            }
          }
        }

        if (isSharedHash || isSharedPHash) {
          excludedAsSharedCount++;
          continue;
        }

        const filename = `${seriesTitleForFile}_ep${chapterLabel}_${String(i + 1).padStart(3, '0')}.${ext}`;
        const key = `${chapterKeyPrefix}${filename}`;
        await uploadToR2(key, buffer, ext);

        downloaded.push({
          order: i + 1,
          filename,
          relativePath: key,
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

    // Extra scrutiny for a chapter that would otherwise finish 'done' with
    // very few pages - this is exactly the shape of the "Bad Born Blood"
    // incident (a site-wide filler image saved as page 1, only caught once
    // it repeated a 3rd time and tripped the normal per-series dedup
    // threshold - the first couple of occurrences always slip through that
    // check by design, see SHARED_ASSET_CHAPTER_THRESHOLD above). A losing
    // 1-in-1 (or 1-in-3) image to a false dedup positive is a much bigger
    // relative loss than losing 1-in-50, so a low page count gets a
    // stricter, immediate, system-wide check instead of waiting for the
    // normal per-series threshold: does ANY of these images already exist
    // under a different chapter, anywhere in the whole database, at all
    // (no threshold)? A genuine short chapter (an epilogue, a bonus page)
    // has unique art and will never match; reused site furniture almost
    // always already exists under at least one earlier chapter somewhere.
    if (chapter.status === 'done' && downloaded.length <= LOW_IMAGE_COUNT_SAFETY_THRESHOLD) {
      const reusedElsewhere = downloaded.filter(img => findOtherChapterWithHashStmt.get(img.contentHash, chapter.id));
      if (reusedElsewhere.length > 0) {
        console.warn(`[scrape] "${chapter.name}": only ${downloaded.length} image(s) total and ${reusedElsewhere.length} of them already exist under a different chapter elsewhere in the database - too suspicious to trust as a real chapter, marking as error instead of done`);
        await deleteR2Prefix(chapterKeyPrefix);
        chapter.images = [];
        chapter.status = 'error';
        chapter.error = 'รูปในตอนนี้มีน้อยผิดปกติและซ้ำกับตอนอื่นในระบบ - น่าจะเป็นรูปเว็บที่ใช้ซ้ำ ไม่ใช่หน้าการ์ตูนจริง ต้องตรวจสอบ';
      }
    }

    chapter.scrapedAt = new Date().toISOString();
    console.log(`[scrape] "${chapter.name}" finished: status=${chapter.status}, downloaded=${downloaded.length}/${expectedCount}, excludedAsShared=${excludedAsSharedCount}`);

    updateChapter(chapter);
    return { httpStatus: 200, error: null, blockedEarly, retryAfterMs };
  } catch (error) {
    console.error(`Error scraping chapter ${chapter.id}:`, error);
    chapter.status = 'error';
    chapter.error = error.message || 'เกิดข้อผิดพลาดระหว่างดึงข้อมูล';
    updateChapter(chapter);
    return { httpStatus: 500, error: chapter.error };
  }
}

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

    // stripTags both removes nested tags (badges, chapter-number spans that
    // share this grid tile) AND runs the full entity decoder - the old
    // hand-rolled version here only handled &nbsp;/&amp;, so a title with a
    // curly quote (&#8217; etc.) or &quot;/&lt;/&gt; came through raw.
    const text = stripTags(match[2]);
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

    // stripTags both removes nested tags (badges, chapter-number spans that
    // share this grid tile) AND runs the full entity decoder - the old
    // hand-rolled version here only handled &nbsp;/&amp;, so a title with a
    // curly quote (&#8217; etc.) or &quot;/&lt;/&gt; came through raw.
    const text = stripTags(match[2]);
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
    const dynamicViews = await fetchDynamicViewCount(listingUrl, html);
    if (dynamicViews) series.metadata.views = dynamicViews;
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
    // Retry metadata fetch whenever there's no cover URL yet, not just when
    // metadata itself is null - a series graduated from the whole-site
    // crawl or the 5-page daily check only ever gets ONE metadata-fetch
    // attempt at creation time (see runSiteCrawl/addSeriesCommand's
    // `if (!series.metadata)` gate), so a single blocked/failed fetch, or
    // a page whose cover markup this extractor missed, left it permanently
    // uncovered - this backfill (runs every sync pass) is the only thing
    // that ever gets a second attempt.
    if (series.seriesUrl && !series.metadata?.coverImageUrl) {
      try {
        const { disallowed, html } = await fetchSeriesPageRespectingRobots(series.seriesUrl, series.useStealth);
        if (!disallowed && html) {
          const freshMetadata = extractSeriesMetadataFromHtml(html, series.seriesUrl);
          if (!series.metadata) {
            series.metadata = freshMetadata;
            series.metadataFetchedAt = new Date().toISOString();
            const dynamicViews = await fetchDynamicViewCount(series.seriesUrl, html);
            if (dynamicViews) series.metadata.views = dynamicViews;
          } else if (freshMetadata.coverImageUrl) {
            // Metadata already exists (title/description were fine) - only
            // fill in the cover URL that was missing, don't clobber
            // everything else with a full re-extraction.
            series.metadata.coverImageUrl = freshMetadata.coverImageUrl;
          }
        }
      } catch (err) {
        console.error(`Cover backfill: failed to fetch metadata for series ${series.id}:`, err.message);
      }
    }

    if (!series.metadata?.coverImageUrl) {
      skipped++;
      saveSeriesMetadata(series); // still persist any metadata just fetched above
      continue;
    }

    const hadPath = series.metadata.coverImagePath;
    await downloadCoverImageIfMissing(series);
    if (!hadPath && series.metadata.coverImagePath) {
      downloaded++;
      // syncSeriesToWebsiteDb only otherwise runs as a side effect of a
      // chapter finishing (syncChapterToWebsiteDbSafe) - an already-fully-
      // synced series with no new chapter has nothing left to trigger that,
      // so a cover backfilled here would sit in R2/SQLite forever without
      // this, never reaching the live site's cover_image_key column.
      try {
        await withMysqlRetry(conn => syncSeriesToWebsiteDb(conn, series));
      } catch (err) {
        console.error(`Cover backfill: failed to push new cover to MySQL for series ${series.id}:`, err.message);
      }
    }
    saveSeriesMetadata(series);
  }

  return { checked: (db.series || []).length, downloaded, skipped };
}

// One-time repair for series saved before decodeHtmlEntities understood
// numeric entities (&#8217; etc.) - those titles are stuck with the literal
// escape sequence forever otherwise, since metadata is only ever re-fetched
// here when a cover is missing (see backfillCoverImages), not when the
// title itself is stale. Re-decodes what's already cached in SQLite and, if
// anything changed, pushes the corrected row straight to MySQL (still
// subject to syncSeriesToWebsiteDb's own is_edited guard, so an admin's
// manual edit is never overwritten).
async function repairEntityTitlesCommand() {
  const db = readDb();
  let fixedCount = 0;

  for (const series of db.series || []) {
    let changed = false;

    const decodedName = decodeHtmlEntities(series.name);
    if (decodedName !== series.name) { series.name = decodedName; changed = true; }

    const m = series.metadata;
    if (m) {
      if (m.title) {
        const d = decodeHtmlEntities(m.title);
        if (d !== m.title) { m.title = d; changed = true; }
      }
      if (m.synopsis) {
        const d = decodeHtmlEntities(m.synopsis);
        if (d !== m.synopsis) { m.synopsis = d; changed = true; }
      }
      if (m.author) {
        const d = decodeHtmlEntities(m.author);
        if (d !== m.author) { m.author = d; changed = true; }
      }
      if (Array.isArray(m.altTitles)) {
        const decodedAlts = m.altTitles.map(t => typeof t === 'string' ? decodeHtmlEntities(t) : t);
        if (decodedAlts.some((t, i) => t !== m.altTitles[i])) { m.altTitles = decodedAlts; changed = true; }
      }
    }

    if (!changed) continue;

    saveSeriesMetadata(series);
    try {
      await withMysqlRetry(conn => syncSeriesToWebsiteDb(conn, series));
      fixedCount++;
      console.log(`[repair-entities] fixed "${series.name}"`);
    } catch (err) {
      console.error(`[repair-entities] fixed locally but failed to push "${series.name}" to MySQL:`, err.message);
    }
  }

  console.log(`[repair-entities] done - ${fixedCount} series fixed`);
  return fixedCount;
}

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
// maxChaptersThisTurn lets a caller round-robin scraping work across many
// series (see syncAllSeries) instead of draining one series' entire backlog
// before ever touching the next - a single series with a huge backlog (a
// long-completed title being onboarded, or one that slipped behind) would
// otherwise starve every other tracked series' freshness for as long as it
// takes to finish (could be days - this is exactly what happened 2026-09-26,
// see the fix alongside this one for checkLatestUpdatesForSite). A chapter
// already in flight when the cap is hit is finished before returning -
// stopping is checked between chapters, not mid-scrape.
async function runScrapeAllForSeries(db, series, { maxChaptersThisTurn = Infinity } = {}) {
  const findEligible = () => (series.chapters || []).filter(
    c => c.status !== 'done' && (c.retryCount || 0) < MAX_CHAPTER_RETRIES && !scrapingChapters[c.id]
  );

  let scrapedCount = 0;
  let blockedEarly = false;
  let lastRetryAfterMs = null;

  for (let round = 0; round < MAX_CHAPTER_RETRIES; round++) {
    if (scrapedCount >= maxChaptersThisTurn) break;
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
      if (scrapedCount >= maxChaptersThisTurn) break;
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

// Raised from 60/500 after real sites turned out to have well over 500
// titles - hitting either cap silently sets discoveryDone=true (see below)
// and the crawl never goes looking for the rest, even once it otherwise
// finishes. Still bounded (not Infinity) as a guard against a pathological
// site/redirect loop burning through requests forever.
const MAX_LISTING_PAGES = 400;
const MAX_DISCOVERED_SERIES_PER_CRAWL = 8000;
const MAX_CONSECUTIVE_BLOCKED_SERIES = 3;
// After the normal per-chapter retries are spent, the crawl keeps doing full
// "recheck" sweeps over any chapters that are STILL incomplete - lifting the
// per-chapter retry cap and waiting an escalating cooldown between sweeps - so
// a series briefly blocked by a 429/403 gets picked back up automatically
// instead of staying stuck. Bounded so genuinely-dead chapters (404 art, etc.)
// don't loop the crawl forever.
const MAX_RECHECK_ROUNDS = 5;
const RECHECK_COOLDOWN_BASE_MS = 3 * 60 * 1000; // 3, 6, 9, 12, 15 min between rounds

// Temporary throttle: while we focus scraping effort on one source site,
// this lets discovery (finding NEW series or NEW chapters) be paused for
// every other site without touching their code paths - see syncAllSeries
// and resumeRunningCrawls below, the only two callers that check this.
// Deliberately does NOT stop scraping chapters that are already known/
// pending for a paused origin - only stops looking for MORE work there.
// Empty/unset ACTIVE_DISCOVERY_ORIGINS = no restriction (every site's
// discovery runs, the historical default) - this is opt-in, not a new
// default that could silently stop discovery if the env var is forgotten
// somewhere.
const ACTIVE_DISCOVERY_ORIGINS = (process.env.ACTIVE_DISCOVERY_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isDiscoveryActiveForOrigin(origin) {
  return ACTIVE_DISCOVERY_ORIGINS.length === 0 || ACTIVE_DISCOVERY_ORIGINS.includes(origin);
}

function originOf(url) {
  try { return new URL(url).origin; } catch (e) { return null; }
}

function findCrawl(db, crawlId) {
  return (db.siteCrawls || []).find(c => c.id === crawlId);
}

// id -> { stopRequested: boolean } - the fast in-memory signal the loop
// checks between every unit of work; the persisted `status` field on the
// crawl record is for display/durability, this is what actually stops it.
const crawlControl = {};

// maxUnitsThisTurn lets a caller round-robin between several crawls instead
// of draining one to completion before ever touching the next (see
// resumeRunningCrawls) - "one unit" is one listing page fetched (discovery
// phase), one retry-chapter scraped (recheck phase), or one series fully
// scraped (main phase). The crawl's own persisted state (discoveredSeries/
// processedSeriesUrls/nextListingPageUrl/...) is exactly what makes this
// safe to pause and resume arbitrarily - a return here is not a stop, just
// "come back and call this again to continue where it left off".
async function runSiteCrawl(crawlId, { maxUnitsThisTurn = Infinity } = {}) {
  if (!crawlControl[crawlId]) crawlControl[crawlId] = { stopRequested: false };
  let unitsDone = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (crawlControl[crawlId].stopRequested) return;
    if (unitsDone >= maxUnitsThisTurn) return; // yield back to the round-robin scheduler

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
      unitsDone++;
      continue;
    }

    // Phase 2: process discovered series one at a time - but not in plain
    // discovery order. A series we already track should reach its latest
    // chapter before we spend time discovering one we've never touched, so
    // that whatever's actively updating gets caught up fastest. Priority:
    //   1) already tracked AND still has an incomplete chapter
    //   2) already tracked, fully done, but overdue for an update check
    //      (SERIES_RECHECK_INTERVAL_MS - see lastUpdateCheckAt above)
    //   3) never tracked before - falls back to plain discovery order
    const unprocessedLinks = crawl.discoveredSeries.filter(s => !crawl.processedSeriesUrls.includes(s.url));
    const findTrackedSeries = (url) => (db.series || []).find(
      ds => ds.seriesUrl === url || (ds.sourceUrls || []).includes(url)
    );
    const nextLink =
      unprocessedLinks.find(s => {
        const tracked = findTrackedSeries(s.url);
        return tracked && (tracked.chapters || []).some(c => c.status !== 'done');
      }) ||
      unprocessedLinks.find(s => {
        const tracked = findTrackedSeries(s.url);
        if (!tracked) return false;
        const age = tracked.lastUpdateCheckAt ? Date.now() - new Date(tracked.lastUpdateCheckAt).getTime() : Infinity;
        return age > SERIES_RECHECK_INTERVAL_MS;
      }) ||
      unprocessedLinks[0];
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

        // Still cooling down from a previously-started recheck round - don't
        // block waiting it out (that would stall every other crawl's turn
        // too, see maxUnitsThisTurn above), just yield. A later call, once
        // the deadline has passed, falls through and starts the sweep.
        if (crawl.recheckCooldownUntil && Date.now() < crawl.recheckCooldownUntil) {
          return;
        }

        crawl.recheckRound = (crawl.recheckRound || 0) + 1;
        crawl.lastError = `รอบตรวจซ้ำ ${crawl.recheckRound}/${MAX_RECHECK_ROUNDS}: ยังมี ${incompleteChapters.length} ตอนที่ไม่ครบ กำลังพัก cooldown แล้วลองใหม่`;
        incompleteChapters.forEach(c => { c.retryCount = 0; updateChapter(c); }); // give them a fresh retry budget
        crawl.consecutiveBlockedSeries = 0; // fresh block budget after the cooldown
        crawl.currentSeriesUrl = null;
        crawl.currentSeriesName = null;
        // Escalating cooldown between recheck rounds (3, 6, 9, ... minutes) so a
        // rate-limiting site gets progressively more time to recover -
        // tracked as a deadline, not a blocking sleep, so it costs nothing
        // while other crawls take their turns in the meantime.
        crawl.recheckCooldownUntil = Date.now() + RECHECK_COOLDOWN_BASE_MS * crawl.recheckRound;
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
      unitsDone++;
      continue;
    }

    crawl.currentSeriesUrl = nextLink.url;
    crawl.currentSeriesName = nextLink.name;
    writeDb(db);

    // A per-series line here would be one log line per series - fine for a
    // handful of sites, but noisy (and a needless bit of stdout I/O) on a
    // site with hundreds of series. Only print a site-level progress summary
    // on the very first series of this run and every SITE_PROGRESS_LOG_EVERY
    // series after that, so long crawls still surface "found X / done Y /
    // Z left" periodically without a line per series.
    if (crawl.processedSeriesUrls.length % SITE_PROGRESS_LOG_EVERY === 0) {
      console.log(
        `[crawl:${crawl.siteUrl}] found ${crawl.discoveredSeries.length} series so far, ` +
        `done ${crawl.processedSeriesUrls.length}, ${crawl.discoveredSeries.length - crawl.processedSeriesUrls.length} left ` +
        `(now on: "${nextLink.name}") - ${crawl.stats.chaptersDownloaded} chapter(s) downloaded this run`
      );
    }

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
          // We just fetched this series's own page and are about to scan it
          // for chapter links below - that IS the "did anything new come
          // out" check, so stamp it now regardless of whether new chapters
          // turned up. This is what lets the priority pick above (further
          // up this file) tell "recently checked" apart from "overdue for
          // a check" once a series has no incomplete chapters left.
          series.lastUpdateCheckAt = new Date().toISOString();
          if (!series.metadata) {
            series.metadata = extractSeriesMetadataFromHtml(html, nextLink.url);
            series.metadataFetchedAt = new Date().toISOString();
            const dynamicViews = await fetchDynamicViewCount(nextLink.url, html);
            if (dynamicViews) series.metadata.views = dynamicViews;
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
    saveSeries(series); // new series and/or newly-discovered chapters
    writeDb(db); // crawl bookkeeping (siteCrawls stays in the blob)
    await sleep(computeNextDelayMs(seriesRobotsRules.crawlDelaySeconds));

    // Scrape every not-yet-done chapter of this series, then keep sweeping the
    // ones that came out incomplete until they either finish or use up their
    // retry budget - so a transient failure (a 525 blip, a brief rate-limit) is
    // fixed right here, before moving to the next series, instead of waiting for
    // the end-of-crawl retry pass which on a big site could be hours away. Each
    // failed scrape bumps retryCount (see scrapeChapterCore), so a chapter drops
    // out of `pending` after MAX_CHAPTER_RETRIES sweeps - the loop can't spin.
    // The stop signal is checked before every chapter so a stop lands promptly.
    // Chapters that used up their retry budget in an earlier visit (e.g. the
    // source hadn't uploaded the page's images yet, or a run of transient
    // errors) would otherwise stay stuck in 'error'/'partial' forever, since
    // nothing else resets retryCount. Give them one fresh budget every time
    // the round-robin crawl comes back around to this series - still capped
    // at MAX_CHAPTER_RETRIES attempts within *this* pass, so a permanently
    // broken chapter just costs one extra sweep per revisit, not a spin.
    series.chapters.forEach(c => {
      if (c.status !== 'done' && (c.retryCount || 0) >= MAX_CHAPTER_RETRIES) {
        c.retryCount = 0;
      }
    });
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
    unitsDone++;
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint - this module has no HTTP server. Every invocation is a
// single pass: discover/scrape whatever there is to do, write it to SQLite,
// then exit. There is no long-lived watchdog; run this again (e.g. from
// cron) to pick up new chapters/series later.
// ---------------------------------------------------------------------------

// One round-robin unit for syncAllSeries's scrape phase below - deliberately
// tiny (a single chapter) so a series with a huge backlog (a long-completed
// title being onboarded, or one that slipped behind) only ever holds up
// every other tracked series' freshness by about one chapter's worth of
// time, not its entire backlog - see runScrapeAllForSeries's doc comment.
const SYNC_MAX_CHAPTERS_PER_SERIES_PER_ROUND = 1;

// Discovers new chapters and downloads everything not yet 'done' for every
// series already tracked in the DB. Cover backfill used to run here too,
// but even this can run for a long time (a single series can have 70+ new
// chapters) - it's now called once, earlier, at the very top of main()'s
// no-arg path instead, so a missing cover never waits behind ANY backlog,
// including one discovered by the "cheap" 2-page check itself (see there).
async function syncAllSeries(db) {
  const pending = [];
  for (const series of db.series || []) {
    if (series.seriesUrl && isDiscoveryActiveForOrigin(originOf(series.seriesUrl))) {
      try {
        const { addedCount } = await discoverAndAddNewChapters(db, series, series.seriesUrl);
        if (addedCount > 0) console.log(`[sync] "${series.name}": ${addedCount} new chapter(s)`);
      } catch (err) {
        console.error(`[sync] discover failed for "${series.name}":`, err.message);
      }
    }
    // A paused origin (see ACTIVE_DISCOVERY_ORIGINS) still falls through to
    // backfill/scrape below - only the "look for brand-new chapters" step
    // above is skipped, not the "finish downloading what we already know
    // about" work every series gets regardless of origin.
    await backfillMissingChaptersFromSiblings(db, series);
    // Both discoverAndAddNewChapters and the sibling-backfill above only
    // push new chapters onto series.chapters in memory - saveSeries() (not
    // saveSeriesMetadata(), which explicitly skips chapters/images) must
    // persist them before the scrape below, or its first image insert for a
    // brand-new chapter violates the images.chapterId foreign key.
    saveSeries(series);

    // Give any chapter that used up its retry budget in an earlier run (this
    // routine sync is what docker/cron actually runs on a schedule - see
    // the identical reset in crawlCommand for the whole-site-crawl path) one
    // fresh budget every time this series comes up again, so a chapter that
    // failed 3x (dedup false-positive, transient block, site hiccup, ...)
    // gets retried on the next sync pass instead of staying 'error' forever.
    // Still capped at MAX_CHAPTER_RETRIES attempts within this pass, so a
    // permanently broken chapter costs one extra sweep per sync, not a spin.
    let unstuckCount = 0;
    series.chapters.forEach(c => {
      if (c.status !== 'done' && (c.retryCount || 0) >= MAX_CHAPTER_RETRIES) {
        c.retryCount = 0;
        unstuckCount++;
      }
    });
    if (unstuckCount > 0) console.log(`[sync] "${series.name}": giving ${unstuckCount} exhausted chapter(s) a fresh retry budget`);

    pending.push(series);
  }

  // Round-robins the actual scraping across every series (one chapter each
  // per round, cycling back around) instead of draining one series' entire
  // backlog before ever touching the next - same reasoning as
  // resumeRunningCrawls' round-robin over site crawls, applied one level
  // down at the per-chapter granularity.
  let active = pending;
  while (active.length > 0) {
    const next = [];
    for (const series of active) {
      const { scrapedCount, blockedEarly } = await runScrapeAllForSeries(db, series, { maxChaptersThisTurn: SYNC_MAX_CHAPTERS_PER_SERIES_PER_ROUND });
      if (scrapedCount > 0) console.log(`[sync] "${series.name}": scraped ${scrapedCount} chapter(s)${blockedEarly ? ' (stopped early - site blocked)' : ''}`);
      // A blocked series sits out the rest of this pass rather than being
      // fed straight back into the very next round against the same site.
      const stillEligible = (series.chapters || []).some(
        c => c.status !== 'done' && (c.retryCount || 0) < MAX_CHAPTER_RETRIES
      );
      if (stillEligible && !blockedEarly) next.push(series);
    }
    active = next;
  }
}

// Catches up any chapter that finished downloading (status 'done', so R2
// already has its pages) but never made it into MySQL, or made it in only
// partially - e.g. the sync in scrapeChapterCore ran while the website DB
// was briefly unreachable (VPN, network blip, ...), or the `chapters` row
// upsert succeeded but the subsequent `chapter_pages` insert kept failing
// on every retry (leaving a chapter row with zero pages behind - the
// website shows the chapter but "fails to load page images" since R2 has
// the files but MySQL never got the rows pointing at them).
// syncChapterToWebsiteDbSafe() only runs once, right when a chapter
// finishes, and nothing revisits a 'done' chapter afterward - without this
// pass, a chapter that failed to sync (fully or partially) that one time
// would stay broken on the website forever even though its images are
// safely in R2. Cheap to run every cycle: 1-2 queries per series, not per
// chapter.
async function repairMysqlSync(db) {
  let repairedCount = 0;
  for (const series of db.series || []) {
    const doneChapters = (series.chapters || []).filter(c => c.status === 'done');
    if (doneChapters.length === 0) continue;

    let pageCountsByNumber;
    try {
      pageCountsByNumber = await withMysqlRetry(async (conn) => {
        // By source_series_id, not a freshly-recomputed slug - the same fix
        // syncSeriesToWebsiteDb got on 2026-09-19 (see the comment there):
        // a title correction after the row was created leaves the row's
        // actual (unchanged, by design) slug mismatched against slugify()
        // of the current title, so a slug-based lookup here would find
        // nothing and misreport every one of this series' chapters as
        // "missing" even though they're all fine - seen live 2026-09-26,
        // re-"repairing" 242 already-correct chapters every single run.
        const [[seriesRow]] = await conn.execute('SELECT id FROM series WHERE source_series_id = ?', [series.id]);
        const counts = new Map();
        if (seriesRow) {
          const [rows] = await conn.execute(
            `SELECT c.number AS number, COUNT(cp.id) AS pageCount
             FROM chapters c LEFT JOIN chapter_pages cp ON cp.chapter_id = c.id
             WHERE c.series_id = ?
             GROUP BY c.id, c.number`,
            [seriesRow.id]
          );
          rows.forEach(r => counts.set(Number(r.number), Number(r.pageCount)));
        }
        return counts;
      });
    } catch (err) {
      // MySQL still unreachable (e.g. VPN blocking it) - skip this series
      // for now, next repair pass (next bot run) will try again.
      console.error(`[repair-sync] could not check MySQL state for "${series.name}":`, err.message);
      continue;
    }

    for (const chapter of doneChapters) {
      const num = extractLeadingNumber(chapter.name);
      if (num === null) continue;
      const expectedPages = (chapter.images || []).length;
      const existingPages = pageCountsByNumber.get(num);
      if (existingPages !== undefined && (existingPages > 0 || expectedPages === 0)) continue;
      const reason = existingPages === undefined ? 'missing in MySQL' : 'chapter row exists but has 0 pages';
      console.log(`[repair-sync] "${series.name}" ep${num}: ${reason}, re-syncing`);
      await syncChapterToWebsiteDbSafe(series, chapter);
      repairedCount++;
    }
  }
  if (repairedCount > 0) console.log(`[repair-sync] re-synced ${repairedCount} chapter(s) that were missing or incomplete in MySQL`);
  return repairedCount;
}

// Finishes every site crawl left in 'running' state from an interrupted
// previous run - a CLI invocation is a fresh process every time, so nothing
// else will ever come back to resume it otherwise.
//
// Round-robins between them (one series/page/retry-chapter at a time, see
// maxUnitsThisTurn on runSiteCrawl) instead of draining one crawl fully
// before ever touching the next - a site with hundreds of series to work
// through would otherwise starve every other tracked site of any progress
// at all for as long as it takes to finish (could be days).
// One "round" below is one full pass of the round-robin, i.e. every active
// site gets to fully scrape one series (see maxUnitsThisTurn: 1 and
// unitsDone++ at the end of the per-series loop in runSiteCrawl - one unit
// really is one whole series, so a round can already take a while). Printing
// the cross-site table every round would still be too chatty on a long
// multi-site sync, so it only prints every ROUND_ROBIN_SUMMARY_EVERY_ROUNDS.
const ROUND_ROBIN_SUMMARY_EVERY_ROUNDS = 5;

function logRoundRobinSummary(ids) {
  const db = readDb(); // fresh read - ids' crawl objects were written by runSiteCrawl mid-loop
  console.log(`[sync] --- progress across ${ids.length} site(s) ---`);
  for (const id of ids) {
    const c = findCrawl(db, id);
    if (!c) continue;
    const found = c.discoveredSeries.length;
    const done = c.processedSeriesUrls.length;
    const discoveryNote = c.discoveryDone ? 'หาเรื่องครบแล้ว' : 'ยังหาเรื่องเพิ่มอยู่';
    console.log(
      `[sync]   ${c.siteUrl}: เจอ ${found} เรื่อง, โหลดจบแล้ว ${done}, เหลือ ${found - done} เรื่อง ` +
      `(${discoveryNote}) - กำลังทำ: "${c.currentSeriesName || '-'}"`
    );
  }
}

async function resumeRunningCrawls(db) {
  const pausedIds = [];
  let activeIds = (db.siteCrawls || [])
    .filter(c => c.status === 'running')
    .filter(c => {
      if (isDiscoveryActiveForOrigin(originOf(c.siteUrl))) return true;
      pausedIds.push(c.siteUrl);
      return false;
    })
    .map(c => c.id);
  if (pausedIds.length > 0) {
    console.log(`[sync] discovery paused for ${pausedIds.length} site crawl(s) (ACTIVE_DISCOVERY_ORIGINS): ${pausedIds.join(', ')}`);
  }
  if (activeIds.length === 0) return;

  console.log(`[sync] resuming ${activeIds.length} site crawl(s) round-robin: ${activeIds.map(id => findCrawl(db, id)?.siteUrl).join(', ')}`);
  activeIds.forEach(id => { crawlControl[id] = { stopRequested: false }; });

  let round = 0;
  while (activeIds.length > 0) {
    for (const id of [...activeIds]) {
      await runSiteCrawl(id, { maxUnitsThisTurn: 1 });
      const latest = findCrawl(readDb(), id);
      if (!latest || latest.status !== 'running') {
        activeIds = activeIds.filter(x => x !== id);
        console.log(`[sync] site crawl for ${latest?.siteUrl || id} finished with status: ${latest?.status || 'gone'}`);
      }
    }
    round++;
    if (activeIds.length > 0 && round % ROUND_ROBIN_SUMMARY_EVERY_ROUNDS === 0) {
      logRoundRobinSummary(activeIds);
    }
  }
}

// Registers (or finds by URL/name) a series and immediately discovers +
// downloads its chapters - the CLI's equivalent of the old "add series" form
// plus an immediate scrape, since there's no UI to come back and click
// "scrape" later.
//
// scrape: false skips the download step entirely, leaving newly-discovered
// chapters as pending records for syncAllSeries to pick up later - used by
// checkLatestUpdatesForSite, which needs to stay fast regardless of how
// large a backlog any single front-page series happens to have (a series
// with a big pending backlog used to make this "quick" 2-page check take
// as long as that one series' entire backlog, sometimes days - see the
// 2026-09-26 fix alongside this one).
async function addSeriesCommand(url, { name, stealth, scrape = true } = {}) {
  const seriesUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  const db = readDb();
  if (!db.series) db.series = [];

  const fallbackName = (name && name.trim()) || new URL(seriesUrl).pathname.split('/').filter(Boolean).pop() || seriesUrl;
  const normalizedName = normalizeForComparison(fallbackName);
  let series = db.series.find(s => normalizeForComparison(s.name) === normalizedName || s.seriesUrl === seriesUrl);

  if (!series) {
    series = {
      id: Date.now().toString(),
      name: fallbackName,
      useStealth: !!stealth,
      metadata: null,
      metadataFetchedAt: null,
      createdAt: new Date().toISOString(),
      seriesUrl,
      sourceUrls: [],
      chapters: []
    };
    const possibleDuplicates = findPossibleDuplicateSeries(db, series);
    if (possibleDuplicates.length > 0) {
      console.warn(`[add] "${fallbackName}" looks similar to already-tracked series: ${possibleDuplicates.map(d => d.name).join(', ')}`);
    }
    db.series.push(series);
    saveSeries(series);
    console.log(`[add] created series "${fallbackName}" (${series.id})`);
  } else {
    console.log(`[add] "${series.name}" is already tracked (${series.id}) - syncing it`);
  }

  const result = await discoverAndAddNewChapters(db, series, seriesUrl);
  if (result.disallowed) throw new Error(`robots.txt disallows ${seriesUrl}`);
  if (result.fetchFailed) throw new Error(`could not fetch ${seriesUrl}`);
  // discoverAndAddNewChapters just pushed new chapters onto series.chapters
  // in memory - saveSeries() (not saveSeriesMetadata(), which explicitly
  // skips chapters/images) must run before the scrape below or its first
  // image insert violates the images.chapterId foreign key against a
  // chapters row that was never written.
  saveSeries(series);
  console.log(`[add] discovered ${result.discoveredCount} chapter(s), ${result.addedCount} new`);

  if (!scrape) return;

  const { scrapedCount, blockedEarly } = await runScrapeAllForSeries(db, series);
  console.log(`[add] scraped ${scrapedCount} chapter(s)${blockedEarly ? ' (stopped early - site blocked)' : ''}`);
}

// How many of a site's own listing pages (its homepage, then whatever
// pagination it exposes) to walk when checking for newly-updated/newly-
// added series - see checkLatestUpdatesForSite below. Deliberately tiny
// compared to a full whole-site crawl (MAX_LISTING_PAGES=400, meant to
// discover an entire catalog once): most manga aggregator homepages
// surface recently-updated series at the front, so a handful of pages is
// enough to catch what's new without paying for an exhaustive crawl.
// Lowered from 5 to 2 (2026-09-20): a front-page series with a large
// backlog makes addSeriesCommand fully scrape it before this check can
// return (see repairMysqlSync/cover-backfill ordering notes above), so 5
// pages was making this "quick" check too slow to keep up with how often
// it's meant to run.
const LATEST_UPDATES_MAX_PAGES = 2;
// How often to re-run that check per site - see runDueLatestUpdatesChecks.
const LATEST_UPDATES_INTERVAL_MS = 12 * 60 * 60 * 1000;
// Which site homepages get the check at all - empty/unset = feature off
// (opt-in, same posture as ACTIVE_DISCOVERY_ORIGINS above).
const LATEST_UPDATES_SITE_URLS = (process.env.LATEST_UPDATES_SITE_URLS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Walks up to `maxPages` of a site's listing pages (following whatever
// pagination discoverSeriesLinksFromHtml/findNextListingPageUrl - the same
// helpers runSiteCrawl's discovery phase uses - can find from the given
// starting URL), collects every series link seen, and feeds each one
// through addSeriesCommand: if we already track it, that's just a normal
// discover-new-chapters-and-scrape pass; if we don't, it gets created and
// scraped from scratch. Either way this is exactly "if we have it, update
// it; if not, add it" with no separate logic needed here.
async function checkLatestUpdatesForSite(siteUrl, maxPages = LATEST_UPDATES_MAX_PAGES, { dryRun = false } = {}) {
  console.log(`[latest-updates] checking first ${maxPages} listing page(s) of ${siteUrl}...`);

  let pageUrl = siteUrl;
  const visited = new Set();
  const seriesLinks = new Map(); // url -> {url, name}

  for (let page = 1; page <= maxPages && pageUrl && !visited.has(pageUrl); page++) {
    visited.add(pageUrl);
    const pageOrigin = originOf(pageUrl);
    if (!pageOrigin) break;

    let robotsRules = { disallowPaths: [], crawlDelaySeconds: null };
    const { disallowed, html } = await runExclusiveByOrigin(pageUrl, async () => {
      const robotsText = await fetchTextOrNull(`${pageOrigin}/robots.txt`, 8000, false);
      robotsRules = robotsText ? parseRobotsRules(robotsText) : robotsRules;
      if (isPathDisallowed(pageUrl, robotsRules.disallowPaths)) {
        return { disallowed: true, html: null };
      }
      return { disallowed: false, html: await fetchTextOrNull(pageUrl, 15000, false) };
    });

    if (disallowed) {
      console.warn(`[latest-updates] robots.txt disallows ${pageUrl} - stopping early`);
      break;
    }
    if (!html) {
      console.warn(`[latest-updates] could not fetch ${pageUrl} - stopping early`);
      break;
    }

    for (const link of discoverSeriesLinksFromHtml(html, pageUrl)) {
      if (!seriesLinks.has(link.url)) seriesLinks.set(link.url, link);
    }

    const nextPage = findNextListingPageUrl(html, pageUrl);
    pageUrl = (nextPage && !visited.has(nextPage)) ? nextPage : null;
    if (pageUrl && page < maxPages) {
      await sleep(computeNextDelayMs(robotsRules.crawlDelaySeconds));
    }
  }

  console.log(`[latest-updates] found ${seriesLinks.size} series link(s) across ${visited.size} page(s) of ${siteUrl}`);

  if (dryRun) {
    // Preview only - used by the `check-latest-updates --dry-run` CLI
    // command to see what a real run WOULD do without touching R2/MySQL.
    const db = readDb();
    for (const { url, name } of seriesLinks.values()) {
      const tracked = (db.series || []).find(s => s.seriesUrl === url || (s.sourceUrls || []).includes(url));
      console.log(`[latest-updates]   ${tracked ? 'ALREADY TRACKED' : 'NEW'} - "${name}" - ${url}`);
    }
    console.log(`[latest-updates] dry-run: would process ${seriesLinks.size} series link(s), nothing written`);
    return;
  }

  let okCount = 0;
  for (const { url, name } of seriesLinks.values()) {
    try {
      // Pass the title actually seen on the listing tile through as the
      // fallback name (addSeriesCommand only uses it if this isn't already
      // a tracked series, or as the name to create a new one with) -
      // normalizeForComparison strips non-ASCII/punctuation, so a Thai
      // subtitle baked into the tile text ("Lookism ลุกคิซึม") still
      // matches an existing plain "Lookism" row. Previously this was
      // dropped entirely, leaving addSeriesCommand to fall back to a raw
      // URL-slug name that never gets replaced if the one metadata-fetch
      // attempt on creation fails (see backfillCoverImages above).
      //
      // scrape: false - this check's whole point is to stay fast regardless
      // of any single series' backlog size, so it only registers the
      // series and discovers chapter links here; syncAllSeries (which
      // main() always runs right after this) does the actual downloading,
      // round-robined fairly across every tracked series instead of
      // draining whichever one happened to be on the front page first.
      await addSeriesCommand(url, { name, scrape: false });
      okCount++;
    } catch (err) {
      console.error(`[latest-updates] failed for ${url}:`, err.message);
    }
  }
  console.log(`[latest-updates] done with ${siteUrl}: ${okCount}/${seriesLinks.size} series link(s) processed successfully`);
}

// Runs checkLatestUpdatesForSite for each configured site, but only once
// per LATEST_UPDATES_INTERVAL_MS - the last-checked timestamp is persisted
// in the store blob (db.latestUpdatesChecks) the same way db.siteCrawls is,
// so the cadence holds regardless of how often (or briefly) this process
// itself gets invoked by cron/docker.
async function runDueLatestUpdatesChecks(db) {
  if (LATEST_UPDATES_SITE_URLS.length === 0) return;
  if (!db.latestUpdatesChecks) db.latestUpdatesChecks = {};

  for (const siteUrl of LATEST_UPDATES_SITE_URLS) {
    const lastCheckedAt = db.latestUpdatesChecks[siteUrl];
    const msSinceLastCheck = lastCheckedAt ? Date.now() - new Date(lastCheckedAt).getTime() : Infinity;
    if (msSinceLastCheck < LATEST_UPDATES_INTERVAL_MS) {
      console.log(`[latest-updates] ${siteUrl} last checked ${(msSinceLastCheck / 3600000).toFixed(1)}h ago - not due yet`);
      continue;
    }
    await checkLatestUpdatesForSite(siteUrl);
    db.latestUpdatesChecks[siteUrl] = new Date().toISOString();
    writeDb(db);
  }
}

// Wipes the cross-chapter dedup bookkeeping (seenAssetUrls/Hashes,
// sharedAssetUrls/Hashes, assetPHashLog) for one series so the next scrape
// relearns which images are genuinely shared site furniture from scratch -
// use this after a false-positive blacklist entry (or a threshold/logic
// change like this one) has already poisoned a series' saved state.
async function resetDedupCommand(url) {
  const seriesUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  const db = readDb();
  const series = (db.series || []).find(s => s.seriesUrl === seriesUrl || (s.sourceUrls || []).includes(seriesUrl));
  if (!series) throw new Error(`No tracked series found for ${seriesUrl}`);

  DEDUP_STATE_FIELDS.forEach(field => {
    series[field] = field === 'seenAssetUrls' || field === 'seenAssetHashes' ? {} : [];
  });
  saveSeriesMetadata(series);
  console.log(`[reset-dedup] cleared dedup state for "${series.name}" (${series.id})`);
}

// Starts (or resumes) a whole-site crawl and runs it to completion in this
// process - unlike the old web handler, which only kicked the crawl off and
// returned immediately, a CLI invocation has to wait for it since nothing
// else is left running once the process exits.
async function crawlCommand(url, { stealth } = {}) {
  const formattedUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  const targetOrigin = new URL(formattedUrl).origin;

  const db = readDb();
  if (!db.siteCrawls) db.siteCrawls = [];
  let crawl = db.siteCrawls.find(c => {
    try { return new URL(c.siteUrl).origin === targetOrigin; } catch { return false; }
  });

  if (!crawl) {
    crawl = {
      id: Date.now().toString(),
      siteUrl: formattedUrl,
      useStealth: !!stealth,
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
    db.siteCrawls.push(crawl);
    console.log(`[crawl] starting new crawl for ${formattedUrl} (${crawl.id})`);
  } else {
    crawl.status = 'running';
    crawl.lastError = null;
    console.log(`[crawl] resuming crawl for ${formattedUrl} (${crawl.id})`);
  }
  writeDb(db);

  crawlControl[crawl.id] = { stopRequested: false };
  await runSiteCrawl(crawl.id);

  const finalDb = readDb();
  const finalCrawl = findCrawl(finalDb, crawl.id);
  console.log(`[crawl] finished: status=${finalCrawl?.status}, series processed=${finalCrawl?.stats?.seriesProcessed ?? 0}`);
}

function parseArgs(argv) {
  const [cmd, arg, ...rest] = argv;
  const stealth = rest.includes('--stealth');
  const nameFlag = rest.find(a => a.startsWith('--name='));
  const name = nameFlag ? nameFlag.slice('--name='.length) : undefined;
  const dryRun = rest.includes('--dry-run');
  return { cmd, arg, stealth, name, dryRun };
}

// Every command shares one Chrome profile dir (CHROME_PROFILE_DIR above),
// and getBrowser() pkills whatever's already holding it before launching -
// fine for cleaning up a stale process from a previous crash, but two bot.js
// invocations running at the same time would pkill each other's live Chrome
// mid-scrape. Serialize the whole process instead of patching that one
// spot: a second invocation waits here for the first to finish.
//
// Staleness is judged by a heartbeat timestamp, NOT by checking whether the
// holder's PID is still alive - `server/data` (and this lock file with it)
// is a volume shared across separate Docker containers, each with its own
// independent PID namespace starting back at 1. A PID recorded by a
// previous container is essentially guaranteed to coincidentally match some
// unrelated process in the next container, so a PID-liveness check would
// almost always report a long-dead lock as "still alive" and hang forever
// under Docker specifically (this happened - see git history).
const LOCK_FILE = path.join(DATA_DIR, 'bot.lock');
const LOCK_POLL_MS = 3000;
const LOCK_LOG_EVERY_MS = 15000; // don't spam "waiting..." every 3s
const LOCK_HEARTBEAT_MS = 20000; // how often the holder proves it's still alive
const LOCK_STALE_MS = 90000; // 3+ missed heartbeats = holder is gone, safe to steal

function touchLock() {
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, updatedAt: Date.now() }));
}

let lockHeartbeatTimer = null;

async function acquireLock() {
  let waited = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx'); // atomic create; throws EEXIST if already locked
      fs.closeSync(fd);
      touchLock();
      lockHeartbeatTimer = setInterval(touchLock, LOCK_HEARTBEAT_MS);
      lockHeartbeatTimer.unref?.(); // don't let the heartbeat itself keep the process alive
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (e) { /* corrupt/empty - treat as stale below */ }
      const age = holder?.updatedAt ? Date.now() - holder.updatedAt : Infinity;
      if (age > LOCK_STALE_MS) {
        // No heartbeat in a while - the previous holder crashed, was killed,
        // or (Docker) its container is simply gone. Safe to take over.
        fs.rmSync(LOCK_FILE, { force: true });
        continue;
      }

      if (waited % LOCK_LOG_EVERY_MS === 0) {
        console.log(`[lock] another bot.js run (pid ${holder?.pid ?? '?'}) is in progress - waiting...`);
      }
      await sleep(LOCK_POLL_MS);
      waited += LOCK_POLL_MS;
    }
  }
}

function releaseLock() {
  if (lockHeartbeatTimer) clearInterval(lockHeartbeatTimer);
  try {
    const holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (holder.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch (e) { /* already gone - nothing to do */ }
}

async function main() {
  const { cmd, arg, stealth, name, dryRun } = parseArgs(process.argv.slice(2));

  if (cmd === 'add') {
    if (!arg) throw new Error('Usage: node server/bot.js add <seriesUrl> [--name="..."] [--stealth]');
    await addSeriesCommand(arg, { name, stealth });
  } else if (cmd === 'crawl') {
    if (!arg) throw new Error('Usage: node server/bot.js crawl <siteUrl> [--stealth]');
    await crawlCommand(arg, { stealth });
  } else if (cmd === 'repair-sync') {
    await repairMysqlSync(readDb());
  } else if (cmd === 'reset-dedup') {
    if (!arg) throw new Error('Usage: node server/bot.js reset-dedup <seriesUrl>');
    await resetDedupCommand(arg);
  } else if (cmd === 'check-latest-updates') {
    if (!arg) throw new Error('Usage: node server/bot.js check-latest-updates <siteUrl> [--dry-run]');
    await checkLatestUpdatesForSite(arg, LATEST_UPDATES_MAX_PAGES, { dryRun });
  } else if (cmd === 'repair-entities') {
    await repairEntityTitlesCommand();
  } else if (cmd === 'remove-series') {
    if (!arg) throw new Error('Usage: node server/bot.js remove-series <seriesId>');
    if (!readDb().series.some(s => s.id === arg)) throw new Error(`No tracked series with id "${arg}"`);
    deleteSeriesRow(arg);
    console.log(`[remove-series] stopped tracking "${arg}" - its chapters/images are gone from the bot's own DB (the live website row is untouched; delete that separately if needed)`);
  } else if (!cmd) {
    const db = readDb();
    // Runs before EVERYTHING else. A missing cover costs one page fetch +
    // one image download; nothing else this run might do should be able to
    // delay that.
    const coverResult = await backfillCoverImages(db);
    if (coverResult.downloaded > 0) console.log(`[sync] downloaded ${coverResult.downloaded} new cover(s)`);
    // Same reasoning as the cover backfill just above, run right alongside
    // it: this only pushes chapters that already finished downloading in a
    // previous run (images already sit in R2, so it's 1-2 MySQL queries per
    // series, no scraping) - a reader shouldn't have to wait behind a fresh
    // multi-hundred-chapter backlog to see content the bot already has.
    const repairedNowCount = await repairMysqlSync(readDb());
    if (repairedNowCount > 0) console.log(`[sync] re-synced ${repairedNowCount} already-downloaded chapter(s) that were missing from the live site`);
    // Runs next, before resumeRunningCrawls below. checkLatestUpdatesForSite
    // (inside runDueLatestUpdatesChecks) now only discovers chapter links
    // for whatever it finds on the front pages (scrape: false - see there),
    // so it stays quick regardless of any single series' backlog size.
    await runDueLatestUpdatesChecks(db);
    // Runs before resumeRunningCrawls (whole-site discovery of BRAND NEW
    // series, lowest priority - see its own round-robin/while loop, which
    // can genuinely take days to fully finish one pass). syncAllSeries keeps
    // every ALREADY-tracked series current (round-robined one chapter at a
    // time per series - see SYNC_MAX_CHAPTERS_PER_SERIES_PER_ROUND) and must
    // never wait behind that: a reader following an ongoing series shouldn't
    // go stale for days just because the bot is also mid-crawl discovering
    // an entirely new site's catalog. Old, not-yet-discovered backlogs can
    // wait - freshness of what's already live can't.
    await syncAllSeries(readDb());
    await resumeRunningCrawls(readDb());
    // Cheap catch-up pass every regular run too, not just on-demand - covers
    // chapters that finished downloading while MySQL was briefly unreachable
    // during THIS run (or a previous one) without needing a separate command.
    await repairMysqlSync(readDb());
  } else {
    throw new Error(`Unknown command "${cmd}". Usage: node server/bot.js [add <url> | crawl <url> | repair-sync | reset-dedup <seriesUrl> | check-latest-updates <siteUrl> [--dry-run] | repair-entities | remove-series <seriesId>]`);
  }
}

acquireLock()
  .then(() => main())
  .then(() => shutdownBrowser())
  .then(() => mysqlPool.end())
  .then(() => { releaseLock(); process.exit(0); })
  .catch(async (err) => {
    console.error(err);
    await shutdownBrowser();
    await mysqlPool.end().catch(() => {});
    releaseLock();
    process.exit(1);
  });

