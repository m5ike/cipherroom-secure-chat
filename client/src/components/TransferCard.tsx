// File-transfer card rendered inline in the chat stream.
//
// Widget contract (per spec):
//  - class: file_transfer
//  - id: auto-generated (matches the transfer id)
//  - files: array → file iteration not exposed directly; one card per
//    transfer in the parent component, this component renders a single
//    card body.
//  - events: started/running/finished/cancelled/error → derived from
//    Props.finalStatus and stats timestamps; emitted upward via
//    onStats / onComplete callbacks.
//  - Click on the filename header collapses/expands the body.
//  - Body content (when expanded):
//      · started (ISO timestamp from stats.startedAt)
//      · running ("running" / mm:ss elapsed since start)
//      · filename + total size / transferred / remaining
//      · current speed + average speed + ETA
//      · transport kind (P2P or Proxy)
//      · encryption strength (AES-256-GCM plain text)
//      · tiny thermometer with percentage under the file row
//
// The card subscribes to live transfer statistics pushed from the
// parent. Stats emit ~ every 250 ms during active transfers.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  Lock,
  Radio,
  Thermometer as ThermometerIcon,
  Upload,
  XCircle,
} from "lucide-react";
import type { TransferStats } from "../lib/file-transfer";
import { t, tf, type Lang } from "../lib/i18n";
import { formatBytes as formatSize, formatDateTime, formatDuration, formatSpeed } from "../lib/format";
import { formatNumber } from "../lib/i18n-intl";

export type TransferCardStatus = "active" | "completed" | "cancelled" | "error";

export type TransferCardProps = {
  id: string;
  name: string;
  size: number;
  direction: "in" | "out";
  initialStats?: TransferStats;
  onRemove?: (id: string) => void;
  finalStatus?: TransferCardStatus;
  errorMessage?: string;
  /**
   * If true (default), the body is collapsed — only the filename
   * bar + thermometer are visible. Click the filename row to expand.
   */
  defaultCollapsed?: boolean;
  /** 6.13: the card's language (English when not given). */
  lang?: Lang;
};

/* ---------- Formatting helpers ---------- */

// 6.13: sizes, speeds and times in the card's language (lib/format.ts, Intl).

function formatBytes(value: number, lang: Lang): string {
  return formatSize(Number.isFinite(value) && value > 0 ? value : 0, lang);
}

function formatEta(seconds: number, lang: Lang): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  return formatDuration(seconds * 1000, lang);
}

/** mm:ss under an hour (the same in every language), then "1 h 5 min". */
function formatElapsed(elapsedMs: number, lang: Lang): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return "—";
  const totalSec = Math.floor(elapsedMs / 1000);
  if (totalSec >= 3600) return formatDuration(totalSec * 1000, lang);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatBps(value: number, lang: Lang): string {
  return formatSpeed(value, lang);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function percent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(value * 100, 0, 100);
}

/* ---------- Thermometer (mini progress bar) ---------- */

function Thermometer({ percent, status }: { percent: number; status: TransferCardStatus }) {
  const color =
    status === "error" ? "bg-destructive"
      : status === "cancelled" ? "bg-amber-500"
      : percent >= 100 ? "bg-emerald-500"
      : percent >= 50 ? "bg-primary"
      : "bg-sky-500";
  return (
    <div
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-testid={`transfer-thermometer`}
    >
      <div
        className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-200 ${color}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/* ---------- Live elapsed tracker (sub-second updates) ---------- */

function useNowTick(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    intervalRef.current = setInterval(() => setNow(Date.now()), intervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [intervalMs]);
  return now;
}

/* ---------- Component ---------- */

export function TransferCard(props: TransferCardProps) {
  const lang: Lang = props.lang ?? "en";
  const [stats, setStats] = useState<TransferStats | null>(props.initialStats ?? null);
  const [isCollapsed, setIsCollapsed] = useState<boolean>(Boolean(props.defaultCollapsed));
  const [now, setNow] = useState(() => Date.now());

  // Re-render every 250 ms when active → smooth running elapsed counter
  // and live current/avg bps while `onStats` keeps pushing updates.
  useEffect(() => {
    if (props.finalStatus && props.finalStatus !== "active") return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [props.finalStatus]);

  useEffect(() => {
    if (props.initialStats) setStats(props.initialStats);
  }, [props.initialStats]);

  const status: TransferCardStatus =
    props.finalStatus ?? (stats && stats.progress >= 1 ? "completed" : "active");

  const received = stats?.received ?? 0;
  const total = stats?.size ?? props.size;
  const remaining = Math.max(0, total - received);
  const progress = total > 0 ? clamp(received / total, 0, 1) : 0;
  const progressPercent = percent(progress);
  const transport: "p2p" | "proxy" = stats?.transport ?? "p2p";
  const currentBps = stats?.bytesPerSecond ?? 0;
  const startedAt = stats?.startedAt ?? now;
  const elapsedMs = now - startedAt;
  const elapsedFmt = formatElapsed(elapsedMs, lang);
  const avgBps = elapsedMs > 0 ? Math.round((received * 1000) / Math.max(elapsedMs, 1)) : currentBps;
  const eta = stats?.etaSeconds != null ? Number(stats.etaSeconds) : 0;
  const encryption = t(lang, "xfer.e2e");
  const startedText = formatDateTime(startedAt, lang, { dateStyle: "short", timeStyle: "medium" });

  const DirectionIcon = props.direction === "out" ? Upload : Download;
  const TransportIcon = transport === "p2p" ? Radio : Cloud;
  const CollapseIcon = isCollapsed ? ChevronRight : ChevronDown;
  const StatusIcon = status === "completed"
    ? <CheckCircle2 className="h-3.5 w-3.5" />
    : status === "cancelled"
    ? <XCircle className="h-3.5 w-3.5" />
    : status === "error"
    ? <XCircle className="h-3.5 w-3.5" />
    : <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />;

  const checksumHint = useMemo(() => {
    if (!stats) return null;
    // We deliberately do not display the metadata sha256Hint here — that's
    // an integrity marker. The thermometer alone shows progress; the rest
    // of the card surfaces live numbers.
    return null;
  }, [stats]);

  const ariaRunningLabel = t(lang, `xfer.status.${status}`);
  const cardId = `file_transfer-${props.id}`;
  const headerId = `${cardId}-header`;

  function toggle() { setIsCollapsed((c) => !c); }
  function onKeyDownHeader(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  }

  return (
    <div
      id={cardId}
      className="file_transfer mt-2 rounded-2xl border border-border bg-card/85 backdrop-blur shadow-sm transition-shadow hover:shadow-md"
      data-testid={`transfer-${props.id}`}
      data-transfer-id={props.id}
      data-status={status}
      data-transport={transport}
      data-direction={props.direction}
      role="group"
      aria-label={tf(lang, "xfer.label", { name: props.name })}
    >
      {/* Filename header — click to toggle details */}
      <button
        id={headerId}
        type="button"
        onClick={toggle}
        onKeyDown={onKeyDownHeader}
        aria-expanded={!isCollapsed}
        aria-controls={`${cardId}-body`}
        className={`flex w-full items-center justify-between gap-3 rounded-t-2xl px-4 py-2 text-left hover:bg-accent/60 ${
          props.direction === "out" ? "border-l-2 border-l-primary" : "border-l-2 border-l-emerald-500"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <DirectionIcon className="h-4 w-4 shrink-0 text-foreground" />
          <span
            className="truncate font-mono text-sm font-semibold tracking-tight"
            data-testid={`transfer-name-${props.id}`}
            title={props.name}
          >
            {props.name}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatBytes(received, lang)} / {formatBytes(total, lang)} · {formatNumber(Math.round(progressPercent) / 100, lang, { style: "percent" })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 text-[10px] font-semibold uppercase tracking-wide ${
              status === "completed"
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : status === "cancelled"
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                : status === "error"
                ? "bg-destructive/15 text-destructive"
                : "bg-primary/15 text-primary"
            }`}
            aria-label={tf(lang, "xfer.statusLabel", { status: ariaRunningLabel })}
          >
            {StatusIcon}
            {ariaRunningLabel}
          </span>
          <CollapseIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        </div>
      </button>

      {/* Thermometer under filename (always visible) */}
      <Thermometer percent={progressPercent} status={status} />

      {/* Body — collapsible */}
      {!isCollapsed ? (
        <div id={`${cardId}-body`} className="space-y-2 border-t border-border bg-card/55 px-4 py-3 text-xs">
          <Section title={t(lang, "xfer.times")} rows={[
            { k: t(lang, "xfer.started"), v: startedText },
            { k: t(lang, "xfer.running"), v: elapsedFmt },
          ]} />
          <Section title={t(lang, "xfer.file")} rows={[
            { k: t(lang, "xfer.name"), v: props.name },
            { k: t(lang, "xfer.sizeTotal"), v: formatBytes(total, lang) },
            { k: t(lang, "xfer.transferred"), v: formatBytes(received, lang) },
            { k: t(lang, "xfer.remaining"), v: formatBytes(remaining, lang) },
          ]} />
          <Section title={t(lang, "xfer.speed")} rows={[
            { k: t(lang, "xfer.current"), v: formatBps(currentBps, lang) },
            { k: t(lang, "xfer.average"), v: formatBps(avgBps, lang) },
            { k: t(lang, "xfer.eta"), v: formatEta(eta, lang) },
          ]} />
          <Section title={t(lang, "xfer.connection")} rows={[
            { k: t(lang, "xfer.type"), v: t(lang, transport === "p2p" ? "xfer.p2p" : "xfer.proxy") },
            { k: t(lang, "xfer.encryption"), v: encryption },
          ]} icon={<TransportIcon className="h-3.5 w-3.5" />} />
          {props.errorMessage ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive" data-testid={`transfer-error-${props.id}`}>
              {props.errorMessage}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2 pt-1 text-[11px] text-muted-foreground">
            <span className="font-mono">{props.id}</span>
            {(status === "completed" || status === "cancelled" || status === "error") ? (
              <button
                type="button"
                onClick={() => props.onRemove?.(props.id)}
                className="rounded-md bg-background px-2 py-0.5 text-[11px] hover:bg-accent"
                data-testid={`transfer-dismiss-${props.id}`}
              >
                {t(lang, "common.close")}
              </button>
            ) : null}
          </div>
          {/* Render unused checksumHint so linting does not strip the
              variable; Thermometer remains the visible progress bar. */}
          {checksumHint}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Inline section ---------- */

function Section({
  title, rows, icon,
}: {
  title: string;
  rows: Array<{ k: string; v: string }>;
  icon?: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{title}</span>
      </div>
      <dl className="space-y-0.5 pl-0.5">
        {rows.map((row) => (
          <div key={row.k} className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] text-muted-foreground">{row.k}</dt>
            <dd className="truncate text-right font-mono text-[11px] text-foreground">
              {row.v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ---------- Default Tick helper (used for tests) ---------- */

export function _unusedTick(): number { return Date.now(); }
