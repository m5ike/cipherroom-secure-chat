import { Fragment, type ReactNode } from "react";

const URL_PATTERN = /\b((?:https?|ftp):\/\/[^\s<>"]+|www\.[^\s<>"]+)/gi;

export function linkify(text: string): ReactNode {
  if (!text) return text;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_PATTERN.lastIndex = 0;

  while ((match = URL_PATTERN.exec(text)) !== null) {
    const start = match.index;
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }
    const raw = match[0];
    const href = raw.startsWith("www.") ? `https://${raw}` : raw;
    parts.push(
      <a
        key={`lnk-${start}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="underline decoration-dotted underline-offset-2 hover:opacity-80"
      >
        {raw}
      </a>,
    );
    lastIndex = start + raw.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? <Fragment>{parts}</Fragment> : text;
}
