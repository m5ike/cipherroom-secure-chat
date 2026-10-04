// 6.7: where a position can go — navigation apps and ride-hailing apps — as
// links built from the point. ONE table; the Android app keeps the same
// one in location/GeoLinks.java (same order, same URLs): when a format
// changes, fix it in both. PURE: a point in, URLs out. Nothing is fetched
// here — a link leaves the app only when the user taps it.
//
// Formats (checked 2026-10):
//   Google Maps  https://www.google.com/maps/dir/?api=1&destination=lat,lng   (Maps URLs; opens the app on phones)
//   Apple Maps   https://maps.apple.com/?daddr=lat,lng&dirflg=d               (legacy form: every iOS / macOS, the web)
//   Waze         https://waze.com/ul?ll=lat,lng&navigate=yes
//   Mapy.com     https://mapy.com/fnc/v1/route?end=lng,lat&routeType=car_fast&navigate=true   (lon first!)
//   OSM          https://www.openstreetmap.org/directions?to=lat,lng
//   geo:         geo:lat,lng?q=lat,lng(label)                                (Android only)
//   Uber         https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=…&dropoff[longitude]=…&dropoff[nickname]=…
//   Bolt, Liftago, FREENOW publish no destination link: their site / app
//   opens and the destination goes to the clipboard (prefill: false).

export type GeoPoint = { lat: number; lon: number; label?: string };
export type GeoLinkKind = "nav" | "ride";

export type GeoApp = {
  id: string;
  kind: GeoLinkKind;
  name: string;
  /** The destination goes along; false: the app only opens (the destination is copied for pasting). */
  prefill: boolean;
  /** Only where the platform opens it. */
  only?: "android";
  url: (p: GeoPoint) => string;
};

export type GeoLink = { id: string; kind: GeoLinkKind; name: string; prefill: boolean; url: string };

/** Degrees with six decimals (≈ 0.1 m), always a dot — Java's %.6f gives the same. */
export const deg = (n: number): string => n.toFixed(6);
/** encodeURIComponent — GeoLinks.enc in the app gives the same. */
export const enc = (s: string): string => encodeURIComponent(s);
/** A geo: label: a parenthesis would end it early. */
const encLabel = (s: string): string => enc(s).replace(/\(/g, "%28").replace(/\)/g, "%29");
const ll = (p: GeoPoint) => `${deg(p.lat)},${deg(p.lon)}`;

export function geoUri(p: GeoPoint): string {
  return `geo:${ll(p)}?q=${ll(p)}${p.label ? `(${encLabel(p.label)})` : ""}`;
}

/** The table: navigation first, then rides — the order the buttons show. */
export const GEO_APPS: readonly GeoApp[] = [
  { id: "google", kind: "nav", name: "Google Maps", prefill: true, url: (p) => `https://www.google.com/maps/dir/?api=1&destination=${ll(p)}` },
  { id: "apple", kind: "nav", name: "Apple Maps", prefill: true, url: (p) => `https://maps.apple.com/?daddr=${ll(p)}&dirflg=d` },
  { id: "waze", kind: "nav", name: "Waze", prefill: true, url: (p) => `https://waze.com/ul?ll=${ll(p)}&navigate=yes` },
  { id: "mapy", kind: "nav", name: "Mapy.com", prefill: true, url: (p) => `https://mapy.com/fnc/v1/route?end=${deg(p.lon)},${deg(p.lat)}&routeType=car_fast&navigate=true` },
  { id: "osm", kind: "nav", name: "OpenStreetMap", prefill: true, url: (p) => `https://www.openstreetmap.org/directions?to=${ll(p)}` },
  { id: "geo", kind: "nav", name: "geo:", prefill: true, only: "android", url: geoUri },
  {
    id: "uber", kind: "ride", name: "Uber", prefill: true,
    url: (p) => `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${deg(p.lat)}&dropoff[longitude]=${deg(p.lon)}${p.label ? `&dropoff[nickname]=${enc(p.label)}` : ""}`,
  },
  { id: "bolt", kind: "ride", name: "Bolt", prefill: false, url: () => "https://bolt.eu/" },
  { id: "liftago", kind: "ride", name: "Liftago", prefill: false, url: () => "https://www.liftago.cz/" },
  { id: "freenow", kind: "ride", name: "FREENOW", prefill: false, url: () => "https://www.free-now.com/" },
];

/** A browser on Android (it opens geo: links in a map app). */
export function isAndroid(ua: string): boolean {
  return /Android/i.test(ua);
}

/** The links of one kind for this point, in the table's order (geo: only on Android). */
export function geoLinks(p: GeoPoint, kind: GeoLinkKind, opts: { android?: boolean } = {}): GeoLink[] {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return [];
  return GEO_APPS
    .filter((a) => a.kind === kind && (a.only !== "android" || opts.android))
    .map((a) => ({ id: a.id, kind: a.kind, name: a.name, prefill: a.prefill, url: a.url(p) }));
}

/** What goes to the clipboard for an app that cannot take the destination: "50.087500, 14.421300". */
export function destinationText(p: GeoPoint): string {
  return `${deg(p.lat)}, ${deg(p.lon)}`;
}
