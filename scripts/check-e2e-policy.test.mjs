// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkE2ePolicy } from "./check-e2e-policy.mjs";

const fixture = (files) => {
  const root = mkdtempSync(path.join(tmpdir(), "e2e-policy-"));
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
  return root;
};

test("the repository enforces focus, fixme ownership and catalog isolation", () => {
  const root = process.env.CONSOLE_TEST_ROOT ?? path.resolve(import.meta.dirname, "..");
  assert.deepEqual(checkE2ePolicy(root, "2026-11-03"), []);
});

test("locale setters require the locale fixture's test import", () => {
  const root = fixture({
    "e2e/states/missing.spec.ts": "import { test } from '@playwright/test';\ni18n.set('en');",
    "e2e/states/comment.spec.ts": "// import { test } from '../locale-fixture';\ni18n.set('en');",
    "e2e/states/other.spec.ts": "import { expect } from '../locale-fixture';\ni18n.set('en');",
    "e2e/states/type.spec.ts": "import type { test } from '../locale-fixture';\ni18n.set('en');",
    "e2e/states/wrong.spec.ts": "import { test } from './locale-fixture';\ni18n.set('en');",
  });
  assert.deepEqual(checkE2ePolicy(root), ["comment", "missing", "other", "type", "wrong"].map(name =>
    `e2e/states/${name}.spec.ts:2: i18n.set requires test from e2e/locale-fixture.ts`));
});

test("fixture imports work at different depths and comments do not count as locale setters", () => {
  const root = fixture({
    "e2e/root.spec.ts": "import { test } from './locale-fixture';\ni18n.set('en');",
    "e2e/states/guarded.spec.ts": "import {\n test as catalogTest\n} from '../locale-fixture';\ni18n.set('en');",
    "e2e/states/comment.spec.ts": "// i18n.set('en');",
    "e2e/helper.ts": "i18n.set('en');",
  });
  assert.deepEqual(checkE2ePolicy(root), []);
});

test("missing and expired fixme metadata fail with the source location", () => {
  const root = fixture({
    "playwright.config.ts": "export default { forbidOnly: !!process.env.CI };\n",
    "e2e/a.spec.ts": [
      "test.fixme('missing', async () => {});",
      "// fixme: owner=@owner; reason=waiting for the API; expires=2026-11-03",
      "test.fixme('expired', async () => {});",
    ].join("\n"),
  });
  assert.deepEqual(checkE2ePolicy(root, "2026-11-03"), [
    "e2e/a.spec.ts:1: test.fixme needs an immediately preceding owner, reason and expiry",
    "e2e/a.spec.ts:3: test.fixme owned by @owner expired on 2026-11-03",
  ]);
});

test("an unguarded Playwright config fails", () => {
  const root = fixture({ "e2e/focus.config.ts": "import { defineConfig } from '@playwright/test';\nexport default defineConfig({});\n" });
  assert.deepEqual(checkE2ePolicy(root, "2026-11-03"), [
    "e2e/focus.config.ts: missing forbidOnly",
  ]);
});

test("blank fixme owners and reasons fail", () => {
  const root = fixture({
    "e2e/a.spec.ts": [
      "// fixme: owner=   ; reason=waiting for the API; expires=2026-11-04",
      "test.fixme('owner', async () => {});",
      "// fixme: owner=@owner; reason=   ; expires=2026-11-04",
      "test.fixme('reason', async () => {});",
    ].join("\n"),
  });
  assert.deepEqual(checkE2ePolicy(root, "2026-11-03"), [
    "e2e/a.spec.ts:2: test.fixme needs an immediately preceding owner, reason and expiry",
    "e2e/a.spec.ts:4: test.fixme needs an immediately preceding owner, reason and expiry",
  ]);
});
