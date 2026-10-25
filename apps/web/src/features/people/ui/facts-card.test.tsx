// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import type { Facts } from "../domain/facts";

const read = vi.hoisted(() => ({ data: {} as Facts }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: read.data }) }));
vi.mock("../api", () => ({ factsQuery: vi.fn(), confirmProbation: vi.fn() }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({}) }));

let FactsCard: typeof import("./facts-card").FactsCard;
beforeAll(async () => {
  await loadCatalog("ko");
  ({ FactsCard } = await import("./facts-card"));
});

function card(birth_date: string | null) {
  read.data = {
    employee_id: "person", hire_date: null, birth_date, work_email: null, id_type: null,
    employment: null, updated_at: "2026-10-21T00:00:00Z",
  };
  return renderToStaticMarkup(<FactsCard e={{ id: "person", name: "한기록" } as Parameters<typeof FactsCard>[0]["e"]} editing={false} onEdit={() => {}} />);
}

test("the employment record masks a recorded birth date before reveal", () => {
  const html = card("1965-01-01");
  expect(html).not.toContain("1965");
  expect(html).toContain("••••-••-••");
  expect(html).toContain(t("empCard.reveal.open", { field: t("facts.birthDate") }));
});

test("a missing birth date stays unregistered without a mask or reveal", () => {
  const html = card(null);
  expect(html).toContain(t("facts.notSet"));
  expect(html).not.toContain("••••-••-••");
  expect(html).not.toContain(t("empCard.reveal.open", { field: t("facts.birthDate") }));
});

test("a read-only record retains probation facts and offers no profile or probation writes", () => {
  card(null);
  read.data.employment = { employment_type: "REGULAR", probation_state: "OVERDUE", probation_end_date: "2026-10-23" } as Facts["employment"];
  const html = renderToStaticMarkup(<FactsCard e={{ id: "person", name: "한기록" } as Parameters<typeof FactsCard>[0]["e"]} readOnly editing={false} onEdit={() => {}} />);
  expect(html).toContain(t("facts.probation"));
  expect(html).not.toContain(t("facts.edit"));
  expect(html).not.toContain(t("facts.probation.confirm"));
});
