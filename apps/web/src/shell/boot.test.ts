// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { bootKo } from "../../../../packages/i18n/src/catalogs/boot";
import { bootBootstrapKo } from "../../../../packages/i18n/src/catalogs/boot-bootstrap";

// Entry loading/recovery uses bootstrap copy; sign-in and shell copy may await the boot catalog.
const BOOTSTRAP = ["main.tsx", "shell/locale.ts", "lib/react/crash-screen.tsx", "lib/react/support-reference.tsx", "ui/skeleton/skeleton.tsx"];
const BOOT = ["routes/app.ts", "shell/shell.tsx", "shell/nav.ts", "auth/Login.tsx", "auth/SetupPasskey.tsx", "auth/IdleGuard.tsx", "ui/empty-state.tsx", "lib/refusal.ts", "lib/react/command-error.tsx", "lib/react/query-state.tsx", "lib/react/denied.tsx", "lib/react/announce.ts", "reference/authz/api.ts"];

for (const [name, files, catalog] of [["bootstrap", BOOTSTRAP, bootBootstrapKo], ["boot", BOOT, bootKo]] as const) {
  test(`${name} surfaces have translated copy before their catalog boundary`, () => {
    const ids = files.flatMap(f =>
      [...readFileSync(new URL(`../${f}`, import.meta.url), "utf8").matchAll(/(?:\bt\(|hub: |label: )\s*["'`]([^"'`$]+)/g)].map(m => `${f}: ${m[1]}`),
    );
    expect(ids.length).toBeGreaterThan(10);
    // A template id (`shell.locale.${l}`) is checked by its static prefix.
    expect(ids.filter(x => !Object.keys(catalog).some(k => k.startsWith(x.split(": ")[1]!)))).toEqual([]);
  });
}
