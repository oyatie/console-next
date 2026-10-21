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
    ["Corp Rev", "CORPORATION", "Kim", "SINGLE", "110111-1234567", "Seoul", "01234", "REVISE_ENTITY", "11111111-1111-1111-1111-111111111111", "2"],
  ];
  const rows = entityRows(grid, 0, cols, kinds, modes);
  expect(rows[0]!.op).toBe("REVISE_ENTITY");
  expect(rows[0]!.id).toBe("11111111-1111-1111-1111-111111111111");
  expect(rows[0]!.expectedVersion).toBe(2);
  expect(bulkGaps(rows[0]!)).toEqual([]);

  const op = entityRowOp(rows[0]!);
  expect(op).toMatchObject({
    op: "REVISE_ENTITY",
    id: "11111111-1111-1111-1111-111111111111",
    expected_version: 2,
  });
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
  expect(bulkGaps(rows[0]!)).toEqual([]);
  const opCreate = entityRowOp(rows[0]!);
  expect(opCreate).toMatchObject({
    op: "CREATE_WORKPLACE",
    legal_entity_id: "22222222-2222-2222-2222-222222222222",
    workplace: { name: "부산지사" },
  });

  expect(rows[1]!.op).toBe("REVISE_WORKPLACE");
  expect(rows[1]!.id).toBe("33333333-3333-3333-3333-333333333333");
  expect(rows[1]!.expectedVersion).toBe(1);
  expect(bulkGaps(rows[1]!)).toEqual([]);
  const opRevise = entityRowOp(rows[1]!);
  expect(opRevise).toMatchObject({
    op: "REVISE_WORKPLACE",
    id: "33333333-3333-3333-3333-333333333333",
    expected_version: 1,
    workplace: { name: "인천물류" },
  });
});
