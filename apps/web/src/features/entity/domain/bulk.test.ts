import { expect, test } from "vitest";
import { entityBody, entityGaps } from "./create";
import { bulkGaps, emptyColumns, entityRows, guessEntityColumns } from "./bulk";

const kinds = { CORPORATION: "corporation", INDIVIDUAL: "individual", ID_NUMBER_ORG: "organisation" };
const modes = { SINGLE: "single", SEVERAL: "several", JOINT: "joint" };
const columns = { name: 0, kind: 1, representatives: 2, mode: 3, crn: 4, road: 5, zip: 6 };

test("an unknown header is not guessed into a legal identity", () => {
  expect(guessEntityColumns(["Name", "surprise"], { name: "name", kind: "kind", representatives: "reps", mode: "mode", crn: "crn", road: "road", zip: "zip" })).toEqual({ ...emptyColumns(), name: 0 });
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
