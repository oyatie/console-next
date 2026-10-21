// The one key registry of the people screens (spec §3, R27): the key map overlay is generated from it, and it lists
// only keys that work today. Copy ids: peopleJump.keys.<id>; groups: peopleJump.keys.group.<id>.

export type KeyEntry = { id: string; keys: string[] };
export const KEY_GROUPS: { id: string; keys: KeyEntry[] }[] = [
  {
    id: "roster",
    keys: [
      { id: "move", keys: ["J", "K"] },
      { id: "select", keys: ["Space"] },
      { id: "find", keys: ["/"] },
      { id: "peek", keys: ["Enter"] },
      { id: "open", keys: ["O"] },
    ],
  },
  {
    id: "card",
    keys: [
      { id: "section", keys: ["1–8"] },
      { id: "history", keys: ["H"] },
      { id: "walk", keys: ["J", "K"] },
      { id: "quick", keys: ["Enter", "Esc"] },
      { id: "undo", keys: ["⌘Z"] },
    ],
  },
  {
    id: "sheet",
    keys: [
      { id: "pick", keys: ["↑", "↓", "Space"] },
      { id: "close", keys: ["Esc"] },
    ],
  },
  {
    id: "anywhere",
    keys: [
      { id: "jump", keys: ["⌘K"] },
      { id: "help", keys: ["?"] },
    ],
  },
];
