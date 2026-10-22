// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { entityBody, entityGaps } from "./create";
import {
  bulkGaps,
  emptyColumns,
  entityRowOp,
  entityRows,
  guessEntityColumns,
} from "./bulk";

const kinds = { CORPORATION: "corporation", INDIVIDUAL: "individual", ID_NUMBER_ORG: "organisation" };
const modes = { SINGLE: "single", SEVERAL: "several", JOINT: "joint" };
const words: Parameters<typeof guessEntityColumns>[1] = {
  name: "name",
  kind: "kind",
  representatives: "reps",
  mode: "mode",
  crn: "crn",
  road: "road",
  zip: "zip",
  op: "op",
  id: "id",
  version: "version",
  legalEntityId: "legal_entity_id",
  workplaceName: "workplace_name",
};
const columns = { ...emptyColumns(), name: 0, kind: 1, representatives: 2, mode: 3, crn: 4, road: 5, zip: 6 };

test("an unknown header is not guessed into a legal identity", () => {
  expect(guessEntityColumns(["Name", "surprise"], words)).toEqual({
    ...emptyColumns(),
    name: 0,
  });
});

test("a corporation retains every required identity field and several representatives ask their mode", () => {
  const rows = entityRows([[], ["Example", "CORPORATION", "Kim|Lee", "", "000111-1234560", "Seoul", "01234"]], 0, columns, kinds, modes);
  expect(entityGaps(rows[0]!.draft)).toEqual(["representationMode"]);
  const draft = { ...rows[0]!.draft, representationMode: "JOINT" as const };
  expect(entityGaps(draft)).toEqual([]);
  expect(entityBody(draft)).toMatchObject({ crn: "0001111234560", representation_mode: "JOINT", representatives: ["Kim", "Lee"], head_office_address: { road_addr_part1: "Seoul", zip_no: "01234", source: "MANUAL_UNVERIFIED" } });
});

test("unknown kinds, missing representatives and incomplete corporations are held for correction", () => {
  const rows = entityRows([[], ["Uncertain", "unknown", ""], ["Corp", "corporation", "Kim"]], 0, columns, kinds, modes);
  expect(entityGaps(rows[0]!.draft)).toEqual(["kind", "representatives"]);
  expect(entityGaps(rows[1]!.draft)).toEqual(["crn", "headOffice"]);
  expect(rows.map((r) => r.line)).toEqual([2, 3]);
});

test("an imported representation mode is held when it conflicts with its named representatives", () => {
  const one = entityRows([[], ["Individual", "INDIVIDUAL", "Kim", "JOINT"]], 0, columns, kinds, modes)[0]!;
  expect(bulkGaps(one)).toContain("representationMode");
  expect(bulkGaps({ ...one, draft: { ...one.draft, representationMode: "SINGLE" } })).toEqual([]);
  const several = entityRows([[], ["Individual", "INDIVIDUAL", "Kim|Lee", "SINGLE"]], 0, columns, kinds, modes)[0]!;
  expect(bulkGaps(several)).toContain("representationMode");
});

test("an unknown imported mode remains unanswered even for one representative", () => {
  const row = entityRows([[], ["Individual", "INDIVIDUAL", "Kim", "unknown"]], 0, columns, kinds, modes)[0]!;
  expect(bulkGaps(row)).toContain("representationMode");
});

test("single-path supports REVISE_ENTITY with id and expected version", () => {
  const cols = { ...columns, op: 7, id: 8, version: 9 };
  const grid = [
    [],
    ["Corp Rev", "CORPORATION", "Kim", "SINGLE", "000111-1234560", "Seoul", "01234", "REVISE_ENTITY", "11111111-1111-1111-1111-111111111111", "2"],
  ];
  const rows = entityRows(grid, 0, cols, kinds, modes);
  expect(rows[0]!.op).toBe("REVISE_ENTITY");
  expect(rows[0]!.id).toBe("11111111-1111-1111-1111-111111111111");
  expect(rows[0]!.expectedVersion).toBe(2);
  expect(bulkGaps(rows[0]!)).toEqual([]);

  expect(() => entityRowOp(rows[0]!)).toThrow("record");
});

test("single-path supports CREATE_WORKPLACE and REVISE_WORKPLACE", () => {
  const cols = { ...columns, op: 7, id: 8, version: 9, legalEntityId: 10, workplaceName: 11 };
  const grid = [
    [],
    ["", "", "", "", "", "Busan", "54321", "CREATE_WORKPLACE", "", "", "22222222-2222-2222-2222-222222222222", "부산지사"],
    ["", "", "", "", "", "Incheon", "12345", "REVISE_WORKPLACE", "33333333-3333-3333-3333-333333333333", "1", "", "인천물류"],
  ];
  const rows = entityRows(grid, 0, cols, kinds, modes);

  expect(rows[0]!.op).toBe("CREATE_WORKPLACE");
  expect(rows[0]!.workplaceName).toBe("부산지사");
  expect(rows[0]!.legalEntityId).toBe("22222222-2222-2222-2222-222222222222");
  expect(bulkGaps(rows[0]!)).toEqual(["workplaceFlow"]);
  expect(() => entityRowOp(rows[0]!)).toThrow("workplaceFlow");

  expect(rows[1]!.op).toBe("REVISE_WORKPLACE");
  expect(rows[1]!.id).toBe("33333333-3333-3333-3333-333333333333");
  expect(rows[1]!.expectedVersion).toBe(1);
  expect(bulkGaps(rows[1]!)).toEqual([]);
  expect(() => entityRowOp(rows[1]!)).toThrow("record");
});


test("revise overlays mapped fields on the read entity without clearing registry facts", () => {
  const current = {
    id: "11111111-1111-1111-1111-111111111111", biz_kind: "CORPORATION", crn: { value: "0001111234560" },
    current: { version: 7, name: "Before", representatives: ["Kim"], representation_mode: "SINGLE",
      additional_representatives: 2, incorporated_on: "2019-04-03", capital_won: 300,
      main_phone: { value: "+82212345678" }, head_office_address: { road_addr_part1: "Seoul", zip_no: "01234", source: "MANUAL_UNVERIFIED" } },
    workplaces: [], registrations: [], scheduled: [],
  } as unknown as import("@console/api/pending").LegalEntity;
  const row = entityRows([[], ["After", "REVISE_ENTITY", current.id]], 0,
    { ...emptyColumns(), name: 0, op: 1, id: 2 }, kinds, modes)[0]!;
  const result = entityRowOp(row, [current]);
  expect(result.entity).toMatchObject({ name: "After", capital_won: 300, main_phone: "+82212345678",
    incorporated_on: "2019-04-03", representatives: ["Kim"], additional_representatives: 2 });
  expect(result.expected_version).toBe(7);
});

test("a workplace rename retains its serial, opening date, contacts and statutory facts", () => {
  const workplace = { id: "33333333-3333-3333-3333-333333333333", registration_id: "reg", sub_serial: "0002",
    current: { version: 4, name: "Before", opened_on: "2019-04-03", phone: { value: "+82212345678" },
      representative_name: "Kim", main_product: "Parts", withholding_mode: "OWN", independent_lsa_unit: true,
      independent_lsa_evidence: "Separate work rules", status: "SUSPENDED", status_until: "2026-12-31" } };
  const entity = { id: "entity", registrations: [], workplaces: [workplace] } as unknown as import("@console/api/pending").LegalEntity;
  const row = entityRows([[], ["After", "REVISE_WORKPLACE", workplace.id]], 0,
    { ...emptyColumns(), workplaceName: 0, op: 1, id: 2 }, kinds, modes)[0]!;
  const result = entityRowOp(row, [entity]);
  expect(result.workplace).toMatchObject({ name: "After", registration_id: "reg", sub_serial: "0002", opened_on: "2019-04-03",
    phone: "+82212345678", representative_name: "Kim", main_product: "Parts", withholding_mode: "OWN",
    independent_lsa_unit: true, independent_lsa_evidence: "Separate work rules", status_until: "2026-12-31" });
  expect(result.expected_version).toBe(4);
});

test("workplace creation is held for the existing statutory-answers flow", () => {
  const row = { line: 2, op: "CREATE_WORKPLACE" as const, legalEntityId: "entity", workplaceName: "Branch", draft: { ...entityRows([[], ["Branch"]], 0, { ...emptyColumns(), name: 0 }, kinds, modes)[0]!.draft } };
  expect(bulkGaps(row)).toContain("workplaceFlow");
  expect(() => entityRowOp(row)).toThrow();
});

test("a revision cannot replace an unreadable or missing record with a partial draft", () => {
  const row = entityRows([[], ["After", "REVISE_ENTITY", "missing"]], 0,
    { ...emptyColumns(), name: 0, op: 1, id: 2 }, kinds, modes)[0]!;
  expect(bulkGaps(row, [])).toContain("record");
  expect(() => entityRowOp(row, [])).toThrow("record");
  const restricted = { id: "missing", biz_kind: "INDIVIDUAL", current: { version: 1, name: "Before", representatives: null } } as unknown as import("@console/api/pending").LegalEntity;
  expect(bulkGaps(row, [restricted])).toContain("record");
  expect(() => entityRowOp(row, [restricted])).toThrow("record");
});

test("a mapped postal code preserves the unmapped road, detail and registry facts", () => {
  const current = { id: "entity", biz_kind: "CORPORATION", current: { name: "Before", version: 2, representatives: ["Kim"],
    head_office_address: { road_addr_part1: "Seoul", zip_no: "01234", detail: "3층", source: "MANUAL_UNVERIFIED" } } } as unknown as import("@console/api/pending").LegalEntity;
  const row = entityRows([[], ["99999", "REVISE_ENTITY", current.id]], 0,
    { ...emptyColumns(), zip: 0, op: 1, id: 2 }, kinds, modes)[0]!;
  const result = entityRowOp(row, [current]);
  expect(result.entity?.head_office_address).toMatchObject({ road_addr_part1: "Seoul", zip_no: "99999", detail: "3층" });
  expect(result.entity?.name).toBe("Before");
});
