import { Fragment, type ReactNode } from "react";

// Links, and (5.2) @mentions and #tags: a mention is highlighted, a tag is a
// button that asks the app to show only the messages with it ("m5:tag").
const TOKEN_PATTERN = /\b((?:https?|ftp):\/\/[^\s<>"]+|www\.[^\s<>"]+)|(^|[\s(])([@#])([\p{L}\p{N}_][\p{L}\p{N}_.-]{0,39})/giu;

const TAG_PATTERN = /(?:^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_.-]{0,39})/gu;
/** A tag as the chat shows and filters it: lower case, no trailing "." or "-". */
const tagOf = (word: string) => word.replace(/[.-]+$/, "").toLowerCase();

/** The #tags of a message — the same ones linkify turns into buttons. */
export function tagsIn(text: string): string[] {
  if (!text || !text.includes("#")) return [];
  return [...text.matchAll(TAG_PATTERN)].map((m) => tagOf(m[1])).filter(Boolean);
}

export function linkify(text: string): ReactNode {
  if (!text) return text;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TOKEN_PATTERN.lastIndex = 0;

  while ((match = TOKEN_PATTERN.exec(text)) !== null) {
    if (match[1]) {
      const start = match.index;
      if (start > lastIndex) parts.push(text.slice(lastIndex, start));
      const raw = match[1];
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
      continue;
    }
    const start = match.index + match[2].length;
    if (start > lastIndex) parts.push(text.slice(lastIndex, start));
    const word = match[4].replace(/[.-]+$/, ""); // the same as tagOf, keeping the case
    const end = start + 1 + word.length;
    if (match[3] === "#") {
      parts.push(
        <button key={`tag-${start}`} type="button" className="hashtag" data-tag={word.toLowerCase()}
          onClick={() => window.dispatchEvent(new CustomEvent("m5:tag", { detail: word.toLowerCase() }))}>
          #{word}
        </button>,
      );
    } else {
      parts.push(<span key={`men-${start}`} className="mention">@{word}</span>);
    }
    lastIndex = end;
    TOKEN_PATTERN.lastIndex = end;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? <Fragment>{parts}</Fragment> : text;
}
