import React, { useState, useEffect } from 'react';
import './App.css';
import { useNotifications, ToastStack, ConfirmModal } from './components/Notifications';
import Icon from './components/Icon';

// Sparkline component to display a neat visual grid of recent check results.
function Sparkline({ checks }) {
  if (!checks || checks.length === 0) {
    return (
      <div className="sparkline-container">
        <span className="meta-label">History</span>
        <div className="sparkline-bars" style={{ height: '24px', display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>No data yet</span>
        </div>
      </div>
    );
  }

  // Get last 20 checks
  const recentChecks = checks.slice(-20);
  
  // Find max response time to scale the height of green bars
  const maxResponse = Math.max(...recentChecks.map(c => c.status === 'up' ? c.responseTime : 0), 200);

  return (
    <div className="sparkline-container">
      <span className="meta-label">History (Last {recentChecks.length})</span>
      <div className="sparkline-bars">
        {recentChecks.map((check, index) => {
          const isUp = check.status === 'up';
          // Calculate height percentage (min 15%, max 100%)
          const heightPct = isUp 
            ? Math.max(15, Math.min(100, (check.responseTime / maxResponse) * 100))
            : 100;
          
          const timeString = new Date(check.timestamp).toLocaleTimeString();
          const tooltipText = `Checked: ${timeString}\nStatus: ${check.status.toUpperCase()}\nResponse Time: ${isUp ? `${check.responseTime}ms` : 'N/A'}${check.error ? `\nError: ${check.error}` : ''}`;
          
          return (
            <div
              key={index}
              className={`sparkline-bar ${isUp ? '' : 'bar-down'}`}
              style={{ height: `${heightPct}%` }}
              title={tooltipText}
            />
          );
        })}
      </div>
    </div>
  );
}

function App() {
  const { notify, confirmAction, toasts, dismissToast, confirmState, resolveConfirm } = useNotifications();

  const [theme, setTheme] = useState(() => localStorage.getItem('robot-hub-theme') || 'light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('robot-hub-theme', theme);
  }, [theme]);

  const [monitors, setMonitors] = useState([]);
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({ total: 0, up: 0, down: 0, unknown: 0, avgResponseTime: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modals state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingMonitor, setEditingMonitor] = useState(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deletingMonitor, setDeletingMonitor] = useState(null);
  const [isClearLogsModalOpen, setIsClearLogsModalOpen] = useState(false);
  const [isGalleryModalOpen, setIsGalleryModalOpen] = useState(false);
  const [galleryMonitorId, setGalleryMonitorId] = useState('');
  const [galleryMonitorName, setGalleryMonitorName] = useState('');
  const [galleryImages, setGalleryImages] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState(null);
  const [savedImages, setSavedImages] = useState([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedError, setSavedError] = useState(null);
  const [savingImageUrls, setSavingImageUrls] = useState({});
  const [isSavingAll, setIsSavingAll] = useState(false);
  const [activeSavedTab, setActiveSavedTab] = useState('');
  const [visibleTypes, setVisibleTypes] = useState({ ad: true, content: true, manga: true });
  const [selectedImageIds, setSelectedImageIds] = useState({});
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [selectedGalleryUrls, setSelectedGalleryUrls] = useState({});
  const [isSavingSelected, setIsSavingSelected] = useState(false);
  const [isPagesModalOpen, setIsPagesModalOpen] = useState(false);
  const [pagesMonitorId, setPagesMonitorId] = useState('');
  const [pagesMonitorName, setPagesMonitorName] = useState('');
  const [pagesResult, setPagesResult] = useState(null);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [pagesError, setPagesError] = useState(null);

  // Manga Downloader state
  const [seriesList, setSeriesList] = useState([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesError, setSeriesError] = useState(null);
  const [selectedSeriesId, setSelectedSeriesId] = useState('');
  const [newSeriesName, setNewSeriesName] = useState('');
  const [isAddingSeries, setIsAddingSeries] = useState(false);
  const [newChapterName, setNewChapterName] = useState('');
  const [newChapterUrl, setNewChapterUrl] = useState('');
  const [currentView, setCurrentView] = useState('monitor'); // 'monitor', 'library', 'downloader', 'gallery'
  const [isAddingChapter, setIsAddingChapter] = useState(false);
  const [showManualChapterForm, setShowManualChapterForm] = useState(false);
  const [showDownloaderInfo, setShowDownloaderInfo] = useState(false);
  const [scrapingChapterIds, setScrapingChapterIds] = useState({});
  const [expandedChapterId, setExpandedChapterId] = useState('');
  const [discoverUrl, setDiscoverUrl] = useState('');
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isScrapingAll, setIsScrapingAll] = useState(false);
  const [isRetryingProblems, setIsRetryingProblems] = useState(false);
  const [autoRetryEnabled, setAutoRetryEnabled] = useState(true);
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(true);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [isFetchingMetadata, setIsFetchingMetadata] = useState(false);
  const [isExportingSeries, setIsExportingSeries] = useState(false);
  const [isCleaningDuplicates, setIsCleaningDuplicates] = useState(false);
  const [isDownloadingCovers, setIsDownloadingCovers] = useState(false);
  const [showSeriesMetadata, setShowSeriesMetadata] = useState(false);
  const [expandedLibrarySeoIds, setExpandedLibrarySeoIds] = useState({});
  // A series can have hundreds of chapters - rendering every single one as a
  // full DOM card causes serious jank on every 2s poll refresh (which feels
  // like constant spinning/lag) and reflows the page enough to visibly kick
  // the scroll position around. Default to only the chapters still needing
  // work, and render them a page at a time.
  const [showDoneChapters, setShowDoneChapters] = useState(false);
  const [chapterVisibleCount, setChapterVisibleCount] = useState(50);
  const CHAPTER_PAGE_SIZE = 50;

  // Whole-site crawl state
  const [siteCrawls, setSiteCrawls] = useState([]);
  const [crawlSiteUrl, setCrawlSiteUrl] = useState('');
  const [isStartingCrawl, setIsStartingCrawl] = useState(false);
  const [expandedCrawlId, setExpandedCrawlId] = useState('');
  const [useStealthCrawl, setUseStealthCrawl] = useState(false);
  const [useStealthAdd, setUseStealthAdd] = useState(false);

  // Manga Library Dashboard state
  const [libraryFilter, setLibraryFilter] = useState('all'); // all, complete, incomplete
  const [librarySearch, setLibrarySearch] = useState('');
  const [libraryPage, setLibraryPage] = useState(1);
  const LIBRARY_PAGE_SIZE = 24;

  // Metadata (label/icon) for the heuristic image type classification
  const SAVED_TYPE_META = {
    ad: { label: 'โฆษณา', icon: <Icon name="megaphone" size={13} /> },
    content: { label: 'ข้อมูล', icon: <Icon name="file-text" size={13} /> },
    manga: { label: 'อื่นๆ', icon: <Icon name="book-open" size={13} /> }
  };

  // Form states
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formInterval, setFormInterval] = useState('60');

  // Individual monitor checking state
  const [checkingIds, setCheckingIds] = useState({});

  // Fetch all dashboard data
  const fetchData = async () => {
    try {
      const [monitorsRes, logsRes, statsRes] = await Promise.all([
        fetch('/api/monitors'),
        fetch('/api/logs'),
        fetch('/api/stats')
      ]);

      if (!monitorsRes.ok || !logsRes.ok || !statsRes.ok) {
        throw new Error('Failed to fetch data from server');
      }

      const monitorsData = await monitorsRes.json();
      const logsData = await logsRes.json();
      const statsData = await statsRes.json();

      setMonitors(monitorsData);
      setLogs(logsData);
      setStats(statsData);
      setError(null);
    } catch (err) {
      console.error('Fetch error:', err);
      setError('Could not connect to the backend server. Please verify it is running.');
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch and set interval polling
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  // Handle Add Monitor
  const handleAddSubmit = async (e) => {
    e.preventDefault();
    if (!formName || !formUrl) return;

    try {
      const res = await fetch('/api/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName,
          url: formUrl,
          interval: parseInt(formInterval, 10)
        })
      });

      if (!res.ok) throw new Error('Failed to add monitor');

      // Reset form & close modal
      setFormName('');
      setFormUrl('');
      setFormInterval('60');
      setIsAddModalOpen(false);
      
      // Refresh
      fetchData();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Handle Edit Monitor Click
  const openEditModal = (monitor) => {
    setEditingMonitor(monitor);
    setFormName(monitor.name);
    setFormUrl(monitor.url);
    setFormInterval(monitor.interval.toString());
    setIsEditModalOpen(true);
  };

  // Handle Edit Submit
  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingMonitor || !formName || !formUrl) return;

    try {
      const res = await fetch(`/api/monitors/${editingMonitor.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName,
          url: formUrl,
          interval: parseInt(formInterval, 10)
        })
      });

      if (!res.ok) throw new Error('Failed to update monitor');

      // Reset & close
      setEditingMonitor(null);
      setFormName('');
      setFormUrl('');
      setFormInterval('60');
      setIsEditModalOpen(false);

      // Refresh
      fetchData();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Handle Toggle Active
  const handleToggleActive = async (monitor) => {
    try {
      const res = await fetch(`/api/monitors/${monitor.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          active: !monitor.active
        })
      });

      if (!res.ok) throw new Error('Failed to toggle status');
      fetchData();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Handle Delete Monitor Modal Open
  const openDeleteModal = (monitor) => {
    setDeletingMonitor(monitor);
    setIsDeleteModalOpen(true);
  };

  // Confirm Delete Monitor
  const confirmDeleteMonitor = async () => {
    if (!deletingMonitor) return;
    try {
      const res = await fetch(`/api/monitors/${deletingMonitor.id}`, {
        method: 'DELETE'
      });

      if (!res.ok) throw new Error('Failed to delete monitor');
      setIsDeleteModalOpen(false);
      setDeletingMonitor(null);
      fetchData();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Handle Open Image Gallery
  const handleOpenGallery = async (monitor) => {
    setGalleryMonitorId(monitor.id);
    setGalleryMonitorName(monitor.name);
    setGalleryImages([]);
    setGalleryLoading(true);
    setGalleryError(null);
    setIsGalleryModalOpen(true);
    setSelectedGalleryUrls({});

    try {
      const res = await fetch(`/api/monitors/${monitor.id}/images`);
      if (!res.ok) {
        throw new Error('Failed to fetch images from this site');
      }
      const data = await res.json();
      setGalleryImages(data.images || []);
    } catch (err) {
      setGalleryError(err.message || 'Error occurred while loading images');
    } finally {
      setGalleryLoading(false);
    }
  };

  // Handle Open Site Pages Scan (discovers pages via sitemap.xml, checks each one's status + images)
  const handleOpenPagesScan = async (monitor) => {
    setPagesMonitorId(monitor.id);
    setPagesMonitorName(monitor.name);
    setPagesResult(null);
    setPagesLoading(true);
    setPagesError(null);
    setIsPagesModalOpen(true);

    try {
      const res = await fetch(`/api/monitors/${monitor.id}/pages`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to scan site pages');
      }
      setPagesResult(data);
    } catch (err) {
      setPagesError(err.message || 'Error occurred while scanning site pages');
    } finally {
      setPagesLoading(false);
    }
  };

  // Fetch all manga series
  // showSpinner is only true for the initial load - the 2s background poll
  // (see the polling effect below) must NOT flip seriesLoading, or the
  // entire series/chapters section unmounts to a bare spinner and remounts
  // every single poll, which is what was causing the constant "reload"
  // flicker and resetting the user's scroll position every couple seconds.
  const fetchSeries = async (showSpinner = true) => {
    if (showSpinner) setSeriesLoading(true);
    setSeriesError(null);
    try {
      const res = await fetch('/api/series');
      if (!res.ok) throw new Error('Failed to fetch manga series');
      const data = await res.json();
      setSeriesList(data);
      // Auto-pick a series and sync the discover-URL field ONLY on an explicit
      // load (showSpinner), never on the 2s background poll - otherwise the poll
      // overwrites whatever the user is typing in the URL box (and yanks their
      // selection) every couple seconds, which is why text kept "disappearing".
      if (showSpinner) {
        setSelectedSeriesId(prev => {
          const incompleteList = data.filter(s => !s.chapters || s.chapters.length === 0 || s.chapters.some(c => c.status !== 'done'));
          const nextId = prev && incompleteList.some(s => s.id === prev) ? prev : (incompleteList.length > 0 ? incompleteList[0].id : '');
          const nextSeries = data.find(s => s.id === nextId);
          setDiscoverUrl(nextSeries?.seriesUrl || '');
          return nextId;
        });
      }
    } catch (err) {
      setSeriesError(err.message);
    } finally {
      setSeriesLoading(false);
    }
  };

  // Select a series in the left pane, syncing the discover-URL input to it
  const handleSelectSeries = (series) => {
    setSelectedSeriesId(series.id);
    setExpandedChapterId('');
    setDiscoverUrl(series.seriesUrl || '');
    setChapterVisibleCount(CHAPTER_PAGE_SIZE);
  };

  // Auto-discover every chapter link from a series' "all chapters" page
  const handleDiscoverChapters = async (e) => {
    e.preventDefault();
    if (!selectedSeriesId || !discoverUrl.trim()) return;

    setIsDiscovering(true);
    try {
      const res = await fetch(`/api/series/${selectedSeriesId}/discover-chapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: discoverUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to discover chapters');

      notify.success(`พบ ${data.discoveredCount} ตอน — เพิ่มใหม่ ${data.addedCount} ตอน${data.skippedCount > 0 ? ` (ข้าม ${data.skippedCount} ตอนที่มีอยู่แล้ว)` : ''} — กำลังโหลดให้แล้ว (โหลดไป ${data.scrapedCount} ครั้ง)`);
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsDiscovering(false);
    }
  };

  // Scrape every chapter in the selected series that hasn't finished downloading yet
  const handleScrapeAllChapters = async (seriesId) => {
    if (isScrapingAll) return;
    if (!(await confirmAction('บอทจะไล่โหลดทุกตอนที่ยังไม่เสร็จทีละตอน อาจใช้เวลานาน ต้องการดำเนินการต่อหรือไม่?'))) return;

    setIsScrapingAll(true);
    try {
      const res = await fetch(`/api/series/${seriesId}/scrape-all`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to scrape all chapters');

      notify.success(`โหลดไปแล้ว ${data.scrapedCount} ตอน${data.blockedEarly ? '\nเว็บเริ่มบล็อกระหว่างทาง ระบบเลยหยุดให้อัตโนมัติ' : ''}`);
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsScrapingAll(false);
    }
  };

  // Re-download the chapters that ended up incomplete (error/partial/blocked),
  // even the ones that already used up their auto-retry budget - resets their
  // counter server-side and runs the same download loop as scrape-all.
  const handleRetryProblemChapters = async (seriesId) => {
    if (isRetryingProblems || isScrapingAll) return;
    if (!(await confirmAction('ลองโหลดเฉพาะตอนที่มีปัญหา (error/โหลดไม่ครบ) ใหม่ทั้งหมด รวมตอนที่ครบ 3 ครั้งแล้วด้วย ต้องการดำเนินการต่อหรือไม่?'))) return;

    setIsRetryingProblems(true);
    try {
      const res = await fetch(`/api/series/${seriesId}/retry-problem-chapters`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to retry problem chapters');

      notify.success(data.message
        ? data.message
        : `ลองโหลดตอนที่มีปัญหา ${data.retriedProblemCount ?? ''} ตอนใหม่ (โหลดไป ${data.scrapedCount} ครั้ง)${data.blockedEarly ? '\nเว็บเริ่มบล็อกระหว่างทาง ระบบเลยหยุดให้อัตโนมัติ' : ''}`);
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsRetryingProblems(false);
    }
  };

  // (Re-)fetch SEO metadata (synopsis, genres, author/artist, status,
  // rating, views, ...) from the series' own detail page
  const handleFetchSeriesMetadata = async (seriesId) => {
    if (isFetchingMetadata) return;
    setIsFetchingMetadata(true);
    try {
      const res = await fetch(`/api/series/${seriesId}/fetch-metadata`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch SEO metadata');
      setShowSeriesMetadata(true);
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsFetchingMetadata(false);
    }
  };

  // Checks whether a series' tracked chapters have any holes in their
  // numbering (e.g. has 1-255 and 257-880 but no 256 anywhere) - separate
  // from download status, since a "gap" here means the chapter was never
  // even discovered, not just left pending.
  const [isCheckingGaps, setIsCheckingGaps] = useState(false);
  const handleCheckChapterGaps = async (seriesId) => {
    if (isCheckingGaps) return;
    setIsCheckingGaps(true);
    try {
      const res = await fetch(`/api/series/${seriesId}/chapter-gaps`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to check chapter gaps');
      if (data.missing.length === 0) {
        notify.success(`ตอนที่ ${data.min}-${data.max} ครบทุกตอน ไม่มีตอนขาดหาย`);
      } else {
        notify.info(`ขาดตอนที่: ${data.missing.join(', ')} (จากช่วง ${data.min}-${data.max})`);
      }
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsCheckingGaps(false);
    }
  };

  // Copy every finished chapter into a human-readable <title>/<chapter>/
  // export folder alongside a metadata.json carrying the SEO fields above
  const handleExportSeries = async (seriesId) => {
    if (isExportingSeries) return;
    setIsExportingSeries(true);
    try {
      const res = await fetch(`/api/series/${seriesId}/export`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to export series');
      notify.success(`Export แล้ว ${data.exportedChapterCount} ตอน\nไปที่: server/data/${data.exportPath}`);
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsExportingSeries(false);
    }
  };

  // Hash every downloaded image in the series and strip out any that turn
  // out to be byte-identical across 2+ chapters - a translator's ad/credit
  // slide re-uploaded fresh every chapter, which the URL-based ad filter
  // can't catch since its URL is different each time.
  const handleCleanDuplicateImages = async (seriesId) => {
    if (isCleaningDuplicates) return;
    setIsCleaningDuplicates(true);
    try {
      const res = await fetch(`/api/series/${seriesId}/clean-duplicate-images`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to clean duplicate images');
      notify.success(`ตรวจสอบ ${data.chaptersScanned} ตอน — ลบรูปซ้ำ ${data.imagesRemoved} รูป จาก ${data.chaptersAffected} ตอน\n(เหมือนเป๊ะ ${data.exactDuplicatesRemoved} รูป, หน้าตาคล้ายกันมาก ${data.nearDuplicatesRemoved} รูป)`);
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsCleaningDuplicates(false);
    }
  };

  // Fetch every whole-site crawl job (running, stopped, done, error)
  const fetchSiteCrawls = async () => {
    try {
      const res = await fetch('/api/site-crawls');
      if (!res.ok) return;
      setSiteCrawls(await res.json());
    } catch (err) {
      // Silent - this is a background poll, the main series list already
      // surfaces a connection error banner elsewhere.
    }
  };

  // Load the global bot-automation flags (auto-retry problem chapters, auto-check
  // for newly-released chapters).
  const fetchAutoRetrySetting = async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (typeof data.autoRetryEnabled === 'boolean') setAutoRetryEnabled(data.autoRetryEnabled);
      if (typeof data.autoUpdateEnabled === 'boolean') setAutoUpdateEnabled(data.autoUpdateEnabled);
    } catch (err) { /* keep current values on failure */ }
  };

  const saveBotSetting = async (key, enabled, setter) => {
    setter(enabled); // optimistic
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: enabled }),
      });
      const data = await res.json();
      if (typeof data[key] === 'boolean') setter(data[key]);
    } catch (err) {
      setter(!enabled); // revert on failure
      notify.error('บันทึกการตั้งค่าไม่สำเร็จ');
    }
  };
  const handleToggleAutoRetry = (enabled) => saveBotSetting('autoRetryEnabled', enabled, setAutoRetryEnabled);
  const handleToggleAutoUpdate = (enabled) => saveBotSetting('autoUpdateEnabled', enabled, setAutoUpdateEnabled);

  // Manually check a series for newly-released chapters and download just the new ones.
  const handleCheckUpdates = async (seriesId) => {
    if (isCheckingUpdates) return;
    setIsCheckingUpdates(true);
    try {
      const res = await fetch(`/api/series/${seriesId}/check-updates`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to check updates');
      notify.success(data.newChapters > 0
        ? `พบตอนใหม่ ${data.newChapters} ตอน กำลังโหลดให้แล้ว (โหลดไป ${data.scrapedCount} ครั้ง)`
        : 'ไม่มีตอนใหม่ — เป็นเวอร์ชันล่าสุดแล้ว');
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  // Backfills cover art for every series that has a known cover URL but no
  // downloaded file yet - safe to click repeatedly, each series only ever
  // downloads its cover once.
  const handleDownloadAllCovers = async () => {
    if (isDownloadingCovers) return;
    setIsDownloadingCovers(true);
    try {
      const res = await fetch('/api/series/download-covers', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to download covers');
      notify.success(`เช็คแล้ว ${data.checked} เรื่อง — ดาวน์โหลดปกใหม่ ${data.downloaded} เรื่อง`);
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsDownloadingCovers(false);
    }
  };

  // Open the Manga Downloader modal
  const handleOpenMangaModal = () => {
    setCurrentView('downloader');
    setExpandedChapterId('');
    fetchSeries();
    fetchSiteCrawls();
    fetchAutoRetrySetting();
  };

  // While the modal is open, poll for fresh chapter/crawl statuses so a
  // running scrape (single chapter, "scrape all", or a whole-site crawl)
  // visibly ticks forward as it goes, instead of only updating once
  // everything finishes.
  useEffect(() => {
    if (currentView !== 'downloader' && currentView !== 'library') return;
    const interval = setInterval(() => {
      fetchSeries(false);
      fetchSiteCrawls();
    }, 2000);
    return () => clearInterval(interval);
  }, [currentView]);

  // Start a whole-site crawl: hand over just the site's root/listing URL and
  // the bot discovers every series, then every chapter of every series, and
  // downloads them all on its own - see runSiteCrawl on the server.
  const handleStartCrawl = async (e) => {
    e.preventDefault();
    if (!crawlSiteUrl.trim()) return;

    setIsStartingCrawl(true);
    try {
      const res = await fetch('/api/site-crawls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: crawlSiteUrl, useStealth: useStealthCrawl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start site crawl');
      setCrawlSiteUrl('');
      fetchSiteCrawls();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsStartingCrawl(false);
    }
  };

  // Stop a running crawl - the bot bails out before its next chapter/page
  const handleStopCrawl = async (crawlId) => {
    try {
      const res = await fetch(`/api/site-crawls/${crawlId}/stop`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to stop crawl');
      fetchSiteCrawls();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Resume a stopped/errored crawl from wherever it left off
  const handleResumeCrawl = async (crawlId) => {
    try {
      const res = await fetch(`/api/site-crawls/${crawlId}/resume`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to resume crawl');
      fetchSiteCrawls();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Remove a crawl job's record (already-downloaded series/chapters are kept)
  const handleDeleteCrawl = async (crawlId) => {
    if (!(await confirmAction('ลบงานดึงทั้งเว็บนี้? (เรื่อง/ตอนที่โหลดไปแล้วจะยังอยู่ ไม่ถูกลบ)', { danger: true }))) return;
    try {
      const res = await fetch(`/api/site-crawls/${crawlId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete crawl');
      fetchSiteCrawls();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Metadata (label/color) for a crawl job's overall status
  const CRAWL_STATUS_META = {
    running: { label: 'กำลังทำงาน', color: 'var(--color-blue)', icon: <Icon name="refresh" size={13} /> },
    stopped: { label: 'หยุดแล้ว', color: 'var(--color-yellow)', icon: <Icon name="pause" size={13} /> },
    done: { label: 'เสร็จสมบูรณ์', color: 'var(--color-green)', icon: <Icon name="check" size={13} /> },
    error: { label: 'ผิดพลาด', color: 'var(--color-red)', icon: <Icon name="alert-triangle" size={13} /> }
  };

  // Add a new manga series (a "เรื่อง")
  const handleAddSeries = async (e) => {
    e.preventDefault();
    if (!newSeriesName.trim()) return;

    setIsAddingSeries(true);
    try {
      const res = await fetch('/api/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newSeriesName, useStealth: useStealthAdd })
      });
      if (!res.ok) throw new Error('Failed to create series');
      const created = await res.json();
      setNewSeriesName('');
      await fetchSeries();
      setSelectedSeriesId(created.id);
      setDiscoverUrl('');
      if (created.possibleDuplicates?.length > 0) {
        notify.info(`เรื่องนี้อาจซ้ำกับที่มีอยู่แล้ว: ${created.possibleDuplicates.map(d => d.name).join(', ')} — เช็คก่อนโหลดตอน จะได้ไม่โหลดซ้ำ`);
      }
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsAddingSeries(false);
    }
  };

  // Delete a manga series and everything downloaded under it
  const handleDeleteSeries = async (seriesId, seriesName) => {
    if (!(await confirmAction(`Are you sure you want to delete the series "${seriesName}" and all its downloaded chapters?`, { danger: true }))) return;
    try {
      const res = await fetch(`/api/series/${seriesId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete series');
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Add a new chapter ("ตอน") to the currently selected series
  const handleAddChapter = async (e) => {
    e.preventDefault();
    if (!selectedSeriesId || !newChapterName.trim() || !newChapterUrl.trim()) return;

    setIsAddingChapter(true);
    try {
      const res = await fetch(`/api/series/${selectedSeriesId}/chapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newChapterName, url: newChapterUrl })
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to add chapter');
      }
      setNewChapterName('');
      setNewChapterUrl('');
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsAddingChapter(false);
    }
  };

  // Delete a chapter and its downloaded images
  const handleDeleteChapter = async (seriesId, chapterId, chapterName) => {
    if (!(await confirmAction(`Are you sure you want to delete the chapter "${chapterName}"?`, { danger: true }))) return;
    try {
      const res = await fetch(`/api/series/${seriesId}/chapters/${chapterId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete chapter');
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Remove a single unwanted image (an ad/translator-credit slide the
  // automatic filters missed) from a chapter, without deleting the whole chapter
  const handleDeleteChapterImage = async (seriesId, chapterId, filename) => {
    if (!(await confirmAction('ลบรูปนี้ออกจากตอน?', { danger: true }))) return;
    try {
      const res = await fetch(`/api/series/${seriesId}/chapters/${chapterId}/images/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete image');
      fetchSeries();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Trigger the bot to scrape a chapter's page for manga-only images and
  // download them. Anti-block delays mean this can take a while - that's fine.
  const handleScrapeChapter = async (seriesId, chapterId) => {
    if (scrapingChapterIds[chapterId]) return;

    setScrapingChapterIds(prev => ({ ...prev, [chapterId]: true }));
    try {
      const res = await fetch(`/api/series/${seriesId}/chapters/${chapterId}/scrape`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to scrape chapter');
      await fetchSeries();
      setExpandedChapterId(chapterId);
    } catch (err) {
      notify.error(err.message);
      fetchSeries();
    } finally {
      setScrapingChapterIds(prev => ({ ...prev, [chapterId]: false }));
    }
  };

  // Mirrors MAX_CHAPTER_RETRIES on the server - just for the display hint
  // below, the server is what actually enforces the retry cap.
  const MAX_CHAPTER_RETRIES_DISPLAY = 3;

  // Metadata (label/color) for a chapter's scrape status
  const CHAPTER_STATUS_META = {
    pending: { label: 'ยังไม่โหลด', color: 'var(--color-text-muted)', icon: <Icon name="clock" size={12} /> },
    scraping: { label: 'กำลังโหลด...', color: 'var(--color-blue)', icon: <Icon name="refresh" size={12} /> },
    done: { label: 'โหลดสำเร็จ', color: 'var(--color-green)', icon: <Icon name="check" size={12} /> },
    partial: { label: 'โหลดได้บางส่วน', color: 'var(--color-yellow)', icon: <Icon name="alert-triangle" size={12} /> },
    blocked: { label: 'ถูกบล็อก', color: 'var(--color-red)', icon: <Icon name="ban" size={12} /> },
    error: { label: 'ผิดพลาด', color: 'var(--color-red)', icon: <Icon name="alert-triangle" size={12} /> }
  };

  // Fetch Saved Images List
  const fetchSavedImages = async () => {
    setSavedLoading(true);
    setSavedError(null);
    try {
      const res = await fetch('/api/images/saved');
      if (!res.ok) throw new Error('Failed to fetch saved images from server');
      const data = await res.json();
      setSavedImages(data);

      if (data.length > 0) {
        const uniqueGroups = Array.from(new Set(data.map(item => item.monitorId)));
        setActiveSavedTab(prev => {
          if (!prev || !uniqueGroups.includes(prev)) {
            return uniqueGroups[0];
          }
          return prev;
        });
      } else {
        setActiveSavedTab('');
      }
    } catch (err) {
      setSavedError(err.message);
    } finally {
      setSavedLoading(false);
    }
  };

  // Open Saved Gallery Modal
  const handleOpenSavedGallery = () => {
    setCurrentView('gallery');
    setSelectedImageIds({});
    fetchSavedImages();
  };

  // Save Scraped Image to Server
  const handleSaveImageToServer = async (monitorId, imageUrl) => {
    if (savingImageUrls[imageUrl]) return;

    setSavingImageUrls(prev => ({ ...prev, [imageUrl]: true }));
    try {
      const res = await fetch('/api/images/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monitorId, imageUrl })
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to save image to server');
      }

      notify.success('Image saved to server storage successfully!');
      fetchSavedImages();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setSavingImageUrls(prev => ({ ...prev, [imageUrl]: false }));
    }
  };

  // Save All Scraped Images to Server
  const handleSaveAllImagesToServer = async () => {
    if (galleryImages.length === 0 || !galleryMonitorId) return;

    if (!(await confirmAction(`Are you sure you want to download and save all ${galleryImages.length} images to the server?`))) return;

    setIsSavingAll(true);
    try {
      const res = await fetch('/api/images/save-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monitorId: galleryMonitorId,
          imageUrls: galleryImages.map(img => img.url)
        })
      });

      if (!res.ok) throw new Error('Failed to save all images');
      const data = await res.json();
      
      notify.success(`Batch download finished!\nSaved: ${data.savedCount} images successfully.${data.errorCount > 0 ? `\nFailed: ${data.errorCount} images.` : ''}`);
      
      fetchSavedImages();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsSavingAll(false);
    }
  };

  // Toggle a single scraped image's checkbox selection (live gallery)
  const toggleSelectedGalleryUrl = (url) => {
    setSelectedGalleryUrls(prev => ({ ...prev, [url]: !prev[url] }));
  };

  // Save only the checked scraped images to the server
  const handleSaveSelectedImagesToServer = async () => {
    const urls = Object.keys(selectedGalleryUrls).filter(url => selectedGalleryUrls[url]);
    if (urls.length === 0 || !galleryMonitorId) return;

    if (!(await confirmAction(`Are you sure you want to download and save the ${urls.length} selected image(s) to the server?`))) return;

    setIsSavingSelected(true);
    try {
      const res = await fetch('/api/images/save-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monitorId: galleryMonitorId,
          imageUrls: urls
        })
      });

      if (!res.ok) throw new Error('Failed to save selected images');
      const data = await res.json();

      notify.success(`Saved ${data.savedCount} selected image(s) successfully.${data.errorCount > 0 ? `\nFailed: ${data.errorCount} images.` : ''}`);

      setSelectedGalleryUrls({});
      fetchSavedImages();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsSavingSelected(false);
    }
  };

  // Delete Saved Image from Server
  const handleDeleteSavedImage = async (savedImageId) => {
    if (!(await confirmAction('Are you sure you want to delete this saved image from the server?', { danger: true }))) return;

    try {
      const res = await fetch(`/api/images/saved/${savedImageId}`, {
        method: 'DELETE'
      });

      if (!res.ok) throw new Error('Failed to delete saved image');
      fetchSavedImages();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Delete a group of saved images by monitor ID
  const handleDeleteSavedGroup = async (monitorId, groupName) => {
    if (!(await confirmAction(`Are you sure you want to delete ALL saved images for "${groupName}" from the server?`, { danger: true }))) return;

    try {
      const res = await fetch(`/api/images/saved/group/${monitorId}`, {
        method: 'DELETE'
      });

      if (!res.ok) throw new Error('Failed to delete saved group');
      fetchSavedImages();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Toggle a single saved image's checkbox selection
  const toggleSelectedImage = (id) => {
    setSelectedImageIds(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // Toggle whether a given image type (ad/content/manga) is shown
  const toggleVisibleType = (type) => {
    setVisibleTypes(prev => ({ ...prev, [type]: !prev[type] }));
  };

  // Delete all currently checked saved images in one request
  const handleDeleteSelectedImages = async () => {
    const ids = Object.keys(selectedImageIds).filter(id => selectedImageIds[id]);
    if (ids.length === 0) return;
    if (!(await confirmAction(`Are you sure you want to delete the ${ids.length} selected image(s) from the server?`, { danger: true }))) return;

    setIsBulkDeleting(true);
    try {
      const res = await fetch('/api/images/saved/bulk', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });

      if (!res.ok) throw new Error('Failed to delete selected images');
      setSelectedImageIds({});
      fetchSavedImages();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setIsBulkDeleting(false);
    }
  };

  // Group saved images by monitorId
  const getSavedImagesGroups = () => {
    const groups = {};
    savedImages.forEach(img => {
      if (!groups[img.monitorId]) {
        groups[img.monitorId] = {
          name: img.monitorName,
          items: []
        };
      }
      groups[img.monitorId].items.push(img);
    });
    return groups;
  };

  // Handle Manual check trigger
  const handleManualCheck = async (id) => {
    if (checkingIds[id]) return;

    setCheckingIds(prev => ({ ...prev, [id]: true }));
    try {
      const res = await fetch(`/api/monitors/${id}/check`, {
        method: 'POST'
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        // If it's just 'already in progress', we can silently ignore or show a softer message
        if (res.status === 429) {
          console.log('Check already in progress');
          return;
        }
        throw new Error(errorData.error || 'Check request failed');
      }
      fetchData();
    } catch (err) {
      notify.error(err.message);
    } finally {
      setCheckingIds(prev => ({ ...prev, [id]: false }));
    }
  };

  // Confirm Clear Logs
  const confirmClearLogs = async () => {
    try {
      const res = await fetch('/api/logs/clear', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to clear logs');
      setIsClearLogsModalOpen(false);
      fetchData();
    } catch (err) {
      notify.error(err.message);
    }
  };

  // Render Status Badge
  const renderStatusBadge = (status) => {
    switch (status) {
      case 'up':
        return (
          <span className="status-badge badge-up">
            <span className="pulse-dot up" />
            Online
          </span>
        );
      case 'down':
        return (
          <span className="status-badge badge-down">
            <span className="pulse-dot down" />
            Offline
          </span>
        );
      default:
        return (
          <span className="status-badge badge-unknown">
            <span className="pulse-dot unknown" />
            Unknown
          </span>
        );
    }
  };

  // Calculate monitor statistics for each website
  const getMonitorStats = (monitor) => {
    const checks = monitor.checks || [];
    if (checks.length === 0) return { uptime: '100%', avgResponse: 'N/A' };

    const totalChecks = checks.length;
    const upChecks = checks.filter(c => c.status === 'up').length;
    const uptimePct = ((upChecks / totalChecks) * 100).toFixed(1);

    const upResponses = checks.filter(c => c.status === 'up' && c.responseTime);
    const avgResponse = upResponses.length > 0
      ? Math.round(upResponses.reduce((sum, c) => sum + c.responseTime, 0) / upResponses.length) + ' ms'
      : 'N/A';

    return {
      uptime: `${uptimePct}%`,
      avgResponse
    };
  };

  return (
    <div className="app-wrapper">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <ConfirmModal confirmState={confirmState} onResolve={resolveConfirm} />

      {/* Sidebar Navigation */}
      <aside className="app-sidebar">
        <div className="brand-section">
          <div className="logo-icon">R</div>
          <div style={{ flex: 1 }}>
            <h1>Robot Hub</h1>
            <p>Monitor &amp; Manga Manager</p>
          </div>
          <button
            className="theme-toggle"
            onClick={() => setTheme(prev => (prev === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>
        </div>

        <nav className="sidebar-nav">
          <button
            className={`nav-item ${currentView === 'monitor' ? 'active' : ''}`}
            onClick={() => setCurrentView('monitor')}
          >
            <Icon name="bar-chart" /> Uptime Monitor
          </button>
          <button
            className={`nav-item ${currentView === 'library' ? 'active' : ''}`}
            onClick={() => { setCurrentView('library'); fetchSeries(); }}
          >
            <Icon name="book-stack" /> Manga Library
          </button>
          <button
            className={`nav-item ${currentView === 'downloader' ? 'active' : ''}`}
            onClick={handleOpenMangaModal}
          >
            <Icon name="book-open" /> Manga Downloader
          </button>
          <button
            className={`nav-item ${currentView === 'gallery' ? 'active' : ''}`}
            onClick={handleOpenSavedGallery}
          >
            <Icon name="folder" /> Saved Gallery
          </button>
        </nav>

        {currentView === 'monitor' && (
          <div style={{ marginTop: 'auto' }}>
            <button className="btn btn-primary" onClick={() => setIsAddModalOpen(true)} style={{ width: '100%', justifyContent: 'center' }}>
              <Icon name="plus" size={15} /> Add Website
            </button>
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <main className="app-main">
        {currentView === 'monitor' && (
          <div className="app-container" style={{ margin: 0, maxWidth: '1200px' }}>
            <header className="app-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.5rem', color: 'var(--color-text-primary)' }}>Uptime Monitor</h2>
                <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>Real-time Web Uptime Checker & Alerts</p>
              </div>
            </header>

      {/* Network / Connection Error Warning Banner */}
      {error && (
        <div style={{
          backgroundColor: 'rgba(var(--danger-tint-base), 0.1)',
          border: '1px solid var(--color-red)',
          color: 'var(--color-red)',
          padding: '1rem',
          borderRadius: '0.5rem',
          fontSize: '0.9rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Icon name="alert-triangle" size={15} /> {error}</span>
          <button className="btn btn-danger" style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }} onClick={fetchData}>
            Retry Connection
          </button>
        </div>
      )}

      {/* Stats Summary cards */}
      <section className="stats-grid">
        <div className="stat-card">
          <div className="stat-title">
            <span>Overall Status</span>
            <span style={{ color: stats.down > 0 ? 'var(--color-red)' : stats.total > 0 ? 'var(--color-green)' : 'var(--color-text-muted)' }}>
              ●
            </span>
          </div>
          <div className="stat-value">
            {stats.total === 0 ? 'No Sites' : stats.down > 0 ? 'Degraded' : 'Healthy'}
          </div>
          <div className="stat-desc">
            {stats.down > 0 ? `${stats.down} sites currently offline` : 'All sites working normally'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-title">Online Monitors</div>
          <div className="stat-value" style={{ color: 'var(--color-green)' }}>
            {stats.up} <span style={{ fontSize: '1rem', fontWeight: '400', color: 'var(--color-text-muted)' }}>/ {stats.total}</span>
          </div>
          <div className="stat-desc">Monitors actively reporting Online</div>
        </div>

        <div className="stat-card">
          <div className="stat-title">Offline Monitors</div>
          <div className="stat-value" style={{ color: stats.down > 0 ? 'var(--color-red)' : 'var(--color-text-primary)' }}>
            {stats.down}
          </div>
          <div className="stat-desc">Monitors experiencing HTTP/Connection errors</div>
        </div>

        <div className="stat-card">
          <div className="stat-title">Avg Response Time</div>
          <div className="stat-value" style={{ color: 'var(--color-cyan)' }}>
            {stats.avgResponseTime || '0'}<span style={{ fontSize: '1rem', fontWeight: '400', color: 'var(--color-text-muted)' }}> ms</span>
          </div>
          <div className="stat-desc">Overall response latency across online sites</div>
        </div>
      </section>

      {/* Main Grid: Left = Monitors List, Right = In-app alert logs */}
      {loading && monitors.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--color-text-muted)' }}>
          Loading dashboard monitors...
        </div>
      ) : (
        <div className="dashboard-grid">
          {/* Left panel */}
          <div>
            <div className="section-header">
              <h2>Monitor List</h2>
              <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
                Auto-refreshes every 5s
              </span>
            </div>

            {monitors.length === 0 ? (
              <div className="empty-dashboard">
                <div className="empty-icon"><Icon name="globe" size={40} strokeWidth={1.25} /></div>
                <h3>No Websites Monitored</h3>
                <p>You aren't checking any websites yet. Click "+ Add Website" above to start tracking server uptime.</p>
                <button className="btn btn-primary" onClick={() => setIsAddModalOpen(true)}>
                  Add your first site
                </button>
              </div>
            ) : (
              <div className="monitors-list">
                {monitors.map(monitor => {
                  const mStats = getMonitorStats(monitor);
                  return (
                    <div
                      key={monitor.id}
                      className={`monitor-card status-${monitor.status} ${!monitor.active ? 'status-unknown' : ''}`}
                      style={{ opacity: monitor.active ? 1 : 0.6 }}
                    >
                      {/* Name & URL */}
                      <div className="monitor-info">
                        <span className="monitor-name">
                          {monitor.name}
                          <span style={{ 
                            fontSize: '0.7rem', 
                            color: 'var(--color-text-muted)', 
                            backgroundColor: 'rgba(var(--tint-base), 0.05)',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '4px',
                            marginLeft: '0.5rem',
                            fontWeight: 'normal',
                            border: '1px solid var(--border-color)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem'
                          }}>
                            <Icon name="clock" size={11} /> {monitor.interval >= 60 ? `${monitor.interval / 60}m` : `${monitor.interval}s`}
                          </span>
                        </span>
                        <a
                          href={monitor.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="monitor-url"
                        >
                          {monitor.url}
                        </a>
                        
                        {monitor.active && monitor.status === 'down' && (
                          <div style={{
                            fontSize: '0.75rem',
                            color: 'var(--color-red)',
                            marginTop: '0.35rem',
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '0.25rem'
                          }}>
                            <span style={{ flexShrink: 0, display: 'flex' }}><Icon name="alert-triangle" size={12} /></span>
                            <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                              {monitor.lastError || 'Connection failed'}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Status */}
                      <div className="monitor-status-section">
                        {monitor.active ? renderStatusBadge(monitor.status) : <span className="status-badge badge-unknown">Paused</span>}
                      </div>

                      {/* Stats + history */}
                      <div className="monitor-metrics">
                        <div className="monitor-meta">
                          <span className="meta-label">Uptime</span>
                          <span className="meta-value" style={{ color: parseFloat(mStats.uptime) > 95 ? 'var(--color-green)' : parseFloat(mStats.uptime) > 80 ? 'var(--color-yellow)' : 'var(--color-red)' }}>
                            {monitor.active ? mStats.uptime : '—'}
                          </span>
                        </div>

                        <div className="monitor-meta">
                          <span className="meta-label">Avg Response</span>
                          <span className="meta-value">{monitor.active ? mStats.avgResponse : '—'}</span>
                        </div>

                        {/* Sparkline Response Grid */}
                        {monitor.active ? (
                          <Sparkline checks={monitor.checks} />
                        ) : (
                          <div className="sparkline-container">
                            <span className="meta-label">History</span>
                            <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', lineHeight: '24px' }}>Monitoring paused</span>
                          </div>
                        )}
                      </div>

                      {/* Action buttons */}
                      <div className="monitor-actions">
                        <button
                          className="btn btn-secondary btn-icon-only"
                          title={monitor.active ? 'Pause polling' : 'Resume polling'}
                          onClick={() => handleToggleActive(monitor)}
                        >
                          <Icon name={monitor.active ? 'pause' : 'play'} />
                        </button>
                        <button
                          className="btn btn-secondary btn-icon-only"
                          title="Check status now"
                          disabled={!monitor.active || checkingIds[monitor.id]}
                          onClick={() => handleManualCheck(monitor.id)}
                          style={{
                            cursor: (!monitor.active || checkingIds[monitor.id]) ? 'not-allowed' : 'pointer',
                            opacity: (!monitor.active || checkingIds[monitor.id]) ? 0.5 : 1
                          }}
                        >
                          <Icon name={checkingIds[monitor.id] ? 'clock' : 'refresh'} />
                        </button>
                        <button
                          className="btn btn-secondary btn-icon-only"
                          title="Show website images"
                          disabled={!monitor.active || monitor.status !== 'up'}
                          onClick={() => handleOpenGallery(monitor)}
                          style={{
                            cursor: (!monitor.active || monitor.status !== 'up') ? 'not-allowed' : 'pointer',
                            opacity: (!monitor.active || monitor.status !== 'up') ? 0.5 : 1
                          }}
                        >
                          <Icon name="camera" />
                        </button>
                        <button
                          className="btn btn-secondary btn-icon-only"
                          title="Scan all site pages via sitemap.xml"
                          disabled={!monitor.active || monitor.status !== 'up'}
                          onClick={() => handleOpenPagesScan(monitor)}
                          style={{
                            cursor: (!monitor.active || monitor.status !== 'up') ? 'not-allowed' : 'pointer',
                            opacity: (!monitor.active || monitor.status !== 'up') ? 0.5 : 1
                          }}
                        >
                          <Icon name="map" />
                        </button>
                        <button
                          className="btn btn-secondary btn-icon-only"
                          title="Edit settings"
                          onClick={() => openEditModal(monitor)}
                        >
                          <Icon name="edit" />
                        </button>
                        <button
                          className="btn btn-danger btn-icon-only"
                          title="Delete monitor"
                          onClick={() => openDeleteModal(monitor)}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right panel (Sidebar logs) */}
          <div>
            <div className="section-header">
              <h2>Alert Logs</h2>
            </div>
            <div className="alerts-panel">
              <div className="alerts-header">
                <h3><Icon name="bell" size={17} /> Activity History</h3>
                {logs.length > 0 && (
                  <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setIsClearLogsModalOpen(true)}>
                    Clear
                  </button>
                )}
              </div>
              <div className="alerts-list">
                {logs.length === 0 ? (
                  <div className="alerts-empty">
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.5rem', color: 'var(--color-text-muted)' }}><Icon name="bell-off" size={22} strokeWidth={1.25} /></div>
                    No alerts logged yet. Web system is operating normally.
                  </div>
                ) : (
                  logs.map(log => {
                    const isToUp = log.to === 'up';
                    return (
                      <div key={log.id} className={`alert-item ${isToUp ? 'alert-to-up' : 'alert-to-down'}`}>
                        <div className="alert-title-row">
                          <span className="alert-name">{log.monitorName}</span>
                          <span className="alert-timestamp">
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="alert-msg">
                          Went {isToUp ? 'ONLINE' : 'OFFLINE'}
                        </div>
                        <div className="alert-meta">
                          {isToUp ? (
                            <span className="alert-meta-green">Response: {log.responseTime}ms</span>
                          ) : (
                            <span className="alert-meta-red">Error: {log.error || 'Network error'}</span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Monitor Modal */}
      {isAddModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Add New Website</h3>
              <button className="modal-close" onClick={() => setIsAddModalOpen(false)}>×</button>
            </div>
            <form onSubmit={handleAddSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group">
                <label htmlFor="add-name">Name</label>
                <input
                  id="add-name"
                  type="text"
                  className="form-input"
                  placeholder="e.g. My API Server"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="add-url">URL</label>
                <input
                  id="add-url"
                  type="text"
                  className="form-input"
                  placeholder="e.g. https://api.myserver.com/health"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="add-interval">Check Interval</label>
                <select
                  id="add-interval"
                  className="form-select"
                  value={formInterval}
                  onChange={(e) => setFormInterval(e.target.value)}
                >
                  <option value="10">10 seconds (Testing)</option>
                  <option value="30">30 seconds</option>
                  <option value="60">1 minute (Recommended)</option>
                  <option value="300">5 minutes</option>
                  <option value="900">15 minutes</option>
                  <option value="3600">1 hour</option>
                </select>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setIsAddModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Create Monitor
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Monitor Modal */}
      {isEditModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Edit Website Details</h3>
              <button className="modal-close" onClick={() => setIsEditModalOpen(false)}>×</button>
            </div>
            <form onSubmit={handleEditSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group">
                <label htmlFor="edit-name">Name</label>
                <input
                  id="edit-name"
                  type="text"
                  className="form-input"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="edit-url">URL</label>
                <input
                  id="edit-url"
                  type="text"
                  className="form-input"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="edit-interval">Check Interval</label>
                <select
                  id="edit-interval"
                  className="form-select"
                  value={formInterval}
                  onChange={(e) => setFormInterval(e.target.value)}
                >
                  <option value="10">10 seconds</option>
                  <option value="30">30 seconds</option>
                  <option value="60">1 minute</option>
                  <option value="300">5 minutes</option>
                  <option value="900">15 minutes</option>
                  <option value="3600">1 hour</option>
                </select>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setIsEditModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Monitor Confirmation Modal */}
      {isDeleteModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ borderColor: 'rgba(var(--danger-tint-base), 0.3)' }}>
            <div className="modal-header">
              <h3 style={{ color: 'var(--color-red)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Icon name="alert-triangle" size={18} /> Delete Monitor</h3>
              <button className="modal-close" onClick={() => setIsDeleteModalOpen(false)}>×</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.95rem' }}>
                Are you sure you want to delete <strong>{deletingMonitor?.name}</strong>? This action will remove the website monitor and its ping history.
              </p>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setIsDeleteModalOpen(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-danger" onClick={confirmDeleteMonitor}>
                  Yes, Delete Monitor
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Clear Logs Confirmation Modal */}
      {isClearLogsModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ borderColor: 'rgba(var(--danger-tint-base), 0.3)' }}>
            <div className="modal-header">
              <h3 style={{ color: 'var(--color-red)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Icon name="alert-triangle" size={18} /> Clear Alert Logs</h3>
              <button className="modal-close" onClick={() => setIsClearLogsModalOpen(false)}>×</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.95rem' }}>
                Are you sure you want to clear all status transition alert history? This cannot be undone.
              </p>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setIsClearLogsModalOpen(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-danger" onClick={confirmClearLogs}>
                  Yes, Clear Logs
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Website Image Gallery Modal */}
      {isGalleryModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '700px', width: '90%' }}>
            <div className="modal-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Icon name="image" size={18} /> Image Gallery: {galleryMonitorName} {galleryImages.length > 0 && `(${galleryImages.length} images)`}</h3>
              <button className="modal-close" onClick={() => setIsGalleryModalOpen(false)}>×</button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '70vh', overflowY: 'auto', paddingRight: '0.25rem' }}>
              {galleryLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '3rem 0', gap: '1rem' }}>
                  <div className="spinner" />
                  <span style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>Scraping website for images...</span>
                </div>
              ) : galleryError ? (
                <div style={{ color: 'var(--color-red)', textAlign: 'center', padding: '2rem 0', fontSize: '0.95rem' }}>
                  {galleryError}
                </div>
              ) : galleryImages.length === 0 ? (
                <div style={{ color: 'var(--color-text-muted)', textAlign: 'center', padding: '3rem 0', fontSize: '0.95rem' }}>
                  No image tags found on this website's home page (ignoring data URIs).
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                    Here are all the {galleryImages.length} unique images found on the homepage, split by guessed type. This verifies image asset accessibility.
                  </p>

                  {/* Type Filter Checkboxes */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                    <span style={{ color: 'var(--color-text-muted)' }}>แสดง Type:</span>
                    {Object.entries(SAVED_TYPE_META).map(([type, meta]) => (
                      <label key={type} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={visibleTypes[type]}
                          onChange={() => toggleVisibleType(type)}
                        />
                        {meta.icon} {meta.label}
                      </label>
                    ))}
                  </div>

                  {/* Images Grid, grouped by guessed type */}
                  {(() => {
                    const itemsByType = { ad: [], content: [], manga: [] };
                    galleryImages.forEach(item => {
                      const type = itemsByType[item.type] ? item.type : 'content';
                      itemsByType[type].push(item);
                    });

                    return Object.entries(itemsByType).map(([type, items]) => {
                      if (items.length === 0 || !visibleTypes[type]) return null;
                      const meta = SAVED_TYPE_META[type];
                      return (
                        <div key={type} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          <h5 style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)', margin: 0 }}>
                            {meta.icon} {meta.label} ({items.length})
                          </h5>
                          <div className="gallery-grid">
                            {items.map((item, index) => (
                              <div key={index} className="gallery-card">
                                <div className="gallery-img-container" style={{ position: 'relative' }}>
                                  <input
                                    type="checkbox"
                                    checked={!!selectedGalleryUrls[item.url]}
                                    onChange={() => toggleSelectedGalleryUrl(item.url)}
                                    style={{ position: 'absolute', top: '0.35rem', left: '0.35rem', width: '1.1rem', height: '1.1rem', cursor: 'pointer', zIndex: 1 }}
                                    title="Select image"
                                  />
                                  <img
                                    src={item.url}
                                    alt={`Scraped asset ${index + 1}`}
                                    onError={(e) => {
                                      e.target.src = 'https://placehold.co/150x150/1e293b/64748b?text=Error+Loading+Image';
                                    }}
                                  />
                                </div>
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="gallery-img-link"
                                  title={item.url}
                                >
                                  Link #{index + 1}
                                </a>
                                <button
                                  className="btn btn-secondary"
                                  style={{
                                    padding: '0.2rem 0.5rem',
                                    fontSize: '0.7rem',
                                    marginTop: '0.25rem',
                                    width: '100%',
                                    gap: '0.25rem'
                                  }}
                                  disabled={savingImageUrls[item.url]}
                                  onClick={() => handleSaveImageToServer(galleryMonitorId, item.url)}
                                >
                                  {savingImageUrls[item.url] ? 'Saving...' : 'Save to Server'}
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
              
              <div className="modal-footer" style={{ marginTop: '0.5rem', flexWrap: 'wrap' }}>
                {Object.values(selectedGalleryUrls).some(Boolean) && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isSavingSelected}
                    onClick={handleSaveSelectedImagesToServer}
                    style={{ marginRight: 'auto' }}
                  >
                    {isSavingSelected
                      ? 'Saving selected...'
                      : `Save Selected (${Object.values(selectedGalleryUrls).filter(Boolean).length})`}
                  </button>
                )}
                {galleryImages.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isSavingAll}
                    onClick={handleSaveAllImagesToServer}
                    style={{ marginRight: Object.values(selectedGalleryUrls).some(Boolean) ? 0 : 'auto' }}
                  >
                    {isSavingAll ? 'Saving all...' : 'Save All to Server'}
                  </button>
                )}
                <button type="button" className="btn btn-secondary" onClick={() => setIsGalleryModalOpen(false)}>
                  Close Gallery
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Site Pages Scan Modal (discovers pages via sitemap.xml, checks status + images per page) */}
      {isPagesModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '800px', width: '95%' }}>
            <div className="modal-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Icon name="map" size={18} /> Site Pages: {pagesMonitorName}</h3>
              <button className="modal-close" onClick={() => setIsPagesModalOpen(false)}>×</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '75vh', overflowY: 'auto', paddingRight: '0.25rem' }}>
              {pagesLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '3rem 0', gap: '1rem' }}>
                  <div className="spinner" />
                  <span style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>
                    กำลังหา sitemap.xml และสแกนแต่ละหน้า (อาจใช้เวลาสักครู่)...
                  </span>
                </div>
              ) : pagesError ? (
                <div style={{ color: 'var(--color-red)', textAlign: 'center', padding: '2rem 0', fontSize: '0.95rem' }}>
                  {pagesError}
                </div>
              ) : pagesResult && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                    พบทั้งหมด {pagesResult.totalDiscovered} หน้าใน sitemap.xml
                    {pagesResult.totalAllowed !== pagesResult.totalDiscovered && ` (robots.txt อนุญาตให้เข้าถึง ${pagesResult.totalAllowed} หน้า)`}
                    {pagesResult.limited && ` — สแกนแค่ ${pagesResult.processedCount} หน้าแรก (จำกัดไว้กันโดนเว็บบล็อก)`}
                  </p>
                  {pagesResult.blockedEarly && (
                    <p style={{ fontSize: '0.85rem', color: 'var(--color-red)', display: 'flex', alignItems: 'flex-start', gap: '0.4rem' }}>
                      <Icon name="alert-triangle" size={14} style={{ marginTop: '0.15rem' }} />
                      <span>เว็บเริ่มตอบกลับแบบจำกัด/บล็อก (HTTP 429/403) ระบบเลยหยุดสแกนหน้าที่เหลือให้อัตโนมัติเพื่อความปลอดภัย</span>
                    </p>
                  )}

                  {(() => {
                    const total = pagesResult.pages.length;
                    const upCount = pagesResult.pages.filter((p) => p.status === 'up').length;
                    const downPages = pagesResult.pages.filter((p) => p.status === 'down');
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', border: '1px solid var(--border-color)', borderRadius: '0.75rem', padding: '0.75rem 1rem' }}>
                        <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                          <span>สแกนแล้วทั้งหมด <strong>{total}</strong> หน้า</span>
                          <span style={{ color: 'var(--color-green)' }}>ปกติ <strong>{upCount}</strong> หน้า</span>
                          <span style={{ color: 'var(--color-red)' }}>มีปัญหา <strong>{downPages.length}</strong> หน้า</span>
                        </div>
                        {downPages.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            {downPages.map((p) => (
                              <div key={p.url} style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>
                                <span style={{ fontFamily: 'var(--font-mono)' }}>{p.statusCode || 'Down'}</span> — {p.url} — {p.error}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {pagesResult.pages.map((page) => {
                    return (
                      <div key={page.url} style={{ border: '1px solid var(--border-color)', borderRadius: '0.75rem', padding: '0.75rem 1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 0 }}>
                            <a href={page.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-blue)', fontSize: '0.85rem', wordBreak: 'break-all' }}>
                              {page.url}
                            </a>
                            {page.status === 'down' && (
                              <span style={{ fontSize: '0.75rem', color: 'var(--color-red)', fontFamily: 'var(--font-mono)' }}>
                                {page.error}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                            {page.status === 'up' ? (
                              <span className="status-badge badge-up">
                                <span className="pulse-dot up" /> {page.statusCode} · {page.responseTime}ms
                              </span>
                            ) : (
                              <span className="status-badge badge-down">
                                <span className="pulse-dot down" /> {page.statusCode || 'Down'}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="modal-footer" style={{ marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setIsPagesModalOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* End Monitor View */}
          </div>
        )}

      {/* Manga Library View */}
      {currentView === 'library' && (
        <div style={{ padding: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div className="modal-header" style={{ padding: '0 0 1.25rem 0', borderBottom: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', width: '100%', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <h2>คลังการ์ตูน (Manga Library)</h2>
                {seriesLoading && <span className="spinner-inline" title="กำลังโหลด..." />}
              </div>
              <input
                type="text"
                className="form-input"
                placeholder="ค้นหาชื่อเรื่อง..."
                value={librarySearch}
                onChange={(e) => {
                  setLibrarySearch(e.target.value);
                  setLibraryPage(1); // Reset to first page on search
                }}
                style={{ minWidth: '250px' }}
              />
            </div>
          </div>
            
            <div className="modal-body" style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', backgroundColor: 'var(--bg-tertiary)' }}>
              {(() => {
                let completeSeriesList = seriesList.filter(s => s.chapters?.some(c => c.status === 'done'));
                
                if (librarySearch.trim()) {
                  const query = librarySearch.toLowerCase();
                  completeSeriesList = completeSeriesList.filter(s => s.name.toLowerCase().includes(query));
                }
                
                if (completeSeriesList.length === 0 && !seriesLoading) {
                  return (
                    <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', marginTop: '3rem' }}>
                      {librarySearch ? 'ไม่พบเรื่องที่ค้นหา' : 'ยังไม่มีตอนที่โหลดเสร็จ (เรื่องไหนที่มีตอนโหลดเสร็จแล้วอย่างน้อย 1 ตอนจะมาแสดงที่นี่ให้กดอ่านได้เลย)'}
                    </div>
                  );
                }

                const totalPages = Math.ceil(completeSeriesList.length / LIBRARY_PAGE_SIZE);
                const startIndex = (libraryPage - 1) * LIBRARY_PAGE_SIZE;
                const paginatedSeries = completeSeriesList.slice(startIndex, startIndex + LIBRARY_PAGE_SIZE);

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', height: '100%' }}>
                    <div className="table-responsive">
                      <table className="library-table">
                        <colgroup>
                          <col className="col-title" />
                          <col className="col-progress" />
                          <col className="col-status" />
                          <col className="col-actions" />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>ชื่อเรื่อง</th>
                            <th>ความคืบหน้า</th>
                            <th>สถานะ</th>
                            <th style={{ textAlign: 'right' }}>การจัดการ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {paginatedSeries.map(series => {
                            const total = series.chapters?.length || 0;
                            const done = series.chapters?.filter(c => c.status === 'done').length || 0;
                            const errors = series.chapters?.filter(c => ['error', 'blocked', 'partial'].includes(c.status)).length || 0;
                            const isComplete = total > 0 && done === total;

                            return (
                              <React.Fragment key={series.id}>
                                <tr>
                                  <td>
                                    <div className="library-row-title">
                                      {series.metadata?.coverImagePath && (
                                        <img
                                          src={`/api/saved-assets/${series.metadata.coverImagePath}`}
                                          alt=""
                                          style={{ width: '36px', height: '50px', objectFit: 'cover', borderRadius: '0.25rem', flexShrink: 0 }}
                                        />
                                      )}
                                      <div style={{ minWidth: 0 }}>
                                        <div className="library-row-title-text" title={series.name}>
                                          {series.name}
                                        </div>
                                        <div className="library-row-url" title={series.seriesUrl}>
                                          <a href={series.seriesUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-blue)', textDecoration: 'none' }}>
                                            {series.seriesUrl || 'No URL'}
                                          </a>
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                  <td>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.3rem' }}>
                                      <span>{done} / {total} ตอน</span>
                                      {errors > 0 && <span style={{ color: 'var(--color-red)' }}>มีปัญหา {errors}</span>}
                                    </div>
                                    {total > 0 && (
                                      <div style={{ width: '100%', height: '5px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden' }}>
                                        <div style={{ width: `${(done / total) * 100}%`, height: '100%', backgroundColor: 'var(--color-green)' }} />
                                      </div>
                                    )}
                                  </td>
                                  <td style={{ fontSize: '0.85rem' }}>
                                    {isComplete ? <span style={{ color: 'var(--color-green)' }}>สมบูรณ์</span> : <span style={{ color: 'var(--color-yellow)' }}>รอโหลด</span>}
                                  </td>
                                  <td style={{ textAlign: 'right' }}>
                                    <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                      {series.metadata && (
                                        <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setExpandedLibrarySeoIds(prev => ({ ...prev, [series.id]: !prev[series.id] }))}>
                                          {expandedLibrarySeoIds[series.id] ? '▲ ซ่อน SEO' : '▼ ดู SEO'}
                                        </button>
                                      )}
                                      <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setExpandedCrawlId(prev => prev === series.id ? '' : series.id)}>
                                        {expandedCrawlId === series.id ? '▲ ซ่อนตอน' : `ตอน (${done})`}
                                      </button>
                                      <button className="btn btn-primary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => handleExportSeries(series.id)} disabled={isExportingSeries}>
                                        {isExportingSeries ? '...' : 'Export'}
                                      </button>
                                    </div>
                                  </td>
                                </tr>

                                {/* Expanded Chapters Viewer */}
                                {expandedCrawlId === series.id && (
                                  <tr>
                                    <td colSpan="4" style={{ padding: '1rem', backgroundColor: 'var(--bg-tertiary)', borderBottom: '2px solid var(--border-color)' }}>
                                      <h4 style={{ margin: '0 0 1rem 0', color: 'var(--color-text)' }}>ตอนที่โหลดเสร็จ ({done})</h4>
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                        {series.chapters.filter(c => c.status === 'done').map((chapter, index) => (
                                          <div key={chapter.id} style={{ display: 'flex', flexDirection: 'column' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.25rem 0', fontSize: '0.85rem' }}>
                                              <span style={{ color: 'var(--color-text)' }}>ตอนที่ {index + 1} {chapter.name ? `- ${chapter.name}` : ''}</span>
                                              <button
                                                className="btn btn-secondary"
                                                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  setExpandedChapterId(prev => prev === chapter.id ? '' : chapter.id);
                                                }}
                                              >
                                                {expandedChapterId === chapter.id ? '▲ ปิด' : 'ดูรูป'}
                                              </button>
                                            </div>
                                            {expandedChapterId === chapter.id && chapter.images && chapter.images.length > 0 && (
                                              <div className="gallery-grid" style={{ marginTop: '0.5rem', marginBottom: '1rem', backgroundColor: 'var(--bg-primary)', padding: '0.5rem', borderRadius: '0.5rem' }}>
                                                {chapter.images.map(img => (
                                                  <div key={img.filename} className="gallery-card">
                                                    <div className="gallery-img-container">
                                                      <img
                                                        src={`/api/saved-assets/${img.relativePath}`}
                                                        alt={`Page ${img.order}`}
                                                        onError={(e) => {
                                                          e.target.src = 'https://placehold.co/150x150/1e293b/64748b?text=Missing+Image';
                                                        }}
                                                      />
                                                    </div>
                                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.25rem' }}>
                                                      <a
                                                        href={`/api/saved-assets/${img.relativePath}`}
                                                        download
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="gallery-img-link"
                                                      >
                                                        หน้า {img.order}
                                                      </a>
                                                    </div>
                                                  </div>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </td>
                                  </tr>
                                )}

                                {/* Expanded SEO Viewer */}
                                {expandedLibrarySeoIds[series.id] && series.metadata && (
                                  <tr>
                                    <td colSpan="4" style={{ padding: '1rem', backgroundColor: 'var(--bg-tertiary)', borderBottom: '2px solid var(--border-color)' }}>
                                      <h4 style={{ margin: '0 0 1rem 0', color: 'var(--color-text)' }}>ข้อมูล SEO</h4>
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.8rem', color: 'var(--color-text)' }}>
                                        {series.metadata.title && <div><strong>ชื่อเรื่อง:</strong> {series.metadata.title}</div>}
                                        {series.metadata.altTitles?.length > 0 && <div><strong>ชื่ออื่น:</strong> {series.metadata.altTitles.join(', ')}</div>}
                                        {series.metadata.synopsis && <div><strong>เรื่องย่อ:</strong> {series.metadata.synopsis}</div>}
                                        {series.metadata.author && <div><strong>ผู้แต่ง:</strong> {series.metadata.author}</div>}
                                        {series.metadata.artist && <div><strong>ผู้วาด:</strong> {series.metadata.artist}</div>}
                                        {series.metadata.genres?.length > 0 && <div><strong>แนว:</strong> {series.metadata.genres.join(', ')}</div>}
                                        {series.metadata.status && <div><strong>สถานะ:</strong> {series.metadata.status}</div>}
                                        {series.metadata.postedBy && <div><strong>อัพเดทโดย:</strong> {series.metadata.postedBy}</div>}
                                        {series.metadata.lastUpdatedDate && <div><strong>อัพเดทล่าสุด:</strong> {series.metadata.lastUpdatedDate}</div>}
                                        {series.metadata.rating && <div><strong>คะแนน:</strong> {series.metadata.rating}</div>}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1rem', marginTop: 'auto', paddingTop: '1rem' }}>
                    <button 
                      className="btn btn-secondary" 
                      disabled={libraryPage === 1}
                      onClick={() => setLibraryPage(p => Math.max(1, p - 1))}
                    >
                      ◀ ก่อนหน้า
                    </button>
                    <span style={{ fontSize: '0.9rem', color: 'var(--color-text)' }}>
                      หน้า {libraryPage} จาก {totalPages}
                    </span>
                    <button 
                      className="btn btn-secondary" 
                      disabled={libraryPage === totalPages}
                      onClick={() => setLibraryPage(p => Math.min(totalPages, p + 1))}
                    >
                      ถัดไป ▶
                    </button>
                  </div>
                )}
              </div>
            );
              })()}
            </div>
        </div>
      )}

      {/* Manga Downloader View */}
      {currentView === 'downloader' && (
        <div style={{ padding: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div className="modal-header" style={{ padding: '0 0 1.25rem 0', borderBottom: 'none' }}>
            <h3>Manga Downloader</h3>
          </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '78vh', overflowY: 'auto', paddingRight: '0.25rem' }}>
              <button
                type="button"
                onClick={() => setShowDownloaderInfo(prev => !prev)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--color-text-muted)', fontSize: '0.8rem', alignSelf: 'flex-start' }}
              >
                <Icon name={showDownloaderInfo ? 'chevron-up' : 'chevron-down'} size={13} />
                วิธีใช้งานหน้านี้
              </button>
              {showDownloaderInfo && (
                <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', margin: 0 }}>
                  หน้านี้คือ <b>"คิวดาวน์โหลด"</b> คุณสามารถเพิ่มหน้าเว็บไซต์หรือเพิ่มเรื่องทิ้งไว้ได้หลายๆ เว็บพร้อมกัน บอทจะทำการโหลดรูปแยกกันตามโดเมนแบบคู่ขนาน (Concurrent) ทันที เมื่อโหลดครบ 100% เรื่องนั้นจะถูกย้ายไปที่ <b>"คลังการ์ตูน"</b> อัตโนมัติ
                </p>
              )}

              {/* Whole-site crawl: hand over just the site's root/listing URL and
                  the bot discovers every series + every chapter on its own,
                  running in the background on the server (not this browser
                  tab) until it finishes or is stopped. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', border: '1px solid var(--border-color)', borderRadius: '0.5rem', padding: '1.1rem 1.25rem', background: 'var(--bg-card)' }}>
                <div>
                  <h4 style={{ margin: '0 0 0.25rem 0', fontSize: '0.95rem' }}>ดึงทั้งเว็บอัตโนมัติ</h4>
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                    วางลิงก์หน้าแรกของเว็บ บอทจะไล่หาทุกเรื่องและทุกตอนให้เองในเบื้องหลัง ปิดแท็บนี้ได้เลย
                  </p>
                </div>

                <form onSubmit={handleStartCrawl} style={{ display: 'flex', gap: '0.5rem', flexDirection: 'column', flex: 'none' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="https://www.go-manga.com/"
                      value={crawlSiteUrl}
                      onChange={(e) => setCrawlSiteUrl(e.target.value)}
                      style={{ flex: '1 1 250px' }}
                      required
                    />
                    <button type="submit" className="btn btn-primary" disabled={isStartingCrawl}>
                      {isStartingCrawl ? 'กำลังเริ่ม...' : 'เริ่มดึงทั้งเว็บ'}
                    </button>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer', alignSelf: 'flex-start' }}>
                    <input type="checkbox" checked={useStealthCrawl} onChange={(e) => setUseStealthCrawl(e.target.checked)} />
                    ใช้โหมดล่องหนทะลวง Cloudflare
                  </label>
                </form>

                {siteCrawls.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {siteCrawls.map(crawl => {
                      const meta = CRAWL_STATUS_META[crawl.status] || CRAWL_STATUS_META.stopped;
                      const totalSeries = crawl.discoveredSeries.length;
                      const doneSeries = crawl.processedSeriesUrls.length;
                      return (
                        <div key={crawl.id} className="crawl-card">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                            <span style={{ wordBreak: 'break-all' }}>{crawl.siteUrl}</span>
                            <span style={{ color: meta.color, flexShrink: 0 }}>{meta.icon} {meta.label}</span>
                          </div>
                          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                            <div className="monitor-meta">
                              <span className="meta-label">เจอเรื่อง</span>
                              <span className="meta-value">{totalSeries}{!crawl.discoveryDone && ' ⋯'}</span>
                            </div>
                            <div className="monitor-meta">
                              <span className="meta-label">เสร็จแล้ว</span>
                              <span className="meta-value">{doneSeries}</span>
                            </div>
                            <div className="monitor-meta">
                              <span className="meta-label">โหลดแล้ว</span>
                              <span className="meta-value">{crawl.stats.chaptersDownloaded} ตอน</span>
                            </div>
                          </div>
                          {crawl.currentSeriesName && crawl.status === 'running' && (
                            <div style={{ color: 'var(--color-blue)' }}>กำลังทำเรื่อง: {crawl.currentSeriesName}</div>
                          )}
                          {crawl.lastError && (
                            <div style={{ color: 'var(--color-yellow)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{crawl.lastError}</div>
                          )}
                          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                            {crawl.status === 'running' ? (
                              <button type="button" className="btn btn-secondary" style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }} onClick={() => handleStopCrawl(crawl.id)}>
                                หยุด
                              </button>
                            ) : crawl.status !== 'done' && (
                              <button type="button" className="btn btn-secondary" style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }} onClick={() => handleResumeCrawl(crawl.id)}>
                                ทำต่อ
                              </button>
                            )}
                            {totalSeries > 0 && (
                              <button
                                type="button"
                                className="btn btn-secondary"
                                style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }}
                                onClick={() => setExpandedCrawlId(prev => prev === crawl.id ? '' : crawl.id)}
                              >
                                {expandedCrawlId === crawl.id ? '▲ ซ่อนรายชื่อเรื่อง' : `▼ ดูว่าเรื่องไหนเสร็จแล้วบ้าง (${doneSeries}/${totalSeries})`}
                              </button>
                            )}
                            <button type="button" className="btn btn-danger" style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }} onClick={() => handleDeleteCrawl(crawl.id)}>
                              ลบงานนี้
                            </button>
                          </div>

                          {expandedCrawlId === crawl.id && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', maxHeight: '220px', overflowY: 'auto', marginTop: '0.25rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.4rem' }}>
                              {crawl.discoveredSeries.map(item => {
                                const isProcessed = crawl.processedSeriesUrls.includes(item.url);
                                const isCurrent = crawl.currentSeriesUrl === item.url;
                                const matchedSeries = seriesList.find(s => s.seriesUrl === item.url);
                                const chapters = matchedSeries?.chapters || [];
                                const doneChapters = chapters.filter(c => c.status === 'done').length;
                                const statusIcon = isCurrent ? 'refresh' : isProcessed ? 'check' : 'clock';
                                const statusColor = isCurrent ? 'var(--color-blue)' : isProcessed ? 'var(--color-green)' : 'var(--color-text-muted)';
                                return (
                                  <div key={item.url} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', color: statusColor }}>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      <Icon name={statusIcon} size={12} /> {item.name}
                                    </span>
                                    <span style={{ flexShrink: 0 }}>{chapters.length > 0 ? `${doneChapters}/${chapters.length} ตอน` : (isProcessed ? '0 ตอน' : '')}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {seriesError && (
                <div style={{ color: 'var(--color-red)', fontSize: '0.9rem' }}>{seriesError}</div>
              )}

              {/* Add Series Form */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', border: '1px solid var(--border-color)', borderRadius: '0.5rem', padding: '1.1rem 1.25rem', background: 'var(--bg-card)' }}>
                <h4 style={{ margin: 0, fontSize: '0.95rem' }}>เพิ่มเรื่องใหม่</h4>
                <form onSubmit={handleAddSeries} style={{ display: 'flex', gap: '0.85rem', flexDirection: 'column', flex: 'none' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="ชื่อเรื่องมังงะ เช่น One Piece หรือ URL หน้ารวมตอน"
                      value={newSeriesName}
                      onChange={(e) => setNewSeriesName(e.target.value)}
                      style={{ flex: 1, minWidth: '200px' }}
                      required
                    />
                    <button type="submit" className="btn btn-primary" disabled={isAddingSeries}>
                      {isAddingSeries ? 'Adding...' : '+ Add Series'}
                    </button>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer', alignSelf: 'flex-start' }}>
                    <input type="checkbox" checked={useStealthAdd} onChange={(e) => setUseStealthAdd(e.target.checked)} />
                    ใช้โหมดล่องหนทะลวง Cloudflare (สำหรับเว็บที่กันบอท)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer', alignSelf: 'flex-start' }} title="บอทจะวนกลับมาโหลดตอนที่มีปัญหา (error/โหลดไม่ครบ) ให้เองอัตโนมัติทุก ~10 นาที ไม่ต้องกดเอง">
                    <input type="checkbox" checked={autoRetryEnabled} onChange={(e) => handleToggleAutoRetry(e.target.checked)} />
                    ให้บอทลองโหลดตอนที่มีปัญหาใหม่เองอัตโนมัติ
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer', alignSelf: 'flex-start' }} title="บอทจะเช็คเรื่องที่โหลดไว้ทุก ~3 ชั่วโมงว่ามีตอนใหม่ออกไหม ถ้ามีก็โหลดมาเพิ่มให้เองอัตโนมัติ (ไม่โหลดตอนเดิมซ้ำ)">
                    <input type="checkbox" checked={autoUpdateEnabled} onChange={(e) => handleToggleAutoUpdate(e.target.checked)} />
                    ให้บอทเช็คตอนใหม่ของเรื่องเก่าแล้วโหลดเพิ่มเองอัตโนมัติ
                  </label>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', alignSelf: 'flex-start' }}
                    disabled={isDownloadingCovers}
                    title="ดาวน์โหลดรูปปกของทุกเรื่อง แยกเก็บไว้ต่างหาก - เรื่องที่มีปกอยู่แล้วจะไม่โหลดซ้ำ"
                    onClick={handleDownloadAllCovers}
                  >
                    {isDownloadingCovers ? 'กำลังดาวน์โหลดปก...' : 'ดาวน์โหลดปกทั้งหมด'}
                  </button>
                </form>
              </div>

              {seriesLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2rem 0', gap: '1rem' }}>
                  <div className="spinner" />
                </div>
              ) : seriesList.length === 0 ? (
                <div style={{ color: 'var(--color-text-muted)', textAlign: 'center', padding: '2rem 0', fontSize: '0.9rem' }}>
                  ยังไม่มีเรื่องมังงะ เพิ่มเรื่องแรกด้านบนได้เลย
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '1rem', alignItems: 'start' }}>
                  {/* Series list */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    {(() => {
                      const incompleteSeriesList = seriesList.filter(s => !s.chapters || s.chapters.length === 0 || s.chapters.some(c => c.status !== 'done'));
                      if (incompleteSeriesList.length === 0 && seriesList.length > 0) {
                        return <div style={{ color: 'var(--color-text-muted)', textAlign: 'center', padding: '1rem', fontSize: '0.85rem' }}>ไม่มีคิวที่กำลังโหลด (โหลดเสร็จหมดแล้วจะอยู่ในคลัง)</div>;
                      }
                      return incompleteSeriesList.map(s => (
                      <div
                        key={s.id}
                        onClick={() => handleSelectSeries(s)}
                        className={`series-list-item ${selectedSeriesId === s.id ? 'active' : ''}`}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.name} <span style={{ opacity: 0.7, fontSize: '0.75rem' }}>({(s.chapters || []).length})</span>
                        </span>
                        <button
                          className="btn btn-danger btn-icon-only"
                          style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem', flexShrink: 0 }}
                          title="Delete series"
                          onClick={(e) => { e.stopPropagation(); handleDeleteSeries(s.id, s.name); }}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </div>
                      ));
                    })()}
                  </div>

                  {/* Chapters of selected series */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {(() => {
                      const series = seriesList.find(s => s.id === selectedSeriesId);
                      if (!series) {
                        return <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>เลือกเรื่องทางซ้ายเพื่อจัดการตอน</div>;
                      }
                      return (
                        <>
                          {/* Auto-discover: paste the series' "all chapters" listing page URL
                              and the bot walks it to find every chapter link itself. */}
                          <form onSubmit={handleDiscoverChapters} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="วางลิงก์หน้ารวมตอนของเรื่องนี้ เช่น https://www.go-manga.com/manga/xxx"
                              value={discoverUrl}
                              onChange={(e) => setDiscoverUrl(e.target.value)}
                              style={{ flex: '1 1 300px' }}
                              required
                            />
                            <button type="submit" className="btn btn-primary" disabled={isDiscovering}>
                              {isDiscovering ? 'กำลังค้นหา...' : 'ค้นหาตอนทั้งหมดอัตโนมัติ'}
                            </button>
                          </form>

                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                              onClick={() => setShowManualChapterForm(prev => !prev)}
                            >
                              {showManualChapterForm ? '▲ ซ่อนการเพิ่มตอนแบบระบุเอง' : '▼ หรือเพิ่มตอนแบบระบุเอง (ทีละตอน)'}
                            </button>
                            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                              {(series.chapters || []).some(c => c.status !== 'done') && (
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                                  disabled={isScrapingAll}
                                  onClick={() => handleScrapeAllChapters(series.id)}
                                >
                                  {isScrapingAll ? 'กำลังโหลดทุกตอน...' : 'Scrape ทุกตอนที่ยังไม่เสร็จ'}
                                </button>
                              )}
                              {(series.chapters || []).some(c => ['error', 'partial', 'blocked'].includes(c.status)) && (
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                                  disabled={isRetryingProblems || isScrapingAll}
                                  onClick={() => handleRetryProblemChapters(series.id)}
                                >
                                  {isRetryingProblems ? 'กำลังลองตอนที่มีปัญหา...' : 'ลองตอนที่มีปัญหาใหม่'}
                                </button>
                              )}
                              {series.seriesUrl && (
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                                  disabled={isCheckingUpdates}
                                  title="เช็คว่ามีตอนใหม่ออกไหม แล้วโหลดเฉพาะตอนใหม่ (ไม่โหลดตอนเดิมซ้ำ)"
                                  onClick={() => handleCheckUpdates(series.id)}
                                >
                                  {isCheckingUpdates ? 'กำลังเช็คตอนใหม่...' : 'เช็คตอนใหม่'}
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn btn-secondary"
                                style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                                disabled={isFetchingMetadata}
                                onClick={() => handleFetchSeriesMetadata(series.id)}
                              >
                                {isFetchingMetadata ? 'กำลังดึงข้อมูล...' : series.metadata ? 'รีเฟรชข้อมูล SEO' : 'ดึงข้อมูล SEO'}
                              </button>
                              {(series.chapters || []).length > 1 && (
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                                  disabled={isCheckingGaps}
                                  title="เช็คว่าตอนไหนหายไปจากลำดับบ้าง (ไม่ได้เช็คแค่โหลดเสร็จหรือยัง แต่เช็คว่ามีตอนนั้นอยู่ในระบบหรือเปล่า)"
                                  onClick={() => handleCheckChapterGaps(series.id)}
                                >
                                  {isCheckingGaps ? 'กำลังเช็ค...' : 'เช็คตอนที่ขาดหาย'}
                                </button>
                              )}
                              {(series.chapters || []).some(c => c.status === 'done') && (
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                                  disabled={isCleaningDuplicates}
                                  onClick={() => handleCleanDuplicateImages(series.id)}
                                >
                                  {isCleaningDuplicates ? 'กำลังตรวจสอบ...' : 'ลบรูปโฆษณา/เครดิตซ้ำ'}
                                </button>
                              )}
                              {(series.chapters || []).some(c => c.status === 'done') && (
                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                                  disabled={isExportingSeries}
                                  onClick={() => handleExportSeries(series.id)}
                                >
                                  {isExportingSeries ? 'กำลัง Export...' : 'Export ตอนที่เสร็จแล้ว'}
                                </button>
                              )}
                            </div>
                          </div>

                          {series.metadata && (
                            <div style={{ border: '1px solid var(--border-color)', borderRadius: '0.5rem', padding: '0.5rem 0.75rem' }}>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', marginBottom: showSeriesMetadata ? '0.5rem' : 0 }}
                                onClick={() => setShowSeriesMetadata(prev => !prev)}
                              >
                                {showSeriesMetadata ? '▼ ซ่อนข้อมูล SEO' : `▶ แสดงข้อมูล SEO ที่ดึงมา${series.metadataFetchedAt ? ` (${new Date(series.metadataFetchedAt).toLocaleString('th-TH')})` : ''}`}
                              </button>
                              {showSeriesMetadata && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.8rem' }}>
                                  {series.metadata.title && <div><strong>ชื่อเรื่อง:</strong> {series.metadata.title}</div>}
                                  {series.metadata.altTitles?.length > 0 && <div><strong>ชื่ออื่น:</strong> {series.metadata.altTitles.join(', ')}</div>}
                                  {series.metadata.synopsis && <div><strong>เรื่องย่อ:</strong> {series.metadata.synopsis}</div>}
                                  {series.metadata.genres?.length > 0 && <div><strong>ประเภท:</strong> {series.metadata.genres.join(', ')}</div>}
                                  {series.metadata.status && <div><strong>สถานะ:</strong> {series.metadata.status}</div>}
                                  {series.metadata.type && <div><strong>ชนิด:</strong> {series.metadata.type}</div>}
                                  {series.metadata.author && <div><strong>นักเขียน:</strong> {series.metadata.author}</div>}
                                  {series.metadata.artist && <div><strong>นักวาด:</strong> {series.metadata.artist}</div>}
                                  {series.metadata.released && <div><strong>ปีที่ปล่อย:</strong> {series.metadata.released}</div>}
                                  {series.metadata.rating && <div><strong>เรตติ้ง:</strong> {series.metadata.rating}{series.metadata.ratingCount ? ` (${series.metadata.ratingCount} โหวต)` : ''}</div>}
                                  {series.metadata.views && <div><strong>ยอดวิว:</strong> {series.metadata.views}</div>}
                                  {series.metadata.followers && <div><strong>ผู้ติดตาม:</strong> {series.metadata.followers}</div>}
                                  {series.metadata.publishedDate && <div><strong>เผยแพร่วันที่:</strong> {series.metadata.publishedDate}</div>}
                                  {series.metadata.lastUpdatedDate && <div><strong>แก้ไขล่าสุด:</strong> {series.metadata.lastUpdatedDate}</div>}
                                </div>
                              )}
                            </div>
                          )}

                          {showManualChapterForm && (
                            <form onSubmit={handleAddChapter} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                              <input
                                type="text"
                                className="form-input"
                                placeholder="ชื่อตอน เช่น ตอนที่ 1"
                                value={newChapterName}
                                onChange={(e) => setNewChapterName(e.target.value)}
                                style={{ flex: '1 1 150px' }}
                                required
                              />
                              <input
                                type="text"
                                className="form-input"
                                placeholder="URL หน้าตอนนี้"
                                value={newChapterUrl}
                                onChange={(e) => setNewChapterUrl(e.target.value)}
                                style={{ flex: '2 1 250px' }}
                                required
                              />
                              <button type="submit" className="btn btn-secondary" disabled={isAddingChapter}>
                                {isAddingChapter ? '...' : '+ Add Chapter'}
                              </button>
                            </form>
                          )}

                          {(series.chapters || []).length > 0 && (() => {
                            const total = series.chapters.length;
                            const doneCount = series.chapters.filter(c => c.status === 'done').length;
                            const scrapingChapter = series.chapters.find(c => c.status === 'scraping');
                            const pendingCount = series.chapters.filter(c => c.status === 'pending').length;
                            const issueCount = series.chapters.filter(c => ['error', 'blocked', 'partial'].includes(c.status)).length;
                            return (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', border: '1px solid var(--border-color)', borderRadius: '0.5rem', padding: '0.5rem 0.75rem', fontSize: '0.8rem' }}>
                                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                                  <span>โหลดเสร็จแล้ว <strong style={{ color: 'var(--color-green)' }}>{doneCount}</strong> / {total} ตอน</span>
                                  {pendingCount > 0 && <span style={{ color: 'var(--color-text-muted)' }}>ยังไม่โหลด {pendingCount} ตอน</span>}
                                  {issueCount > 0 && <span style={{ color: 'var(--color-yellow)' }}>มีปัญหา {issueCount} ตอน</span>}
                                </div>
                                <div style={{ color: 'var(--color-blue)', minHeight: '1.1rem' }}>
                                  {scrapingChapter && `กำลังโหลดตอน: ${scrapingChapter.name}`}
                                </div>
                              </div>
                            );
                          })()}

                          {(series.chapters || []).length === 0 ? (
                            <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', padding: '1rem 0' }}>
                              ยังไม่มีตอนในเรื่องนี้ เพิ่มตอนแรกด้านบน
                            </div>
                          ) : (() => {
                            // A series can have hundreds of chapters - only render a
                            // bounded, filtered slice at a time (see chapterVisibleCount
                            // above) instead of every single one, which is what was
                            // causing the constant lag/scroll-jump on large series.
                            const allChapters = series.chapters;
                            const doneChapterCount = allChapters.filter(c => c.status === 'done').length;
                            const visibleChapters = showDoneChapters ? allChapters : allChapters.filter(c => c.status !== 'done');
                            const pageOfChapters = visibleChapters.slice(0, chapterVisibleCount);

                            return (
                              <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.75rem' }}>
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                                    onClick={() => { setShowDoneChapters(prev => !prev); setChapterVisibleCount(CHAPTER_PAGE_SIZE); }}
                                  >
                                    {showDoneChapters ? `▼ ซ่อนตอนที่เสร็จแล้ว (${doneChapterCount} ตอน)` : `▶ แสดงตอนที่เสร็จแล้วด้วย (${doneChapterCount} ตอน)`}
                                  </button>
                                  {visibleChapters.length > 0 && (
                                    <span style={{ color: 'var(--color-text-muted)' }}>แสดง {pageOfChapters.length} / {visibleChapters.length} ตอน</span>
                                  )}
                                </div>

                                {pageOfChapters.map(chapter => {
                                  const statusMeta = CHAPTER_STATUS_META[chapter.status] || CHAPTER_STATUS_META.pending;
                                  const isScraping = chapter.status === 'scraping' || scrapingChapterIds[chapter.id];
                              return (
                                <div key={chapter.id} className="chapter-row">
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', minWidth: 0 }}>
                                      <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{chapter.name}</span>
                                      <a href={chapter.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-blue)', fontSize: '0.75rem', wordBreak: 'break-all' }}>
                                        {chapter.url}
                                      </a>
                                      <span style={{ fontSize: '0.75rem', color: statusMeta.color }}>
                                        {statusMeta.icon} {statusMeta.label}
                                        {chapter.images && chapter.images.length > 0 && ` — ${chapter.images.length} รูป`}
                                        {['error', 'partial', 'blocked'].includes(chapter.status) && chapter.retryCount > 0 &&
                                          ` (ลองอัตโนมัติแล้ว ${chapter.retryCount}/${MAX_CHAPTER_RETRIES_DISPLAY} ครั้ง)`}
                                      </span>
                                      {chapter.error && (
                                        <span style={{ fontSize: '0.7rem', color: 'var(--color-red)', fontFamily: 'var(--font-mono)' }}>
                                          {chapter.error}
                                        </span>
                                      )}
                                    </div>
                                    <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0, flexWrap: 'wrap' }}>
                                      <button
                                        className="btn btn-secondary"
                                        style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                                        disabled={isScraping}
                                        onClick={() => handleScrapeChapter(series.id, chapter.id)}
                                      >
                                        {isScraping ? 'Downloading...' : chapter.images.length > 0 ? 'Re-scrape' : 'Scrape & Download'}
                                      </button>
                                      {chapter.images && chapter.images.length > 0 && (
                                        <button
                                          className="btn btn-secondary"
                                          style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                                          onClick={() => setExpandedChapterId(prev => prev === chapter.id ? '' : chapter.id)}
                                        >
                                          {expandedChapterId === chapter.id ? 'Hide Images' : 'View Images'}
                                        </button>
                                      )}
                                      <button
                                        className="btn btn-danger"
                                        style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                                        onClick={() => handleDeleteChapter(series.id, chapter.id, chapter.name)}
                                      >
                                        <Icon name="trash" size={13} />
                                      </button>
                                    </div>
                                  </div>

                                  {expandedChapterId === chapter.id && chapter.images && chapter.images.length > 0 && (
                                    <div className="gallery-grid" style={{ marginTop: '0.75rem' }}>
                                      {chapter.images.map(img => (
                                        <div key={img.filename} className="gallery-card">
                                          <div className="gallery-img-container">
                                            <img
                                              src={`/api/saved-assets/${img.relativePath}`}
                                              alt={`Page ${img.order}`}
                                              onError={(e) => {
                                                e.target.src = 'https://placehold.co/150x150/1e293b/64748b?text=Missing+Image';
                                              }}
                                            />
                                          </div>
                                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.25rem' }}>
                                            <a
                                              href={`/api/saved-assets/${img.relativePath}`}
                                              download
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="gallery-img-link"
                                            >
                                              หน้า {img.order}
                                            </a>
                                            <button
                                              type="button"
                                              className="btn btn-danger"
                                              title="ลบรูปนี้ (โฆษณา/เครดิตที่หลุดมา)"
                                              style={{ padding: '0.1rem 0.35rem', fontSize: '0.65rem', flexShrink: 0 }}
                                              onClick={() => handleDeleteChapterImage(series.id, chapter.id, img.filename)}
                                            >
                                              <Icon name="trash" size={11} />
                                            </button>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                                })}

                                {pageOfChapters.length < visibleChapters.length && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ alignSelf: 'center', fontSize: '0.8rem', padding: '0.4rem 1rem' }}
                                    onClick={() => setChapterVisibleCount(prev => prev + CHAPTER_PAGE_SIZE)}
                                  >
                                    แสดงเพิ่ม ({visibleChapters.length - pageOfChapters.length} ตอนที่เหลือ)
                                  </button>
                                )}
                              </>
                            );
                          })()}
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}

              <div className="modal-footer" style={{ marginTop: '0.5rem', display: 'none' }}>
                {/* Footer hidden in view mode */}
              </div>
            </div>
        </div>
      )}

      {/* Saved Gallery View */}
      {currentView === 'gallery' && (
        <div style={{ padding: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div className="modal-header" style={{ padding: '0 0 1.25rem 0', borderBottom: 'none' }}>
            <h3>Saved Images Gallery</h3>
          </div>
          
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxHeight: '75vh', overflowY: 'auto', paddingRight: '0.25rem' }}>
              {savedLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '3rem 0', gap: '1rem' }}>
                  <div className="spinner" />
                  <span style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>Loading saved images...</span>
                </div>
              ) : savedError ? (
                <div style={{ color: 'var(--color-red)', textAlign: 'center', padding: '2rem 0', fontSize: '0.95rem' }}>
                  {savedError}
                </div>
              ) : savedImages.length === 0 ? (
                <div style={{ color: 'var(--color-text-muted)', textAlign: 'center', padding: '4rem 0', fontSize: '0.95rem' }}>
                  No images saved yet. Open a website's image gallery and click "Save to Server" to add photos.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {/* Tab Bar for Saved Groups */}
                  <div className="tab-bar" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
                    {Object.entries(getSavedImagesGroups()).map(([id, group]) => (
                      <button
                        key={id}
                        className={`tab-btn ${activeSavedTab === id ? 'active' : ''}`}
                        onClick={() => { setActiveSavedTab(id); setSelectedImageIds({}); }}
                      >
                        {group.name} ({group.items.length})
                      </button>
                    ))}
                  </div>

                  {/* Type Filter Checkboxes */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                    <span style={{ color: 'var(--color-text-muted)' }}>แสดง Type:</span>
                    {Object.entries(SAVED_TYPE_META).map(([type, meta]) => (
                      <label key={type} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={visibleTypes[type]}
                          onChange={() => toggleVisibleType(type)}
                        />
                        {meta.icon} {meta.label}
                      </label>
                    ))}
                  </div>

                  {Object.entries(getSavedImagesGroups()).map(([id, group]) => {
                    if (activeSavedTab !== id) return null;
                    const itemsByType = { ad: [], content: [], manga: [] };
                    group.items.forEach(item => {
                      const type = itemsByType[item.type] ? item.type : 'content';
                      itemsByType[type].push(item);
                    });
                    const selectedCount = group.items.filter(item => selectedImageIds[item.id]).length;

                    return (
                      <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
                          <h4 style={{ fontSize: '1.1rem', color: 'var(--color-blue)', margin: 0 }}>
                            {group.name} <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', fontWeight: 'normal' }}>({group.items.length} images)</span>
                          </h4>
                          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {selectedCount > 0 && (
                              <button
                                className="btn btn-danger"
                                style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                                disabled={isBulkDeleting}
                                onClick={handleDeleteSelectedImages}
                              >
                                {isBulkDeleting ? 'Deleting...' : `Delete Selected (${selectedCount})`}
                              </button>
                            )}
                            <button
                              className="btn btn-danger"
                              style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                              onClick={() => handleDeleteSavedGroup(id, group.name)}
                            >
                              Delete All ({group.items.length} images)
                            </button>
                          </div>
                        </div>

                        {Object.entries(itemsByType).map(([type, items]) => {
                          if (items.length === 0 || !visibleTypes[type]) return null;
                          const meta = SAVED_TYPE_META[type];
                          return (
                            <div key={type} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                              <h5 style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)', margin: 0 }}>
                                {meta.icon} {meta.label} ({items.length})
                              </h5>
                              <div className="gallery-grid">
                                {items.map((item) => (
                                  <div key={item.id} className="gallery-card">
                                    <div className="gallery-img-container" style={{ position: 'relative' }}>
                                      <input
                                        type="checkbox"
                                        checked={!!selectedImageIds[item.id]}
                                        onChange={() => toggleSelectedImage(item.id)}
                                        style={{ position: 'absolute', top: '0.35rem', left: '0.35rem', width: '1.1rem', height: '1.1rem', cursor: 'pointer', zIndex: 1 }}
                                        title="Select image"
                                      />
                                      <img
                                        src={`/api/saved-assets/${item.filename}`}
                                        alt={item.originalUrl}
                                        onError={(e) => {
                                          e.target.src = 'https://placehold.co/150x150/1e293b/64748b?text=Missing+Image';
                                        }}
                                      />
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', padding: '0.25rem 0' }}>
                                      <span style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)', textAlign: 'center' }}>
                                        Saved: {new Date(item.timestamp).toLocaleDateString()}
                                      </span>
                                      <div style={{ display: 'flex', gap: '0.25rem', width: '100%', marginTop: '0.25rem' }}>
                                        <a
                                          href={`/api/saved-assets/${item.filename}`}
                                          download
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="btn btn-secondary"
                                          style={{ flex: 1, padding: '0.2rem 0', fontSize: '0.65rem' }}
                                          title="View full size image"
                                        >
                                          View
                                        </a>
                                        <button
                                          className="btn btn-danger"
                                          style={{ flex: 1, padding: '0.2rem 0', fontSize: '0.65rem' }}
                                          onClick={() => handleDeleteSavedImage(item.id)}
                                          title="Delete from server"
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
        </div>
      )}


      {/* End Main Content */}
      </main>

      {/* Footer remains outside if desired, or can be omitted in sidebar layout. Let's omit or place it in sidebar. */}
    </div>
  );
}

export default App;
