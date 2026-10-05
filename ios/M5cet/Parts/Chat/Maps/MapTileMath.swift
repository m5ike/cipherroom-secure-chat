// ui/bubble/TileMath (6.2): Web Mercator for the map preview — where a position
// falls in the world of 256-px tiles at a zoom, and which tiles a view of w × h map
// pixels centred exactly on it needs, with each tile's offset in the view. Pure.

import Foundation

enum MapTileMath {
    static let tile = 256
    /// Web Mercator stops here (the square world).
    static let maxLat = 85.0511287798

    /// A tile of the view: its coordinates (x wrapped round the world) and where its top-left corner goes in the view.
    struct Tile: Hashable, CustomStringConvertible {
        let z: Int, x: Int, y: Int
        let left: Double, top: Double
        var description: String { "\(z)/\(x)/\(y)" }
    }

    /// The size of the world at zoom z, in map pixels.
    static func world(_ z: Int) -> Double { Double(tile) * pow(2, Double(z)) }

    /// The position's pixel in the world at zoom z.
    static func project(_ lat: Double, _ lon: Double, _ z: Int) -> (x: Double, y: Double) {
        let w = world(z)
        let la = max(-maxLat, min(maxLat, lat))
        let lo = max(-180, min(180, lon))
        let x = (lo + 180) / 360 * w
        let r = la * (Double.pi / 180)
        let y = (1 - log(tan(r) + 1 / cos(r)) / .pi) / 2 * w
        return (x, y)
    }

    /// The tile a position is in (OpenStreetMap's slippy-map numbering).
    static func tileOf(_ lat: Double, _ lon: Double, _ z: Int) -> (x: Int, y: Int) {
        let p = project(lat, lon, z)
        let n = 1 << z
        return (min(n - 1, Int(floor(p.x / Double(tile)))), min(n - 1, max(0, Int(floor(p.y / Double(tile))))))
    }

    /// The tiles for a w × h view centred on the position: rows top to bottom, left to right. Tiles past the poles
    /// are left out (the view shows the background there); x wraps across the date line.
    static func tiles(_ lat: Double, _ lon: Double, _ z: Int, _ w: Double, _ h: Double) -> [Tile] {
        let c = project(lat, lon, z)
        let left = c.x - w / 2, top = c.y - h / 2
        let n = 1 << z
        let t = Double(tile)
        let x0 = Int(floor(left / t)), x1 = Int(floor((left + w - 1e-9) / t))
        let y0 = Int(floor(top / t)), y1 = Int(floor((top + h - 1e-9) / t))
        var out = [Tile]()
        for ty in y0...max(y0, y1) where ty >= 0 && ty < n && ty <= y1 {
            for tx in x0...max(x0, x1) where tx <= x1 {
                let wx = ((tx % n) + n) % n
                out.append(Tile(z: z, x: wx, y: ty, left: Double(tx) * t - left, top: Double(ty) * t - top))
            }
        }
        return out
    }

    /// Metres per map pixel at the latitude (the accuracy circle).
    static func metersPerPixel(_ lat: Double, _ z: Int) -> Double {
        156543.03392 * cos(max(-maxLat, min(maxLat, lat)) * (Double.pi / 180)) / pow(2, Double(z))
    }
}
