import { expect, test } from "vitest";
import { createProblems, entityBody, entityGaps, registrationBody, stepsFor } from "./create";
import { emptyDraft, problems, type Draft } from "./draft";

const draft = (over: Partial<Draft>): Draft => ({ ...emptyDraft("entity"), bizKind: "CORPORATION", name: "주식회사 가나", representatives: ["홍길동"], headOffice: "OTHER", headOfficeAddress: { road: "서울특별시 강남구 테헤란로 152", zip: "", detail: "", verified: false }, ...over });

test("regression: company-08 a corporation being founded skips the certificate and needs no number", () => {
  expect(stepsFor("CORPORATION", true)).toEqual(["basics", "registry", "review"]);
  const d = draft({ founding: true });
  expect(entityGaps(d)).toEqual([]);
  expect(entityBody(d)).toMatchObject({ founding: true, crn: null });
  expect(registrationBody(d)).toBeNull();
  // Not founding: the number is a gap again.
  expect(entityGaps(draft({}))).toEqual(["crn"]);
});

test("regression: company-21 the record starts at the certificate's opening date when it is typed", () => {
  expect(entityBody(draft({ crn: "0002110006241", openedOn: "2020-03-02" })).opened_on).toBe("2020-03-02");
});

test("negative: worst-case-25 a wrong check digit is held in the wizard and the sheets until confirmed", () => {
  const today = "2026-10-07";
  expect(createProblems(draft({ brn: "0008162516" }), { today, taken: null }).brn).toBe("brnChecksum");
  expect(createProblems(draft({ brn: "0008162516", brnConfirmed: "0008162516" }), { today, taken: null }).brn).toBeUndefined();
  expect(createProblems(draft({ brn: "0000000000" }), { today, taken: null }).brn).toBeUndefined();
  expect(problems(draft({ brn: "0008162516" }), { withDocument: false, showRequired: false, today }).brn).toBe("brnChecksum");
});
