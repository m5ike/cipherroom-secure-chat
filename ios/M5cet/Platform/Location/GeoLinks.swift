// Where a position can go (6.7): navigation and ride-hailing apps — ONE table.
// Port of android/app/src/main/java/cz/m5cet/app/location/GeoLinks.java; the
// web keeps the same in client/src/lib/geo-links.ts (same order, the same web
// links): when a format changes, fix it in all three.
//
// Pure: which apps are installed comes in (iOS: UIApplication.canOpenURL for the
// schemes in Info.plist LSApplicationQueriesSchemes — LocationService.mapApps),
// the choices go out. Nothing is opened here; a link leaves the phone only when
// the user taps it.
//
// Formats (checked 2026-10): Google Maps google.navigation:q=lat,lng (Android) /
// comgooglemaps://?daddr=lat,lng&directionsmode=driving (iOS); Apple Maps
// maps://?daddr=lat,lng&dirflg=d (iOS; the web's https://maps.apple.com form
// otherwise); Waze waze://?ll=lat,lng&navigate=yes; Mapy.com
// https://mapy.com/fnc/v1/route (lon first! a universal link — the app opens it
// when installed); OsmAnd osmand.api://navigate (Android) /
// osmandmaps://navigate?lat=…&lon=…&title=… (iOS); Sygic
// com.sygic.aura://coordinate|lon|lat|drive; HERE WeGo
// https://share.here.com/r/mylocation/lat,lng,name?m=d (a universal link);
// Uber uber://?action=setPickup…. Bolt, Liftago and FREENOW publish no
// destination link: the app opens and the destination goes to the clipboard
// (prefill false). Android's "other apps that open geo:" has no iOS
// counterpart — Apple Maps, always there, takes that place.

import Foundation

enum GeoLinks {
    static let nav = "nav", ride = "ride"

    /// A link from the point (label: "" = none).
    typealias Link = @Sendable (_ lat: Double, _ lon: Double, _ label: String) -> String

    struct App: Sendable {
        let id: String
        let kind: String
        let name: String
        /// The destination goes along; false: the app only opens (the destination is copied for pasting).
        let prefill: Bool
        /// Android packages (what the manifest's <queries> names).
        let packages: [String]
        /// The app's own Android link (nil: just open the app).
        let app: Link?
        /// In the browser when the app is not here (nil: none).
        let web: Link?
        /// iOS: the URL scheme canOpenURL checks (Info.plist LSApplicationQueriesSchemes); nil: no app link on iOS.
        let iosScheme: String?
        /// iOS: the app's own link (nil: the scheme alone opens the app).
        let iosApp: Link?
    }

    /// One line of a picker.
    struct Choice: Sendable, Equatable, CustomStringConvertible {
        let id: String
        let name: String
        /// Android: the package to open it in; iOS: the app's URL scheme; nil: the browser.
        let pkg: String?
        /// The link; nil: just open the app.
        let uri: String?
        /// When the app refuses the link: geo: in the same app (Android navigation), else nil.
        let fallback: String?
        let web: Bool
        let prefill: Bool

        var description: String { id + (web ? " (web)" : " @" + (pkg ?? "")) + " " + (uri ?? "nil") }
    }

    // MARK: format

    /// Degrees with six decimals (≈ 0.1 m), always a dot — the web's toFixed(6), Java's %.6f.
    static func deg(_ v: Double) -> String { JavaFormat.fixed(v, 6) }

    private static func ll(_ lat: Double, _ lon: Double) -> String { deg(lat) + "," + deg(lon) }

    /// Like the web's encodeURIComponent (UTF-8, %20 for a space, !'()*~ as they are).
    static func enc(_ s: String?) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return (s ?? "").addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }

    /// geo:lat,lng?q=lat,lng(label) — a parenthesis in the label would end it early.
    static func geoUri(_ lat: Double, _ lon: Double, _ label: String?) -> String {
        let l = (label ?? "").isEmpty ? "" : "(" + enc(label).replacingOccurrences(of: "(", with: "%28").replacingOccurrences(of: ")", with: "%29") + ")"
        return "geo:" + ll(lat, lon) + "?q=" + ll(lat, lon) + l
    }

    private static func has(_ label: String, _ prefix: String) -> String { label.isEmpty ? "" : prefix + enc(label) }

    private static let mapy: Link = { la, lo, _ in "https://mapy.com/fnc/v1/route?end=" + deg(lo) + "," + deg(la) + "&routeType=car_fast&navigate=true" }
    private static let uberWeb: Link = { la, lo, l in
        "https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=" + deg(la) + "&dropoff[longitude]=" + deg(lo) + has(l, "&dropoff[nickname]=")
    }
    private static let here: Link = { la, lo, l in "https://share.here.com/r/mylocation/" + ll(la, lo) + has(l, ",") + "?m=d" }

    // MARK: table

    /// Navigation first, then rides — the order the pickers show (the web's, plus the apps only the
    /// phones open). Apple Maps (the web's second line) is iOS's own: `iosChoices` adds it.
    static let apps: [App] = [
        App(id: "google", kind: nav, name: "Google Maps", prefill: true, packages: ["com.google.android.apps.maps"],
            app: { la, lo, _ in "google.navigation:q=" + ll(la, lo) },
            web: { la, lo, _ in "https://www.google.com/maps/dir/?api=1&destination=" + ll(la, lo) },
            iosScheme: "comgooglemaps", iosApp: { la, lo, _ in "comgooglemaps://?daddr=" + ll(la, lo) + "&directionsmode=driving" }),
        App(id: "waze", kind: nav, name: "Waze", prefill: true, packages: ["com.waze"],
            app: { la, lo, _ in "waze://?ll=" + ll(la, lo) + "&navigate=yes" },
            web: { la, lo, _ in "https://waze.com/ul?ll=" + ll(la, lo) + "&navigate=yes" },
            iosScheme: "waze", iosApp: { la, lo, _ in "waze://?ll=" + ll(la, lo) + "&navigate=yes" }),
        App(id: "mapy", kind: nav, name: "Mapy.com", prefill: true, packages: ["cz.seznam.mapy"], app: mapy, web: mapy,
            iosScheme: nil, iosApp: nil),
        App(id: "osmand", kind: nav, name: "OsmAnd", prefill: true, packages: ["net.osmand.plus", "net.osmand"],
            app: { la, lo, l in "osmand.api://navigate?dest_lat=" + deg(la) + "&dest_lon=" + deg(lo) + has(l, "&dest_name=") + "&profile=car&force=true" },
            web: nil,
            iosScheme: "osmandmaps", iosApp: { la, lo, l in "osmandmaps://navigate?lat=" + deg(la) + "&lon=" + deg(lo) + has(l, "&title=") + "&profile=car" }),
        App(id: "sygic", kind: nav, name: "Sygic", prefill: true, packages: ["com.sygic.aura"],
            app: { la, lo, _ in "com.sygic.aura://coordinate|" + deg(lo) + "|" + deg(la) + "|drive" },
            web: nil,
            iosScheme: "com.sygic.aura", iosApp: { la, lo, _ in "com.sygic.aura://coordinate%7C" + deg(lo) + "%7C" + deg(la) + "%7Cdrive" }),
        App(id: "here", kind: nav, name: "HERE WeGo", prefill: true, packages: ["com.here.app.maps"], app: here, web: nil,
            iosScheme: nil, iosApp: nil),
        App(id: "osm", kind: nav, name: "OpenStreetMap", prefill: true, packages: [],
            app: nil,
            web: { la, lo, _ in "https://www.openstreetmap.org/directions?to=" + ll(la, lo) },
            iosScheme: nil, iosApp: nil),
        App(id: "uber", kind: ride, name: "Uber", prefill: true, packages: ["com.ubercab"],
            app: { la, lo, l in "uber://?action=setPickup&pickup=my_location&dropoff[latitude]=" + deg(la) + "&dropoff[longitude]=" + deg(lo) + has(l, "&dropoff[nickname]=") },
            web: uberWeb,
            iosScheme: "uber", iosApp: { la, lo, l in
                "uber://?action=setPickup&pickup=my_location&dropoff%5Blatitude%5D=" + deg(la) + "&dropoff%5Blongitude%5D=" + deg(lo) + has(l, "&dropoff%5Bnickname%5D=")
            }),
        App(id: "bolt", kind: ride, name: "Bolt", prefill: false, packages: ["ee.mtakso.client"], app: nil, web: { _, _, _ in "https://bolt.eu/" },
            iosScheme: nil, iosApp: nil),
        App(id: "liftago", kind: ride, name: "Liftago", prefill: false, packages: ["com.adleritech.app.liftago.passenger"], app: nil,
            web: { _, _, _ in "https://www.liftago.cz/" }, iosScheme: nil, iosApp: nil),
        App(id: "freenow", kind: ride, name: "FREENOW", prefill: false, packages: ["taxi.android.client"], app: nil,
            web: { _, _, _ in "https://www.free-now.com/" }, iosScheme: nil, iosApp: nil),
    ]

    /// Every Android package of the table (what the manifest's <queries> must name).
    static func packages() -> Set<String> { Set(apps.flatMap(\.packages)) }

    /// Every iOS scheme of the table (what Info.plist LSApplicationQueriesSchemes must name).
    static func iosSchemes() -> Set<String> { Set(apps.compactMap(\.iosScheme)) }

    /// The web link of an app of the table (nil: none), e.g. for a test or a share.
    static func web(_ id: String, _ lat: Double, _ lon: Double, _ label: String?) -> String? {
        guard let a = apps.first(where: { $0.id == id && $0.web != nil }) else { return nil }
        return a.web!(lat, lon, label ?? "")
    }

    /// What goes to the clipboard for an app that cannot take the destination: "50.087500, 14.421300".
    static func destinationText(_ lat: Double, _ lon: Double) -> String { deg(lat) + ", " + deg(lon) }

    private static func inWorld(_ lat: Double, _ lon: Double) -> Bool { abs(lat) <= 90 && abs(lon) <= 180 }

    /// Android's picker lines for one kind: the table's apps that are installed (their own links), then —
    /// for navigation — the other apps that open geo: (geoApps: package → its name, in the system's order),
    /// then the web links of the table's apps that are not installed.
    static func choices(_ kind: String, _ lat: Double, _ lon: Double, _ label: String?, installed: Set<String>,
                        geoApps: [(String, String)]?) -> [Choice] {
        var out = [Choice]()
        guard inWorld(lat, lon) else { return out }
        let l = label ?? ""
        let geo = geoUri(lat, lon, l)
        var known = Set<String>()
        var missing = [App]()
        for a in apps where a.kind == kind {
            known.formUnion(a.packages)
            if let pkg = a.packages.first(where: { installed.contains($0) }) {
                out.append(Choice(id: a.id, name: a.name, pkg: pkg, uri: a.app?(lat, lon, l), fallback: kind == nav ? geo : nil, web: false, prefill: a.prefill))
            } else if a.web != nil {
                missing.append(a)
            }
        }
        if kind == nav, let geoApps {
            for (pkg, name) in geoApps where !known.contains(pkg) {
                out.append(Choice(id: "geo:" + pkg, name: name, pkg: pkg, uri: geo, fallback: nil, web: false, prefill: true))
            }
        }
        for a in missing { out.append(Choice(id: a.id, name: a.name, pkg: nil, uri: a.web!(lat, lon, l), fallback: nil, web: true, prefill: a.prefill)) }
        return out
    }

    // MARK: iOS

    /// Apple Maps with directions to the point (the system app, always present): the maps: scheme opens it
    /// without a browser hop; the web's https://maps.apple.com/?daddr=… is the same place.
    static func appleMapsDirections(_ lat: Double, _ lon: Double) -> String { "maps://?daddr=" + ll(lat, lon) + "&dirflg=d" }

    /// The web's Apple Maps link (geo-links.ts "apple").
    static func appleMapsWeb(_ lat: Double, _ lon: Double) -> String { "https://maps.apple.com/?daddr=" + ll(lat, lon) + "&dirflg=d" }

    /// iOS's picker lines for one kind: Apple Maps first for navigation (the phone's own map app, as geo:
    /// is on Android), then the table's apps whose scheme the phone can open (their own links), then the
    /// apps reached by a universal link (Mapy.com, HERE — the app opens it when installed, else the
    /// browser), then the web links of the apps that are not installed. `canOpen(scheme)` = canOpenURL.
    static func iosChoices(_ kind: String, _ lat: Double, _ lon: Double, _ label: String?, canOpen: (String) -> Bool) -> [Choice] {
        var out = [Choice]()
        guard inWorld(lat, lon) else { return out }
        let l = label ?? ""
        if kind == nav {
            out.append(Choice(id: "apple", name: "Apple Maps", pkg: "maps", uri: appleMapsDirections(lat, lon), fallback: appleMapsWeb(lat, lon), web: false, prefill: true))
        }
        var later = [Choice]()
        for a in apps where a.kind == kind {
            if let scheme = a.iosScheme, canOpen(scheme) {
                out.append(Choice(id: a.id, name: a.name, pkg: scheme, uri: a.iosApp?(lat, lon, l) ?? scheme + "://",
                                  fallback: a.web?(lat, lon, l), web: false, prefill: a.prefill))
            } else if a.iosScheme == nil, a.id == "mapy" || a.id == "here", let link = a.app {
                // A universal link: the app when it is installed, else the browser.
                later.append(Choice(id: a.id, name: a.name, pkg: nil, uri: link(lat, lon, l), fallback: nil, web: true, prefill: a.prefill))
            } else if let web = a.web {
                later.append(Choice(id: a.id, name: a.name, pkg: nil, uri: web(lat, lon, l), fallback: nil, web: true, prefill: a.prefill))
            }
        }
        return out + later
    }
}
