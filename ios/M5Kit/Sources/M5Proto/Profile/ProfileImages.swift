// 6.7: the profile's photo and background, as the web makes them — the pure
// parts of android profile/ProfileImages.java (client/src/lib/profile/
// image.ts): the crop (a centred square, a 3:1 band), the scale (never up),
// the byte caps, the quality / scale ladder of the JPEG encoding — and
// stripJpeg, which removes every metadata segment byte for byte, so no GPS
// position, camera or serial number goes anywhere. Decoding a picture with
// its EXIF orientation and drawing / compressing it are the platform's
// (ImageIO / Core Graphics in the app): it implements ProfileImages.Renderer.

import M5Core
import M5Crypto

/// Profile pictures: crop, ladder and metadata stripping (android `profile/ProfileImages.java`).
public enum ProfileImages {
    /// The largest picked file read (bytes).
    public static let rawMaxBytes = 25 * 1024 * 1024
    /// The JPEG qualities tried, best first.
    public static let qualities = [86, 78, 70, 60, 50]
    /// The scales tried for each, largest first.
    public static let scales: [Double] = [1, 0.8, 0.64, 0.5]

    /// Why a picture cannot be the profile's.
    public enum Failure: String, Error, Sendable {
        case notAnImage = "not-an-image"
        case imageTooLarge = "image-too-large"
    }

    /// The byte cap of a kind ("avatar" or "cover").
    public static func cap(_ kind: String) -> Int { kind == "avatar" ? ProfileCard.avatarBytes : ProfileCard.coverBytes }

    /// The part of the source to draw (sx, sy, sw, sh) and its size (dw, dh); never scaled up.
    public struct Crop: Sendable, Equatable {
        public let sx: Int, sy: Int, sw: Int, sh: Int, dw: Int, dh: Int
        /// {sx, sy, sw, sh, dw, dh} as Java's int[].
        public var array: [Int] { [sx, sy, sw, sh, dw, dh] }
    }

    public static func cropFor(_ kind: String, _ w: Int, _ h: Int) -> Crop {
        let avatar = kind == "avatar"
        let ratio = avatar ? 1 : Double(ProfileCard.coverW) / Double(ProfileCard.coverH)
        var sw = w, sh = Js.round(Double(w) / ratio)
        if sh > h { sh = h; sw = Js.round(Double(h) * ratio) }
        let sx = (w - sw) / 2, sy = (h - sh) / 2
        let maxW = avatar ? ProfileCard.avatarPx : ProfileCard.coverW
        let scale = Swift.min(1.0, Double(maxW) / Double(Swift.max(1, sw)))
        return Crop(sx: sx, sy: sy, sw: sw, sh: sh, dw: Swift.max(1, Js.round(Double(sw) * scale)), dh: Swift.max(1, Js.round(Double(sh) * scale)))
    }

    /// The power-of-two sample size to decode a w × h picture with: no larger than twice what is kept.
    public static func sampleSize(_ kind: String, _ w: Int, _ h: Int) -> Int {
        let target = kind == "avatar" ? ProfileCard.avatarPx * 2 : ProfileCard.coverW * 2
        var n = 1
        while Swift.max(w, h) / (n * 2) >= target { n *= 2 }
        return n
    }

    /// A JPEG without APP1–APP15 (EXIF, XMP, ICC, IPTC) and comments; nil if it is not a well-formed JPEG.
    public static func stripJpeg(_ b: Bytes?) -> Bytes? {
        guard let b, b.count >= 4, b[0] == 0xFF, b[1] == 0xD8 else { return nil }
        var out: Bytes = [0xFF, 0xD8]
        out.reserveCapacity(b.count)
        var i = 2
        while i + 1 < b.count {
            if b[i] != 0xFF { return nil }
            var marker = b[i + 1]
            while marker == 0xFF && i + 2 < b.count { i += 1; marker = b[i + 1] }
            if marker == 0xD9 { out += [0xFF, 0xD9]; return out }
            if (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01 { out += [0xFF, marker]; i += 2; continue }
            if i + 3 >= b.count { return nil }
            let len = Int(b[i + 2]) << 8 | Int(b[i + 3])
            if len < 2 || i + 2 + len > b.count { return nil }
            let drop = (marker > 0xE0 && marker <= 0xEF) || marker == 0xFE
            if !drop { out += b[i..<(i + 2 + len)] }
            i += 2 + len
            // Start of scan: the entropy-coded data and the rest stay as they are.
            if marker == 0xDA { out += b[i...]; return out }
        }
        return nil
    }

    public static func dataUrl(_ jpeg: Bytes) -> String { "data:image/jpeg;base64," + Crypto.b64(jpeg) }

    /// Draws the crop of the decoded picture (EXIF orientation applied) onto
    /// white at width × height and encodes it as a JPEG of `quality` (0–100).
    /// The app's implementation may keep the drawn bitmap per size.
    public protocol Renderer {
        func jpeg(_ crop: Crop, width: Int, height: Int, quality: Int) throws -> Bytes
    }

    /// The encode ladder of a decoded picture (`width` × `height` after its
    /// orientation): each scale, each quality, until the JPEG fits the cap —
    /// then stripped to a clean data: URL. Throws Failure.imageTooLarge when
    /// nothing fits, notAnImage when the encoder's JPEG is not one.
    public static func encode(_ kind: String, width: Int, height: Int, renderer: some Renderer) throws -> String {
        guard width > 0, height > 0 else { throw Failure.notAnImage }
        let c = cropFor(kind, width, height)
        let limit = cap(kind)
        for scale in scales {
            let w = Swift.max(1, Js.round(Double(c.dw) * scale)), h = Swift.max(1, Js.round(Double(c.dh) * scale))
            for q in qualities {
                let jpeg = try renderer.jpeg(c, width: w, height: h, quality: q)
                if !jpeg.isEmpty && jpeg.count <= limit {
                    guard let clean = stripJpeg(jpeg) else { throw Failure.notAnImage }
                    return dataUrl(clean)
                }
            }
        }
        throw Failure.imageTooLarge
    }
}
