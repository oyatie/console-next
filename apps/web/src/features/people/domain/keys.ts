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
      { id: "help", keys: ["?", "⌘/"] },
    ],
  },
];

/**
 * The numbers of the sections a person's full record shows: the restricted one only while its disability or veteran
 * switch is on, documents only where they are served. A section keeps its number when another is not shown, so the
 * number in its head, the key cap on its link and the digit that opens it are one number, and a digit that is not
 * listed opens nothing.
 */
export const cardSections = (switches: readonly { section: string; enabled: boolean }[] | undefined, documents: boolean) =>
  [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => (n !== 7 || switches?.some((x) => (x.section === "DISABILITY" || x.section === "VETERAN") && x.enabled)) && (n !== 8 || documents));
