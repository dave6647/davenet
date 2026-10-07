import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  APPROVAL_STATUS_LABELS,
  JOB_STATUS_LABELS,
  OPPORTUNITY_STATUS_LABELS,
  TASK_STATUS_LABELS,
  priorityLabel,
  type ApprovalStatus,
  type JobStatus,
  type OpportunityStatus,
  type TaskStatus,
} from '../../../shared/domain.ts';

// ---------------------------------------------------------------- Toasts

interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'error' | 'info';
}
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Führt eine Aktion aus und meldet Erfolg/Fehler. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (okText) toast(okText, 'ok');
        return r;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

// ---------------------------------------------------------------- Bausteine

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          <div className="spacer" />
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHead({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      <div className="spacer" />
      {actions && <div className="btn-row">{actions}</div>}
    </div>
  );
}

export function Badge({ kind, children, title }: { kind?: 'ok' | 'warn' | 'err' | 'info' | 'accent'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${kind ?? ''}`} title={title}>
      {children}
    </span>
  );
}

const JOB_KIND: Record<JobStatus, 'ok' | 'warn' | 'err' | 'info' | 'accent' | undefined> = {
  QUEUED: 'info',
  RUNNING: 'accent',
  WAITING_FOR_PROVIDER_QUOTA: 'warn',
  WAITING_FOR_APPROVAL: 'warn',
  BLOCKED: 'err',
  COMPLETED: 'ok',
  FAILED: 'err',
  CANCELLED: undefined,
};
export const JobStatusBadge = ({ status }: { status: JobStatus }) => <Badge kind={JOB_KIND[status]}>{JOB_STATUS_LABELS[status] ?? status}</Badge>;

const OPP_KIND: Partial<Record<OpportunityStatus, 'ok' | 'warn' | 'err' | 'info' | 'accent'>> = {
  DISCOVERED: 'info',
  SCREENING: 'info',
  RESEARCH: 'info',
  EVALUATION: 'info',
  PROPOSED: 'warn',
  TESTING: 'accent',
  APPROVED: 'accent',
  DEVELOPMENT: 'accent',
  REVIEW: 'accent',
  READY: 'warn',
  DEPLOYED: 'ok',
  REJECTED: 'err',
};
export const OppStatusBadge = ({ status }: { status: OpportunityStatus }) => <Badge kind={OPP_KIND[status]}>{OPPORTUNITY_STATUS_LABELS[status] ?? status}</Badge>;

const TASK_KIND: Partial<Record<TaskStatus, 'ok' | 'warn' | 'err' | 'info' | 'accent'>> = {
  TODO: 'info',
  IN_PROGRESS: 'accent',
  IN_REVIEW: 'accent',
  REWORK: 'warn',
  DONE: 'ok',
  BLOCKED: 'err',
};
export const TaskStatusBadge = ({ status }: { status: TaskStatus }) => <Badge kind={TASK_KIND[status]}>{TASK_STATUS_LABELS[status] ?? status}</Badge>;

const APPROVAL_KIND: Record<ApprovalStatus, 'ok' | 'warn' | 'err' | undefined> = { PENDING: 'warn', APPROVED: 'ok', REJECTED: 'err', CANCELLED: undefined };
export const ApprovalStatusBadge = ({ status }: { status: ApprovalStatus }) => <Badge kind={APPROVAL_KIND[status]}>{APPROVAL_STATUS_LABELS[status]}</Badge>;

export const PriorityBadge = ({ p }: { p: number }) => <Badge kind={p >= 3 ? 'err' : p === 2 ? 'warn' : undefined}>{priorityLabel(p)}</Badge>;

export const CapBadge = ({ c }: { c: string }) => <Badge kind={c === 'HIGH' ? 'accent' : c === 'LOW' ? undefined : 'info'}>{c}</Badge>;

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="alert error">⚠ {error}</div>;
}

export function Loading() {
  return <div className="empty">Lädt …</div>;
}

export function Modal({ title, onClose, children, wide, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="small" onClick={onClose} aria-label="Schließen">
            ✕
          </button>
        </div>
        {children}
        {footer && <div className="btn-row" style={{ justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.key} className={`tab ${value === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Meter für einen Wert gegen ein Limit. Ab 80 % Warnung, ab 100 % kritisch – immer mit Prozent-Label (nie nur Farbe). */
export function Bar({ value, max, kind }: { value: number; max: number; kind?: 'warn' | 'err' }) {
  const raw = max > 0 ? (value / max) * 100 : 0;
  const p = Math.min(100, raw);
  const state = kind ?? (raw >= 100 ? 'err' : raw >= 80 ? 'warn' : '');
  return (
    <div className="meter">
      <div className={`bar ${state}`} role="meter" aria-valuenow={Math.round(raw)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${p}%` }} />
      </div>
      <span className="meter-label">
        {state ? '⚠ ' : ''}
        {Math.round(raw)} %
      </span>
    </div>
  );
}

/** Button mit Rückfrage vor kritischen Aktionen. */
export function ConfirmButton({ children, confirm, onConfirm, className, disabled, title }: { children: ReactNode; confirm: string; onConfirm: () => void; className?: string; disabled?: boolean; title?: string }) {
  return (
    <button className={className} disabled={disabled} title={title} onClick={() => window.confirm(confirm) && onConfirm()}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Formularfelder

export function Field({ label, help, children, full }: { label: ReactNode; help?: ReactNode; children: ReactNode; full?: boolean }) {
  return (
    <label className={`field ${full ? 'full' : ''}`}>
      <span>{label}</span>
      {children}
      {help && <span className="help">{help}</span>}
    </label>
  );
}

export function TextInput({ value, onChange, placeholder, disabled, type }: { value: string | null | undefined; onChange: (v: string) => void; placeholder?: string; disabled?: boolean; type?: string }) {
  return <input type={type ?? 'text'} value={value ?? ''} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
}

export function TextArea({ value, onChange, rows, placeholder }: { value: string | null | undefined; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return <textarea value={value ?? ''} rows={rows ?? 4} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/** Zahl; leeres Feld = null (z. B. "kein Limit"). */
export function NumberInput({ value, onChange, step, placeholder, min }: { value: number | null | undefined; onChange: (v: number | null) => void; step?: number; placeholder?: string; min?: number }) {
  return (
    <input
      type="number"
      step={step ?? 1}
      min={min}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  );
}

export function Select<T extends string | number>({ value, onChange, options, allowEmpty }: { value: T | null | undefined; onChange: (v: T | null) => void; options: { value: T; label: string }[]; allowEmpty?: string }) {
  return (
    <select
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => {
        if (e.target.value === '') return onChange(null);
        const opt = options.find((o) => String(o.value) === e.target.value);
        onChange(opt ? opt.value : null);
      }}
    >
      {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
