// Where the app keeps its encrypted files and how they are written: Data
// Protection classes, no backup, durable (synced) writes — Android's
// noBackupFilesDir, Vault.writeAtomic / writeDurable / syncDir.
//
//   app container   Library/Application Support/m5/        USER tier, PIN and biometric wraps, the
//                                                          lock inbox, vault files       (NSFileProtectionComplete)
//   App Group       Library/Application Support/m5/        SYS tier and its wrapped key — what the
//                   (group.cz.m5cet.app)                   notification extension may read
//                                                          (completeUntilFirstUserAuthentication)
//
// Both are excluded from iCloud / Finder backups (isExcludedFromBackup — Android
// allowBackup=false). Without an App Group container (an unsigned simulator
// build) the shared part is Application Support/m5-shared of the app.

import Foundation

enum ProtectedFiles {
    /// Creates the directory (and parents) with this protection class and excludes it from backups.
    static func ensureDirectory(_ dir: URL, protection: FileProtectionType) throws {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        if !fm.fileExists(atPath: dir.path, isDirectory: &isDir) {
            do {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: protection])
            } catch {
                throw SecurityError.io("cannot create \(dir.lastPathComponent)")
            }
        }
        excludeFromBackup(dir)
    }

    static func excludeFromBackup(_ url: URL) {
        var u = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? u.setResourceValues(values)
    }

    /// Writes a temporary file with the protection class, syncs it to the disk (F_FULLFSYNC),
    /// renames it over the target and syncs the directory — the rename is on the disk before
    /// anything that depends on it (Android Vault.writeDurable).
    static func writeDurable(_ data: Data, to url: URL, protection: FileProtectionType) throws {
        let fm = FileManager.default
        let tmp = url.appendingPathExtension("tmp")
        try? fm.removeItem(at: tmp)
        guard fm.createFile(atPath: tmp.path, contents: data, attributes: [.protectionKey: protection]) else {
            throw SecurityError.io("cannot write \(url.lastPathComponent)")
        }
        fullSync(path: tmp.path)
        guard rename(tmp.path, url.path) == 0 else {
            try? fm.removeItem(at: tmp)
            throw SecurityError.io("cannot replace \(url.lastPathComponent)")
        }
        fullSync(path: url.deletingLastPathComponent().path)
    }

    /// The bytes on the disk, not only in the drive's cache (APFS: F_FULLFSYNC; fsync where it is refused).
    static func fullSync(path: String) {
        let fd = open(path, O_RDONLY)
        guard fd >= 0 else { return }
        if fcntl(fd, F_FULLFSYNC) != 0 { fsync(fd) }
        close(fd)
    }

    static func read(_ url: URL) throws -> Data? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do { return try Data(contentsOf: url) } catch { throw SecurityError.io("cannot read \(url.lastPathComponent)") }
    }

    /// Deletes a directory's contents (and the directory), except one file to keep (the pending wipe report).
    static func deleteTree(_ url: URL, keeping keep: URL? = nil) {
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path) else { return }
        if let keep, keep.standardizedFileURL.path.hasPrefix(url.standardizedFileURL.path + "/") {
            for child in (try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? [] {
                if child.standardizedFileURL.path == keep.standardizedFileURL.path { continue }
                deleteTree(child, keeping: keep)
            }
            return
        }
        if url.standardizedFileURL.path == keep?.standardizedFileURL.path { return }
        try? fm.removeItem(at: url)
    }
}

/// The app's directories for the security code (one place, so the wipe finds everything).
struct SecurityPaths: Sendable {
    /// The app container's Application Support/m5 — USER tier, wraps, lock inbox, vault files.
    let root: URL
    /// The App Group's Application Support/m5 — SYS tier (the notification extension reads it).
    let shared: URL
    /// The pending wipe report (outside root: it survives the wipe that wrote it).
    let pendingWipe: URL
    /// Whether `shared` really is the App Group container (false: an unsigned build).
    let sharedIsAppGroup: Bool

    var sysDir: URL { shared.appendingPathComponent("sys", isDirectory: true) }
    var sysKey: URL { shared.appendingPathComponent("sys.key") }
    var lockState: URL { shared.appendingPathComponent("lock-state.json") }
    var userDir: URL { root.appendingPathComponent("user", isDirectory: true) }
    var pinWrap: URL { root.appendingPathComponent("user.pin") }
    var bioWrap: URL { root.appendingPathComponent("user.bio") }
    var lockbox: URL { root.appendingPathComponent("lockbox", isDirectory: true) }
    var files: URL { root.appendingPathComponent("files", isDirectory: true) }
    /// The software stand-ins of the Keychain (unsigned simulator builds only): the app-only group's
    /// in the app's container, the shared group's on the App Group side.
    var devKeychain: URL { root.appendingPathComponent("dev-keychain", isDirectory: true) }
    var devSharedKeychain: URL { shared.appendingPathComponent("dev-keychain", isDirectory: true) }

    /// The app's real locations.
    static func system() -> SecurityPaths {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let group = Bundle.main.object(forInfoDictionaryKey: "M5AppGroup") as? String
        let container = group.flatMap { fm.containerURL(forSecurityApplicationGroupIdentifier: $0) }
        let shared = container.map { $0.appendingPathComponent("Library/Application Support/m5", isDirectory: true) }
        return SecurityPaths(root: support.appendingPathComponent("m5", isDirectory: true),
                             shared: shared ?? support.appendingPathComponent("m5-shared", isDirectory: true),
                             pendingWipe: support.appendingPathComponent("pending-wipe.json"),
                             sharedIsAppGroup: shared != nil)
    }

    /// Everything under one directory (tests).
    static func under(_ base: URL) -> SecurityPaths {
        SecurityPaths(root: base.appendingPathComponent("app/m5", isDirectory: true),
                      shared: base.appendingPathComponent("group/m5", isDirectory: true),
                      pendingWipe: base.appendingPathComponent("app/pending-wipe.json"),
                      sharedIsAppGroup: false)
    }

    /// Creates the directories with their protection classes.
    func prepare() throws {
        try ProtectedFiles.ensureDirectory(root, protection: .complete)
        try ProtectedFiles.ensureDirectory(userDir, protection: .complete)
        try ProtectedFiles.ensureDirectory(shared, protection: .completeUntilFirstUserAuthentication)
        try ProtectedFiles.ensureDirectory(sysDir, protection: .completeUntilFirstUserAuthentication)
    }
}
