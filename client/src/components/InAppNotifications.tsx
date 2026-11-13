import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export type NotificationVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  title?: string;
  message: string;
  variant: NotificationVariant;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'primary';
}

interface NotificationContextValue {
  notify: (
    message: string,
    variant?: NotificationVariant,
    title?: string,
    durationMs?: number
  ) => void;
  confirmDialog: (options: ConfirmOptions) => Promise<boolean>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmOptions | null>(null);
  const confirmResolverRef = useRef<((accepted: boolean) => void) | null>(null);
  const timersRef = useRef<Record<string, number>>({});

  const dismissToast = useCallback((id: string) => {
    if (timersRef.current[id]) {
      window.clearTimeout(timersRef.current[id]);
      delete timersRef.current[id];
    }
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const notify = useCallback(
    (
      message: string,
      variant: NotificationVariant = 'info',
      title?: string,
      durationMs?: number
    ) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const timeout = durationMs ?? (variant === 'error' || variant === 'warning' ? 5500 : 3800);

      setToasts(prev => [...prev.slice(-4), { id, title, message, variant }]);

      timersRef.current[id] = window.setTimeout(() => {
        dismissToast(id);
      }, timeout);
    },
    [dismissToast]
  );

  const resolveConfirm = useCallback((accepted: boolean) => {
    setPendingConfirm(null);
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    if (resolver) resolver(accepted);
  }, []);

  const confirmDialog = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise(resolve => {
      if (confirmResolverRef.current) {
        confirmResolverRef.current(false);
      }
      confirmResolverRef.current = resolve;
      setPendingConfirm(options);
    });
  }, []);

  useEffect(() => {
    if (!pendingConfirm) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        resolveConfirm(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [pendingConfirm, resolveConfirm]);

  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach(t => window.clearTimeout(t));
    };
  }, []);

  const renderIcon = (variant: NotificationVariant) => {
    switch (variant) {
      case 'success':
        return <CheckCircle2 size={18} className="inapp-toast-icon" />;
      case 'error':
        return <AlertCircle size={18} className="inapp-toast-icon" />;
      case 'warning':
        return <AlertTriangle size={18} className="inapp-toast-icon" />;
      default:
        return <Info size={18} className="inapp-toast-icon" />;
    }
  };

  return (
    <NotificationContext.Provider value={{ notify, confirmDialog }}>
      {children}

      {/* Stacked In-App Toast Notifications */}
      {toasts.length > 0 && (
        <div className="inapp-toast-stack" role="region" aria-live="polite" aria-label="Notifications">
          {toasts.map(t => (
            <div key={t.id} className={`inapp-toast inapp-toast-${t.variant}`} role="alert">
              <div className="inapp-toast-leading">{renderIcon(t.variant)}</div>
              <div className="inapp-toast-body">
                {t.title && <div className="inapp-toast-title">{t.title}</div>}
                <div className="inapp-toast-msg">{t.message}</div>
              </div>
              <button
                type="button"
                className="inapp-toast-close"
                onClick={() => dismissToast(t.id)}
                aria-label="Dismiss notification"
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* In-App Confirmation Modal Dialog */}
      {pendingConfirm && (
        <div
          className="inapp-confirm-overlay"
          onClick={() => resolveConfirm(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="inapp-confirm-title"
        >
          <div className="inapp-confirm-modal" onClick={e => e.stopPropagation()}>
            <div
              className={`inapp-confirm-icon-wrap ${
                pendingConfirm.variant === 'danger' ? 'confirm-danger' : 'confirm-primary'
              }`}
            >
              <AlertTriangle size={24} />
            </div>
            <h3 id="inapp-confirm-title">{pendingConfirm.title}</h3>
            <p className="inapp-confirm-msg">{pendingConfirm.message}</p>
            <div className="inapp-confirm-actions">
              <button
                type="button"
                className="btn-ui btn-ui-secondary"
                onClick={() => resolveConfirm(false)}
              >
                {pendingConfirm.cancelLabel || 'Cancel'}
              </button>
              <button
                type="button"
                className={`btn-ui ${
                  pendingConfirm.variant === 'danger' ? 'btn-ui-danger-solid' : 'btn-ui-primary'
                }`}
                onClick={() => resolveConfirm(true)}
                autoFocus
              >
                {pendingConfirm.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </NotificationContext.Provider>
  );
};

export function useNotify(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotify must be used within NotificationProvider');
  }
  return ctx;
}
