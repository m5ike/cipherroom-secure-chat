import Testing
@testable import M5Core

@Test func moduleExists() { #expect(M5CoreModule.name == "M5Core") }
