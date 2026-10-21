import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { bootKo } from "../../../../packages/i18n/src/catalogs/boot";

// The sign-in screen and the shell render before any screen catalog loads: every id they use must
// be boot copy (packages/i18n/src/catalogs/boot.ts), or it would show as a raw id.
const ENTRY = ["main.tsx", "routes/app.ts", "shell/shell.tsx", "shell/nav.ts", "shell/locale.ts", "auth/Login.tsx", "ui/empty-state.tsx", "lib/refusal.ts", "lib/react/command-error.tsx", "lib/react/query-state.tsx", "lib/react/denied.tsx", "lib/react/announce.ts", "reference/authz/api.ts"];

test("the entry's copy is all boot copy", () => {
  const ids = ENTRY.flatMap((f) =>
    [...readFileSync(new URL(`../${f}`, import.meta.url), "utf8").matchAll(/(?:\bt\(|hub: |label: )\s*["'`]([^"'`$]+)/g)].map((m) => `${f}: ${m[1]}`),
  );
  expect(ids.length).toBeGreaterThan(40);
  // A template id (`shell.locale.${l}`) is checked by its static prefix.
  expect(ids.filter((x) => !Object.keys(bootKo).some((k) => k.startsWith(x.split(": ")[1]!)))).toEqual([]);
});
