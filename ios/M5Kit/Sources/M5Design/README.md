# M5Design

The design framework of the M5cet apps without any drawing: the server-driven UI of the Android
app (`android/app/src/main/java/cz/m5cet/app/{design,ui,update,core}`) ported to Swift for iOS,
iPadOS and watchOS (pure Foundation + Compression + Synchronization; no UIKit / SwiftUI). The
SwiftUI layer (`ios/M5cet/Renderer`, wave 2) draws what this target resolves; the app wires its
platform parts through a few protocols. The format is exactly the Android one — the same
`default-design.json`, the same signed bundles, the same expressions.

## Ported pieces

| Android | Swift |
|---|---|
| `design/Design.java` | `Design` (texts with the chain and plurals, colours, `fromJSON`, `fromFiles`, `withFallback`), `DesignDocument` and its Codable parts (`DesignNode`, `EventHandler`, `DesignMenuItem`, `DesignLibrary`, `LibraryStep`, `DesignAsset`, `DesignTheme`, `AnimSpec`) |
| `ui/Expr.java` | `Expr` (lexer, parser, evaluator, templates, filters, `readsData`), `Scope`, `Translator`, `ExprError` |
| `ui/Renderer.java` (model) | `ScreenResolver`, `RenderContext`, `RenderNode` and its parts (`RenderModel.swift`) |
| `ui/Actions.java` | `DesignAction` (122 actions, typed arguments), `ActionCatalog`, `ActionRunner`, `ActionHost` |
| `ui/ActionGuard.java`, `ui/DesignUrls.java`, `ui/DesignShare.java` | `ActionGuard`, `DesignUrls`, `DesignShare` |
| `core/Settings.java`, `core/SettingSchema.java` | `SettingsModel`, `SettingSchema` |
| `core/Locales.java`, `core/Plurals.java`, `core/Formats.java` | `DesignLocales`, `DesignPlurals`, `DesignFormats`, `DesignLanguage` / `BuiltInLanguages` (M5Core owns the contract; the app may hand its own `DesignLanguage`) |
| `design/Appearance.java`, `ui/look/{Look,Palette,Migration,Swipe,Buttons,Sheets,Menus}.java` (model) | `Appearance`, `LookTemplate`, `Look`, `Palette`, `LookMigration`, `SwipeMath`, `ButtonIconMath`, `SheetContent`, `DesignAction.dangerous` |
| `ui/Icons.java`, `ui/SvgPath.java` | `IconSet` (icons.json → `IconShape`s), `SvgPath` (→ `PathElement`s), `Icons.sfSymbol` (277 names, 259 with an SF Symbol verified on macOS 27) |
| `ui/Ui.java` (initials, name colours) | `ScreenResolver.initials`, `ScreenResolver.nameColor` |
| `update/BundleFile.java` | `BundleFile` (M5AB), `BundleContents` (M5PK + manifest), `Gzip`, `BundleVerifier`, `BundleCrypto` |
| `update/Bundles.java` (rules) | `BundleLedger` (offer, stage, trial, confirm, roll back) |
| `ui/MainActivity.scopeFor` (common part) | `ScreenScope` |
| `server/android/design.ts` catalogue | `ElementCatalog` (→ `ELEMENTS.md`), `ActionCatalog`, `DesignReport` (unknown elements / actions, LIMITS) |

## What the app provides

### `ActionHost` (main actor)

The runner (`ActionRunner(host:)`) does the design's logic; the host does what touches the
platform:

| Member | Meaning |
|---|---|
| `design`, `translator` | the design in use; its texts in the app's language (`Translator(design:lang:)`) |
| `settings` | a `SettingsModel`; the runner writes validated values through the setter — persist `settings.data` there |
| `form` | `$form`; inputs and choices write it |
| `isDark` | the tone now (`theme.toggle`) |
| `shownUsername()` | `profile.public` may name only the person whose detail is open |
| `flash`, `refresh`, `settingChanged`, `lookChanged`, `languageChanged` | notices, rebind the screen, side effects of a setting (permissions, services), redraw for the look, a new language |
| `confirmOpen(URLConfirmation)` | `url.open`: show title (host) + the whole address, open only on confirm |
| `confirmShare(ShareConfirmation)` | a computed copy / share: show `shown`, then call `runner.confirmed(request)` on confirm |
| `copy`, `share` | the design's own text, at once (copy marked sensitive) |
| `perform(DesignAction, source:)` | everything else: navigation, rooms, messages, calls, NFC, people, profile, history… with arguments already read as Android reads them |
| `log` | never put an argument's value in the log (it reaches the console) |

The runner already handles: `ActionGuard` refusals (flash `security.refused`), `lib.run`
(no nesting, ≤ 60 steps, each step's `if`, a broken step stops the library), `set`,
`setting.set`, `setting.toggle`, `look.set`, `look.reset`, `appearance.reset`, `theme.toggle`,
`nfc.reader`, `call.speaker` (toggles the setting, then `perform`), `url.open`'s readability rule
(`security.urlRefused`), copy / share confirmation (`security.shareTooLong` past 2000 code points),
and the commits of bound elements (`commit(binding, value:)`, `inputChanged(bind:text:)`).

### `BundleCrypto`

`sha256`, `verifyP1363` (ECDSA P-256 / SHA-256, r‖s), `eciesOpen` (the device's encryption key:
ECDH with the wire's ephemeral key, HKDF-SHA256 salt `m5cet/android/ecies/1` info
`<purpose>|<deviceId>`, AES-256-GCM AAD `m5cet/android/ecies/1|<purpose>|<deviceId>`) and
`aesGcmOpen`. Wire it to M5Crypto; `Tests/M5DesignTests/BundleTests.swift` has a CryptoKit
implementation (`CryptoKitBundleCrypto`) that opens a bundle the server's code built.

Downloading: `BundleVerifier.open(file:expectedId:serverKeySpki:serverKid:deviceId:appCode:crypto:)`
→ keep `content` sealed (Keychain-protected file), `ledger.staged(…)`; refused →
`ledger.failed(…)`. At start: `ledger.loadActive(now:open:)` with
`BundleVerifier.openStored(content:id:appCode:crypto:)`, then `design.withFallback(builtIn)`;
`confirmTrial` after `BundleLedger.trialMs` without a crash; `crashed()` from the crash handler;
`renderFailed(…)` when a screen of the trial fails (`resolveOrFallback`). Persist the ledger
(Codable). The app code is `major·10000 + minor·100 + patch` (6.14.0 → 61400).

### Settings store and state providers

* `SettingsModel(data:)` — load the stored JSON, save `data` after every change. `$settings` is
  `settings.scope()`.
* State providers build each screen's own variables (`ScreenScope.screens` lists them: `$lock`,
  `$rooms`, `$room` = `ScreenScope.room(…)`, `$msg`, `$call`, `$users`, `$log`, `$composer`,
  `$presets` = `Appearance.presets(…)`, …) and call
  `ScreenScope.scope(screen:app:form:settings:define:account:own:)` (the lock and enrolment
  screens never see `$form`).
* Resources: the app bundle carries `m5/default-design.json` (`Design.fromJSON`),
  `m5/themes.json` (`LookTemplate.list`) and `m5/icons.json` (`IconSet(json:)`).

## The renderer contract (for the SwiftUI layer)

```swift
let ctx = RenderContext(design: design, dark: appearance.isDark(systemDark: colorScheme == .dark),
                        translator: Translator(design: design, lang: lang), settings: settings,
                        templates: templates, form: form, reducedMotion: reduceMotion, animateEnter: isNewScreen)
let root = try ScreenResolver(ctx).resolve(screen: "rooms", scope: scope)   // nil: hidden
```

Resolve again on every state change (it is cheap; ids are stable). Draw each `RenderNode`:

* **Identity** — `id` is unique and stable (design ids on the path, `#i` for repeated copies):
  use it for `ForEach` and for running `enter` once per id.
* **Hidden** nodes are not in the tree (`if` false). `isRepeat` groups hold an `each` node's copies.
* **Layout** (`layout`, in the parent): `width` / `height` are `.fill` (`maxWidth/maxHeight:
  .infinity`), `.wrap` or `.points(x)`; `weight > 0` shares the free space along the parent's axis
  (a custom `Layout`); `crossAlign` (row: vertical, column: horizontal; `.none` = start);
  `frameAlign` in a stack; `margin` already includes the parent's gap (left in a row, top in a
  column) — stacks use `spacing: 0`. Edges are physical (left / right), as on Android.
* **Containers** (`container`): `.vertical`, `.horizontal`, `.overlay` (ZStack), `.flow`
  (wrapping, `flowGap`, `justify`); `justify` start / center / end; "between" / "around" arrive as
  `.flex` children (zero-size, weight 1); `scroll` wraps the stack in a ScrollView (vertical fills
  the viewport).
* **Box** (`box`): `padding`, `fill` (nil = none), `radius` (999 = capsule), `border`, `opacity`,
  `elevation` (shadow), `minHeight`, `press` (`.ripple(color)`, `.scale`, `.system`, `.none`).
* **Text** (`textStyle` on textual elements): size (points, text size applied), weight
  (regular / medium / bold), italic, `FontFamily`, `lines`, `align`, `lineSpacing` 1.1,
  `maxWidth`, `color`, `hintColor` (inputs). `foreground` is the colour icons use too.
* **Content** (`content`): one case per element — see `ELEMENTS.md` for each element's props and
  its SwiftUI mapping. Icons: `Icons.sfSymbol(name)` when the platform has the symbol, else stroke
  `IconSet.shapes(name)` (24 × 24 box, 2 pt round stroke, `fill` shapes filled).
* **Events**: `events["click" | "longClick" | "submit"]` → `runner.fire(event)` (haptic: `.tick`
  for buttons, icon buttons and chips, `.long` for long presses). Bound controls: toggles with
  `commitsOnTap`, selects, sliders (`SliderContent.value(atFraction:)` on release) and segmented
  → `runner.commit(node.binding!, value:)`; inputs → `runner.inputChanged(bind:text:)`.
* **Menus**: `menu.open` → `ScreenResolver(ctx).menu(id, scope:)` → `runner.fire(item)` (red
  when `dangerous`). **Swipe rows**: `SwipeContent.right` / `.left` tiles with `SwipeMath` for
  the drag; `runner.fire(action)`. **Sheets**: `SheetContent.dock` / `dismissOnAction`.
* **Slots** (`.slot(name)`): the app's native parts get the node's `scope`.
* **Failures**: `resolveOrFallback(screen:scope:builtIn:)` shows the built-in design's screen and
  hands back the error for `BundleLedger.renderFailed`.

## Deliberate differences from Android

* `==` on two arrays / objects compares content (Java compares identity; values have none here).
* An SVG path with a stray character ends there (Android loops for ever).
* An argument that fails to evaluate on a tap is logged and ignored (Android would crash).
* `maxWidth` applies to textual elements only — as on Android (a column's `maxWidth` is ignored there too).
