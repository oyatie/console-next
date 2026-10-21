import { expect, test } from "vitest";
import { emptyWorkplace, INSURANCE_CHOICES, insurers, planWorkplace, rowsFor, workplaceProblems, type WorkplaceDraft } from "./workplace";

const base = (over: Partial<WorkplaceDraft> = {}): WorkplaceDraft => ({
  ...emptyWorkplace(),
  name: "부산지점", regMode: "LATER", address: { road: "부산광역시 중구 중앙대로 2", zip: "48939", detail: "", verified: false }, openedOn: "2026-09-01", independentAccounts: false, insurance: "ALL_ESTABLISHED_NUMBERS_LATER",
  ...over,
});
const facts = { askHeadOffice: false, showRequired: true };

test("nothing is defaulted: registration, insurance, where withholding is filed and (when unsettled) the head office are asked", () => {
  expect(workplaceProblems(emptyWorkplace(), { askHeadOffice: true, showRequired: true })).toMatchObject({ name: "required", regMode: "required", insurance: "required", independentAccounts: "required", headOffice: "required" });
  expect(workplaceProblems(emptyWorkplace(), facts).headOffice).toBeUndefined();
});

test("established-with-numbers-later needs no numbers; established now needs each number and date", () => {
  expect(workplaceProblems(base(), facts)).toEqual({});
  expect(planWorkplace(base(), { corp: true, registrationId: null, headOffice: null }).insurance).toEqual({ shortcut: "ALL_ESTABLISHED_NUMBERS_LATER", insurers: [] });
  expect(workplaceProblems(base({ insurance: "ALL_ESTABLISHED_NOW" }), facts)).toMatchObject({ "row.NPS.mgmtNo": "required", "row.IACI.establishedOn": "required" });
  expect(rowsFor(base({ insurance: "NONE_YET" })).every((r) => r.status === "NOT_ESTABLISHED")).toBe(true);
});

test("per insurer: each status is chosen, and a number outside the 8–13 digit band is refused", () => {
  const rows = emptyWorkplace().rows.map((r) => (r.insurer === "EI" ? { ...r, status: "ESTABLISHED" as const, mgmtNo: "1234", establishedOn: "2026-09-01" } : r));
  expect(workplaceProblems(base({ insurance: "PER_INSURER", rows }), facts)).toMatchObject({ "row.NPS.status": "required", "row.EI.mgmtNo": "insuranceNoLength" });
});

test("a unit-taxation sub-workplace needs a four-digit serial other than 0000, and keeps its own address", () => {
  expect(workplaceProblems(base({ regMode: "UNIT_TAXATION_SUB", subSerial: "0000" }), facts).subSerial).toBe("subSerial");
  const body = planWorkplace(base({ regMode: "UNIT_TAXATION_SUB", subSerial: "0001" }), { corp: true, registrationId: "r1", headOffice: false });
  expect(body).toMatchObject({ registration_id: "r1", sub_serial: "0001", same_address_as_registration: false, address: { source: "MANUAL_UNVERIFIED", si_nm: "부산광역시" } });
});

test("a workplace from a certificate takes its place and date; withholding is only sent when it is not the statute's", () => {
  const body = planWorkplace(base({ regMode: "EXISTING", registrationId: "r1", address: null, openedOn: "" }), { corp: true, registrationId: "r1", openedOn: "2019-03-04", headOffice: true });
  expect(body).toMatchObject({ registration_id: "r1", same_address_as_registration: true, address: null, opened_on: "2019-03-04", withholding_mode: null, is_head_office: true });
  expect(planWorkplace(base({ independentAccounts: true }), { corp: true, registrationId: null, headOffice: null }).withholding_mode).toBe("OWN_INDEPENDENT_ACCOUNTS");
  expect(planWorkplace(base(), { corp: false, registrationId: null, headOffice: null }).withholding_mode).toBe("HEAD_OFFICE");
});

// Edges the mutation run found unpinned (npm run mutants).
const now = (mgmtNo: string) => base({ insurance: "ALL_ESTABLISHED_NOW", rows: emptyWorkplace().rows.map((r) => ({ ...r, mgmtNo, establishedOn: "2026-09-01" })) });
const plan = (d: WorkplaceDraft) => planWorkplace(d, { corp: true, registrationId: "r1", openedOn: "2019-03-04", headOffice: null });

test("the insurance number band is 8 to 13 digits, both ends included; a filled row needs nothing more", () => {
  expect(INSURANCE_CHOICES).toEqual(["ALL_ESTABLISHED_NUMBERS_LATER", "ALL_ESTABLISHED_NOW", "NONE_YET", "PER_INSURER"]);
  expect(workplaceProblems(now("12345678"), facts)).toEqual({});
  expect(workplaceProblems(now("1234567890123"), facts)).toEqual({});
  expect(workplaceProblems(now("1234567"), facts)["row.NPS.mgmtNo"]).toBe("insuranceNoLength");
  expect(workplaceProblems(now("12345678901234"), facts)["row.NPS.mgmtNo"]).toBe("insuranceNoLength");
  const statusKeys = (d: WorkplaceDraft) => Object.keys(workplaceProblems(d, facts)).filter((k) => k.endsWith(".status"));
  expect(statusKeys(now(""))).toEqual([]);
  expect(statusKeys(emptyWorkplace())).toEqual([]);
  const chosen = emptyWorkplace().rows.map((r) => ({ ...r, status: "NOT_ESTABLISHED" as const }));
  expect(statusKeys(base({ insurance: "PER_INSURER", rows: chosen }))).toEqual([]);
  expect(rowsFor(base()).every((r) => r.status === "ESTABLISHED_NUMBER_PENDING")).toBe(true);
});

test("each draft gap is named, and none is named while required marks are hidden", () => {
  expect(workplaceProblems(base({ name: "  " }), facts).name).toBe("required");
  expect(workplaceProblems(base({ regMode: "EXISTING", registrationId: null }), facts).registrationId).toBe("required");
  expect(workplaceProblems(base({ regMode: "EXISTING", registrationId: "r1" }), facts).registrationId).toBeUndefined();
  expect(workplaceProblems(base({ regMode: "UNIT_TAXATION_SUB", subSerial: "" }), facts).subSerial).toBe("required");
  expect(workplaceProblems(base({ regMode: "UNIT_TAXATION_SUB", subSerial: "001" }), facts).subSerial).toBe("subSerial");
  expect(workplaceProblems(base({ regMode: "UNIT_TAXATION_SUB", subSerial: "0001" }), facts)).toEqual({});
  expect(workplaceProblems(base({ address: null, openedOn: "" }), facts)).toMatchObject({ address: "required", openedOn: "required" });
  expect(workplaceProblems(base({ regMode: "UNIT_TAXATION_SUB", subSerial: "0001", address: null, openedOn: "" }), facts)).toMatchObject({ address: "required", openedOn: "required" });
  expect(workplaceProblems(base({ regMode: "NEW", address: null, openedOn: "" }), facts)).toEqual({});
  expect(workplaceProblems(base({ email: "nope", phone: "12" }), facts)).toEqual({ email: "emailInvalid", phone: "phoneInvalid" });
  expect(workplaceProblems(base({ email: "x-001@example.com", phone: "010-1234-5678" }), facts)).toEqual({});
  expect(workplaceProblems(base({ email: "a@b.example", phone: "010-1234-5678" }), facts)).toEqual({});
  expect(workplaceProblems(emptyWorkplace(), { askHeadOffice: true, showRequired: false })).toEqual({});
  expect(workplaceProblems(base({ headOffice: false }), { askHeadOffice: true, showRequired: true })).toEqual({});
});

test("insurers: none for the no-number shortcuts; statuses only per insurer; numbers only where established; the NHIS office only on NHIS", () => {
  expect(insurers(base({ insurance: "NONE_YET" }))).toEqual([]);
  expect(insurers(now("12345678"))[0]).toEqual({ insurer: "NPS", status: undefined, mgmt_no: "12345678", established_on: "2026-09-01" });
  const code = { code: "B1", label: "종로지사", version: "1" };
  const rows = emptyWorkplace().rows.map((r) => ({ ...r, status: r.insurer === "EI" ? ("NOT_ESTABLISHED" as const) : ("ESTABLISHED" as const), mgmtNo: "12345678", establishedOn: "2026-09-01", code }));
  const per = insurers(base({ insurance: "PER_INSURER", rows }));
  expect(per.find((r) => r.insurer === "EI")).toEqual({ insurer: "EI", status: "NOT_ESTABLISHED", mgmt_no: null, established_on: null });
  expect(per.find((r) => r.insurer === "NHIS")).toMatchObject({ status: "ESTABLISHED", nhis_branch_office_code: "B1" });
  expect(per.find((r) => r.insurer === "NPS")).not.toHaveProperty("nhis_branch_office_code");
  expect(insurers(base({ insurance: "PER_INSURER", rows: rows.map((r) => ({ ...r, code: null })) })).some((r) => "nhis_branch_office_code" in r)).toBe(false);
});

test("the request trims what was typed, holds no certificate when later, and sends no empty contact", () => {
  expect(plan(base({ name: " 부산지점 ", email: " x-001@example.com ", phone: "010-1234-5678" }))).toMatchObject({ name: "부산지점", registration_id: null, sub_serial: null, same_address_as_registration: false, email: "x-001@example.com", phone: "+821012345678" });
  expect(plan(base({ name: " 부산지점 ", email: " a@b.example ", phone: "010-1234-5678" }))).toMatchObject({ name: "부산지점", registration_id: null, sub_serial: null, same_address_as_registration: false, email: "a@b.example", phone: "+821012345678" });
  expect(plan(base({ email: "  " }))).toMatchObject({ email: null, phone: null });
  expect(plan(base({ regMode: "NEW", address: null }))).toMatchObject({ registration_id: "r1", same_address_as_registration: true, address: null, opened_on: "2019-03-04" });
  expect(plan(base({ regMode: "UNIT_TAXATION_SUB", subSerial: "0002", address: null }))).toMatchObject({ registration_id: "r1", sub_serial: "0002", address: null, opened_on: "2026-09-01" });
});
