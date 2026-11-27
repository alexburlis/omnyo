import {
  experimental_Icon as Icon,
  experimental_ResponsiveDrawerShell as ResponsiveDrawerShell,
} from "@omnyo/plugin-sdk/app";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useIsCompactViewport } from "../../components/omnyo/components/ui/hooks/use-compact-viewport.js";
import { usePersistentOverlayFocus } from "../../components/omnyo/components/ui/responsive-overlay.js";
import type { SmError } from "./data/client.js";
import { errorCopy } from "./errors.js";

export type Tone = "success" | "warning" | "muted" | "danger" | "attention" | "info";

export function Pill({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: string }) {
  return (
    <span className={`stm-pill stm-pill--${tone}`}>
      {icon === undefined ? (
        <span className="stm-pill-dot" aria-hidden="true" />
      ) : (
        <Icon name={icon} fallback="Circle" aria-hidden className="stm-pill-icon" />
      )}
      <span>{children}</span>
    </span>
  );
}

export function Chip({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: Tone | "selected";
}) {
  return <span className={`stm-chip stm-chip--${tone}`}>{children}</span>;
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled = false,
  disabledReason,
  type = "button",
  icon,
  ariaLabel,
  pending = false,
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  disabled?: boolean;
  disabledReason?: string;
  type?: "button" | "submit";
  icon?: string;
  ariaLabel?: string;
  pending?: boolean;
}) {
  return (
    <button
      type={type}
      className={`stm-button stm-button--${variant}`}
      disabled={disabled || pending}
      aria-disabled={disabled || pending}
      aria-busy={pending || undefined}
      aria-label={ariaLabel}
      title={disabled ? disabledReason : undefined}
      onClick={onClick}
    >
      {icon !== undefined ? (
        <Icon name={icon} fallback="Circle" aria-hidden className="stm-button-icon" />
      ) : null}
      {children}
    </button>
  );
}

export function EmptyState({
  title,
  body,
  actions,
}: {
  title: string;
  body?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="stm-empty">
      <p className="stm-empty-title">{title}</p>
      {body === undefined ? null : <p className="stm-empty-body">{body}</p>}
      {actions === undefined ? null : <div className="stm-row">{actions}</div>}
    </div>
  );
}

export function Alert({
  tone,
  title,
  children,
  actions,
}: {
  tone: "danger" | "warning" | "info";
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`stm-alert stm-alert--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <div className="stm-alert-body">
        {title === undefined ? null : <p className="stm-alert-title">{title}</p>}
        {children}
      </div>
      {actions === undefined ? null : <div className="stm-row">{actions}</div>}
    </div>
  );
}

export function ErrorAlert({
  error,
  onRetry,
  subject,
}: {
  error: SmError;
  onRetry?: () => void;
  subject?: string;
}) {
  const copy = errorCopy(error, subject);

  return (
    <Alert
      tone="danger"
      title={copy.title}
      actions={onRetry === undefined ? undefined : <Button onClick={onRetry}>Try again</Button>}
    >
      {copy.body === null ? null : <p className="stm-text-sm">{copy.body}</p>}
      {error.issues.length > 0 ? (
        <ul className="stm-issues">
          {error.issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <code className="stm-mono">{issue.path || "/"}</code> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

export function Skeleton({ rows = 3, height = 20 }: { rows?: number; height?: number }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 150);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="stm-skeleton-group" aria-busy="true" aria-label="Loading">
      {visible
        ? Array.from({ length: rows }, (_, index) => (
            <div key={index} className="stm-skeleton" style={{ height }} />
          ))
        : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={`stm-field${error ? " stm-field--error" : ""}`}>
      <label className="stm-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="stm-field-error">{error}</p>
      ) : hint === undefined ? null : (
        <p className="stm-field-hint">{hint}</p>
      )}
    </div>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const compact = useIsCompactViewport();
  const titleId = useId();

  const body = (
    <div className="stm-root stm-dialog-content">
      <h2 id={titleId} className="stm-h2 stm-dialog-title">
        {title}
      </h2>
      <div className="stm-dialog-body">{children}</div>
      {footer === undefined ? null : <div className="stm-dialog-footer">{footer}</div>}
    </div>
  );

  if (compact)
    return (
      <ResponsiveDrawerShell
        motionDurationMs={220}
        open={open}
        onOpenChange={onOpenChange}
        labelledBy={titleId}
        contentClassName="stm-drawer"
      >
        {body}
      </ResponsiveDrawerShell>
    );

  if (!open) return null;

  return (
    <CenteredDialog onClose={() => onOpenChange(false)} titleId={titleId} wide={wide}>
      {body}
    </CenteredDialog>
  );
}

function CenteredDialog({
  children,
  onClose,
  titleId,
  wide,
}: {
  children: ReactNode;
  onClose(): void;
  titleId: string;
  wide: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const requestClose = useCallback(() => onClose(), [onClose]);

  usePersistentOverlayFocus({ open: true, panelRef, requestClose });

  return createPortal(
    <div className="stm-root stm-dialog-layer" data-omnyo-portaled-overlay="">
      <div className="stm-dialog-backdrop" aria-hidden="true" onClick={requestClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`stm-dialog${wide ? " stm-dialog--wide" : ""}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Sheet({
  open,
  onOpenChange,
  label,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  label: string;
  children: ReactNode;
}) {
  return (
    <ResponsiveDrawerShell
      motionDurationMs={220}
      open={open}
      onOpenChange={onOpenChange}
      srLabel={label}
      contentClassName="stm-drawer"
    >
      <div className="stm-root stm-drawer-body">{children}</div>
    </ResponsiveDrawerShell>
  );
}

export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;

    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);

    return () => window.clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatAbsolute(at: number): string {
  return new Date(at).toISOString();
}

export function formatRelative(at: number, now: number): string {
  const seconds = Math.round((now - at) / 1000);

  if (seconds < 45) return "just now";

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);

  if (hours < 24) return `${hours}h ago`;

  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function TimeAgo({ at, now }: { at: number; now: number }) {
  return (
    <time dateTime={formatAbsolute(at)} title={formatAbsolute(at)}>
      {formatRelative(at, now)}
    </time>
  );
}
