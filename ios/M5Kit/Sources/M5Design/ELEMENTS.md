# M5Design elements

Generated from `Sources/M5Design/ElementCatalog.swift` (`ElementCatalog.markdown()`; `CatalogTests` fails when this file
is out of step — run the tests with `M5_WRITE_ELEMENTS_MD=1` to write it again). The format is the Android design's
(`server/android/design.ts` ELEMENTS); `ScreenResolver` turns a tree into `RenderNode`s whose `content`, `box`,
`layout`, `container` and `textStyle` carry everything below already resolved.

| Element | Group | Children | Text | Since |
|---|---|---|---|---|
| `column` | layout | yes | — | 60000 |
| `row` | layout | yes | — | 60000 |
| `stack` | layout | yes | — | 60000 |
| `scroll` | layout | yes | — | 60000 |
| `card` | layout | yes | — | 60000 |
| `text` | content | — | template | 60000 |
| `icon` | content | — | — | 60000 |
| `image` | content | — | — | 60000 |
| `avatar` | content | — | — | 60000 |
| `badge` | content | — | template | 60000 |
| `chip` | content | — | template | 60000 |
| `divider` | content | — | — | 60000 |
| `spacer` | content | — | — | 60000 |
| `progress` | content | — | — | 60000 |
| `button` | controls | — | template | 60000 |
| `iconButton` | controls | — | — | 60000 |
| `input` | controls | — | — | 60000 |
| `switch` | controls | — | template | 60000 |
| `checkbox` | controls | — | template | 60000 |
| `select` | controls | — | — | 60100 |
| `slider` | controls | — | — | 60100 |
| `segmented` | controls | — | — | 60100 |
| `sheet` | layout | yes | — | 60200 |
| `swipe` | layout | yes | — | 60700 |
| `slot` | logic | — | — | 60000 |

## `column` — Column

Children one under another.

Props: none.

SwiftUI: VStack(spacing: 0) — children carry their margins (the gap is in them); justify start/center/end aligns the content; between/around come as `.flex` children.

## `row` — Row

Children side by side.

| Prop | Kind | Meaning |
|---|---|---|
| `wrap` | bool | Wrap to the next line |

SwiftUI: HStack(spacing: 0); with wrap = true a flow Layout (gap between items and lines, justify start/center/end).

## `stack` — Stack

Children on top of each other (the last one on top).

Props: none.

SwiftUI: ZStack — children fill it by default; `self` aligns a child (start = top-leading, center, end = bottom-trailing).

## `scroll` — Scroll

Scrolls its one child.

| Prop | Kind | Meaning |
|---|---|---|
| `horizontal` | bool | Horizontal |

SwiftUI: ScrollView(.vertical or .horizontal) around a VStack / HStack(spacing: 0); vertical fills the viewport.

## `card` — Card

A raised surface with rounded corners.

Props: none.

SwiftUI: VStack(spacing: 0) on a RoundedRectangle(box.radius) filled with box.fill and a shadow of box.elevation.

## `text` — Text

A text template: {$var}, {_'key'}, {=expression}.

| Prop | Kind | Meaning |
|---|---|---|
| `variant` | select | Style (body, title, headline, display, caption, label, mono) |
| `align` | select | Alignment (start, center, end) |
| `links` | bool | Clickable links |

SwiftUI: Text(content.text) with textStyle (size × fontScale, weight, italic, family, lineLimit, alignment); links = true → AttributedString with detected URLs / e-mails; an icon before it.

## `icon` — Icon

A lucide icon, drawn natively.

| Prop | Kind | Meaning |
|---|---|---|
| `icon` | icon | Icon |
| `size` | number | Size (dp) |
| `color` | color | Colour |

SwiftUI: Image(systemName: Icons.sfSymbol(name)) sized to `size`, or the Lucide geometry (IconSet) stroked 2 pt round in a 24×24 box; tinted with `color`.

## `image` — Image

A picture.

| Prop | Kind | Meaning |
|---|---|---|
| `src` | image | Image — asset:<name> from the design's assets, or a fixed https URL on a host in ANDROID_DESIGN_IMAGE_HOSTS (never computed: 6.7, F-01) |
| `fit` | select | Fit (cover, contain, center) |
| `ratio` | number | Width / height |

SwiftUI: Image from content.source (.asset bytes, .data bytes, .remote https URL loaded by the app); cover → scaledToFill + clipped, contain → scaledToFit, center → natural size; ratio > 0 → aspectRatio(ratio).

## `avatar` — Avatar

A round badge with initials.

| Prop | Kind | Meaning |
|---|---|---|
| `name` | text | Name (initials, colour) |
| `size` | number | Size (dp) |

SwiftUI: Circle filled with content.color, the initials in white, bold, 40 % of the size.

## `badge` — Badge

A small pill with a number or a word.

| Prop | Kind | Meaning |
|---|---|---|
| `icon` | icon | Icon |
| `color` | color | Colour |

SwiftUI: Text in a Capsule filled with box.fill (padding 2 × 7 by default), a 12 pt icon before it.

## `chip` — Chip

A compact choice.

| Prop | Kind | Meaning |
|---|---|---|
| `icon` | icon | Icon |
| `selected` | expr | Selected |

SwiftUI: Text in a RoundedRectangle(box.radius) with box.border (primary when selected) and box.fill; tappable when it has a click event.

## `divider` — Divider

A thin line.

Props: none.

SwiftUI: Rectangle filled with box.fill: 1 pt high in a column, 1 pt wide in a row (layout gives the sizes).

## `spacer` — Spacer

Empty space.

| Prop | Kind | Meaning |
|---|---|---|
| `size` | number | Size (dp); empty = fill |

SwiftUI: Spacer(minLength: 0) with weight 1 when it has no size; else a clear frame of size × size. A fill shows when box.fill is set.

## `progress` — Progress

A progress bar.

| Prop | Kind | Meaning |
|---|---|---|
| `value` | expr | Value 0–1 (empty = spinning) |

SwiftUI: ProgressView(value:) linear when content.value is set, else a circular spinner; tint primary.

## `button` — Button

A button; its action is in Events.

| Prop | Kind | Meaning |
|---|---|---|
| `icon` | icon | Icon |
| `variant` | select | Variant (primary, tonal, secondary, text, danger) |
| `disabled` | expr | Disabled when |

SwiftUI: Button with label HStack(icon 18 pt + 8 pt + Text), centred together; box.fill / border / radius from the variant and the user's button style; min height 44; disabled → 0.5 opacity, no taps; press style ripple / scale / none.

## `iconButton` — Icon button

A round button with an icon.

| Prop | Kind | Meaning |
|---|---|---|
| `icon` | icon | Icon |
| `label` | text | Accessible label |
| `variant` | select | Variant (primary, tonal, secondary, text, danger) |
| `badge` | expr | Badge number |

SwiftUI: Button 44 × 44 with a 22 pt icon in content.iconColor on content.shape; accessibilityLabel = label (also a help tooltip); a 16 pt badge at the top trailing corner.

## `input` — Input

A text field; Enter runs its submit action.

| Prop | Kind | Meaning |
|---|---|---|
| `bind` | text | Value name — Stored under $form.<name> |
| `hint` | text | Hint |
| `type` | select | Type (text, password, number, email, phone, multiline, url) |

SwiftUI: TextField / SecureField (password) / TextField(axis: .vertical) (multiline) with the keyboard of the type; its text is $form[bind] (write every change back through the runner's form); submit → the submit event.

## `switch` — Switch

An on/off switch: bound to a setting it changes it itself, else its click action does.

| Prop | Kind | Meaning |
|---|---|---|
| `checked` | expr | On when |
| `setting` | text | Setting — e.g. voice.autoplay — the switch changes it itself |
| `bind` | text | Or a form value |

SwiftUI: Toggle(text, isOn:) tinted primary; a change → ActionRunner.commit(node, .bool(on)) when it is bound (setting / bind) and has no click event, else the click event.

## `checkbox` — Checkbox

A checkbox (e.g. selecting rooms).

| Prop | Kind | Meaning |
|---|---|---|
| `checked` | expr | Checked when |
| `setting` | text | Setting — e.g. voice.autoplay — the switch changes it itself |
| `bind` | text | Or a form value |

SwiftUI: Toggle with a checkbox style (square checkmark) — same rules as the switch.

## `select` — Select

A drop-down choice; its change event follows the new value ($value).

| Prop | Kind | Meaning |
|---|---|---|
| `setting` | text | Setting — e.g. voice.lang — read and changed by the element |
| `bind` | text | Or a form value |
| `options` | text | Options — value:Label\|value2:{_'key'} or =$list (values or {value, label}) |
| `hint` | text | Hint |

SwiftUI: Menu (or Picker .menu) showing content.label with a chevron-down; the current option checked; a pick → ActionRunner.commit(node, .string(value)).

## `slider` — Slider

A number on a track (rate, pitch, size…).

| Prop | Kind | Meaning |
|---|---|---|
| `setting` | text | Setting |
| `bind` | text | Or a form value |
| `min` | number | Minimum |
| `max` | number | Maximum |
| `step` | number | Step |

SwiftUI: Slider(value: fraction 0…1) tinted primary; on release → ActionRunner.commit(node, .number(content.value(atFraction:))).

## `segmented` — Segmented

A few choices side by side (tone, density…).

| Prop | Kind | Meaning |
|---|---|---|
| `setting` | text | Setting |
| `bind` | text | Or a form value |
| `options` | text | Options — value:Label\|… |

SwiftUI: HStack of equal-width segments (min height 38) on box.fill (surfaceVariant) with radius content.outerRadius; the chosen one on content.selectedFill (radius content.innerRadius); a tap → commit.

## `sheet` — Sheet / dock

The root of a sheet or the Tools dock — a column.

| Prop | Kind | Meaning |
|---|---|---|
| `present` | select | Shown as (sheet, dock) |
| `dismissOnAction` | expr | Close before an action |

SwiftUI: The root of .sheet / a dock overlay: a VStack; content.present sheet → presentationDetents from the bottom over a scrim, dock → a floating card above the composer (a tap outside closes it); dismissOnAction → close before running an action.

## `swipe` — Swipe row

A row that slides sideways to its menus' actions.

| Prop | Kind | Meaning |
|---|---|---|
| `right` | text | Menu revealed by a drag to the right |
| `left` | text | Menu revealed by a drag to the left |
| `rightColor` | color | Colour of the right menu's edge action |
| `leftColor` | color | Colour of the left menu's edge action |

SwiftUI: The children in a VStack on @surface, dragged sideways (SwipeMath: claims / clamp / settle / progress) over the tiles of content.swipe.right (left edge) and .left (right edge); the edge tile filled with the side's colour, the others tonal.

## `slot` — App part

A native component of the app (message list, composer…).

| Prop | Kind | Meaning |
|---|---|---|
| `name` | slot | Part |

SwiftUI: The app's native part for content.slot (messages, composer, roomList, lockPad…) with the node's scope.

## Style props (every element)

| Prop | Meaning | Values |
|---|---|---|
| `padding` | Padding | dp: 12 or "8 16" or "8 16 8 16" |
| `margin` | Margin | dp, same forms as padding |
| `gap` | Gap | dp between children |
| `width` | Width | match, wrap or dp |
| `height` | Height | match, wrap or dp |
| `maxWidth` | Max width | dp |
| `weight` | Weight | share of the free space in a row/column |
| `align` | Align children | start, center, end, stretch |
| `justify` | Justify children | start, center, end, between, around |
| `self` | Align self | start, center, end, stretch |
| `bg` | Background | @token or #rrggbb (#aarrggbb) |
| `fg` | Text colour | @token or #rrggbb |
| `radius` | Corner radius | dp |
| `border` | Border | "1 @border" (width colour) |
| `elevation` | Elevation | dp of shadow |
| `size` | Text size | sp |
| `bold` | Bold | true / false |
| `italic` | Italic | true / false |
| `font` | Font | sans, serif, mono |
| `lines` | Max lines | number |
| `opacity` | Opacity | 0–1 |

A string starting with `=` is an expression (bg, fg, border, opacity…). Padding, margin and gap are multiplied by the density (compact 0.8, comfortable 1.2); text sizes by the font scale.

## Colour tokens

`@primary` · `@onPrimary` · `@background` · `@surface` · `@surfaceVariant` · `@onSurface` · `@muted` · `@accent` · `@border` · `@danger` · `@success` · `@warning` · `@bubbleIn` · `@onBubbleIn` · `@bubbleOut` · `@onBubbleOut` · `@scrim`

## Events

`click` · `longClick` · `submit` · `change` — each `{ action, arg? }`; `change` sees the new value as `$value`.

## Enter animations

`none` · `fade` · `slide-up` · `slide-down` · `slide-left` · `slide-right` · `scale` · `pop`; easings `standard` · `decelerate` · `accelerate` · `linear` · `overshoot` · `bounce`.

## App parts (`slot`)

| Name | Screens |
|---|---|
| `splashLogo` | splash |
| `logo` | lock, enroll, about, rooms |
| `lockPad` | lock |
| `enrollForm` | enroll |
| `roomList` | rooms |
| `roomTabs` | room |
| `messages` | room |
| `composer` | room |
| `userPanel` | room |
| `userList` | users |
| `callControls` | call |
| `callVideo` | call |
| `settingsList` | settings |
| `joinForm` | join |
| `updateProgress` | update |
| `msgBody` | message.in, message.out |
| `aiChat` | ai |
| `voicePad` | voice |
| `nfcPanel` | nfc |
| `nfcWork` | nfc |
| `nfcBuilder` | nfc.builder |
| `msgHold` | message.in, message.out |

## Limits (server sanitizer)

nodes 1500 · depth 30 · text 4000 · strings 3000 per language · libraries 60 · steps 60 · menu items 40 · asset 512 kB · assets 2 MB. The app: expressions ≤ 400 characters nested ≤ 40, `each` ≤ 200 items, options ≤ 100, library steps ≤ 60 and no nested `lib.run`, swipe ≤ 4 actions a side.
