// Privacy-conscious geolocation helpers. We do NOT bundle Leaflet to keep
// the install footprint small. Instead we generate OpenStreetMap link
// (https://www.openstreetmap.org/?mlat=...&mlon=...#map=15/lat/lon) which
// works in every browser and offers a static tile preview via the
// public OSM tile server when the operator opts in.
//
// Coordinates carried by chat messages flow through the same encrypted
// DataChannel as everything else. The tile preview is fetched from the
// OSM public tile server and reveals approximate coordinates to that
// service — see docs/maps-location.md.

export type LatLng = { lat: number; lng: number; accuracy?: number; ts: number };

export type GeolocationCaps = { available: boolean; reason?: string };

export function detectGeolocation(): GeolocationCaps {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    return { available: false, reason: "navigator.geolocation neexistuje." };
  }
  return { available: true };
}

export function getCurrentPosition(timeoutMs = 15_000): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("Geolocation API není dostupné."));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          ts: Date.now(),
        });
      },
      (err) => reject(new Error(err.message || "geolocation-error")),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

export type LocationWatcher = { stop: () => void };

export function watchPosition(
  cb: (pos: LatLng) => void,
  onError?: (msg: string) => void,
): LocationWatcher | null {
  if (!("geolocation" in navigator)) {
    onError?.("Geolocation API není dostupné.");
    return null;
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => cb({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      ts: Date.now(),
    }),
    (err) => onError?.(err.message || "watch-error"),
    { enableHighAccuracy: true, maximumAge: 5_000 },
  );
  return { stop: () => navigator.geolocation.clearWatch(id) };
}

export function osmLink(point: LatLng, zoom = 15): string {
  const lat = point.lat.toFixed(6);
  const lng = point.lng.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=${zoom}/${lat}/${lng}`;
}

// Static tile URL using the public OSM tile server (subject to its tile
// usage policy). For production we recommend pointing at a self-hosted
// tile server; see docs/maps-location.md.
export function osmStaticTileUrl(point: LatLng, zoom = 15): string {
  const xtile = Math.floor(((point.lng + 180) / 360) * Math.pow(2, zoom));
  const latRad = (point.lat * Math.PI) / 180;
  const ytile = Math.floor(
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom),
  );
  return `https://tile.openstreetmap.org/${zoom}/${xtile}/${ytile}.png`;
}
