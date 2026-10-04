// 6.7: the links of a position — navigation and ride apps (lib/geo-links.ts),
// and the place of a message (map-preview.ts placeOf / sheetMap). The same
// expected URLs are in the Android app's GeoLinksTest.java: one table, two
// platforms, the same order.

import { describe, it, expect } from "vitest";
import { GEO_APPS, deg, destinationText, enc, geoLinks, geoUri, isAndroid } from "../client/src/lib/geo-links";
import { placeOf, sheetMap } from "../client/src/lib/map-preview";
import { DEFAULT_MAP_PREVIEW } from "../client/src/lib/client-config";

const PRAGUE = { lat: 50.0875, lon: 14.4213, label: "Jana & Petr (doma)" };

describe("the table", () => {
  it("lists navigation, then rides, in the order both platforms show", () => {
    expect(GEO_APPS.filter((a) => a.kind === "nav").map((a) => a.id)).toEqual(["google", "apple", "waze", "mapy", "osm", "geo"]);
    expect(GEO_APPS.filter((a) => a.kind === "ride").map((a) => a.id)).toEqual(["uber", "bolt", "liftago", "freenow"]);
  });

  it("writes degrees with six decimals and a dot, and encodes like encodeURIComponent", () => {
    expect(deg(50.0875)).toBe("50.087500");
    expect(deg(-33.8568)).toBe("-33.856800");
    expect(enc("Jana & Petr (doma)")).toBe("Jana%20%26%20Petr%20(doma)");
    expect(enc("Jiří Šťastný+1")).toBe("Ji%C5%99%C3%AD%20%C5%A0%C5%A5astn%C3%BD%2B1");
  });
});

describe("navigation links", () => {
  it("build each app's destination URL", () => {
    const links = Object.fromEntries(geoLinks(PRAGUE, "nav").map((l) => [l.id, l.url]));
    expect(links).toEqual({
      google: "https://www.google.com/maps/dir/?api=1&destination=50.087500,14.421300",
      apple: "https://maps.apple.com/?daddr=50.087500,14.421300&dirflg=d",
      waze: "https://waze.com/ul?ll=50.087500,14.421300&navigate=yes",
      // Mapy.com takes the longitude first.
      mapy: "https://mapy.com/fnc/v1/route?end=14.421300,50.087500&routeType=car_fast&navigate=true",
      osm: "https://www.openstreetmap.org/directions?to=50.087500,14.421300",
    });
  });

  it("offer geo: only on Android, its label kept inside the parentheses", () => {
    expect(geoLinks(PRAGUE, "nav").some((l) => l.id === "geo")).toBe(false);
    const geo = geoLinks(PRAGUE, "nav", { android: true }).find((l) => l.id === "geo");
    expect(geo?.url).toBe("geo:50.087500,14.421300?q=50.087500,14.421300(Jana%20%26%20Petr%20%28doma%29)");
    expect(geoUri({ lat: -33.8568, lon: 151.2153 })).toBe("geo:-33.856800,151.215300?q=-33.856800,151.215300");
    expect(isAndroid("Mozilla/5.0 (Linux; Android 15; SM-F956B) AppleWebKit/537.36 Chrome/140 Mobile")).toBe(true);
    expect(isAndroid("Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)")).toBe(false);
  });

  it("are none for a place outside the world", () => {
    expect(geoLinks({ lat: 91, lon: 0 }, "nav")).toEqual([]);
    expect(geoLinks({ lat: Number.NaN, lon: 0 }, "ride")).toEqual([]);
  });
});

describe("ride links", () => {
  it("give Uber the destination (and its name), the others only open", () => {
    const rides = geoLinks(PRAGUE, "ride");
    expect(rides.map((r) => [r.id, r.prefill])).toEqual([["uber", true], ["bolt", false], ["liftago", false], ["freenow", false]]);
    expect(rides[0].url).toBe("https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300&dropoff[nickname]=Jana%20%26%20Petr%20(doma)");
    expect(geoLinks({ lat: 50.0875, lon: 14.4213 }, "ride")[0].url).toBe("https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300");
    expect(rides.slice(1).map((r) => r.url)).toEqual(["https://bolt.eu/", "https://www.liftago.cz/", "https://www.free-now.com/"]);
  });

  it("copy the destination as plain coordinates for the apps that cannot take it", () => {
    expect(destinationText(PRAGUE)).toBe("50.087500, 14.421300");
  });
});

describe("the place of a message", () => {
  it("is its header position first", () => {
    expect(placeOf("Jsem tady", { lat: 50.0875, lon: 14.4213, acc: 12 })).toEqual({ lat: 50.0875, lon: 14.4213, acc: 12, live: false, message: false, coords: "50.08750, 14.42130 ± 12 m" });
  });

  it("is read from a position message (web and app) — and that message IS the place", () => {
    const p = placeOf("📍 50.08750, 14.42130 (±12 m) https://www.openstreetmap.org/?mlat=50.087500&mlon=14.421300#map=15/50.087500/14.421300", undefined);
    expect(p).toEqual({ lat: 50.0875, lon: 14.4213, acc: 12, live: false, message: true, coords: "50.08750, 14.42130 ± 12 m" });
    expect(placeOf("📍 live -33.85680, 151.21530 https://…", undefined)).toMatchObject({ lat: -33.8568, lon: 151.2153, acc: null, live: true, message: true });
    // The app's position message carries loc too: still the message's place.
    expect(placeOf("📍 50.08750, 14.42130 (±12 m) https://…", { lat: 50.08751, lon: 14.42131, acc: 9 })).toMatchObject({ lat: 50.08751, message: true, acc: 9 });
  });

  it("is nothing for plain text, a sealed text, or a place outside the world", () => {
    expect(placeOf("Ahoj 📍 50.1, 14.4", undefined)).toBeNull();
    expect(placeOf("📍 50.08750, 14.42130", undefined, true)).toBeNull();
    expect(placeOf("📍 95.0, 14.4", undefined)).toBeNull();
    expect(placeOf("hi", { lat: 0, lon: 200 })).toBeNull();
  });
});

describe("the place window's map", () => {
  it("lays the tiles out from the centre, so a narrow window keeps the pin in the middle", () => {
    const m = sheetMap(50.0875, 14.4213, DEFAULT_MAP_PREVIEW);
    expect(m).not.toBeNull();
    expect(m!.height).toBe(240);
    expect(m!.tiles.every((t) => t.src.startsWith("/api/map/tile/16/"))).toBe(true);
    expect(m!.tiles.some((t) => t.src === "/api/map/tile/16/35393/22201")).toBe(true);
    expect(m!.tiles[0].style.left).toMatch(/^calc\(50% [-+] \d+px\)$/);
    expect(sheetMap(50.0875, 14.4213, { ...DEFAULT_MAP_PREVIEW, enabled: false })).toBeNull();
  });
});
