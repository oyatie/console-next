// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ExperienceId } from "../../experience/dom";
import { RecordRows } from "./rows";

let activeExperience: ExperienceId = "baseline";

vi.mock("../../experience/dom", async original => ({
  ...await original<typeof import("../../experience/dom")>(),
  useActiveExperienceId: () => activeExperience,
}));

const rows = [{ id: "1", name: "Yoon", role: "Lead" }];
const columns = [
  { header: "Name", card: "title" as const, cell: (r: (typeof rows)[number]) => r.name },
  { header: "Role", card: "fact" as const, cell: (r: (typeof rows)[number]) => r.role },
];

describe("RecordRows mobileLayout", () => {
  beforeEach(() => {
    activeExperience = "baseline";
  });

  test("preserves data-card in baseline when mobileLayout is 'cards'", () => {
    const html = renderToStaticMarkup(
      <RecordRows label="Filings" rows={rows} rowId={r => r.id} columns={columns} mobileLayout="cards" />,
    );
    expect(html).toContain('data-card="title"');
    expect(html).toContain('data-card="fact"');
    expect(html).toContain('data-label="Role"');
  });

  test("omits data-card in baseline when mobileLayout is 'console-cards'", () => {
    const html = renderToStaticMarkup(
      <RecordRows label="Records" rows={rows} rowId={r => r.id} columns={columns} mobileLayout="console-cards" />,
    );
    expect(html).not.toContain("data-card");
    expect(html).not.toContain("data-label");
  });

  test("renders data-card in console when mobileLayout is 'console-cards'", () => {
    activeExperience = "console";
    const html = renderToStaticMarkup(
      <RecordRows label="Records" rows={rows} rowId={r => r.id} columns={columns} mobileLayout="console-cards" />,
    );
    expect(html).toContain('data-card="title"');
    expect(html).toContain('data-card="fact"');
    expect(html).toContain('data-label="Role"');
  });
});
