// The server's Android design catalogue (elements, props, style props, actions,
// slots, screens, colour tokens, limits, icon names, and which app code each
// release's elements and actions need) as JSON — what ios/M5Kit's M5Design
// target mirrors in ElementCatalog.swift / DesignAction.swift. Run from the
// repository root:
//
//   npx tsx ios/M5Kit/Tests/M5DesignTests/fixtures/dump-catalog.ts > ios/M5Kit/Tests/M5DesignTests/fixtures/catalog.json
//
// CatalogTests (M5DesignTests) read catalog.json to check that the Swift
// catalogue names every element, prop and action the server knows.

import { androidCatalog } from "../../../../../server/android/design";
import { ACTIONS_67, ELEMENTS_67 } from "../../../../../server/android/design-67";
import { ACTIONS_68, ELEMENTS_68 } from "../../../../../server/android/design-68";
import { ACTIONS_610, ELEMENTS_610 } from "../../../../../server/android/design-610";
import { ACTIONS_611, ELEMENTS_611 } from "../../../../../server/android/design-611";
import { ACTIONS_612, ELEMENTS_612 } from "../../../../../server/android/design-612";
import { LOCALES_APP_CODE, MIN_APP_CODE } from "../../../../../server/android/bundle";

const { defaults: _defaults, icons, locales: _locales, ...rest } = androidCatalog();

// server/android/bundle.ts NEEDS: the app code a release's own elements and actions need.
const needs = [
  { code: 61200, elements: ELEMENTS_612.map((e) => e.el), actions: ACTIONS_612.map((a) => a.action) },
  { code: 61100, elements: ELEMENTS_611.map((e) => e.el), actions: ACTIONS_611.map((a) => a.action) },
  { code: 61000, elements: ELEMENTS_610.map((e) => e.el), actions: ACTIONS_610.map((a) => a.action) },
  { code: 60800, elements: ELEMENTS_68.map((e) => e.el), actions: ACTIONS_68.map((a) => a.action) },
  { code: 60700, elements: ELEMENTS_67.map((e) => e.el), actions: ACTIONS_67.map((a) => a.action) },
];

const out = {
  ...rest,
  icons: Object.keys(icons).sort(),
  needs,
  minAppCode: MIN_APP_CODE,
  localesAppCode: LOCALES_APP_CODE,
};
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
