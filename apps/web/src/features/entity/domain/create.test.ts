import { expect, test } from "vitest";
import type { LegalEntity } from "@console/api/pending";
import { corpItems, createProblems, crnWarns, entityBody, entityGaps, itemsDone, registrationBody, stepsFor, takenBrn } from "./create";
import { emptyDraft, type Draft } from "./draft";

const today = "2026-10-06";
const addr = { key: "b1", road: "충청북도 청주시 흥덕구 오송읍 새온생명로 21", zip: "28160", detail: "", verified: true };
const corp = (over: Partial<Draft> = {}): Draft => ({
  ...emptyDraft(),
  bizKind: "CORPORATION", name: "(주)새온바이오", brn: "0000000029", crn: "0003110029143", representatives: ["윤가온"], openedOn: "2024-09-01",
  businessAddress: addr, headOffice: "SAME", businessTypes: [{ sector: "제조업", item: "의약품 원료", ntsCode: null, ksic: null }],
  taxType: "01", issueReason: "NEW", taxOfficePrinted: "청주세무서장", certIssuedOn: "2024-09-08", eInvoiceEmail: "tax@saeon-bio.example",
  ...over,
});
const held = { id: "e1", closed_on: null, current: { name: "(주)새온정밀" }, registrations: [{ id: "r1", brn: { value: "0000000034" }, holder_workplace_id: "w1", closed_on: null }], workplaces: [{ id: "w1", current: { name: "서울 본사" } }] } as unknown as LegalEntity;

test("steps follow the certificate kind: only a corporation types its registry extract", () => {
  expect(stepsFor("CORPORATION")).toEqual(["basics", "certificate", "registry", "review"]);
  expect(stepsFor("INDIVIDUAL")).toEqual(["basics", "certificate", "review"]);
  expect(stepsFor("ID_NUMBER_ORG")).toEqual(["basics", "certificate", "review"]);
});

test("refuses only what cannot be right: a short or taken BRN and a future opening date; empty items never refuse", () => {
  expect(createProblems(emptyDraft(), { today, taken: null })).toEqual({});
  const taken = takenBrn("0000000034", [held]);
  expect(taken).toEqual({ entityId: "e1", entity: "(주)새온정밀", holder: "서울 본사" });
  expect(createProblems(corp({ brn: "0000000034", openedOn: "2026-10-16", certIssuedOn: "" }), { today, taken })).toEqual({ brn: "brnTaken", openedOn: "future" });
  expect(createProblems(corp({ brn: "22081" }), { today, taken: null })).toEqual({ brn: "brnLength" });
});

test("the CRN check digit only warns, and only for a corporation formed before 2025-01-31 or of unknown date", () => {
  expect(crnWarns(corp())).toBe(true);
  expect(crnWarns(corp({ incorporatedOn: "2025-03-01" }))).toBe(false);
  expect(crnWarns(corp({ crn: "0001110482138" }))).toBe(false);
});

test("the 법인 saves from kind, name and a representative; the server still asks a corporation for its CRN and head office", () => {
  expect(entityGaps({ ...emptyDraft(), bizKind: "INDIVIDUAL", name: "새온공방", representatives: ["이새온"] })).toEqual([]);
  expect(entityGaps({ ...emptyDraft(), bizKind: "INDIVIDUAL", name: "새온공방" })).toEqual(["representatives"]);
  expect(entityGaps({ ...emptyDraft(), bizKind: "CORPORATION", name: "(주)새온바이오", representatives: ["윤가온"] })).toEqual(["crn", "headOffice"]);
  expect(entityGaps(corp({ representatives: ["윤가온", "한지원"] }))).toEqual(["representationMode"]);
  const body = entityBody(corp());
  expect(body).toMatchObject({ biz_kind: "CORPORATION", representation_mode: "SINGLE", crn: "0003110029143", directors: [] });
  expect(body.head_office_address?.road_addr_part1).toBe(addr.road);
});

test("the certificate is sent only once every value the server needs is there; 사업자 단위 과세 is never defaulted", () => {
  expect(registrationBody(corp())).toBeNull();
  expect(registrationBody(corp({ unitTaxation: false }))).toMatchObject({ brn: "0000000029", unit_taxation: false, tax_type: "01" });
});

test("the side checklist counts 14 corporate items, with a warned CRN as entered and ⑨ as not applicable", () => {
  const items = corpItems(corp(), {});
  expect(items).toHaveLength(14);
  expect(items.find((i) => i.key === "crn")?.state).toBe("warn");
  expect(items.find((i) => i.key === "unitTaxation")?.state).toBe("todo");
  expect(itemsDone(items)).toBe(13);
});
