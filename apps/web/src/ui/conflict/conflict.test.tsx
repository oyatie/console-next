// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { ConflictPanel } from "./field-conflict";

beforeAll(() => loadCatalog("ko"));

test("ConflictPanel renders conflict items and mine vs current values", () => {
  const out = html(
    <ConflictPanel
      kind="field_conflict"
      conflicts={[
        {
          field: "name",
          label: "Department Name",
          mine: "New Design Team",
          current: "Old Design Team",
          actor: "Admin",
          at: "2026-10-21 10:00",
        },
      ]}
      choices={{}}
      onChoose={() => undefined}
    />
  );
  expect(out).toContain("Department Name");
  expect(out).toContain("New Design Team");
  expect(out).toContain("Old Design Team");
  expect(out).toContain('role="alert"');
});
