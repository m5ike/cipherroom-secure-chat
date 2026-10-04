// 6.7: the place of a message in a window of its own — opened from the pin
// (or the place chip) of a bubble, which no longer draws the map itself. The
// map (tiles through this server's proxy, as in 6.2), the coordinates, and
// two lists of the same apps as the Android app, in the same order: where to
// navigate (Google Maps, Apple Maps, Waze, Mapy.com, OpenStreetMap, a map app
// via geo: on Android) and a ride there (Uber with the destination; Bolt,
// Liftago, FREENOW open and get the destination from the clipboard).
// Nothing leaves the browser until a link is tapped (lib/geo-links.ts).

import { useMemo, useState } from "react";
import { t, tf, type Lang } from "../lib/i18n";
import type { MapPreviewPolicy } from "../lib/client-config";
import { sheetMap, type Place } from "../lib/map-preview";
import { osmLink } from "../lib/maps";
import { destinationText, geoLinks, isAndroid, type GeoLinkKind, type GeoPoint } from "../lib/geo-links";
import { SimpleModal } from "./SimpleModal";
import { MenuIcon } from "./MenuIcon";
import "../location.css";

export type LocationSheetProps = {
  id: string;
  place: Place;
  senderName: string;
  mine: boolean;
  mapPolicy?: MapPreviewPolicy;
  lang: Lang;
  onClose: () => void;
  /** A short notice (the destination was copied). */
  onNotice?: (text: string) => void;
  /** For tests: the platform (default: this browser's user agent). */
  userAgent?: string;
};

/** The icons of the two lists — the Android app's buttons use the same. */
const KIND_ICON: Record<GeoLinkKind, string> = { nav: "navigation", ride: "hand" };

export function LocationSheet(props: LocationSheetProps) {
  const { place, lang } = props;
  const [list, setList] = useState<GeoLinkKind | null>(null);
  const [copied, setCopied] = useState(false);
  const title = props.mine ? t(lang, "loc.sheet.mine") : tf(lang, "msg.map.caption", { name: props.senderName });
  const map = useMemo(() => (props.mapPolicy ? sheetMap(place.lat, place.lon, props.mapPolicy) : null), [place.lat, place.lon, props.mapPolicy]);
  const android = isAndroid(props.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent));
  // The label rides along only with apps that show one (Uber's nickname, the geo: pin).
  const point: GeoPoint = { lat: place.lat, lon: place.lon, label: props.mine ? undefined : props.senderName };
  const links = list ? geoLinks(point, list, { android }) : [];
  const osm = osmLink({ lat: place.lat, lng: place.lon, ts: 0 }, 17);

  async function copy(notice: boolean) {
    const text = destinationText(point);
    try { await navigator.clipboard?.writeText(text); } catch { return; }
    setCopied(true);
    if (notice) props.onNotice?.(t(lang, "loc.copied"));
  }

  const kindButton = (kind: GeoLinkKind) => (
    <button
      type="button" className={`loc-sheet__act${list === kind ? " is-open" : ""}`} aria-expanded={list === kind}
      aria-controls={`loc-list-${props.id}`} data-testid={`loc-${kind}`} onClick={() => setList(list === kind ? null : kind)}
    >
      <MenuIcon name={KIND_ICON[kind]} className="loc-sheet__act-icon" />
      <span>{t(lang, kind === "nav" ? "loc.navigate" : "loc.ride")}</span>
    </button>
  );

  return (
    <SimpleModal title={title} onClose={props.onClose} testId="location-sheet" className="loc-sheet">
      {map ? (
        <a className={`loc-sheet__map${map.gray ? " is-gray" : ""}`} href={osm} target="_blank" rel="noopener noreferrer" title={t(lang, "msg.map.open")} data-testid="loc-map">
          <span className="loc-sheet__box" role="img" aria-label={t(lang, "msg.map.alt")} style={{ height: `${map.height}px` }}>
            {map.tiles.map((tile) => <img key={tile.key} src={tile.src} alt="" className="msg-map__tile" style={tile.style} loading="lazy" decoding="async" draggable={false} />)}
            <span className="loc-sheet__pin" style={{ top: `${map.height / 2}px`, color: map.pinColor }}><MenuIcon name="map-pin" className="msg-map__pin" /></span>
            {map.attribution ? <span className="msg-map__attr">{map.attribution}</span> : null}
          </span>
        </a>
      ) : null}
      <p className="loc-sheet__coords" data-testid="loc-coords">
        {place.live ? <span className="loc-sheet__live">{t(lang, "msg.place.live")}</span> : null}
        {place.coords}
      </p>
      <div className="loc-sheet__acts" role="toolbar" aria-label={t(lang, "loc.actions")}>
        {kindButton("nav")}
        {kindButton("ride")}
        <button type="button" className="loc-sheet__act" data-testid="loc-copy" onClick={() => void copy(false)}>
          <MenuIcon name={copied ? "check" : "copy"} className="loc-sheet__act-icon" />
          <span>{t(lang, copied ? "loc.copiedShort" : "loc.copy")}</span>
        </button>
      </div>
      {list ? (
        <ul className="loc-sheet__apps" id={`loc-list-${props.id}`} data-testid={`loc-${list}-list`} aria-label={t(lang, list === "nav" ? "loc.navigate" : "loc.ride")}>
          {/* An app that cannot take the destination gets it from the clipboard. */}
          {links.map((l) => (
            <li key={l.id}>
              <a
                className="loc-sheet__app" href={l.url} data-testid={`loc-app-${l.id}`}
                {...(l.url.startsWith("https:") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                onClick={l.prefill ? undefined : () => void copy(true)}
              >
                <MenuIcon name={l.id === "geo" ? "map" : "external-link"} className="loc-sheet__app-icon" />
                <span className="loc-sheet__app-name">{l.id === "geo" ? t(lang, "loc.geo") : l.name}</span>
                {l.prefill ? null : <span className="loc-sheet__app-note">{t(lang, "loc.ride.paste")}</span>}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="loc-sheet__note">{t(lang, "loc.privacy")}</p>
    </SimpleModal>
  );
}
