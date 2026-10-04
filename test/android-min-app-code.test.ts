// @vitest-environment node
// 6.7 — two version gates found by the docs cross-check:
//  * a build whose design uses a 6.7 element or action (the rooms' `swipe`
//    rows, the profile's actions …) needs the 6.7 app: an older app draws an
//    unknown element as nothing, so it keeps the build it has instead;
//  * the Functions sandbox's permission flag is `--permission` only from
//    Node 22.13 / 23.5 — older 22.x still need `--experimental-permission`.

import { describe, it, expect } from "vitest";
import { DEFAULT_DESIGN, type AndroidDesign, type ANode } from "../server/android/design";
import { designMinAppCode, MIN_APP_CODE } from "../server/android/bundle";
import { ACTIONS_67, ELEMENTS_67 } from "../server/android/design-67";
import { permissionFlag } from "../server/functions/sandbox/pool";

const withRoot = (root: ANode): AndroidDesign => ({ ...DEFAULT_DESIGN, screens: { rooms: root }, menus: {} });
const plain: ANode = { id: "root", el: "column", children: [{ id: "t", el: "text", text: "hi", on: { click: { action: "back" } } }] };

describe("designMinAppCode", () => {
  it("a design with only older elements and actions runs on any supported app", () => {
    expect(designMinAppCode(withRoot(plain))).toBe(MIN_APP_CODE);
  });

  it("a 6.7 element needs the 6.7 app", () => {
    expect(ELEMENTS_67.map((e) => e.el)).toContain("swipe");
    expect(designMinAppCode(withRoot({ ...plain, children: [{ id: "row", el: "swipe", props: { menu: "rooms.swipe" } }] }))).toBe(60700);
  });

  it("a 6.7 action needs the 6.7 app", () => {
    const action = ACTIONS_67[0].action;
    expect(designMinAppCode(withRoot({ ...plain, on: { click: { action } } }))).toBe(60700);
  });

  it("the default design (which uses the 6.7 rows) needs the 6.7 app", () => {
    expect(designMinAppCode(DEFAULT_DESIGN)).toBe(60700);
  });
});

describe("permissionFlag", () => {
  it.each([
    ["22.0.0", "--experimental-permission"],
    ["22.12.0", "--experimental-permission"],
    ["23.4.1", "--experimental-permission"],
    ["22.13.0", "--permission"],
    ["22.20.1", "--permission"],
    ["23.5.0", "--permission"],
    ["24.0.0", "--permission"],
  ])("Node %s → %s", (version, flag) => {
    expect(permissionFlag(version)).toBe(flag);
  });

  it("the running Node's flag is the one the sandbox uses", () => {
    expect(["--permission", "--experimental-permission"]).toContain(permissionFlag());
  });
});
