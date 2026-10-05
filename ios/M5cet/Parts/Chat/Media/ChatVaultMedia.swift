// ui/media/VaultMedia (6.1): media of a message without plaintext on the disk. An
// attachment is either inline (a data URL in the message) or a file in the vault
// (core.files — Platform/Files FileVault). Players read it from memory through an
// AVAssetResourceLoader (no file), pictures are decoded from the bytes, and only
// the share sheet / Quick Look / Save as get a decrypted temporary copy — in the
// app's temporary area, complete file protection, deleted as soon as they are done.

import AVFoundation
import Foundation
import ImageIO
import M5Core
import M5Proto
import UIKit
import UniformTypeIdentifiers

enum ChatMediaError: Error {
    case noFile, badDataURL, noVault
}

@MainActor
enum ChatVaultMedia {
    /// The attachment's bytes (inline data URL or the vault).
    static func data(_ m: ChatMessage) throws -> Data {
        if let d = m.fileDataUrl {
            guard let comma = d.firstIndex(of: ","), let bytes = Data(base64Encoded: String(d[d.index(after: comma)...]), options: .ignoreUnknownCharacters) else {
                throw ChatMediaError.badDataURL
            }
            return bytes
        }
        guard let path = m.filePath else { throw ChatMediaError.noFile }
        guard let files = CoreModels.shared.files else { throw ChatMediaError.noVault }
        return try files.read(path)
    }

    /// The bytes of a vault file by id (a call transcript's recording).
    static func data(vaultId: String) throws -> Data {
        guard let files = CoreModels.shared.files else { throw ChatMediaError.noVault }
        return try files.read(vaultId)
    }

    /// The attachment is here to show (inline, or a finished transfer).
    static func ready(_ m: ChatMessage) -> Bool {
        m.fileDataUrl != nil || (m.filePath != nil && m.fileProgress < 0 && m.fileProgress > -2)
    }

    /// A picture of the message, at most maxPx on its longer side (nil when it is not one or cannot be read).
    static func image(_ m: ChatMessage, maxPx: Int) async -> UIImage? {
        guard let bytes = try? data(m) else { return nil }
        return await Task.detached(priority: .userInitiated) { decode(bytes, maxPx: maxPx) }.value
    }

    nonisolated static func decode(_ bytes: Data, maxPx: Int) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: maxPx, kCGImageSourceShouldCacheImmediately: true]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }

    // MARK: temporary copies (Quick Look, share, Save as)

    /// A decrypted copy under its own name in the app's temporary area — `discard` it after use.
    static func temporaryCopy(_ m: ChatMessage) throws -> URL {
        let name = Payloads.safeFileName(.string(m.fileName ?? "file"))
        if m.fileDataUrl == nil, let path = m.filePath, let files = CoreModels.shared.files {
            return try files.temporaryCopy(path, name: name)
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("m5-share-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        let url = dir.appendingPathComponent(name)
        try data(m).write(to: url, options: [.completeFileProtection, .withoutOverwriting])
        return url
    }

    /// The copy goes (and its folder): the vault's own way for a vault copy, else here.
    static func discard(_ url: URL) {
        if url.deletingLastPathComponent().lastPathComponent.hasPrefix("m5-share-") {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        } else if let files = CoreModels.shared.files {
            files.discard(url)
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }
}

// MARK: - playing from memory

/// Serves an asset's bytes to AVFoundation from memory (Android's MediaDataSource over the vault): the player
/// never sees a file. One per asset; the asset keeps it alive through `ChatMemoryAsset`.
final class MemoryAssetLoader: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    private let data: Data
    private let contentType: String

    init(data: Data, mime: String) {
        self.data = data
        contentType = UTType(mimeType: mime)?.identifier ?? (mime.hasPrefix("video/") ? UTType.mpeg4Movie.identifier : UTType.mpeg4Audio.identifier)
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest) -> Bool {
        if let info = loadingRequest.contentInformationRequest {
            info.contentType = contentType
            info.contentLength = Int64(data.count)
            info.isByteRangeAccessSupported = true
        }
        if let req = loadingRequest.dataRequest {
            let start = max(0, min(data.count, Int(req.requestedOffset)))
            let end = req.requestsAllDataToEndOfResource ? data.count : min(data.count, start + req.requestedLength)
            if start < end { req.respond(with: data.subdata(in: start..<end)) }
        }
        loadingRequest.finishLoading()
        return true
    }
}

/// An AVURLAsset over bytes in memory (the custom scheme never leaves the process).
final class ChatMemoryAsset {
    let asset: AVURLAsset
    private let loader: MemoryAssetLoader
    private static let queue = DispatchQueue(label: "cz.m5cet.app.media-loader")

    init(data: Data, mime: String, name: String) {
        loader = MemoryAssetLoader(data: data, mime: mime)
        let ext = (name as NSString).pathExtension.isEmpty ? "bin" : (name as NSString).pathExtension
        asset = AVURLAsset(url: URL(string: "m5mem://media/\(UUID().uuidString).\(ext)")!)
        asset.resourceLoader.setDelegate(loader, queue: Self.queue)
    }
}

/// One plays at a time (AudioBar.playing / VideoBox.playing); the lock stops everything.
@MainActor
enum ChatMedia {
    private static var stoppers: [ObjectIdentifier: () -> Void] = [:]
    private static var playing: ObjectIdentifier?

    /// `owner` starts playing: whoever played before stops.
    static func willPlay(_ owner: AnyObject, stop: @escaping () -> Void) {
        let id = ObjectIdentifier(owner)
        if let p = playing, p != id { stoppers[p]?() }
        playing = id
        stoppers[id] = stop
    }

    static func released(_ owner: AnyObject) {
        let id = ObjectIdentifier(owner)
        stoppers[id] = nil
        if playing == id { playing = nil }
    }

    static func stopAll() {
        for s in stoppers.values { s() }
        stoppers.removeAll()
        playing = nil
    }
}
