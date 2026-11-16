// SPDX-License-Identifier: LicenseRef-Proprietary
/**
 * Every keyboard shortcut in one table, matched one way. Letters and digits match the physical key (`code`), because
 * a Korean input mode changes `key` ("j" arrives as a Hangul vowel); other keys match the character, so "?" follows
 * the keyboard's layout. `Mod` is ⌘ or Ctrl. Shift counts for letters, digits and named keys, never for a shifted
 * character.
 */
export type KeyEventLike = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

type Binding = {
  /** Chords such as "j", "1", "?", "Mod+k", "Mod+Shift+Enter". */
  keys: readonly string[];
  /** `page`: anywhere on the screen while no dialog is open. `region`: only while focus is inside the caller's element. */
  scope: "page" | "region";
  /** Also while typing in a field; otherwise a field keeps its own keys. */
  inField?: true;
  /** A page key that also works while a dialog is open. */
  inDialog?: true;
};

const DIGITS = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));

/** Ids are `<screen>.<command>`; a screen's ids never share a chord. */
export const KEYMAP = {
  "card.next": { keys: ["j"], scope: "page" },
  "card.prev": { keys: ["k"], scope: "page" },
  "card.history": { keys: ["h"], scope: "page" },
  "card.section": { keys: DIGITS(8), scope: "page" },
  "unplaced.next": { keys: ["j"], scope: "page" },
  "unplaced.prev": { keys: ["k"], scope: "page" },
  "unplaced.place": { keys: DIGITS(5), scope: "page" },
  // Shadows the shell's ⌘K on the people screens, dialogs included, so the shell never opens a second palette.
  "people.find": { keys: ["Mod+k", "Mod+Shift+k"], scope: "page", inField: true, inDialog: true },
  "people.keys": { keys: ["?"], scope: "page" },
  "quick.undo": { keys: ["Mod+z"], scope: "page", inDialog: true },
  "structure.keys": { keys: ["?"], scope: "page" },
  "registerRun.next": { keys: ["Mod+Enter"], scope: "page", inField: true, inDialog: true },
  "registerRun.finish": { keys: ["Mod+Shift+Enter"], scope: "page", inField: true, inDialog: true },
  "registerSheet.save": { keys: ["Mod+Shift+Enter"], scope: "region", inField: true },
} as const satisfies Record<string, Binding>;

export type KeyId = keyof typeof KEYMAP;

const physical = (key: string) => /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : null;

/** Whether the event is the chord. */
export function matches(e: KeyEventLike, chord: string) {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const code = physical(key);
  if (e.metaKey || e.ctrlKey) { if (!parts.includes("Mod")) return false; } else if (parts.includes("Mod")) return false;
  if (e.altKey) return false;
  // A shifted character ("?") carries its shift in the character itself.
  if ((code || key.length > 1) && e.shiftKey !== parts.includes("Shift")) return false;
  // A digit also matches its character, so the number pad keeps working.
  return code ? e.code === code || (/^[0-9]$/.test(key) && e.key === key) : e.key === key;
}

type KeyContext = { typing: boolean; dialog: boolean; inRegion: boolean };

/** The first of `ids` whose chord the event is and whose scope allows it here, with the chord it matched. */
export function pick(e: KeyEventLike, ids: readonly KeyId[], at: KeyContext) {
  for (const id of ids) {
    const b: Binding = KEYMAP[id];
    if (at.typing && !b.inField) continue;
    if (b.scope === "page" ? at.dialog && !b.inDialog : !at.inRegion) continue;
    const chord = b.keys.find(k => matches(e, k));
    if (chord) return { id, chord };
  }
  return null;
}

/** Pairs of ids on one screen that share a chord. */
export function conflicts(map: Record<string, { keys: readonly string[] }>) {
  const seen = new Map<string, string>();
  const found: string[] = [];
  for (const [id, b] of Object.entries(map)) for (const k of b.keys) {
    const at = `${id.split(".")[0]} ${k}`;
    const other = seen.get(at);
    if (other) found.push(`${other} and ${id} both use ${k}`);
    else seen.set(at, id);
  }
  return found;
}
