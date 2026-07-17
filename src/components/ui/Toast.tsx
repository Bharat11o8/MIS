import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-react";

export type ToastKind = "success" | "error" | "warning" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

interface ToastContextValue {
  /** Show a toast. Errors stay until dismissed; everything else auto-hides. */
  toast: (kind: ToastKind, title: string, description?: string) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const STYLES: Record<ToastKind, { icon: React.ReactNode; color: string; bg: string; border: string }> = {
  success: { icon: <CheckCircle2 size={16} />, color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
  error: { icon: <XCircle size={16} />, color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
  warning: { icon: <AlertTriangle size={16} />, color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  info: { icon: <Info size={16} />, color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
};

/** Errors need reading (and often copying), so they don't disappear on their own. */
const AUTO_DISMISS_MS: Record<ToastKind, number | null> = {
  success: 3500,
  info: 4000,
  warning: 6000,
  error: null,
};

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (kind: ToastKind, title: string, description?: string) => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, kind, title, description }]);
      const ms = AUTO_DISMISS_MS[kind];
      if (ms !== null) setTimeout(() => dismiss(id), ms);
    },
    [dismiss]
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (t, d) => toast("success", t, d),
      error: (t, d) => toast("error", t, d),
      warning: (t, d) => toast("warning", t, d),
      info: (t, d) => toast("info", t, d),
    }),
    [toast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="no-print fixed bottom-6 right-6 z-[100] flex flex-col gap-2.5 w-[min(380px,calc(100vw-3rem))]">
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const s = STYLES[t.kind];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, x: 24, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24, scale: 0.96 }}
                transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                className="rounded-2xl border bg-white shadow-lg p-3.5 flex items-start gap-3"
                style={{ borderColor: s.border, boxShadow: "0 12px 40px rgba(0,0,0,0.10)" }}
                role={t.kind === "error" ? "alert" : "status"}
              >
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: s.bg, color: s.color }}
                >
                  {s.icon}
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <p className="text-xs font-bold text-gray-800 leading-snug">{t.title}</p>
                  {t.description && (
                    <p className="text-[11px] text-gray-500 mt-1 leading-relaxed break-words">{t.description}</p>
                  )}
                </div>
                <button
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss notification"
                  className="w-6 h-6 rounded-lg text-gray-300 hover:text-gray-600 hover:bg-gray-50 flex items-center justify-center shrink-0 transition-colors"
                >
                  <X size={13} />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
