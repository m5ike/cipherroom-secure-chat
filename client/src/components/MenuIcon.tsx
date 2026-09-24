// An icon of the menu's catalog (lib/menu-icons-data.ts) by name, drawn by
// lucide's own <Icon> — the same SVG, classes and stroke as the named
// components (so the templates' icon styles apply unchanged).

import { memo } from "react";
import { Icon } from "lucide-react";
import { MENU_ICON_ALIASES, MENU_ICONS } from "../lib/menu-icons-data";

type IconNode = Parameters<typeof Icon>[0]["iconNode"];

export const MenuIcon = memo(function MenuIcon({ name, className }: { name: string; className?: string }) {
  const known = MENU_ICONS[name] ? name : "circle-alert";
  const icon = { name: known, node: MENU_ICONS[known] as unknown as NonNullable<IconNode>, size: 24, aliases: MENU_ICON_ALIASES[known] ?? [] };
  return <Icon icon={icon as never} className={className} aria-hidden="true" />;
});
