import { expect, test } from "vitest";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { unattached, unlinkedCertificates } from "./attach";

const wp = (id: string, name: string, over: Partial<Workplace> = {}) => ({ id, registration_id: null, closed_on: null, headcount: 0, current: { name }, ...over }) as unknown as Workplace;
const entity = (id: string, workplaces: Workplace[], over: Partial<LegalEntity> = {}) => ({ id, closed_on: null, workplaces, ...over }) as unknown as LegalEntity;

test("regression: org-03 lists every workplace with no certificate, the staffed ones first, then in the stored order", () => {
  const rows = unattached([
    entity("a", [wp("hq", "본사", { registration_id: "r1" }), wp("pt", "평택공장", { headcount: 3 }), wp("gw", "광주지점")]),
    entity("b", [wp("x", "안양지점")], { closed_on: "2026-01-31" }),
    entity("c", [wp("y", "가산지점"), wp("z", "닫힌 지점", { closed_on: "2026-02-01" })]),
  ]);
  expect(rows.map((r) => r.w.id)).toEqual(["pt", "gw", "y"]);
});

test("a certificate attached to the entity but to no registration is offered again; a linked or superseded one is not", () => {
  const doc = (id: string, over: object) => ({ id, kind: "BIZ_REG_CERT", registration_id: null, superseded_at: null, ...over }) as never;
  const docs = [doc("free", {}), doc("linked", { registration_id: "r1" }), doc("old", { superseded_at: "2026-01-01T00:00:00Z" }), doc("extract", { kind: "CORP_REGISTRY_EXTRACT" })];
  expect(unlinkedCertificates(docs).map((d) => d.id)).toEqual(["free"]);
});
