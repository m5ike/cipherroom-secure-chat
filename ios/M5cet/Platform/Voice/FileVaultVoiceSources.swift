// Platform/Files' FileVault as the call transcripts' VoiceSourceVault: the
// utterance behind a transcript's "source" icon is kept as an encrypted file
// ("src-…", Android CallAudio.keep → FileVault.Writer).
// `CallVoiceBridge.shared.vault = FileVaultVoiceSources(files: <the app's FileVault>)`.

import Foundation

final class FileVaultVoiceSources: VoiceSourceVault, @unchecked Sendable {
    private let files: FileVault

    init(files: FileVault) { self.files = files }

    func store(id: String, bytes: Data) throws { try files.write(id, bytes) }
}
