// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { SetupRail, currentStep } from "./setup-rail";

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
  expect(out).not.toContain("<h3");
  expect(out).toContain("Company Profile");
  expect(out).toContain("Workplace Registration");
  expect(out).toContain("Requires workplace");
});

test("currentStep and aria-current share the first unfinished step, including blocked steps", () => {
  const steps = [
    { key: "done", title: "Done", state: "done" as const },
    { key: "attention", title: "Review", state: "attention" as const },
    { key: "blocked", title: "Blocked", state: "blocked" as const },
    { key: "next", title: "Next", state: "todo" as const },
  ];
  const out = html(<SetupRail title="Setup" groups={[{ key: "all", title: "Group", steps }]} />);
  expect(currentStep(steps)).toBe("blocked");
  expect(out.match(/aria-current="step"/g)).toHaveLength(1);
  expect(out).toMatch(/aria-current="step">[\s\S]*?Blocked/);
  expect(currentStep(steps.slice(0, 2))).toBeUndefined();
});

test("multiple groups retain their headings", () => {
  const out = html(<SetupRail title="Setup" groups={[{ key: "a", title: "First", steps: [] }, { key: "b", title: "Second", steps: [] }]} />);
  expect(out.match(/<h3/g)).toHaveLength(2);
});
