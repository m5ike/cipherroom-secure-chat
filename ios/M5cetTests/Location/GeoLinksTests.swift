// Port of android/app/src/test/java/cz/m5cet/app/location/GeoLinksTest.java — the same expected web
// URLs as the web's test/geo-links.test.ts (one table, three platforms), the apps' own links, the
// encoding of a label, and which lines a picker shows — plus iOS's picker (Apple Maps, canOpenURL
// schemes, universal links) and that Info.plist may ask about every scheme the table uses.

import XCTest
@testable import M5cet

final class GeoLinksTests: XCTestCase {
    private let lat = 50.0875, lon = 14.4213
    private let label = "Jana & Petr (doma)"

    func testWritesDegreesAndEncodesLikeTheWeb() {
        XCTAssertEqual("50.087500", GeoLinks.deg(50.0875))
        XCTAssertEqual("-33.856800", GeoLinks.deg(-33.8568))
        XCTAssertEqual("Jana%20%26%20Petr%20(doma)", GeoLinks.enc(label))
        XCTAssertEqual("Ji%C5%99%C3%AD%20%C5%A0%C5%A5astn%C3%BD%2B1", GeoLinks.enc("Jiří Šťastný+1"))
        XCTAssertEqual("a!'()*~-_.b", GeoLinks.enc("a!'()*~-_.b"))
    }

    func testTheWebLinksAreTheWebs() {
        XCTAssertEqual("https://www.google.com/maps/dir/?api=1&destination=50.087500,14.421300", GeoLinks.web("google", lat, lon, label))
        XCTAssertEqual("https://waze.com/ul?ll=50.087500,14.421300&navigate=yes", GeoLinks.web("waze", lat, lon, label))
        // Mapy.com takes the longitude first.
        XCTAssertEqual("https://mapy.com/fnc/v1/route?end=14.421300,50.087500&routeType=car_fast&navigate=true", GeoLinks.web("mapy", lat, lon, label))
        XCTAssertEqual("https://www.openstreetmap.org/directions?to=50.087500,14.421300", GeoLinks.web("osm", lat, lon, label))
        XCTAssertEqual("https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300&dropoff[nickname]=Jana%20%26%20Petr%20(doma)",
                       GeoLinks.web("uber", lat, lon, label))
        XCTAssertEqual("https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300", GeoLinks.web("uber", lat, lon, ""))
        XCTAssertEqual("https://bolt.eu/", GeoLinks.web("bolt", lat, lon, label))
        XCTAssertEqual("https://www.liftago.cz/", GeoLinks.web("liftago", lat, lon, label))
        XCTAssertEqual("https://www.free-now.com/", GeoLinks.web("freenow", lat, lon, label))
        XCTAssertNil(GeoLinks.web("sygic", lat, lon, label))
        // The web's Apple Maps line, and what iOS opens for it.
        XCTAssertEqual("https://maps.apple.com/?daddr=50.087500,14.421300&dirflg=d", GeoLinks.appleMapsWeb(lat, lon))
        XCTAssertEqual("maps://?daddr=50.087500,14.421300&dirflg=d", GeoLinks.appleMapsDirections(lat, lon))
    }

    func testGeoKeepsTheLabelInsideItsParentheses() {
        XCTAssertEqual("geo:50.087500,14.421300?q=50.087500,14.421300(Jana%20%26%20Petr%20%28doma%29)", GeoLinks.geoUri(lat, lon, label))
        XCTAssertEqual("geo:-33.856800,151.215300?q=-33.856800,151.215300", GeoLinks.geoUri(-33.8568, 151.2153, ""))
        XCTAssertEqual("50.087500, 14.421300", GeoLinks.destinationText(lat, lon))
    }

    func testTheOrderIsTheWebsWithTheAndroidApps() {
        let nav = GeoLinks.apps.filter { $0.kind == GeoLinks.nav }.map(\.id)
        let ride = GeoLinks.apps.filter { $0.kind == GeoLinks.ride }.map(\.id)
        XCTAssertEqual(["google", "waze", "mapy", "osmand", "sygic", "here", "osm"], nav)
        XCTAssertEqual(["uber", "bolt", "liftago", "freenow"], ride)
        XCTAssertTrue(GeoLinks.packages().isSuperset(of: ["com.google.android.apps.maps", "com.waze", "cz.seznam.mapy", "ee.mtakso.client", "taxi.android.client"]))
    }

    private func ids(_ cs: [GeoLinks.Choice]) -> [String] { cs.map { $0.id + ($0.web ? "/web" : "") } }

    private func byId(_ cs: [GeoLinks.Choice], _ id: String) -> GeoLinks.Choice {
        guard let c = cs.first(where: { $0.id == id }) else { XCTFail("no \(id) in \(cs)"); return cs[0] }
        return c
    }

    func testNavigationOffersTheInstalledAppsThenOtherGeoAppsThenTheWeb() {
        let installed: Set<String> = ["com.waze", "net.osmand", "com.sygic.aura"]
        let geo = [("com.waze", "Waze"),                       // a known app: listed once, with its own link
                   ("app.organicmaps", "Organic Maps"),         // any other map app
                   ("com.generalmagic.magicearth", "Magic Earth")]
        let cs = GeoLinks.choices(GeoLinks.nav, lat, lon, label, installed: installed, geoApps: geo)
        XCTAssertEqual(["waze", "osmand", "sygic", "geo:app.organicmaps", "geo:com.generalmagic.magicearth", "google/web", "mapy/web", "osm/web"], ids(cs))

        let waze = byId(cs, "waze")
        XCTAssertEqual("com.waze", waze.pkg)
        XCTAssertEqual("waze://?ll=50.087500,14.421300&navigate=yes", waze.uri)
        XCTAssertEqual(GeoLinks.geoUri(lat, lon, label), waze.fallback)
        let osmand = byId(cs, "osmand")
        XCTAssertEqual("net.osmand", osmand.pkg) // the free one when OsmAnd+ is not here
        XCTAssertEqual("osmand.api://navigate?dest_lat=50.087500&dest_lon=14.421300&dest_name=Jana%20%26%20Petr%20(doma)&profile=car&force=true", osmand.uri)
        XCTAssertEqual("com.sygic.aura://coordinate|14.421300|50.087500|drive", byId(cs, "sygic").uri)
        let organic = byId(cs, "geo:app.organicmaps")
        XCTAssertEqual("Organic Maps", organic.name)
        XCTAssertEqual("app.organicmaps", organic.pkg)
        XCTAssertEqual(GeoLinks.geoUri(lat, lon, label), organic.uri)
        let google = byId(cs, "google")
        XCTAssertTrue(google.web)
        XCTAssertNil(google.pkg)
        XCTAssertEqual("https://www.google.com/maps/dir/?api=1&destination=50.087500,14.421300", google.uri)
    }

    func testTheInstalledAppsGetTheirOwnLinks() {
        let installed: Set<String> = ["com.google.android.apps.maps", "cz.seznam.mapy", "com.here.app.maps", "net.osmand.plus", "net.osmand"]
        let cs = GeoLinks.choices(GeoLinks.nav, lat, lon, "", installed: installed, geoApps: [])
        XCTAssertEqual(["google", "mapy", "osmand", "here", "waze/web", "osm/web"], ids(cs))
        XCTAssertEqual("google.navigation:q=50.087500,14.421300", byId(cs, "google").uri)
        XCTAssertEqual("https://mapy.com/fnc/v1/route?end=14.421300,50.087500&routeType=car_fast&navigate=true", byId(cs, "mapy").uri)
        XCTAssertEqual("net.osmand.plus", byId(cs, "osmand").pkg) // OsmAnd+ first
        XCTAssertEqual("osmand.api://navigate?dest_lat=50.087500&dest_lon=14.421300&profile=car&force=true", byId(cs, "osmand").uri)
        XCTAssertEqual("https://share.here.com/r/mylocation/50.087500,14.421300?m=d", byId(cs, "here").uri)
        XCTAssertEqual("https://share.here.com/r/mylocation/50.087500,14.421300,Jana?m=d",
                       byId(GeoLinks.choices(GeoLinks.nav, lat, lon, "Jana", installed: installed, geoApps: nil), "here").uri)
    }

    func testRidesGiveUberTheDestinationAndOpenTheOthers() {
        let installed: Set<String> = ["com.ubercab", "ee.mtakso.client"]
        let cs = GeoLinks.choices(GeoLinks.ride, lat, lon, "Jana", installed: installed, geoApps: nil)
        XCTAssertEqual(["uber", "bolt", "liftago/web", "freenow/web"], ids(cs))
        let uber = cs[0]
        XCTAssertEqual("com.ubercab", uber.pkg)
        XCTAssertEqual("uber://?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300&dropoff[nickname]=Jana", uber.uri)
        XCTAssertTrue(uber.prefill)
        XCTAssertNil(uber.fallback)
        let bolt = cs[1]
        XCTAssertEqual("ee.mtakso.client", bolt.pkg)
        XCTAssertNil(bolt.uri) // just open the app; the destination goes to the clipboard
        XCTAssertFalse(bolt.prefill)
        XCTAssertEqual("https://www.liftago.cz/", cs[2].uri)
        XCTAssertFalse(cs[2].prefill)
        // Nothing installed: the web for every one, Uber's with the destination.
        let none = GeoLinks.choices(GeoLinks.ride, lat, lon, "", installed: [], geoApps: nil)
        XCTAssertEqual(["uber/web", "bolt/web", "liftago/web", "freenow/web"], ids(none))
        XCTAssertEqual("https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300", none[0].uri)
    }

    func testAPlaceOutsideTheWorldHasNoChoices() {
        XCTAssertTrue(GeoLinks.choices(GeoLinks.nav, 91, 0, "", installed: [], geoApps: nil).isEmpty)
        XCTAssertTrue(GeoLinks.choices(GeoLinks.ride, .nan, 0, "", installed: [], geoApps: nil).isEmpty)
        XCTAssertTrue(GeoLinks.iosChoices(GeoLinks.nav, 0, 181, "", canOpen: { _ in true }).isEmpty)
    }

    // MARK: iOS

    func testIOSNavigationStartsWithAppleMapsThenTheAppsThePhoneCanOpen() {
        let can: Set<String> = ["waze", "com.sygic.aura"]
        let cs = GeoLinks.iosChoices(GeoLinks.nav, lat, lon, label, canOpen: { can.contains($0) })
        XCTAssertEqual(["apple", "waze", "sygic", "google/web", "mapy/web", "here/web", "osm/web"], ids(cs))
        XCTAssertEqual("maps://?daddr=50.087500,14.421300&dirflg=d", cs[0].uri)
        XCTAssertEqual("https://maps.apple.com/?daddr=50.087500,14.421300&dirflg=d", cs[0].fallback)
        XCTAssertEqual("waze://?ll=50.087500,14.421300&navigate=yes", byId(cs, "waze").uri)
        XCTAssertEqual("https://waze.com/ul?ll=50.087500,14.421300&navigate=yes", byId(cs, "waze").fallback)
        XCTAssertEqual("com.sygic.aura://coordinate%7C14.421300%7C50.087500%7Cdrive", byId(cs, "sygic").uri)
        XCTAssertNotNil(URL(string: byId(cs, "sygic").uri!))
        // Universal links: the app opens them when it is installed, the browser otherwise.
        XCTAssertEqual("https://share.here.com/r/mylocation/50.087500,14.421300,Jana%20%26%20Petr%20(doma)?m=d", byId(cs, "here").uri)
        XCTAssertEqual("https://mapy.com/fnc/v1/route?end=14.421300,50.087500&routeType=car_fast&navigate=true", byId(cs, "mapy").uri)
    }

    func testIOSGoogleMapsAndOsmAndWhenInstalled() {
        let cs = GeoLinks.iosChoices(GeoLinks.nav, lat, lon, "Jana", canOpen: { $0 == "comgooglemaps" || $0 == "osmandmaps" })
        XCTAssertEqual(["apple", "google", "osmand", "waze/web", "mapy/web", "here/web", "osm/web"], ids(cs))
        XCTAssertEqual("comgooglemaps://?daddr=50.087500,14.421300&directionsmode=driving", byId(cs, "google").uri)
        XCTAssertEqual("osmandmaps://navigate?lat=50.087500&lon=14.421300&title=Jana&profile=car", byId(cs, "osmand").uri)
    }

    func testIOSRides() {
        let cs = GeoLinks.iosChoices(GeoLinks.ride, lat, lon, "Jana", canOpen: { $0 == "uber" })
        XCTAssertEqual(["uber", "bolt/web", "liftago/web", "freenow/web"], ids(cs))
        let uber = cs[0]
        XCTAssertEqual("uber://?action=setPickup&pickup=my_location&dropoff%5Blatitude%5D=50.087500&dropoff%5Blongitude%5D=14.421300&dropoff%5Bnickname%5D=Jana", uber.uri)
        XCTAssertNotNil(URL(string: uber.uri!))
        XCTAssertFalse(cs[1].prefill)
        // Nothing installed: Uber's web link keeps the destination.
        let none = GeoLinks.iosChoices(GeoLinks.ride, lat, lon, "", canOpen: { _ in false })
        XCTAssertEqual("https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300", none[0].uri)
    }

    func testInfoPlistMayAskAboutEverySchemeOfTheTable() throws {
        let schemes = Bundle.main.object(forInfoDictionaryKey: "LSApplicationQueriesSchemes") as? [String] ?? []
        // osmandmaps, comgooglemaps, waze, com.sygic.aura, uber — canOpenURL answers only for these.
        XCTAssertTrue(Set(schemes).isSuperset(of: GeoLinks.iosSchemes()), "missing in Info.plist: \(GeoLinks.iosSchemes().subtracting(schemes))")
    }
}
