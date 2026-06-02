import { useEffect, useState } from 'react';
import { Bell, X, CheckCircle2, Bot, Clock } from 'lucide-react';

export interface ToastItem {
  id: string;
  kind: 'cron' | 'delegation' | 'info' | 'success';
  title: string;
  body?: string;
  ts: number;
  onClick?: () => void;
}

interface NotificationToastProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

const AUTO_DISMISS_MS = 6_000;

const ICONS: Record<ToastItem['kind'], React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  cron: Clock,
  delegation: Bot,
  info: Bell,
  success: CheckCircle2,
};

const TONES: Record<ToastItem['kind'], string> = {
  cron: 'border-blue-400/40 bg-blue-50 text-blue-900',
  delegation: 'border-purple-400/40 bg-purple-50 text-purple-900',
  info: 'border-amber-400/40 bg-amber-50 text-amber-900',
  success: 'border-emerald-400/40 bg-emerald-50 text-emerald-900',
};

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    if (hovering) return;
    const t = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [toast.id, hovering, onDismiss]);

  const Icon = ICONS[toast.kind];
  const tone = TONES[toast.kind];

  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={() => { toast.onClick?.(); onDismiss(toast.id); }}
      className={`min-w-[300px] max-w-[400px] rounded-xl border-2 px-3.5 py-2.5 shadow-lg cursor-pointer transition-all hover:scale-[1.02] ${tone}`}
      role="alert"
    >
      <div className="flex items-start gap-2.5">
        <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={2.5} />
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm leading-tight">{toast.title}</div>
          {toast.body && (
            <div className="text-xs mt-1 opacity-80 leading-snug line-clamp-2">{toast.body}</div>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(toast.id); }}
          className="opacity-50 hover:opacity-100 transition-opacity flex-shrink-0"
          aria-label="닫기"
        >
          <X className="w-3.5 h-3.5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

export function NotificationToast({ toasts, onDismiss }: NotificationToastProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      <div className="flex flex-col gap-2 pointer-events-auto">
        {toasts.slice(-4).map(t => (
          <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}
