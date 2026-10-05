// profile.pick: a picture from the photo library (PhotosUI's picker — out of
// process, no library permission needed) for the profile photo or background, then
// ProfileImageEncoder: decoded with its orientation applied (the only thing read
// from its metadata), cropped (a centred square, a 3:1 band), scaled down
// (256 px / 1200 × 400, never up), JPEG under the byte cap (40 / 72 KB, the quality
// and scale ladder) — and every metadata segment stripped byte for byte
// (ProfileImages.stripJpeg), so no GPS position, camera or serial number goes
// anywhere. Port of android/…/profile/ProfileImages.encode.

import Foundation
import ImageIO
import M5Core
import M5Proto
import PhotosUI
import UIKit
import UniformTypeIdentifiers

@MainActor
enum ProfilePhotoPicker {
    private static var delegate: Delegate?

    /// The picker over the app; `done` gets the picked picture's bytes (nothing when cancelled).
    static func pick(host: DesignHost, done: @escaping @MainActor @Sendable (Data) -> Void) {
        guard let top = SecureDialog.topController() else { return }
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        let d = Delegate { data in
            delegate = nil
            if let data { done(data) } else { host.flash(title: "", text: host.peopleText("pf.err.image"), level: .error) }
        }
        delegate = d
        picker.delegate = d
        picker.overrideUserInterfaceStyle = host.isDark ? .dark : .light
        top.present(picker, animated: true)
    }

    @MainActor
    private final class Delegate: NSObject, PHPickerViewControllerDelegate {
        let done: @MainActor @Sendable (Data?) -> Void
        init(done: @escaping @MainActor @Sendable (Data?) -> Void) { self.done = done }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            guard let provider = results.first?.itemProvider else {
                ProfilePhotoPicker.delegate = nil
                return
            }
            let done = done
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                Task { @MainActor in done(data) }
            }
        }
    }
}

/// The platform half of ProfileImages (ImageIO / Core Graphics): decode with the orientation, crop, draw on
/// white, JPEG — the ladder and the stripping are M5Proto's.
struct ProfileImageEncoder: ProfileImages.Renderer {
    let image: CGImage

    /// A picked picture → a clean JPEG data: URL (blocking: run it off the main actor). Throws ProfileImages.Failure.
    static func encode(_ raw: Data, kind: String) throws -> String {
        if raw.count > ProfileImages.rawMaxBytes { throw ProfileImages.Failure.imageTooLarge }
        guard let src = CGImageSourceCreateWithData(raw as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int, w > 0, h > 0
        else { throw ProfileImages.Failure.notAnImage }
        // Decode no larger than twice what is kept (Android's inSampleSize), turned as the camera meant.
        let n = ProfileImages.sampleSize(kind, w, h)
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceShouldCacheImmediately: true, kCGImageSourceThumbnailMaxPixelSize: max(1, max(w, h) / n)]
        guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { throw ProfileImages.Failure.notAnImage }
        return try ProfileImages.encode(kind, width: image.width, height: image.height, renderer: ProfileImageEncoder(image: image))
    }

    func jpeg(_ crop: ProfileImages.Crop, width: Int, height: Int, quality: Int) throws -> [UInt8] {
        guard let part = image.cropping(to: CGRect(x: crop.sx, y: crop.sy, width: crop.sw, height: crop.sh)),
              let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { throw ProfileImages.Failure.notAnImage }
        // JPEG has no alpha: white behind a transparent PNG.
        ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.interpolationQuality = .high
        ctx.draw(part, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let drawn = ctx.makeImage() else { throw ProfileImages.Failure.notAnImage }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { throw ProfileImages.Failure.notAnImage }
        CGImageDestinationAddImage(dest, drawn, [kCGImageDestinationLossyCompressionQuality: Double(quality) / 100] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw ProfileImages.Failure.notAnImage }
        return [UInt8](out as Data)
    }
}
