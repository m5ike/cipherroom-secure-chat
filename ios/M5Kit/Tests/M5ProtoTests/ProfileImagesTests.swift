// 6.7: the profile pictures lose their metadata (EXIF with GPS, XMP,
// comments) and are cropped like the web's — android profile/ProfileImagesTest,
// plus the encode ladder over a fake renderer (the platform's part).

import M5Core
import M5Proto
import Synchronization
import Testing

@Suite("profile ProfileImages")
struct ProfileImagesTests {
    private static func seg(_ out: inout Bytes, _ marker: UInt8, _ body: Bytes) {
        out += [0xFF, marker, UInt8((body.count + 2) >> 8 & 0xFF), UInt8((body.count + 2) & 0xFF)]
        out += body
    }

    private static func ascii(_ s: String) -> Bytes { Array(s.utf8) }

    /// ISO-8859-1 text of bytes.
    private static func latin1(_ b: Bytes) -> String { String(String.UnicodeScalarView(b.map { Unicode.Scalar($0) })) }

    static func jpegWithExif() -> Bytes {
        var out: Bytes = [0xFF, 0xD8]
        seg(&out, 0xE0, ascii("JFIF") + [0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
        seg(&out, 0xE1, ascii("Exif") + [0, 0] + ascii("GPSLatitude=49.1951;Serial=SN12345"))
        seg(&out, 0xFE, ascii("taken at home"))
        seg(&out, 0xDB, Bytes(repeating: 0, count: 65))
        seg(&out, 0xDA, [1, 1, 0, 0, 0x3F, 0])
        out += [0x12, 0x34, 0xFF, 0x00, 0x56, 0xFF, 0xD0, 0x78, 0xFF, 0xD9]
        return out
    }

    @Test func exifGpsAndCommentsAreStripped() throws {
        let out = try #require(ProfileImages.stripJpeg(Self.jpegWithExif()))
        let s = Self.latin1(out)
        #expect(!s.contains("Exif"))
        #expect(!s.contains("GPS"))
        #expect(!s.contains("Serial"))
        #expect(!s.contains("taken at home"))
        #expect(s.contains("JFIF"))
        #expect(out[0] == 0xFF)
        #expect(out[1] == 0xD8)
        #expect(out[out.count - 1] == 0xD9)
        // Stripping again changes nothing.
        #expect(ProfileImages.stripJpeg(out) == out)
    }

    @Test func notAJpegIsRefused() {
        #expect(ProfileImages.stripJpeg(Self.ascii("<svg/>")) == nil)
        #expect(ProfileImages.stripJpeg([0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF]) == nil)
        #expect(ProfileImages.stripJpeg(nil) == nil)
    }

    @Test func cropsLikeTheWeb() {
        #expect(ProfileImages.cropFor("avatar", 4000, 3000).array == [500, 0, 3000, 3000, ProfileCard.avatarPx, ProfileCard.avatarPx])
        let cover = ProfileImages.cropFor("cover", 4000, 3000)
        #expect(cover.sw == 4000)
        #expect(cover.sh == 1333)
        #expect(cover.dw == ProfileCard.coverW)
        #expect(cover.dh == 400)
        // Never scaled up.
        let small = ProfileImages.cropFor("avatar", 100, 50)
        #expect(small.dw == 50)
        #expect(small.dh == 50)
    }

    @Test func theCleanPictureIsAValidProfileImage() throws {
        let url = ProfileImages.dataUrl(try #require(ProfileImages.stripJpeg(Self.jpegWithExif())))
        #expect(ProfileCard.cleanImage(url, ProfileCard.avatarBytes) == url)
    }

    /// A renderer that answers JPEGs of a given size, recording what it was asked.
    final class FakeRenderer: ProfileImages.Renderer, Sendable {
        let asked = Mutex<[(Int, Int, Int)]>([])
        let size: @Sendable (Int, Int, Int) -> Int

        init(_ size: @escaping @Sendable (Int, Int, Int) -> Int) { self.size = size }

        /// [width, height, quality] of each call.
        var calls: [[Int]] { asked.withLock { $0.map { [$0.0, $0.1, $0.2] } } }

        func jpeg(_ crop: ProfileImages.Crop, width: Int, height: Int, quality: Int) throws -> Bytes {
            asked.withLock { $0.append((width, height, quality)) }
            let n = size(width, height, quality)
            var j = ProfileImagesTests.jpegWithExif()
            let pad = Swift.max(0, n - j.count)
            j.insert(contentsOf: Bytes(repeating: 0x55, count: pad), at: j.count - 2)
            return j
        }
    }

    /// (beyond the Android test) the ladder: scales × qualities until the JPEG fits, then stripped.
    @Test func theEncodeLadder() throws {
        let first = FakeRenderer { _, _, _ in 1000 }
        let url = try ProfileImages.encode("avatar", width: 4000, height: 3000, renderer: first)
        #expect(first.calls == [[256, 256, 86]])
        #expect(!url.contains("Exif") && ProfileCard.cleanImage(url, ProfileCard.avatarBytes) == url)
        // Too large at full size: a smaller quality, then a smaller scale.
        let later = FakeRenderer { w, _, q in w == 205 && q == 60 ? 1000 : 50_000 }
        _ = try ProfileImages.encode("avatar", width: 4000, height: 3000, renderer: later)
        #expect(later.calls.count == 9)
        #expect(later.calls.last == [205, 205, 60])
        // Nothing fits.
        #expect(throws: ProfileImages.Failure.imageTooLarge) { try ProfileImages.encode("cover", width: 10, height: 10, renderer: FakeRenderer { _, _, _ in 80_000 }) }
        #expect(throws: ProfileImages.Failure.notAnImage) { try ProfileImages.encode("cover", width: 0, height: 10, renderer: FakeRenderer { _, _, _ in 1 }) }
        #expect(ProfileImages.sampleSize("avatar", 4000, 3000) == 4)
        #expect(ProfileImages.sampleSize("cover", 2000, 1000) == 1)
        #expect(ProfileImages.cap("avatar") == 40 * 1024)
        #expect(ProfileImages.cap("cover") == 72 * 1024)
    }
}
