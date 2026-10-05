// 6.11: who a model's answer is from — "system-messenger" shown as the model:
// its icon (a lucide icon or an emoji) in a circle of the model's colour as
// the avatar, its name as the nickname. A room answer adds who really sent it
// ("via Alice" — the member whose client posted it, end-to-end encrypted and
// signed by them; a click opens their details).

import { MenuIcon } from "../MenuIcon";
import { MENU_ICON_ALIASES, MENU_ICONS } from "../../lib/menu-icons-data";
import type { ModelIdentity } from "../../lib/system-messenger";
import type { AnswerVia } from "../../lib/fn-answer";
import { t, tf, type Lang } from "../../lib/i18n";

/** Icons a model may name that the app's catalog does not carry: the nearest one it has. */
const NEAREST: Record<string, string> = {
  "phone-call": "phone-outgoing", "phone-forwarded": "phone-outgoing", "message-square-text": "message-square", network: "globe",
  "cloud-sun": "sun", calculator: "hash", receipt: "scroll-text", "id-card": "contact-round", "chart-bar": "chart-column",
};
const BY_ALIAS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [name, aliases] of Object.entries(MENU_ICON_ALIASES)) for (const a of aliases) out[a] = name;
  return out;
})();

/** A lucide name the app can draw for a model's icon (unknown ones: "bot"). */
export function modelIconName(icon: string): string {
  if (MENU_ICONS[icon]) return icon;
  const alias = BY_ALIAS[icon] ?? NEAREST[icon];
  return alias && MENU_ICONS[alias] ? alias : "bot";
}

const isLucideName = (icon: string) => /^[a-z][a-z0-9-]*$/.test(icon);

export function ModelAvatar({ identity, size = 24 }: { identity: ModelIdentity; size?: number }) {
  const lucide = isLucideName(identity.icon);
  return (
    <span
      className="model-avatar"
      aria-hidden="true"
      data-icon={lucide ? modelIconName(identity.icon) : "emoji"}
      style={{ width: size, height: size, background: identity.color, fontSize: Math.round(size * 0.55) }}
    >
      {lucide ? <MenuIcon name={modelIconName(identity.icon)} className="model-avatar__icon" /> : identity.icon}
    </span>
  );
}

export function ModelBadge({ identity, via, lang, onVia }: { identity: ModelIdentity; via: AnswerVia | null; lang: Lang; onVia?: () => void }) {
  const viaName = via ? (via.mine ? t(lang, "sysmsg.you") : via.name) : "";
  return (
    <span className="model-badge" data-testid={`model-badge-${identity.keyword}`} title={tf(lang, "sysmsg.title", { name: identity.name, keyword: identity.keyword })}>
      <ModelAvatar identity={identity} size={24} />
      <span className="model-badge__name">{identity.name}</span>
      <span className="model-badge__kw">/{identity.keyword}</span>
      {via ? (
        onVia && !via.mine
          ? <button type="button" className="model-badge__via" onClick={onVia} title={tf(lang, "sysmsg.viaTitle", { name: viaName })} data-testid="model-badge-via">{tf(lang, "sysmsg.via", { name: viaName })}</button>
          : <span className="model-badge__via" title={via.mine ? undefined : tf(lang, "sysmsg.viaTitle", { name: viaName })} data-testid="model-badge-via">{tf(lang, "sysmsg.via", { name: viaName })}</span>
      ) : null}
    </span>
  );
}
