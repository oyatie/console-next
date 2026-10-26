// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { KeyValue, StatRow } from "./key-value";

beforeAll(() => loadCatalog("ko"));

test("KeyValue renders facts and actions", () => {
  const fix = "Fix";
  const out = html(
    <KeyValue
      items={[
        { key: "1", label: "Representative", value: "Hong Gil-dong", action: <button>{fix}</button> },
        { key: "2", label: "Status", value: "Active", readOnly: true },
      ]}
      label="Facts"
    />
  );
  expect(out).toContain("Representative");
  expect(out).toContain("Hong Gil-dong");
  expect(out).toContain("Fix");
  expect(out).not.toContain("aria-readonly");
  expect(out).not.toContain('tabindex="0"');
});

test("KeyValue renders loading state with skeleton and aria-busy", () => {
  const out = html(<KeyValue items={[]} loading />);
  expect(out).toContain('aria-busy="true"');
  expect(out).toContain('role="status"');
});

test("KeyValue renders empty state keeps its labelled container without domain prose", () => {
  const out = html(<KeyValue items={[]} />);
  expect(out).not.toContain("조직도");
  expect(out).toContain('<dl');
});

test("KeyValue renders error state with role alert and data-state error", () => {
  const out = html(<KeyValue items={[]} error="Failed to load facts" />);
  expect(out).toContain('role="alert"');
  expect(out).toContain('data-state="error"');
  expect(out).toContain("Failed to load facts");
});

test("StatRow renders KPI numbers and labels", () => {
  const out = html(
    <StatRow
      items={[
        { key: "total", label: "Total Headcount", value: "128" },
        { key: "active", label: "Active", value: "120" },
      ]}
      label="Summary"
    />
  );
  expect(out).toContain("Total Headcount");
  expect(out).toContain("128");
});


test("read-only facts omit write actions without unsupported ARIA attributes", () => {
  const action = "Edit";
  const out = html(<KeyValue readOnly items={[{ key: "name", label: "Name", value: "Company", action: <button>{action}</button> }]} />);
  expect(out).toContain("Company");
  expect(out).not.toContain("<button");
  expect(out).not.toContain("aria-readonly");
});
