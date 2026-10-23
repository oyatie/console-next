// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { loadCatalog, t } from "@console/i18n";
import { WorkplacesCard } from "./record-workplaces-card";
import { WorkplacesTab } from "./workplaces-tab";

vi.mock("@tanstack/react-router", async (original) => ({ ...await original<object>(), useNavigate: () => () => {} }));
vi.mock("./workplace-panel", () => ({ WorkplacePanel: () => null }));
beforeAll(() => loadCatalog("ko"));

for (const answer of ["registered", "exempt", "abstract", "later", "no-filing-number"] as const) {
  test(`${answer}: record rows distinguish the workplace registration from the entity filing basis`, () => {
    const registered = answer === "registered";
    const finished = answer === "exempt" || answer === "abstract";
    const w = {
      id: "w1", registration_id: registered ? "r1" : null,
      filing_registration_id: answer === "no-filing-number" ? null : "r1",
      registration_todo: !registered && !finished, is_abstract: answer === "abstract",
      not_registered_reason: finished ? { code: "reason", label: "등록 미대상 사유", version: "v1" } : null,
      headcount: 0, insurance: [], current: { name: "근무지", status: "CONTINUING" },
    } as unknown as Workplace;
    const brn = "000-81-00009";
    const e = { id: "e1", read_only: true, workplaces: [w], registrations: [{ id: "r1", brn: { display: brn }, current: { status: "CONTINUING" } }] } as unknown as LegalEntity;
    const html = renderToStaticMarkup(<WorkplacesCard e={e} />);
    const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]!.split(/<[^>]*>/).join("")); // text of each cell for assertions, not sanitising output
    expect(cells[2]).toBe(registered ? brn : `${t("workplace.filing.entityBasis")}${answer === "no-filing-number" ? "" : ` · ${brn}`}`);
    if (finished) expect(cells[3]).toBe(w.not_registered_reason!.label);
    if (!registered && !finished) expect(cells[3]).toBe(t("workplace.registration.prompt"));
    expect(html).not.toContain("chip--warn");

    const tab = renderToStaticMarkup(<WorkplacesTab e={e} />);
    if (!registered) expect(tab).not.toContain("chip--warn");
    if (finished) expect(tab).toContain(w.not_registered_reason!.label);
    if (answer === "later") expect(tab).toContain(t("workplace.filing.entityBasis"));
  });
}
