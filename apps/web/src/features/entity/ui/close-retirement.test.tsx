// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import { loadCatalog } from "@console/i18n";
import { OpenEntityExits } from "./close-entity-exits";
import { ClosePreview } from "./close-preview";

const exit = { case_id: "exit", employee_id: "person", employee_name: "경계직원", effective_exit_date: "2026-10-31" };
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { open_exit_cases: [exit] } }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
beforeAll(() => loadCatalog("ko"));

test("the legal entity close list labels the derived retirement date", () => {
  const html = renderToStaticMarkup(<OpenEntityExits entityId="entity" />);
  expect(html).toContain("퇴직일 2026. 11. 01.");
  expect(html).not.toContain("퇴직일 2026. 10. 31.");
});

test("the workplace close list labels the same retirement date", () => {
  const props = { view: { people: [], exit_cases: [exit], units: [] }, draft: { people: {}, units: {} }, entity: { children: [] }, date: "2026-11-01", insurance: 0 } as unknown as ComponentProps<typeof ClosePreview>;
  const html = renderToStaticMarkup(<ClosePreview {...props} />);
  expect(html).toContain("퇴직일 2026. 11. 01.");
  expect(html).not.toContain("퇴직일 2026. 10. 31.");
});
