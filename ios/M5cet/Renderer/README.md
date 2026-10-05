# Renderer — vykreslování designu ve SwiftUI (vlna 2)

Port `A/ui/{Renderer, Ui, Icons, SvgPath, SystemBars}`, směrování a skořápky `A/ui/MainActivity` a stylových
pomocníků `A/ui/look/{Buttons, Sheets, Menus, FlowLayout, SendButton}` (`A/` = `android/app/src/main/java/cz/m5cet/app/`).
Model designu, `Expr`, akce, `ActionGuard` a `ScreenResolver` jsou v `M5Kit/M5Design` — Renderer kreslí jeho
`RenderNode` 1:1 a nic z designu nevymýšlí: každý text je z designu (řetězce, překladač); doslovné texty jen v DEBUG.

* Výchozí design je v balíčku aplikace: `Bundle.main.url(forResource: "default-design", withExtension: "json", subdirectory: "m5")`
  (také `icons.json`, `themes.json`) — kopíruje je build fáze „Copy design assets“ z `ios/Design/m5/` (design iOS:
  výchozí design Androidu se vzhledem iOS a položkami jen pro iOS, zapisuje ho `npx tsx script/ios-assets.ts`)
  (`Kit/DesignAssets`).
* `App/RootView.swift` ukazuje `Shell/DesignShell`; každé okno (iPad: více oken) má vlastní `DesignHost` (obrazovka,
  zásobník Zpět, `$form`, overlay) nad sdílenými `DesignServices` (`AppModel.design`: design, nastavení, jazyk, tři kontrakty).

## Co kde je

| Android | Swift |
|---|---|
| `ui/Renderer` (`Bound.create` + `bind`, `params`, `staticStyle`, `dynamicStyle`, `textAppearance`, `wireEvents`, `bindContent`, `animate`) | `Nodes/NodeView` (`NodeView`, `NodeCore`, `NodeContainer`, `EnterModifier`), `Nodes/NodeChrome`, `Nodes/ContentViews`, `Nodes/ControlViews` |
| `LinearLayout`, `FrameLayout`, `ui/look/FlowLayout`, `Renderer.RatioImageView` | `Kit/DesignLayouts` (`DesignLinearLayout`, `DesignFrameLayout`, `DesignFlowLayout`, `DesignRatioLayout`), `DesignImageLayout` |
| `Renderer.AvatarView`, `Renderer.Images` | `DesignAvatar`, `DesignImages` (asset, data:, pevné https bez cookies, 16 MB cache, max 1600 px) |
| `ui/Ui` (barvy, písma, easingy, `reducedMotion`) | `Kit/DesignStyle` (`DesignColor.color`, `DesignFonts`, `Easing.animation`, `DesignTextScale` = Dynamic Type místo sp, `DesignHaptics`) |
| `ui/Icons`, `ui/SvgPath` | `Kit/DesignIcon` (`DesignIcon`: SF Symbol z `Icons.sfSymbol`, jinak geometrie Lucide přes `LucidePath`) |
| `ui/SystemBars` | `DesignShell`: pozadí `@background` pod lištami, obsah v safe area a nad klávesnicí, `preferredColorScheme` |
| `ui/MainActivity` (route, showScreen, onBackPressed, scopeFor, showMenu, flash, copy, share, openUrl, settingChanged) | `Shell/DesignHost` (+ `ActionHost` z M5Design), `Shell/ScreenRouter`, `Shell/DesignShell` |
| `ui/Actions` (část rendereru: screen.open, back, menu.open, sheet.open/close, flash, nfc.workbench/builder, update.later) | `DesignHost.perform`; vše ostatní → `AppActionRouter` |
| `ui/DesignUrls.confirmOpen`, `ui/DesignShare.run` (dialogy) | `DesignShell` `.alert` (adresa / ukázaný text, potvrzení) |
| `ui/look/Sheets` | `Shell/SheetLayer` (karta zdola se scrimem ≤ 560 pt, dok ≤ 440 pt nad skladačem, `dismissOnAction`, tap mimo dok projde dál) |
| `ui/look/Menus` | `Nodes/DesignMenuView` (popover u prvku, ikony, nebezpečné červeně, zaškrtnutí) |
| `ui/look/Buttons.hug` | `DesignButtonLabel` (ikona a text vycentrované spolu) |
| `ui/look/SendButton` | `Parts/DesignSendButton` (pro skladač) |
| prvek `swipe` (`ui/look/SwipeRow` + `Swipe`) | `Nodes/SwipeRowView` (dlaždice, `SwipeMath`, jeden otevřený řádek, akce pro VoiceOver) |
| `ui/parts/Logos`, `SettingsList`, `CallParts.Progress` | `Parts/Logos` (`M5MarkView`, `M5SplashLogo`), `Parts/RendererParts` (`settingsList`, `updateProgress`) |

## Tři kontrakty (pro další agenty — malé a stabilní)

Vše se registruje v `App/Bootstrap.swift` přes `model.design` (`AppModel.design: DesignServices`).

### 1. `SlotRegistry` — nativní části (`slot`)

```swift
@MainActor final class SlotRegistry {
    typealias Factory = @MainActor (SlotContext) -> AnyView
    static let names: [String]                     // 22 názvů slotů formátu (Parts.create)
    func register(_ name: String, _ factory: @escaping Factory)
    func unregister(_ name: String)
    func has(_ name: String) -> Bool
    func view(_ context: SlotContext) -> AnyView   // neregistrovaný slot: prázdné místo (DEBUG: čárkovaný rámeček s názvem)
}

@MainActor struct SlotContext {
    let name: String                               // "messages", "composer", "lockPad"…
    let node: RenderNode                           // prvek slot (id, layout, box, foreground, scope)
    let context: RenderContext                     // design, tón (context.dark), texty, vzhled (look, appearance)
    let horizontalSizeClass: UserInterfaceSizeClass?
    let host: DesignHost                           // okno: navigace, listy, menu, flash, $form, nastavení, runner
    var id: String { get }                         // jedinečné stabilní id (kotva pro host.showMenu)
    var scope: Scope { get }                       // proměnné obrazovky ($room, $msg, $update…)
    var foreground: Color { get }
    func color(_ token: String, _ fallback: DesignColor = .magenta) -> Color
    func t(_ key: String) -> String
    @discardableResult func run(_ action: String, _ value: DesignValue? = nil) -> ActionOutcome   // akce kódu aplikace (ActionGuard platí)
    @discardableResult func fire(_ event: RenderEvent) -> ActionOutcome                       // událost šablony
}
```

Registrované rendererem: `splashLogo`, `logo`, `settingsList`, `updateProgress`. Ostatní (`lockPad`, `enrollForm`,
`joinForm`, `roomList`, `roomTabs`, `messages`, `composer`, `userPanel`, `userList`, `callControls`, `callVideo`,
`msgBody`, `msgHold`, `voicePad`, `nfcPanel`, `nfcWork`, `nfcBuilder`, `aiChat`) registrují části.
Velikost: slot dostane rámec prvku — když ho design určuje (body / match / váha), navrhne se přesně; když `wrap`,
použije se ideální velikost části (dejte jí `.frame(idealWidth:idealHeight:)`, nemá-li vlastní).
Šablony designu uvnitř části (Android `a.renderer().build(tree)`: `rooms.item`, `message.in/out/sys`, `users.item`…)
kreslí `DesignTemplateView(screen: "rooms.item", scope: Scope(["room": item]), animateEnter: false)`.
Kotva menu pro vlastní prvek části: `.designMenuAnchor(id)` + `host.showMenu([MenuEntry], anchor: id)`.
Dok nástrojů se drží nad slotem `composer` (preference `DockAnchorKey` — nic dalšího netřeba).

### 2. `AppActionRouter` — akce aplikace

```swift
@MainActor final class AppActionRouter {
    typealias Handler = @MainActor (DesignAction, ActionContext) -> Void
    func register(_ names: [String], handler: @escaping Handler)    // názvy designu: "room.switch", "message.send"…
    func unregister(_ names: [String])
    func handles(_ name: String) -> Bool
    @discardableResult func dispatch(_ action: DesignAction, context: ActionContext) -> Bool
    func onSettingChanged(_ observer: @escaping @MainActor (String, DesignHost) -> Void)   // MainActivity.settingChanged
    func onLink(_ handler: @escaping @MainActor (DeepLink, DesignHost) -> Bool)          // m5cet://, true = převzato
    func onEnterApp(_ observer: @escaping @MainActor (DesignHost) -> Void)               // MainActivity.enterApp
    var shownUsername: (@MainActor () -> String?)?                                       // profile.public (People)
}

@MainActor struct ActionContext {
    let host: DesignHost          // okno, ze kterého akce přišla
    let source: ActionSource?     // id prvku (kotva menu / popoveru); nil pro akce kódu
}
extension DesignAction { var name: String }   // inverzní k DesignAction.parse
```

`DesignHost.perform` sám dělá: `screen.open`, `back`, `menu.open`, `sheet.open`, `sheet.close`, `flash`,
`nfc.workbench`, `nfc.builder`, `update.later` (zavře kartu a předá dál, je-li handler). `ActionRunner` (M5Design)
už udělal `ActionGuard`, `lib.run`, `set`, `setting.*`, `look.*`, `appearance.reset`, `theme.toggle`, `lang.set`
(→ `DesignHost.languageChanged`, pak i handler `lang.set`, je-li), `nfc.reader`, `call.speaker` (přepne nastavení a předá),
`url.open` / `copy` / `share` (potvrzení). Nepřevzatá akce = řádek v logu (`os.Logger`, subsystém `cz.m5cet.app`,
kategorie `actions`, jen název, nikdy argument) a nic dalšího.

### 3. `ScreenStateProvider` — kde aplikace je a proměnné obrazovek

```swift
@MainActor protocol ScreenStateProvider: AnyObject {
    var routeState: AppRouteState { get }                                               // vstupy MainActivity.route
    func variables(for screen: String, context: ScreenContext) -> [String: DesignValue] // MainActivity.scopeFor (vlastní proměnné)
    var define: DesignValue { get }                                                     // $define
    var account: DesignValue { get }                                                    // $account
}
struct AppRouteState { var enrolled, lockSetUp, locked, hasActiveRoom, wipedNotice: Bool }
struct ScreenContext { var wide: Bool; var regularWidth: Bool; var lang: String }
```

Implementaci udělejte `@Observable`: renderer obrazovku přeloží znovu, kdykoli se změní něco, co přečetl
v `routeState` / `variables`. Jinak volejte `host.refresh()` (nová data) nebo `host.route()` (změnil se zámek).
Společné proměnné (`$app`, `$form` — kromě `lock` a `enroll`, `$settings`, `$define`, `$account`) přidává renderer
(`ScreenScope.scope`); k `$lock` přidá `wide` (okno je širší než vyšší), pro `settings.appearance` `$presets`, chybí-li.
Do integrace běží `UnconfiguredScreenState` (nezapsáno → obrazovka zápisu). `SampleScreenState` (jen DEBUG) má
ukázková data konzole (`Debug/SampleScreenData` — generováno z `ios/M5Kit/Tests/M5DesignTests/fixtures/catalog.json`,
test hlídá shodu).

### API okna (`DesignHost`) pro části a handlery

`showScreen(_:transition:)`, `back()`, `route()`, `start()`, `resumed()`, `reshow()` (goRoom na obrazovce místnosti,
nový design), `refresh()`, `flash(title:text:level:)` / `showFlash`, `showSheet(_:)` (join, update — `offerUpdate`),
`closeOverlay()`, `showMenu(_:anchor:)`, `showDesignMenu(_:anchor:)`, `forgetUi()` (6.12 F-16: po zamčení; pak `route()`),
`scope(for:)`, `form`, `settings`, `userSetSetting(_:_:)` (vlastní ťuknutí uživatele, i soukromý klíč),
`runner` (`ActionRunner`), `screen`, `isDark`. Sdílené: `services.setDesign(_:)` (aktivní balíček),
`services.onRenderFailure` (`BundleLedger.renderFailed`), `services.setLang(_:)`.

## Rozvržení (jako Android)

`DesignLayouts` měří jako `LinearLayout` / `FrameLayout` / `FlowLayout`: MATCH_PARENT / WRAP_CONTENT / dp, váhy
dělí volné místo (v obalujícím boxu jejich vlastní velikosti), gravitace na obou osách, okraje s mezerou rodiče,
jednotná šířka match_parent dětí v obalujícím sloupci. Protokol návrhů: `nil` = „jak velký bys byl“ (WRAP), konečné
číslo = „jsi takhle velký“ (EXACTLY) — každý uzel vyplní konečný návrh (listy ve flexibilním rámci). Kontejnery
ořezávají obsah na svůj rámeček (`clipChildren` / `clipToPadding`), vertikální scroll vyplní výšku (`setFillViewport`).
iPhone: na výšku i na šířku. iPad: všechny orientace, Split View, Stage Manager, více oken; Android na velkém
displeji (Fold rozložený) kreslí tutéž jednu obrazovku, takže na regular šířce je obrazovka vystředěná v čitelné šířce
900 pt (listy ≤ 560 pt, menu ≤ 320 pt); `$lock.wide` podle okna. Text: velikosti designu × Dynamic Type (jako sp,
nejvýš 2×). Tmavý / světlý tón (šablona s jedním tónem, volba uživatele, jinak systém), Reduce Motion (žádné
vstupní animace ani přechody), VoiceOver (id uzlu = `accessibilityIdentifier`, popisky ikonových tlačítek,
akce swipe řádku, nadpisy).

## Záměrné rozdíly proti Androidu

* **Opakovaná skupina (`each`) je velká jako její kopie.** Android dá krabici skupiny pevnou šířku/výšku šablony
  (`Bound.params` uzlu s `each`) a ořízne všechny kopie kromě první — v Nastavení › Vzhled byla vidět jediná šablona
  a jediná barva. Náhled v konzoli i formát kreslí prvek pro každou položku. Okraje, váha a zarovnání zůstávají.
  (Pravděpodobná chyba Androidu — k opravě tam.)
* Zpět = gesto od levého okraje (`UIScreenEdgePanGestureRecognizer`) a tlačítka designu; „opustit aplikaci“
  (zásobník prázdný, zámek, zápis) nedělá nic.
* `lang.set` a `theme.toggle` platí hned na místě (Android restartuje aktivitu).
* `copy` jde do schránky jen tohoto zařízení (`localOnly`, ne Universal Clipboard) — Android ji označí jako citlivou.
* Odkazy v textu (`links`) otevírá systém jako Linkify; obrázky https bez cookies a diskové cache.

## DEBUG: ukázkový režim a snímky

Argumenty spuštění (jen DEBUG, v Release nejsou): `-M5Screen <id>` (obrazovka s ukázkovými daty, bez splash a route;
seznam místností a zprávy se kreslí šablonami designu, dokud nejsou části), `-M5Dark YES|NO`, `-M5Sheet <id>`,
`-M5Flash <text>`, `-M5Menu <menu>@<id uzlu>`, `-M5Landscape YES` (iPhone; iPad s multitaskingem žádost ignoruje).

```sh
xcrun simctl launch <udid> cz.m5cet.app -M5Screen rooms -M5Dark YES
xcrun simctl io <udid> screenshot rooms.png
```

Snímky: `ios/docs/screenshots/renderer/`. iPad na šířku: `simctl` neumí otočit simulátor bez okna a `XCUIDevice`
potřebuje cíl UI testů, proto je kreslí test `RendererScreenshotTests` (stejný `DesignShell` v okně 1376 × 1032 pt,
regular šířka): `TEST_RUNNER_M5_SHOTS_DIR=<dir> xcodebuild … test -only-testing:M5cetTests/RendererScreenshotTests`.

## Testy

`ios/M5cetTests/Renderer*.swift`: kontrakty (registr, router, provider, ukázková data = katalog), směrování
(route, zásobník Zpět, přechody, menu s kotvou, listy, dok, flash, potvrzení url / copy, jazyk a tón na místě,
uložení nastavení), každá obrazovka designu se vykreslí (iPhone i iPad, světle i tmavě, i listy a flash) a rozvržení
měří jako Android (sloupec, řádek, flow, stack, váhy, zalamování textu).

## Ještě není (vlna 2, jiní agenti)

Části slotů kromě čtyř výše; skutečný stav aplikace (provider), zámek / zápis / místnosti / hovory / NFC jako handlery
akcí; `BundleLedger` (balíčky designu); ochrana obrazovky (Platform/Security).
