# Maps / location

A privacy-conscious helper around `navigator.geolocation` plus
OpenStreetMap deep links. We deliberately do **not** bundle Leaflet
or any tile library to keep the install footprint small.

## Permission flow

The first call to `getCurrentPosition()` triggers the browser's
geolocation prompt. Users can decline; the panel exposes the reason
and continues to allow chat without location.

## Three operations

- **Share once** — single fix → encrypted chat message containing
  `lat,lng,accuracy` and an OSM link.
- **Continuous sharing** — `watchPosition` with `enableHighAccuracy:
  true`. Each fix is broadcast as a "live" prefix message.
- **Stop** — clears the watch handle and posts a system message.

## OSM links and tiles

`osmLink({ lat, lng })` returns
`https://www.openstreetmap.org/?mlat=...&mlon=...#map=15/lat/lon`
which works in every browser without an extra script load.

`osmStaticTileUrl(...)` returns the URL of a single OSM tile
(`https://tile.openstreetmap.org/<z>/<x>/<y>.png`). Note: the public
OSM tile server has a usage policy that limits high-volume embedding.
For production, host your own tile server or pay a provider such as
Stadia/MapTiler and replace the URL builder.

## Privacy notes

- Coordinates flow only through the encrypted DataChannel.
- The OSM link reveals the position to whoever clicks it and to OSM
  via the HTTP referrer. There is no good way to make a sharable URL
  that is "open in your map app and nowhere else".
- For internal-only deployments, swap OSM for a self-hosted tile URL
  baked into `osmStaticTileUrl`.

## Adding Leaflet

If you need an interactive map preview inside the chat, install
`leaflet` and replace the link rendering with a `<MapContainer>` from
`react-leaflet`. The current implementation intentionally avoids that
dependency.
