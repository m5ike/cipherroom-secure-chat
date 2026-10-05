// Platform/Security's Vault as the people store's PeopleVault: the user tier,
// records people.links / people.verified (sealed with the user key, Data
// Protection complete) — Android's Vault.json / putJson(Tier.USER, …).
// `ContactsService.shared.store.setVault(SecurityPeopleVault(vault: <the app's Vault>))`.

import Foundation

final class SecurityPeopleVault: PeopleVault, @unchecked Sendable {
    private let vault: Vault

    init(vault: Vault) { self.vault = vault }

    var isUnlocked: Bool { vault.unlocked }

    func readRecord(_ name: String) -> Data? { try? vault.get(.user, name) }

    func writeRecord(_ name: String, _ data: Data) throws { try vault.put(.user, name, data) }
}
