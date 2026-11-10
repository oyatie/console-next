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

test("each step renders a visible state badge and optional owner metadata while keeping title first", () => {
  const out = html(
    <SetupRail
      title="운영 준비"
      groups={[{
        key: "setup",
        title: "운영 준비",
        steps: [
          { key: "entity", title: "법인 등록", state: "done", owner: "담당 · 조직 등록·수정 권한" },
          { key: "workplace", title: "사업장 등록", state: "todo", owner: "담당 · 조직 등록·수정 권한" },
          { key: "org", title: "조직 구성", state: "attention", owner: "담당 · 조직 등록·수정 권한" },
          { key: "golive", title: "운영 시작", state: "blocked", owner: "담당 · 운영 계정" },
        ],
      }]}
    />,
  );
  expect(out).not.toContain("sr-only");
  expect(out).toContain(">완료<");
  expect(out).toContain(">필요<");
  expect(out).toContain(">확인<");
  expect(out).toContain(">차단<");
  expect(out).toContain("담당 · 조직 등록·수정 권한");
  expect(out).toContain("담당 · 운영 계정");
  const rows = [...out.matchAll(/<li[^>]*data-step[^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0]);
  expect(rows.map((row) => row.match(/<span[^>]*>([^<]+)/)![1])).toEqual([
    "법인 등록",
    "사업장 등록",
    "조직 구성",
    "운영 시작",
  ]);
});


test("collapsed rows hide explanation, owner and actions but retain a blocked reason and fix", () => {
  const act = "Act", secondary = "Import", fix = "Fix";
  const out = html(<SetupRail title="Setup" groups={[{ key: "all", title: "All", steps: [
    { key: "next", title: "Next", state: "todo", collapsed: true, detail: "Why", owner: "Owner", action: <button>{act}</button>, secondary: <button>{secondary}</button> },
    { key: "blocked", title: "Blocked", state: "blocked", collapsed: true, owner: "Owner", detail: "Why", blocker: "Needs company", remedy: <a href="/org">{fix}</a> },
  ] }]} />);
  for (const hidden of ["Why", "Owner", ">Act<", ">Import<"]) expect(out).not.toContain(hidden);
  expect(out).toContain("Needs company");
  expect(out).toContain('href="/org"');
});


test("collapsed attention retains its count summary without owner or actions", () => {
  const act = "Act", secondary = "Import";
  const out = html(<SetupRail title="Setup" groups={[{ key: "all", title: "All", steps: [
    { key: "review", title: "Review", state: "attention", collapsed: true, detail: "미배치 18", owner: "Owner", action: <button>{act}</button>, secondary: <button>{secondary}</button> },
  ] }]} />);
  expect(out).toContain("미배치 18");
  for (const hidden of ["Owner", ">Act<", ">Import<"]) expect(out).not.toContain(hidden);
});


test.each(["todo", "done", "attention", "blocked"] as const)("a collapsed locked %s row keeps only its permission line", (state) => {
  const fix = "Fix";
  const out = html(<SetupRail title="Setup" groups={[{ key: "all", title: "All", steps: [
    { key: "locked", title: "Step", state, collapsed: true, locked: true, owner: "Permission needed", detail: "Expanded why", blocker: "Blocked reason", remedy: <a href="/org">{fix}</a> },
  ] }]} />);
  expect(out).toContain("Permission needed");
  for (const hidden of ["Expanded why", "Blocked reason", 'href="/org"']) expect(out).not.toContain(hidden);
});
