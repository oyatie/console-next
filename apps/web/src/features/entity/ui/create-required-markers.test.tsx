// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { emptyDraft, type Draft } from "../domain/draft";
import { CertForm } from "./create-cert-form";
import type { CreateState } from "./use-create";

const view = vi.hoisted(() => ({ loaded: false }));
vi.mock("./use-ref", () => ({
  useCodeLists: () => ({ isPending: false, error: null, data: true, refetch: vi.fn() }),
  useAddressSearch: () => ({ query: "", setQuery: vi.fn(), hits: [], loading: false, problem: null, withCodes: (value: unknown) => value }),
  useCodeSearch: () => ({ list: { title: "공식 코드", loaded: view.loaded }, options: [], query: "", setQuery: vi.fn(), loading: false, ready: true }),
}));
beforeAll(() => loadCatalog("ko"));

const schema = (name: string) => readFileSync(new URL(`../../../../../../backend/crates/entity/rest/openapi/schemas/${name}.yaml`, import.meta.url), "utf8");
const required = (name: string) => [...schema(name).match(/^required:\n((?:- [^\n]+\n)+)/m)![1]!.matchAll(/^- (.+)$/gm)].map((match) => match[1]!);
const address = { road: "등록증 소재지", zip: "06236", detail: "", verified: true };
const { primary: { brn: completeBrn } } = JSON.parse(readFileSync(new URL("../../../../../../e2e/registration-identifiers.json", import.meta.url), "utf8")) as { primary: { brn: string } };
const draft = (kind: Draft["bizKind"]): Draft => ({ ...emptyDraft(), bizKind: kind, headOffice: "SAME", businessAddress: address, representatives: ["대표자"] });
const render = (d: Draft, problems: CreateState["problems"] = {}) => renderToStaticMarkup(<CertForm c={{ draft: d, put: vi.fn(), problems, brnClasses: [], today: "2026-10-24", crnWarn: false, checkAvailability: { available: false } } as unknown as CreateState} />);
const markers = (html: string) => [...html.matchAll(/([^<>]+)<span\b[^>]*>필수<\/span>/g)].map((match) => match[1]!.trim()).sort();

test.each(["CORPORATION", "INDIVIDUAL"] as const)("%s certificate marks exactly the server-required fields", (kind) => {
  view.loaded = false;
  const fields: Record<string, Parameters<typeof t>[0]> = {
    name: kind === "CORPORATION" ? "entityCreate.field.corpName" : "entityCreate.field.tradeName",
    representatives: kind === "CORPORATION" ? "entityCreate.field.representative" : "entityCreate.field.ownerName",
    crn: "entityCreate.field.crn", head_office_address: "entityCreate.field.headOfficeSame",
    brn: "entityCreate.field.brn", opened_on: "entityCreate.field.openedOn", business_address: "entityCreate.field.businessAddress",
    business_types: "entityCreate.field.business", unit_taxation: "entityCreate.field.unitTaxation", tax_office_label: "entityCreate.field.taxOffice", tax_type: "entityCreate.field.taxType",
  };
  const corporation = schema("LegalEntityInput").match(/CORPORATION also requires (\w+) and (\w+)/)!;
  // Kind is chosen before this step; representation mode is supplied or asked on the registry step.
  const entity = required("LegalEntityInput").filter((field) => field !== "biz_kind" && field !== "representation_mode");
  const server = [...entity, ...required("RegistrationInput"), "brn", ...(kind === "CORPORATION" ? [corporation[1]!, corporation[2]!] : [])];
  const expected = [...new Set(server.map((field) => t(fields[field]!)))].sort();
  expect(markers(render(draft(kind)))).toEqual(expected);
});

test("the tax-office picker and typed fallback carry the same required marker", () => {
  const d = draft("CORPORATION");
  view.loaded = false;
  const typed = markers(render(d));
  view.loaded = true;
  const picker = markers(render(d));
  expect(picker).toEqual(typed);
  expect(picker).toContain(t("entityCreate.field.taxOffice"));
});

test("an additional representative remains optional and an alternate head office stays required", () => {
  view.loaded = false;
  const d = { ...draft("CORPORATION"), representatives: ["첫 대표", "추가 대표"], headOffice: "OTHER" as const, headOfficeAddress: address };
  const fields = markers(render(d));
  expect(fields).toContain(t("entityCreate.field.headOfficeAddress"));
  expect(fields).toContain(t("entityCreate.field.headOfficeSame"));
  expect(fields).not.toContain(t("entityCreate.field.representativeN", { n: 2 }));
});

test.each(["", completeBrn.slice(0, -1)])("no verification status for an incomplete BRN %j", brn => {
  expect(render({ ...draft("CORPORATION"), brn })).not.toContain(t("nts.state.unavailable"));
});

test("a complete BRN shows the existing verification state only without a field problem", () => {
  const d = { ...draft("CORPORATION"), brn: completeBrn };
  expect(render(d)).toContain(t("nts.state.unavailable"));
  expect(render(d, { brn: "brnChecksum" })).not.toContain(t("nts.state.unavailable"));
});
