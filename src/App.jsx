import React, { useState, useEffect } from 'react';
import './App.css';

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
  const [monitors, setMonitors] = useState([]);
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({ total: 0, up: 0, down: 0, unknown: 0, avgResponseTime: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modals state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingMonitor, setEditingMonitor] = useState(null);

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
      alert(err.message);
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
      alert(err.message);
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
      alert(err.message);
    }
  };

  // Handle Delete Monitor
  const handleDeleteMonitor = async (id) => {
    if (!confirm('Are you sure you want to delete this monitor?')) return;

    try {
      const res = await fetch(`/api/monitors/${id}`, {
        method: 'DELETE'
      });

      if (!res.ok) throw new Error('Failed to delete monitor');
      fetchData();
    } catch (err) {
      alert(err.message);
    }
  };

  // Handle Manual check trigger
  const handleManualCheck = async (id) => {
    if (checkingIds[id]) return;

    setCheckingIds(prev => ({ ...prev, [id]: true }));
    try {
      const res = await fetch(`/api/monitors/${id}/check`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error('Check request failed');
      fetchData();
    } catch (err) {
      alert(err.message);
    } finally {
      setCheckingIds(prev => ({ ...prev, [id]: false }));
    }
  };

  // Handle Clear Logs
  const handleClearLogs = async () => {
    if (!confirm('Clear all in-app logs?')) return;

    try {
      const res = await fetch('/api/logs/clear', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to clear logs');
      fetchData();
    } catch (err) {
      alert(err.message);
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
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="brand-section">
          <div className="logo-icon">🤖</div>
          <div>
            <h1>Robot Monitor</h1>
            <p>Real-time Web Uptime Checker & Alerts</p>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={() => setIsAddModalOpen(true)}>
            <span>+</span> Add Website
          </button>
        </div>
      </header>

      {/* Network / Connection Error Warning Banner */}
      {error && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.15)',
          border: '1px solid var(--color-red)',
          color: 'var(--color-red)',
          padding: '1rem',
          borderRadius: '0.75rem',
          fontSize: '0.9rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span>⚠️ {error}</span>
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
                <div className="empty-icon">🌐</div>
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
                        <span className="monitor-name">{monitor.name}</span>
                        <a
                          href={monitor.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="monitor-url"
                        >
                          {monitor.url}
                        </a>
                      </div>

                      {/* Status */}
                      <div className="monitor-status-section">
                        {monitor.active ? renderStatusBadge(monitor.status) : <span className="status-badge badge-unknown">Paused</span>}
                      </div>

                      {/* Stats */}
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

                      {/* Action buttons */}
                      <div className="monitor-actions">
                        <button
                          className="btn btn-secondary btn-icon-only"
                          title={monitor.active ? 'Pause polling' : 'Resume polling'}
                          onClick={() => handleToggleActive(monitor)}
                        >
                          {monitor.active ? '⏸️' : '▶️'}
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
                          {checkingIds[monitor.id] ? '⏳' : '🔄'}
                        </button>
                        <button
                          className="btn btn-secondary btn-icon-only"
                          title="Edit settings"
                          onClick={() => openEditModal(monitor)}
                        >
                          ✏️
                        </button>
                        <button
                          className="btn btn-danger btn-icon-only"
                          title="Delete monitor"
                          onClick={() => handleDeleteMonitor(monitor.id)}
                        >
                          🗑️
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
                <h3>🔔 Activity History</h3>
                {logs.length > 0 && (
                  <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={handleClearLogs}>
                    Clear
                  </button>
                )}
              </div>
              <div className="alerts-list">
                {logs.length === 0 ? (
                  <div className="alerts-empty">
                    <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🔕</div>
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

      <footer className="app-footer">
        <p>Robot Uptime Monitor &copy; 2026. Made with ❤️ for website reliability.</p>
      </footer>
    </div>
  );
}

export default App;
