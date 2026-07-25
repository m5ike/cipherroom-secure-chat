// File-transfer progress card rendered inline in the chat stream.
// Shows live metrics — transport (P2P / proxy), encryption status,
// bytes-per-second, ETA, and human-readable sizes.

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Cloud,
  Download,
  Lock,
  Radio,
  ShieldCheck,
  Upload,
  XCircle,
} from "lucide-react";
import type { TransferStats } from "../lib/file-transfer";

type CardStatus = "active" | "completed" | "cancelled" | "error";

export type TransferCardProps = {
  id: string;
  name: string;
  size: number;
  direction: "in" | "out";
  initialStats?: TransferStats;
  onRemove?: (id: string) => void;
  finalStatus?: CardStatus;
  errorMessage?: string;
};

function formatBytes(value: number): string {
  if (value <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"] as const;
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const decimals = v >= 100 || i === 0 ? 0 : 1;
  return `${v.toFixed(decimals)} ${units[i]}`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatBps(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024) return `${Math.round(value)} B/s`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB/s`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB/s`;
}

export function TransferCard(props: TransferCardProps) {
  const [stats, setStats] = useState<TransferStats | null>(props.initialStats ?? null);

  // The parent uses onStats to push live updates; here we just expose a
  // setStats that can be wired up through window events for very simple cases.
  useEffect(() => {
    if (!props.initialStats) return;
    setStats(props.initialStats);
  }, [props.initialStats]);

  const status: CardStatus = props.finalStatus ?? (stats && stats.progress >= 1 ? "completed" : "active");
  const received = stats?.received ?? 0;
  const total = stats?.size ?? props.size;
  const progress = stats?.progress ?? (total > 0 ? received / total : 0);
  const transport = stats?.transport ?? "p2p";
  const bps = stats?.bytesPerSecond ?? 0;
  const eta = stats?.etaSeconds ?? 0;

  const DirectionIcon = props.direction === "out" ? Upload : Download;
  const TransportIcon = transport === "p2p" ? Radio : Cloud;

  const headerClass = props.direction === "out"
    ? "border-r-2 border-r-primary"
    : "border-r-2 border-r-emerald-500";

  const ringTrack = "#e5e7eb";
  const ringProgress = status === "error" ? "#ef4444" : status === "cancelled" ? "#f59e0b" : (transport === "p2p" ? "#0a84ff" : "#a855f7");
  const radius = 18;
  const c = 2 * Math.PI * radius;
  const dash = `${(progress * c).toFixed(2)} ${c}`;

  return (
    <div
      data-testid={`transfer-${props.id}`}
      className={`mt-2 rounded-2xl border border-border bg-card/80 backdrop-blur shadow-sm transition-shadow hover:shadow-md ${headerClass}`}
    >
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <DirectionIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="uppercase tracking-wide font-semibold">
              {props.direction === "out" ? "Odesílám" : "Přijímám"}
            </span>
            <span className="text-border">·</span>
            <span className="truncate font-mono">{props.name}</span>
          </div>
          <div className="mt-0.5 text-sm font-semibold text-foreground truncate">
            {formatBytes(received)} <span className="font-normal text-muted-foreground">/ {formatBytes(total)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <StatusBadge status={status} />
        </div>
      </div>

      <div className="px-4 pb-3">
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full transition-[width] duration-200 ease-out"
            style={{
              width: `${Math.min(100, Math.round(progress * 100))}%`,
              background: ringProgress,
            }}
            data-testid={`transfer-progress-${props.id}`}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-x-2 gap-y-1 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <MetricPill icon={<TransportIcon className="h-3.5 w-3.5" />} label="transport" value={transport === "p2p" ? "P2P" : "Proxy"} accentClass={transport === "p2p" ? "text-sky-500" : "text-violet-500"} />
        <MetricPill icon={<Lock className="h-3.5 w-3.5" />} label="encrypt" value="AES-GCM-256" accentClass="text-emerald-500" />
        <MetricPill icon={<ShieldCheck className="h-3.5 w-3.5" />} label="e2ee" value="end-to-end" accentClass="text-emerald-500" />
        <MetricPill icon={<Radio className="h-3.5 w-3.5" />} label="speed" value={formatBps(bps)} accentClass="text-primary" />
        <MetricPill icon={<Radio className="h-3.5 w-3.5" />} label="eta" value={formatEta(eta)} accentClass="text-primary" />
        <MetricPill icon={<Cloud className="h-3.5 w-3.5" />} label="chunks" value={stats ? `${Math.ceil(received / 32 / 1024)}` : "—"} accentClass="text-muted-foreground" />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{props.id}</span>
        {(status === "completed" || status === "cancelled" || status === "error") && (
          <button
            type="button"
            onClick={() => props.onRemove?.(props.id)}
            className="rounded-md bg-background px-2 py-1 text-[11px] hover:bg-accent"
          >
            Zavřít
          </button>
        )}
      </div>
      {props.errorMessage && status === "error" ? (
        <div className="border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-[11px] text-destructive">
          {props.errorMessage}
        </div>
      ) : null}
      {/* Quiet ring decoration — rendered as background pattern */}
      <svg width="0" height="0" aria-hidden="true">
        <defs>
          <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={ringProgress} />
            <stop offset="100%" stopColor={ringTrack} />
          </linearGradient>
        </defs>
      </svg>
      <div aria-hidden="true" className="hidden">{dash}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: CardStatus }) {
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Hotovo
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
        <XCircle className="h-3.5 w-3.5" />
        Zrušeno
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 text-[11px] font-semibold text-destructive">
        <XCircle className="h-3.5 w-3.5" />
        Chyba
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 text-[11px] font-semibold text-primary">
      <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
      Probíhá
    </span>
  );
}

function MetricPill({ icon, label, value, accentClass }: { icon: React.ReactNode; label: string; value: string; accentClass?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`shrink-0 ${accentClass ?? ""}`}>{icon}</span>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-[11px] font-mono font-semibold ${accentClass ?? "text-foreground"}`}>{value}</span>
    </div>
  );
}
