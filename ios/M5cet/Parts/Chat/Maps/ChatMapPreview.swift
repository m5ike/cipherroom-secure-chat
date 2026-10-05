// ui/bubble/MapPreview (6.2): the map in a message with a position — the tiles
// around it from the app's server (GET /api/map/tile/{z}/{x}/{y}: the server
// fetches them from the operator's provider, so the provider never sees this
// phone), put together centred exactly on the point, with the pin, a caption
// ("Jana's current position") and the provider's attribution in a corner. Drawn
// here (CoreGraphics), not MapKit: Android's policy is the operator's tiles through
// the server only, never a third-party map SDK.
//
// Tiles and finished previews stay in memory only (LRU): a tile tells roughly where
// someone was, so nothing of it is written to the disk.

import Foundation
import UIKit

enum ChatMapPreview {
    /// What one preview shows.
    struct Spec: Sendable {
        let lat: Double, lon: Double
        let acc: Int64
        /// "" = no caption.
        let caption: String
        let captionBg: UInt32

        func key(_ p: ChatMapPolicy, _ scale: CGFloat) -> String {
            String(format: "%.6f,%.6f,%lld|", locale: Locale(identifier: "en_US_POSIX"), lat, lon, acc) + caption
                + String(format: "|%08x|%.2f|", locale: Locale(identifier: "en_US_POSIX"), captionBg, Double(scale)) + p.signature
        }
    }

    /// The pixel scale of a preview: the screen's scale, less for a large one (at most ~1.4 megapixels).
    static func scale(_ p: ChatMapPolicy, _ density: CGFloat) -> CGFloat {
        max(1, min(density, CGFloat((1_400_000.0 / (Double(p.width) * Double(p.height))).squareRoot())))
    }

    nonisolated(unsafe) private static let previews: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.totalCostLimit = 12 * 1024 * 1024
        return c
    }()

    static func cached(_ p: ChatMapPolicy, _ s: Spec, _ scale: CGFloat) -> UIImage? { previews.object(forKey: s.key(p, scale) as NSString) }

    /// Draws the preview; nil: no tile came (show the pin).
    @MainActor
    static func render(_ p: ChatMapPolicy, _ s: Spec, _ scale: CGFloat) async -> UIImage? {
        let key = s.key(p, scale)
        if let hit = previews.object(forKey: key as NSString) { return hit }
        let server = CoreModels.shared.server
        let tiles = MapTileMath.tiles(s.lat, s.lon, p.zoom, Double(p.width), Double(p.height))
        let got = await MapTiles.shared.fetch(server: server, policy: p, tiles: tiles)
        let drawn = await Task.detached(priority: .utility) { draw(p, s, scale, tiles, got.images) }.value
        guard let image = drawn.image else {
            if got.off { ChatMapPolicies.switchedOff() } else if got.offline { ChatMapPolicies.unreachable() }
            return nil
        }
        // One with holes is drawn again next time.
        if drawn.count == tiles.count { previews.setObject(image, forKey: key as NSString, cost: Int(image.size.width * image.size.height * image.scale * image.scale * 4)) }
        return image
    }

    private static func draw(_ p: ChatMapPolicy, _ s: Spec, _ scale: CGFloat, _ tiles: [MapTileMath.Tile], _ bytes: [Data?]) -> (image: UIImage?, count: Int) {
        let w = (CGFloat(p.width) * scale).rounded(), h = (CGFloat(p.height) * scale).rounded()
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        var count = 0
        let image = UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: format).image { ctx in
            let c = ctx.cgContext
            UIColor(chatArgb: 0xFFF2_EFE9).setFill() // land, where a tile is missing
            c.fill(CGRect(x: 0, y: 0, width: w, height: h))
            for (i, t) in tiles.enumerated() {
                guard let b = bytes[i], var tile = UIImage(data: b) else { continue }
                if p.grayscale, let g = gray(tile) { tile = g }
                let dst = CGRect(x: CGFloat(t.left) * scale, y: CGFloat(t.top) * scale, width: CGFloat(MapTileMath.tile) * scale, height: CGFloat(MapTileMath.tile) * scale)
                tile.draw(in: dst)
                count += 1
            }
            if count == 0 { return }
            let cx = w / 2, cy = h / 2
            accuracy(c, p, s, scale, cx, cy, w, h)
            pin(c, p.pinColor, scale, cx, cy)
            if !s.caption.isEmpty { caption(s, scale, cx, cy - 34 * scale, w) }
            if !p.attribution.isEmpty { attribution(p.attribution, scale, w, h) }
        }
        return (count == 0 ? nil : image, count)
    }

    private static func gray(_ img: UIImage) -> UIImage? {
        guard let ci = CIImage(image: img), let f = CIFilter(name: "CIColorControls") else { return nil }
        f.setValue(ci, forKey: kCIInputImageKey)
        f.setValue(0, forKey: kCIInputSaturationKey)
        guard let out = f.outputImage, let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }

    /// The accuracy as a faint circle, when it is larger than the pin and smaller than the map.
    private static func accuracy(_ c: CGContext, _ p: ChatMapPolicy, _ s: Spec, _ scale: CGFloat, _ cx: CGFloat, _ cy: CGFloat, _ w: CGFloat, _ h: CGFloat) {
        guard s.acc > 0 else { return }
        let r = CGFloat(Double(s.acc) / MapTileMath.metersPerPixel(s.lat, p.zoom)) * scale
        if r < 10 * scale || r > max(w, h) { return }
        let rect = CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)
        c.setFillColor(UIColor(chatArgb: (p.pinColor & 0x00FF_FFFF) | 0x2600_0000).cgColor)
        c.fillEllipse(in: rect)
        c.setStrokeColor(UIColor(chatArgb: (p.pinColor & 0x00FF_FFFF) | 0x8000_0000).cgColor)
        c.setLineWidth(1.2 * scale)
        c.strokeEllipse(in: rect)
    }

    /// A drop pin whose tip is exactly on the point.
    private static func pin(_ c: CGContext, _ color: UInt32, _ scale: CGFloat, _ cx: CGFloat, _ cy: CGFloat) {
        c.setFillColor(UIColor(chatArgb: 0x4000_0000).cgColor)
        c.fillEllipse(in: CGRect(x: cx - 6 * scale, y: cy - 2.5 * scale, width: 12 * scale, height: 5 * scale))
        let r = 10 * scale, headY = cy - 22 * scale
        let drop = CGMutablePath()
        drop.move(to: CGPoint(x: cx, y: cy))
        drop.addLine(to: CGPoint(x: cx - r * 0.78, y: headY + r * 0.62))
        drop.addLine(to: CGPoint(x: cx + r * 0.78, y: headY + r * 0.62))
        drop.closeSubpath()
        drop.addEllipse(in: CGRect(x: cx - r, y: headY - r, width: 2 * r, height: 2 * r))
        c.setFillColor(UIColor(chatArgb: color).cgColor)
        c.addPath(drop)
        c.fillPath()
        c.setStrokeColor(UIColor.white.cgColor)
        c.setLineWidth(1.5 * scale)
        c.strokeEllipse(in: CGRect(x: cx - r, y: headY - r, width: 2 * r, height: 2 * r))
        c.setFillColor(UIColor.white.cgColor)
        c.fillEllipse(in: CGRect(x: cx - 3.8 * scale, y: headY - 3.8 * scale, width: 7.6 * scale, height: 7.6 * scale))
    }

    /// The caption over the pin: white on the accent, one line, ellipsized to the map.
    private static func caption(_ s: Spec, _ scale: CGFloat, _ cx: CGFloat, _ bottom: CGFloat, _ width: CGFloat) {
        let font = UIFont.boldSystemFont(ofSize: 12 * scale)
        let padX = 8 * scale, padY = 4 * scale
        let para = NSMutableParagraphStyle()
        para.lineBreakMode = .byTruncatingTail
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white, .paragraphStyle: para]
        let text = s.caption as NSString
        let maxW = width - 16 * scale - 2 * padX
        let tw = min(maxW, ceil(text.size(withAttributes: attrs).width))
        let th = ceil(font.lineHeight)
        var box = CGRect(x: cx - tw / 2 - padX, y: bottom - th - 2 * padY, width: tw + 2 * padX, height: th + 2 * padY)
        if box.minY < 2 * scale { box = box.offsetBy(dx: 0, dy: 2 * scale - box.minY) }
        UIColor(chatArgb: 0x3300_0000).setFill()
        UIBezierPath(roundedRect: box.offsetBy(dx: 0, dy: 1.5 * scale), cornerRadius: 9 * scale).fill()
        UIColor(chatArgb: s.captionBg).setFill()
        UIBezierPath(roundedRect: box, cornerRadius: 9 * scale).fill()
        text.draw(with: CGRect(x: box.minX + padX, y: box.minY + padY, width: tw, height: th), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs, context: nil)
    }

    private static func attribution(_ text: String, _ scale: CGFloat, _ w: CGFloat, _ h: CGFloat) {
        let font = UIFont.systemFont(ofSize: 9 * scale)
        let para = NSMutableParagraphStyle()
        para.lineBreakMode = .byTruncatingTail
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor(chatArgb: 0xFF33_3333), .paragraphStyle: para]
        let t = text as NSString
        let tw = min(w * 0.8, ceil(t.size(withAttributes: attrs).width)), pad = 3 * scale
        let th = ceil(font.lineHeight)
        UIColor(chatArgb: 0xBFFF_FFFF).setFill()
        UIRectFill(CGRect(x: w - tw - 2 * pad, y: h - th - pad, width: tw + 2 * pad, height: th + pad))
        t.draw(with: CGRect(x: w - tw - pad, y: h - th - pad / 2, width: tw, height: th), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs, context: nil)
    }
}

/// The tiles from the app's server: in memory only (≤ 6 MB, policy.cacheHours), one request per tile at a time.
actor MapTiles {
    static let shared = MapTiles()

    private struct Tile { let bytes: Data; let at: Int64 }
    private var cache: [String: Tile] = [:]
    private var order: [String] = []
    private var size = 0
    private var fetching: [String: Task<Data, Error>] = [:]

    struct Result: Sendable {
        let images: [Data?]
        /// A tile answered "map-off"; tiles failed for want of the network or the server.
        let off: Bool
        let offline: Bool
    }

    func fetch(server: String, policy p: ChatMapPolicy, tiles: [MapTileMath.Tile]) async -> Result {
        var tasks = [Task<Data, Error>]()
        for t in tiles { tasks.append(task(server: server, policy: p, tile: t)) }
        var out = [Data?]()
        var off = false, offline = false
        for task in tasks {
            do { out.append(try await task.value) } catch let e as ChatHttp.Refused {
                off = off || e.code == "map-off"
                out.append(nil)
            } catch {
                offline = true
                out.append(nil)
            }
        }
        return Result(images: out, off: off, offline: offline)
    }

    private func task(server: String, policy p: ChatMapPolicy, tile t: MapTileMath.Tile) -> Task<Data, Error> {
        let key = server + "|" + p.tiles + p.subdomains + "|" + t.description
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if let hot = cache[key], now - hot.at < Int64(p.cacheHours) * 3_600_000 { return Task<Data, Error> { hot.bytes } }
        if let running = fetching[key] { return running }
        let url = server + "/api/map/tile/\(t.z)/\(t.x)/\(t.y)"
        let task = Task<Data, Error> {
            defer { self.done(key) }
            let b = try await ChatHttp.get(url, max: 600 * 1024)
            self.keep(key, b)
            return b
        }
        fetching[key] = task
        return task
    }

    private func done(_ key: String) { fetching[key] = nil }

    private func keep(_ key: String, _ b: Data) {
        if let old = cache[key] { size -= old.bytes.count; order.removeAll { $0 == key } }
        cache[key] = Tile(bytes: b, at: Int64(Date().timeIntervalSince1970 * 1000))
        order.append(key)
        size += b.count
        while size > 6 * 1024 * 1024, let first = order.first {
            order.removeFirst()
            size -= cache[first]?.bytes.count ?? 0
            cache[first] = nil
        }
    }

    #if DEBUG
    /// Previews: a tile as if the server had sent it.
    func seed(_ key: String, _ b: Data) { keep(key, b) }
    #endif

    /// The lock: what tiles showed leaves the memory.
    func clear() {
        cache.removeAll()
        order.removeAll()
        size = 0
    }
}

extension UIColor {
    /// 0xAARRGGBB as Android's ints.
    convenience init(chatArgb argb: UInt32) {
        self.init(red: CGFloat(argb >> 16 & 0xFF) / 255, green: CGFloat(argb >> 8 & 0xFF) / 255, blue: CGFloat(argb & 0xFF) / 255, alpha: CGFloat(argb >> 24 & 0xFF) / 255)
    }
}
