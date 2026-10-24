// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createRequirements, entityGaps, registrationReady } from "./create";
import { emptyDraft, type Draft } from "./draft";

const schema = (name: string) => readFileSync(new URL(`../../../../../../backend/crates/entity/rest/openapi/schemas/${name}.yaml`, import.meta.url), "utf8");
const required = (name: string) => [...schema(name).match(/^required:\n((?:- [^\n]+\n)+)/m)![1]!.matchAll(/^- (.+)$/gm)].map((m) => m[1]!);
const fields = { biz_kind: "kind", name: "name", representatives: "representatives", representation_mode: "representationMode", crn: "crn", head_office_address: "headOffice", opened_on: "openedOn", business_address: "businessAddress", business_types: "businessTypes", unit_taxation: "unitTaxation", tax_office_label: "taxOfficePrinted", tax_type: "taxType" };
const mapped = (names: string[]) => names.map((name) => fields[name as keyof typeof fields]).sort();
const draft = (over: Partial<Draft> = {}): Draft => ({ ...emptyDraft(), bizKind: "CORPORATION", representatives: ["첫 대표", "다른 대표"], ...over });

test("create field markers follow the server's required set and corporation rule", () => {
  const corporation = schema("LegalEntityInput").match(/CORPORATION also requires (\w+) and (\w+)/)!;
  expect(createRequirements(draft()).entity.toSorted()).toEqual(mapped([...required("LegalEntityInput"), corporation[1]!, corporation[2]!]));
  expect(createRequirements(draft({ bizKind: "INDIVIDUAL" })).entity.toSorted()).toEqual(mapped(required("LegalEntityInput")));
  expect(createRequirements(draft({ founding: true })).entity.toSorted()).toEqual(mapped([...required("LegalEntityInput"), corporation[2]!]));
  expect(createRequirements(draft({ representatives: ["한 대표"] })).entity).toContain("representationMode");
});

test("certificate field markers follow its schema, number requirement and typed name", () => {
  expect(schema("RegistrationInput")).toContain("brn, or brn_pending_reason");
  expect(createRequirements(draft()).registration.toSorted()).toEqual([...mapped(required("RegistrationInput")), "brn", "name"].sort());
});

test("entity gaps use the same field requirements and accept the single-representative default", () => {
  const d = draft({ representatives: ["한 대표"] });
  expect(entityGaps(d)).toEqual(createRequirements(d).entity.filter((field) => !["kind", "representatives", "representationMode"].includes(field)));
  expect(entityGaps(draft({ founding: true, representatives: ["한 대표"], name: "법인", headOfficeAddress: { road: "본점 주소", zip: "", detail: "", verified: false } }))).toEqual([]);
});

test("every certificate requirement affects readiness and optional fields do not", () => {
  const complete = draft({ name: "법인", brn: "0000000029", openedOn: "2026-10-01", businessAddress: { road: "사업장 주소", zip: "", detail: "", verified: false }, businessTypes: [{ sector: "제조업", item: "제품", ntsCode: null, ksic: null }], unitTaxation: false, taxType: "01", taxOfficePrinted: "세무서장" });
  expect(registrationReady(complete)).toBe(true);
  const empty = emptyDraft();
  for (const field of createRequirements(complete).registration) expect(registrationReady({ ...complete, [field]: empty[field] }), field).toBe(false);
  expect(registrationReady({ ...complete, representatives: [""], crn: "", certIssuedOn: "", issueReason: null })).toBe(true);
});
