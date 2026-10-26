// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { SetupRail } from "./setup-rail";

beforeAll(() => loadCatalog("ko"));

test("SetupRail renders checklist groups and steps with progress", () => {
  const [create, fix] = ["Create", "Fix"];
  const out = html(
    <SetupRail
      title="First Run Setup"
      summary="Complete initial configuration"
      groups={[
        {
          key: "org",
          title: "Organization Setup",
          steps: [
            { key: "company", title: "Company Profile", state: "done" },
            { key: "workplace", title: "Workplace Registration", state: "todo", action: <button>{create}</button> },
            { key: "dept", title: "Departments", state: "blocked", detail: "Requires workplace", remedy: <button>{fix}</button> },
          ],
        },
      ]}
    />
  );
  expect(out).toContain("First Run Setup");
  expect(out).toContain("Complete initial configuration");
  expect(out).toContain("Organization Setup");
  expect(out).toContain("Company Profile");
  expect(out).toContain("Workplace Registration");
  expect(out).toContain("Requires workplace");
});
