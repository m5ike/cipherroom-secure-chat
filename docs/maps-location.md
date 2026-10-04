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

## Map preview in a message (6.2)

A message that carries its sender's position (`loc`) shows a small map
instead of the header's pin link — web and Android alike, as the operator
set it up in the console (*Client & addons › Map preview*, client config
`map`: provider template, zoom, width × height, pin and caption colours,
caption / coordinates on or off, grey tiles, cache hours).

- `client/src/lib/map-preview.ts` lays out the Web Mercator tiles (256 px)
  so that the position is exactly in the middle of the box and the pin
  sits on it (`mapMosaic`, unit-tested in `test/map-preview.test.ts`).
- The tiles come from **this server** — `GET /api/map/tile/{z}/{x}/{y}`
  (`server/map-tiles.ts`) fetches them from the operator's provider and
  caches them. The browser never asks a third party, so the provider does
  not learn the viewer's address or what they look at, and the CSP stays
  `img-src 'self'`.
- A click opens the OpenStreetMap link (below). With the preview off, the
  old pin link is back.

## The place window: navigate, ride, copy (6.7)

**Web.** The default bubble no longer draws the map. A position message
("📍 lat, lon …") shows a **place chip** — a pin and the coordinates, with
"live ·" for a live position — in place of its text; a message carrying the
sender's position in its header has a pin button in the head
(`client/src/lib/layouts/message.ts`, `$place`, action `place`; `$map` stays
for operator layouts that still want it). Either opens the place window
(`client/src/components/LocationSheet.tsx`): the map preview (when the
operator's policy enables it; a tap opens openstreetmap.org at zoom 17), the
coordinates with their accuracy and a "live" badge, **Navigate / Ride /
Copy**, the list of apps and a privacy note.

The links (`client/src/lib/geo-links.ts`, 6 decimals) are pure — nothing is
fetched until the user taps:

| Target | URL |
|---|---|
| Google Maps | `https://www.google.com/maps/dir/?api=1&destination=lat,lng` |
| Apple Maps | `https://maps.apple.com/?daddr=lat,lng&dirflg=d` |
| Waze | `https://waze.com/ul?ll=lat,lng&navigate=yes` |
| Mapy.com | `https://mapy.com/fnc/v1/route?end=lon,lat&routeType=car_fast&navigate=true` (longitude first) |
| OpenStreetMap | `https://www.openstreetmap.org/directions?to=lat,lng` |
| the phone's map app | `geo:lat,lng?q=lat,lng(label)` — offered in browsers on Android only |
| Uber | `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=…&dropoff[longitude]=…` (+ `dropoff[nickname]` = the sender's name when the position is not yours) |
| Bolt, Liftago, FREENOW | their home page; the destination cannot be passed, so the coordinates go to the clipboard ("paste it in the app") |

*Copy* puts `lat, lng` (6 decimals, e.g. `50.087500, 14.421300`) on the
clipboard. A web page cannot see which apps are installed.

**Android** (`location/GeoLinks.java`, `ui/parts/PlaceSheet.java`). A
position message still shows the map preview inline when the policy allows
(`MsgBody.java`); a tap on it, or *Position on a map* in the long-press menu,
opens the place sheet (map or coordinates, Navigate / Ride / Copy, a privacy
note, *Open the map* via `geo:`). *Navigate* lists the installed apps of its
table first — Google Maps (`google.navigation:q=`), Waze (`waze://`),
Mapy.com, OsmAnd, Sygic, HERE WeGo —, then every other `geo:` handler, then
the web links of table apps that are not installed (Google Maps, Waze,
Mapy.com, OSM; no Apple Maps). When an app refuses the link the sheet tries
`geo:` in the same app, then simply launches it. *Ride*: Uber (`uber://…`
when installed, else the web link); Bolt, Liftago and FREENOW copy the
coordinates and launch the app, else open its home page. The packages are
declared in the manifest's `<queries>`.

**Hold-to-read beside the bubble (6.7).** Next to a hold-to-read ("tap")
message the empty part of the row reveals it while held — after 180 ms, so a
scroll that starts there reveals nothing (web `hold-side` /
`HOLD_SIDE_MS`, Android slot `msgHold` / `ui/bubble/HoldGesture.java`).

## Privacy notes

- Coordinates flow only through the encrypted DataChannel.
- 6.7: a tap on a navigation or ride app hands the coordinates to that
  service in the URL (Uber and `geo:` also get the sender's name when the
  position is not yours). The place window's map comes through this server.
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
