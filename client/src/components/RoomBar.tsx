// The room bar (6.0): the rooms kept connected at once. The layout
// ("room.bar", lib/layouts/roombar.ts) is the operator's to redesign; the
// choosing and the form stay here. App.tsx does the switching (the room on
// screen and lib/room-hub.ts for the others).

import { useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import type { Lang } from "../lib/i18n";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";

export type RoomBarItem = { key: string; label: string; users: number; unread: number; active: boolean; status: string };

export type RoomBarProps = {
  lang: Lang;
  rooms: RoomBarItem[];
  canAdd: boolean;
  onSwitch: (key: string) => void;
  onClose: (key: string) => void;
  onAdd: (room: string, passphrase: string) => void;
  /** Starts with the form open (the Layout builder's preview). */
  adding?: boolean;
};

export function RoomBar({ lang, rooms, canAdd, onSwitch, onClose, onAdd, adding: startAdding = false }: RoomBarProps) {
  const { tree, base } = useLayoutBase("room.bar", lang);
  const [adding, setAdding] = useState(startAdding);
  const [fields, setFields] = useState({ room: "", passphrase: "" });
  const unreadTotal = rooms.reduce((n, r) => n + (r.active ? 0 : r.unread), 0);
  return renderLayout(tree, {
    ...base,
    data: { rooms, adding, fields, canAdd, unreadTotal },
    actions: {
      switchRoom: (_e, key) => onSwitch(String(key)),
      closeRoom: (_e, key) => onClose(String(key)),
      addOpen: () => setAdding(true),
      addCancel: () => { setAdding(false); setFields({ room: "", passphrase: "" }); },
      addSubmit: (event) => {
        (event as FormEvent).preventDefault();
        const room = fields.room.trim();
        if (!room || !fields.passphrase) return;
        onAdd(room, fields.passphrase);
        setAdding(false);
        setFields({ room: "", passphrase: "" });
      },
      fieldRoom: (event) => { const v = (event as ChangeEvent<HTMLInputElement>).target.value; setFields((f) => ({ ...f, room: v })); },
      fieldKey: (event) => { const v = (event as ChangeEvent<HTMLInputElement>).target.value; setFields((f) => ({ ...f, passphrase: v })); },
      // Left / right move between the rooms' buttons (WAI-ARIA tabs).
      barKey: (event) => {
        const e = event as KeyboardEvent<HTMLElement>;
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const buttons = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("[data-testid=rb-switch]")];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0) return;
        e.preventDefault();
        buttons[(at + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      },
    },
  });
}
