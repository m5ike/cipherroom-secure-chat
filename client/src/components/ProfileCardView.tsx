// A profile as one audience sees it (6.7): the background, the photo, the
// nickname, the about text and the fields shared with that audience. Used
// for the editor's preview, a member's details and a public lookup. What it
// shows came through normalizeShared() (profile/model.ts): the images are
// inline data: pictures (no request), a link opens only on a click and only
// mailto:, tel: or http(s).

import { AtSign, Building2, Cake, Globe, Link2, Mail, MapPin, Phone, StickyNote, User } from "lucide-react";
import type { ComponentType } from "react";
import { Avatar } from "./UserBadge";
import { t, type Lang } from "../lib/i18n";
import { fieldHref, type FieldType, type SharedProfile } from "../lib/profile/model";
import "./profile.css";

export const FIELD_ICONS: Record<FieldType, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  name: User, phone: Phone, email: Mail, address: MapPin, url: Globe, social: AtSign, org: Building2, birthday: Cake, other: StickyNote,
};

export function ProfileCardView({ profile, fallbackName, lang, testId = "profile-card", empty }: {
  profile: SharedProfile | null;
  /** The name to show (and draw the monogram from) when the profile has no nickname. */
  fallbackName: string;
  lang: Lang;
  testId?: string;
  /** Said when there is nothing to show. */
  empty?: string;
}) {
  const nothing = !profile || (!profile.nickname && !profile.about && !profile.avatar && !profile.cover && profile.fields.length === 0);
  if (nothing) return <p className="pf-empty" data-testid={`${testId}-empty`}>{empty ?? t(lang, "pf.preview.empty")}</p>;
  const name = profile.nickname || fallbackName;
  return (
    <div className="pf-card" data-testid={testId}>
      <div className={`pf-card__cover${profile.cover ? "" : " pf-card__cover--none"}`}>
        {profile.cover ? <img src={profile.cover} alt="" data-testid={`${testId}-cover`} /> : null}
      </div>
      <div className="pf-card__head">
        <span className="pf-card__avatar" data-testid={profile.avatar ? `${testId}-avatar` : undefined}><Avatar name={name} avatar={profile.avatar} size={64} /></span>
        <div className="pf-card__names">
          <strong className="pf-card__nick" data-testid={`${testId}-nickname`}>{name}</strong>
        </div>
      </div>
      {profile.about ? <p className="pf-card__about" data-testid={`${testId}-about`}>{profile.about}</p> : null}
      {profile.fields.length ? (
        <dl className="pf-card__fields">
          {profile.fields.map((f, i) => {
            const Icon = FIELD_ICONS[f.type] ?? Link2;
            const href = fieldHref(f.type, f.value);
            return (
              <div className="pf-card__field" key={i} data-testid={`${testId}-field-${i}`}>
                <dt><Icon className="h-3.5 w-3.5" aria-hidden />{f.label || t(lang, `pf.type.${f.type}`)}</dt>
                <dd>{href ? <a href={href} target="_blank" rel="noopener noreferrer nofollow">{f.value}</a> : f.value}</dd>
              </div>
            );
          })}
        </dl>
      ) : null}
    </div>
  );
}
