import { useState } from 'react';

// In-theme replacement for the browser's native alert()/confirm() - those
// break the UI with an unstyled OS dialog and block the whole tab.
// Usage: const { notify, confirmAction, ... } = useNotifications();
// notify.success/error/info(message) fires a toast; confirmAction(message, opts)
// returns a Promise<boolean> so call sites can `if (!(await confirmAction(...))) return;`
// just like the old `if (!confirm(...)) return;`.
//
// ToastStack/ConfirmModal are exported as stable, module-level components
// (not created inside the hook) and take their data via props - if they were
// recreated as closures on every render of the hook's caller, React would see
// a new component "type" each time and force-remount them, which restarts
// their CSS entrance animation mid-flight (observed as the confirm modal
// getting stuck invisible while a background poll kept re-rendering App).

let toastIdCounter = 0;

const TOAST_META = {
  success: { icon: '✓', className: 'toast-success' },
  error: { icon: '⚠️', className: 'toast-error' },
  info: { icon: 'ℹ️', className: 'toast-info' },
};

const TOAST_LIFETIME_MS = 5000;

export function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="toast-stack">
      {toasts.map(t => {
        const meta = TOAST_META[t.type] || TOAST_META.info;
        return (
          <div key={t.id} className={`toast ${meta.className}`}>
            <span className="toast-icon">{meta.icon}</span>
            <span className="toast-body">{t.message}</span>
            <button className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss">×</button>
          </div>
        );
      })}
    </div>
  );
}

export function ConfirmModal({ confirmState, onResolve }) {
  if (!confirmState) return null;
  return (
    <div className="modal-overlay" onClick={() => onResolve(false)}>
      <div className="modal-content" style={{ maxWidth: '420px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{confirmState.danger ? '⚠️ ยืนยันการลบ' : 'ยืนยันการทำงาน'}</h3>
          <button className="modal-close" onClick={() => onResolve(false)}>×</button>
        </div>
        <p className="confirm-modal-message">{confirmState.message}</p>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => onResolve(false)}>
            {confirmState.cancelLabel}
          </button>
          <button
            className={confirmState.danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() => onResolve(true)}
          >
            {confirmState.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useNotifications() {
  const [toasts, setToasts] = useState([]);
  const [confirmState, setConfirmState] = useState(null);

  const dismissToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const pushToast = (type, message) => {
    const id = ++toastIdCounter;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => dismissToast(id), TOAST_LIFETIME_MS);
  };

  const notify = {
    success: (message) => pushToast('success', message),
    error: (message) => pushToast('error', message),
    info: (message) => pushToast('info', message),
  };

  // options: { danger, confirmLabel, cancelLabel }
  const confirmAction = (message, options = {}) => {
    return new Promise((resolve) => {
      setConfirmState({
        message,
        danger: !!options.danger,
        confirmLabel: options.confirmLabel || 'ยืนยัน',
        cancelLabel: options.cancelLabel || 'ยกเลิก',
        resolve,
      });
    });
  };

  const resolveConfirm = (result) => {
    if (confirmState) confirmState.resolve(result);
    setConfirmState(null);
  };

  return { notify, confirmAction, toasts, dismissToast, confirmState, resolveConfirm };
}
