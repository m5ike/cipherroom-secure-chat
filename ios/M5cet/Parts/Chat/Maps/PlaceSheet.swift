// ui/parts/PlaceSheet (6.7) and location/GeoLinks for iOS: the place of a message —
// the map (when the operator has maps on), the coordinates, and the same three
// actions as the web's place window, in the same order: Navigate, Ride, Copy.
// Navigate offers the navigation apps on this iPhone (the known ones with their own
// links — Apple Maps always), then the web; Ride the ride-hailing apps (Uber with
// the destination; Bolt, Liftago, FREENOW open and get it from the clipboard), then
// the web. The links are GeoLinks' table (client/src/lib/geo-links.ts); nothing is
// opened until a line is tapped. "Open map" is Apple Maps after the renderer's
// confirmation (the whole address shown).

import M5Core
import M5Design
import M5Proto
import SwiftUI
import UIKit

/// GeoLinks on iOS: the same table, with the iOS apps' own links (the schemes are in Info.plist's LSApplicationQueriesSchemes).
enum PlaceLinks {
    static let nav = "nav", ride = "ride"

    struct Choice: Equatable {
        let id: String
        let name: String
        let url: String
        /// In the browser (the app is not here).
        let web: Bool
        /// The destination goes along; false: the app only opens (the destination is copied for pasting).
        let prefill: Bool
    }

    private struct App: Sendable {
        let id: String, kind: String, name: String
        let prefill: Bool
        /// The app's own link (nil: no app on iOS), the scheme that tells it is installed (nil: always there).
        let app: (@Sendable (Double, Double, String) -> String)?
        let scheme: String?
        let web: (@Sendable (Double, Double, String) -> String)?
    }

    /// Degrees with six decimals, always a dot (the web's toFixed(6)).
    static func deg(_ v: Double) -> String { String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), v) }
    private static func ll(_ la: Double, _ lo: Double) -> String { deg(la) + "," + deg(lo) }
    /// encodeURIComponent.
    static func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")) ?? ""
    }
    private static func has(_ l: String, _ prefix: String) -> String { l.isEmpty ? "" : prefix + enc(l) }

    private static let apps: [App] = [
        App(id: "google", kind: nav, name: "Google Maps", prefill: true, app: { la, lo, _ in "comgooglemaps://?daddr=\(ll(la, lo))&directionsmode=driving" }, scheme: "comgooglemaps://",
            web: { la, lo, _ in "https://www.google.com/maps/dir/?api=1&destination=\(ll(la, lo))" }),
        App(id: "apple", kind: nav, name: "Apple Maps", prefill: true, app: { la, lo, _ in "maps://?daddr=\(ll(la, lo))&dirflg=d" }, scheme: nil,
            web: { la, lo, _ in "https://maps.apple.com/?daddr=\(ll(la, lo))&dirflg=d" }),
        App(id: "waze", kind: nav, name: "Waze", prefill: true, app: { la, lo, _ in "waze://?ll=\(ll(la, lo))&navigate=yes" }, scheme: "waze://",
            web: { la, lo, _ in "https://waze.com/ul?ll=\(ll(la, lo))&navigate=yes" }),
        App(id: "mapy", kind: nav, name: "Mapy.com", prefill: true, app: nil, scheme: nil,
            web: { la, lo, _ in "https://mapy.com/fnc/v1/route?end=\(deg(lo)),\(deg(la))&routeType=car_fast&navigate=true" }),
        App(id: "osmand", kind: nav, name: "OsmAnd", prefill: true, app: { la, lo, l in "osmandmaps://navigate?lat=\(deg(la))&lon=\(deg(lo))&z=16" + has(l, "&title=") }, scheme: "osmandmaps://", web: nil),
        App(id: "sygic", kind: nav, name: "Sygic", prefill: true, app: { la, lo, _ in "com.sygic.aura://coordinate|\(deg(lo))|\(deg(la))|drive" }, scheme: "com.sygic.aura://", web: nil),
        App(id: "osm", kind: nav, name: "OpenStreetMap", prefill: true, app: nil, scheme: nil, web: { la, lo, _ in "https://www.openstreetmap.org/directions?to=\(ll(la, lo))" }),
        App(id: "uber", kind: ride, name: "Uber", prefill: true,
            app: { la, lo, l in "uber://?action=setPickup&pickup=my_location&dropoff[latitude]=\(deg(la))&dropoff[longitude]=\(deg(lo))" + has(l, "&dropoff[nickname]=") }, scheme: "uber://",
            web: { la, lo, l in "https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=\(deg(la))&dropoff[longitude]=\(deg(lo))" + has(l, "&dropoff[nickname]=") }),
        App(id: "bolt", kind: ride, name: "Bolt", prefill: false, app: nil, scheme: nil, web: { _, _, _ in "https://bolt.eu/" }),
        App(id: "liftago", kind: ride, name: "Liftago", prefill: false, app: nil, scheme: nil, web: { _, _, _ in "https://www.liftago.cz/" }),
        App(id: "freenow", kind: ride, name: "FREENOW", prefill: false, app: nil, scheme: nil, web: { _, _, _ in "https://www.free-now.com/" }),
    ]

    /// The picker's lines for one kind: the table's apps that are here (their own links), then the web links of the others.
    static func choices(_ kind: String, lat: Double, lon: Double, label: String, installed: (String) -> Bool) -> [Choice] {
        guard abs(lat) <= 90 && abs(lon) <= 180 else { return [] }
        var out = [Choice](), web = [Choice]()
        for a in apps where a.kind == kind {
            if let link = a.app, a.scheme.map(installed) ?? true {
                out.append(Choice(id: a.id, name: a.name, url: link(lat, lon, label), web: false, prefill: a.prefill))
            } else if let w = a.web {
                web.append(Choice(id: a.id, name: a.name, url: w(lat, lon, label), web: true, prefill: a.prefill))
            }
        }
        return out + web
    }

    /// What goes to the clipboard for an app that cannot take the destination: "50.087500, 14.421300".
    static func destinationText(_ lat: Double, _ lon: Double) -> String { deg(lat) + ", " + deg(lon) }

    /// "Open map": the point in Apple Maps (with the sender's name as its label).
    static func appleMaps(_ lat: Double, _ lon: Double, label: String) -> String {
        "https://maps.apple.com/?ll=\(ll(lat, lon))" + (label.isEmpty ? "" : "&q=" + enc(label))
    }
}

@MainActor
enum PlaceSheet {
    static func show(_ m: ChatMessage, host: DesignHost) {
        guard BubbleKinds.position(m) != nil else { return }
        let vc = UIHostingController(rootView: AnyView(EmptyView()))
        let view = PlaceSheetView(message: m, host: host, close: { [weak vc] then in
            vc?.dismiss(animated: true) { then?() }
        })
        vc.rootView = AnyView(view.environment(host))
        if let sheet = vc.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        vc.view.backgroundColor = host.renderContext().color("@surface", .white).uiColor
        ChatFileActions.present(vc)
    }
}

private struct PlaceSheetView: View {
    let message: ChatMessage
    let host: DesignHost
    let close: (_ then: (() -> Void)?) -> Void
    @State private var picking: String?
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let c = host.renderContext()
        let fg = c.swiftColor("@onSurface", .black), accent = c.swiftColor("@primary", .blue)
        let pos = BubbleKinds.position(message) ?? JSONObject()
        let lat = pos.chatDouble("lat"), lon = pos.chatDouble("lon"), acc = pos.optInt64("acc")
        let t = host.translator
        let title = message.mine ? t.t("map.captionMine") : t.t("map.caption").replacingOccurrences(of: "{name}", with: message.senderName)
        // The label goes along only with apps that show one: the sender's name, never mine.
        let label = message.mine ? "" : message.senderName
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: picking.map { t.t($0 == PlaceLinks.nav ? "loc.navigateWith" : "loc.rideWith") } ?? title)
                    .font(.system(size: 20 * scale, weight: .bold))
                    .foregroundStyle(fg)
                    .padding(.bottom, 12)
                if let kind = picking {
                    picker(kind, lat: lat, lon: lon, label: label, fg: fg)
                } else {
                    let policy = MapBubble.policy(for: message)
                    if let policy {
                        MapBubbleView(message: message, policy: policy, fg: fg, primary: c.color("@primary", .blue), maxWidth: 560, t: t.t,
                                      onTap: { close { ChatActions.openMap(message, host: host) } })
                    }
                    if policy == nil || policy?.showCoords == false {
                        Text(verbatim: MapBubble.coords(lat, lon, acc))
                            .font(.system(size: 14 * scale)).foregroundStyle(fg.opacity(0.8)).textSelection(.enabled).padding(.top, 4)
                    }
                    HStack(spacing: 6) {
                        action("navigation", t.t("loc.navigate"), fg: fg, accent: accent) { picking = PlaceLinks.nav }
                        action("hand", t.t("loc.ride"), fg: fg, accent: accent) { picking = PlaceLinks.ride }
                        action("copy", t.t("loc.copy"), fg: fg, accent: accent) {
                            host.copy(PlaceLinks.destinationText(lat, lon))
                            host.flash(title: "", text: "✓ " + t.t("loc.copy"), level: .success)
                        }
                    }
                    .padding(.top, 12).padding(.bottom, 4)
                    Text(verbatim: t.t("loc.privacy")).font(.system(size: 11.5 * scale)).foregroundStyle(fg.opacity(0.6)).padding(.top, 6)
                    HStack {
                        Spacer()
                        Button(t.t("nav.close")) { close(nil) }.buttonStyle(.borderless)
                        Button(t.t("map.open")) { close { ChatActions.openMap(message, host: host) } }.buttonStyle(.borderedProminent)
                    }
                    .tint(accent)
                    .padding(.top, 16)
                }
            }
            .padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 16)
        }
    }

    /// One of the three: its icon over its label, the whole a pressable tile.
    private func action(_ icon: String, _ label: String, fg: Color, accent: Color, _ run: @escaping () -> Void) -> some View {
        Button {
            DesignHaptics.tick(Look(settings: host.settings).haptics)
            run()
        } label: {
            VStack(spacing: 4) {
                DesignIcon(name: icon, size: 22, color: accent)
                Text(verbatim: label).font(.system(size: 12.5 * scale, weight: .bold)).foregroundStyle(fg)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10).padding(.horizontal, 6)
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(fg.opacity(0.18), lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel(Text(verbatim: label))
    }

    /// The picker: the apps here first (their icon), then the web; each line says what happens.
    private func picker(_ kind: String, lat: Double, lon: Double, label: String, fg: Color) -> some View {
        let t = host.translator
        let list = PlaceLinks.choices(kind, lat: lat, lon: lon, label: label) { scheme in
            URL(string: scheme).map { UIApplication.shared.canOpenURL($0) } ?? false
        }
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(list, id: \.id) { choice in
                Button { open(choice, lat: lat, lon: lon) } label: {
                    HStack(spacing: 14) {
                        DesignIcon(name: choice.web ? "globe" : "map", size: 24, color: fg.opacity(0.7)).frame(width: 32, height: 32)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(verbatim: choice.name).font(.system(size: 16 * scale)).foregroundStyle(fg)
                            let sub = [choice.web ? t.t("loc.inBrowser") : "", choice.prefill ? "" : t.t("loc.ride.paste")].filter { !$0.isEmpty }.joined(separator: " · ")
                            if !sub.isEmpty { Text(verbatim: sub).font(.system(size: 12.5 * scale)).foregroundStyle(fg.opacity(0.65)) }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
            }
            HStack {
                Spacer()
                Button(t.t("nav.close")) { picking = nil }.buttonStyle(.borderless)
            }
            .padding(.top, 12)
        }
    }

    /// Opens a choice: in its app (its link), or in the browser; an app that cannot take the destination gets it pasted.
    private func open(_ c: PlaceLinks.Choice, lat: Double, lon: Double) {
        if !c.prefill {
            host.copy(PlaceLinks.destinationText(lat, lon))
            host.flash(title: "", text: host.translator.t("loc.copied"), level: .info)
        }
        guard let url = URL(string: c.url) else { return }
        UIApplication.shared.open(url) { ok in
            if !ok { Task { @MainActor in host.flash(title: "", text: host.translator.t("file.noApp"), level: .warn) } }
        }
        close(nil)
    }
}
