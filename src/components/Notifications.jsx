import { useState } from 'react';

// In-theme replacement for the browser's native alert()/confirm() - those
// break the dark UI with an unstyled OS dialog and block the whole tab.
// Usage: const { notify, confirmAction, ToastStack, ConfirmModal } = useNotifications();
// notify.success/error/info(message) fires a toast; confirmAction(message, opts)
// returns a Promise<boolean> so call sites can `if (!(await confirmAction(...))) return;`
// just like the old `if (!confirm(...)) return;`.

let toastIdCounter = 0;

const TOAST_META = {
  success: { icon: '✓', className: 'toast-success' },
  error: { icon: '⚠️', className: 'toast-error' },
  info: { icon: 'ℹ️', className: 'toast-info' },
};

const TOAST_LIFETIME_MS = 5000;

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

  const ToastStack = () => (
    <div className="toast-stack">
      {toasts.map(t => {
        const meta = TOAST_META[t.type] || TOAST_META.info;
        return (
          <div key={t.id} className={`toast ${meta.className}`}>
            <span className="toast-icon">{meta.icon}</span>
            <span className="toast-body">{t.message}</span>
            <button className="toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">×</button>
          </div>
        );
      })}
    </div>
  );

  const ConfirmModal = () => {
    if (!confirmState) return null;
    return (
      <div className="modal-overlay" onClick={() => resolveConfirm(false)}>
        <div className="modal-content" style={{ maxWidth: '420px' }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>{confirmState.danger ? '⚠️ ยืนยันการลบ' : 'ยืนยันการทำงาน'}</h3>
            <button className="modal-close" onClick={() => resolveConfirm(false)}>×</button>
          </div>
          <p className="confirm-modal-message">{confirmState.message}</p>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => resolveConfirm(false)}>
              {confirmState.cancelLabel}
            </button>
            <button
              className={confirmState.danger ? 'btn btn-danger' : 'btn btn-primary'}
              onClick={() => resolveConfirm(true)}
            >
              {confirmState.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return { notify, confirmAction, ToastStack, ConfirmModal };
}
