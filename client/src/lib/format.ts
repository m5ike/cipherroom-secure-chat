// Human-readable formatting helpers shared by the client UI.

import type { Lang } from "./i18n";

export function formatTime(value: number, lang: Lang, timezone: string) {
  try {
    return new Intl.DateTimeFormat(lang === "cs" ? "cs-CZ" : lang === "de" ? "de-DE" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: timezone || undefined,
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleTimeString();
  }
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
