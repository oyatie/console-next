import { afterEach, beforeAll, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { LegalEntity } from "@console/api/pending";
import { i18n, loadCatalog } from "@console/i18n";
import { latinName, nameKey, personName } from "../../../reference/entity/domain/names";
import { entityNameText } from "../../../reference/entity/present";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { NameProblems } from "./name-problems";
import { NameReview } from "./name-review";
import { nameCorrection } from "./name-correction-spec";
import { KindAndName } from "./create-kind-and-name";
beforeAll(() => Promise.all([loadCatalog("ko"), loadCatalog("en")]));
afterEach(() => i18n.set("ko"));

const problems = (...codes: string[]) => codes.map((code) => ({ field: "name", code }));
const entity = (over: Partial<NonNullable<LegalEntity["current"]>> = {}, extra: Partial<LegalEntity> = {}): LegalEntity => ({
  id: "entity", biz_kind: "CORPORATION", can_manage: true,
  current: { name: "주식회사 누리", display_name: "NURI", english_name: "Nuri Co., Ltd.", representatives: ["김예시", "박예시"], effective_from: "2026-01-01", ...over },
  registrations: [], workplaces: [], scheduled: [], identity_problems: [], name_reviews: [], ...extra,
} as unknown as LegalEntity);

async function html(node: () => React.ReactNode) {
  const root = createRootRoute({ component: node });
  const router = createRouter({ routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/org/entities/$id" })]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
}

it("leads with the 법인명 and shows the 약칭 and 영문명 only as secondary labels", () => {
  const out = renderToStaticMarkup(<EntityName entity={entity()} />);
  expect(out.startsWith("주식회사 누리")).toBe(true);
  expect(out).toContain('class="muted"> · NURI');
  expect(out).toContain('class="muted"> · Nuri Co., Ltd.');
  // regression (0h): a 약칭 never stands in for the 법인명.
  expect(renderToStaticMarkup(<EntityName entity={entity({ display_name: "김예시,박예시", english_name: null })} />)).toBe('주식회사 누리<small class="muted"> · 김예시,박예시</small>');
  expect(renderToStaticMarkup(<EntityName entity={entity({ display_name: null, english_name: null })} />)).toBe("주식회사 누리");
});

it("the English UI leads with the 영문명 when there is one, never the 약칭", () => {
  i18n.set("en");
  expect(renderToStaticMarkup(<EntityName entity={entity()} />).startsWith("Nuri Co., Ltd.")).toBe(true);
  expect(renderToStaticMarkup(<EntityName entity={entity({ english_name: null })} />).startsWith("주식회사 누리")).toBe(true);
});

it("a picker's label carries every name, so a search by 약칭 or 영문명 finds the 법인", () => {
  const label = entityNameText(entity());
  for (const q of ["주식회사 누리", "NURI", "Nuri Co"]) expect(label).toContain(q);
});

it("lists the server's problems: the list opens the record, the record offers each fix", async () => {
  const all = ["legal_name_unconfirmed", "legal_name_not_hangul", "display_name_is_person", "primary_registration_classification", "legal_name_review"];
  const listed = await html(() => <NameProblems e={entity({}, { identity_problems: problems(...all) })} />);
  expect(listed.match(/<li/g)).toHaveLength(5);
  expect(listed.match(/>확인</g)).toHaveLength(5);
  const review = { id: "r1", registration_id: "reg", entity_name: "주식회사 누리", registration_name: "NURI" };
  const e = entity({}, { identity_problems: problems(...all), name_reviews: [review] });
  const onRecord = await html(() => <NameProblems e={e} onCertificate={() => undefined} review={(r) => <NameReview key={r.id} e={e} review={r} editable />} />);
  expect(onRecord.match(/>등록증 확인</g)).toHaveLength(2);
  expect(onRecord).toContain("약칭에 대표자 이름이 들어 있습니다");
  expect(onRecord).toContain("등록증 상호(「NURI」)가 법인명(「주식회사 누리」)과 달랐습니다.");
  for (const action of ["법인명 유지", "등록증 상호로 정정"]) expect(onRecord).toContain(action);
  const readOnly = await html(() => <NameProblems e={e} onCertificate={() => undefined} review={(r) => <NameReview key={r.id} e={e} review={r} editable={false} />} />);
  expect(readOnly).not.toContain("법인명 유지");
  expect(await html(() => <NameProblems e={entity()} />)).not.toContain("<li");
});

it("a correction to the certificate's name keeps the old 법인명 as 약칭 or 영문명, by the person's choice", () => {
  const e = entity({ name: "NURI", display_name: null, english_name: null });
  const spec = nameCorrection(e, "주식회사 누리");
  expect(spec.initial.name).toBe("주식회사 누리");
  expect(spec.ready(spec.initial)).toBe(false);
  expect(spec.patch({ ...spec.initial, keep: "english_name" })).toEqual({ name: "주식회사 누리", english_name: "NURI" });
  expect(spec.patch({ ...spec.initial, keep: "display_name" })).toEqual({ name: "주식회사 누리", display_name: "NURI" });
  // A Korean old name cannot become the 영문명.
  const korean = nameCorrection(entity({ name: "누리" }), "주식회사 누리");
  expect(korean.ready({ name: "주식회사 누리", keep: "english_name" })).toBe(false);
  expect(korean.ready({ name: "주식회사 누리", keep: "display_name" })).toBe(true);
});

it("guards person data in any name and Korean in the 영문명, as the server does", () => {
  for (const name of ["㈜누리", "누리(주)", "（주） 누리"]) expect(nameKey(name)).toBe(nameKey("주식회사 누리"));
  for (const value of ["김예시", "김예시,박예시", "김예시，박예시"]) expect(personName(value, ["김예시"])).toBe(true);
  for (const value of ["주식회사 김예시", "Acme, Inc", "Black & Decker", "주식회사 가나,주식회사 나다"]) expect(personName(value, [])).toBe(false);
  for (const ok of ["Nuri Co., Ltd.", "A&B (Korea) Inc", "O'Neil-Kim 2"]) expect(latinName(ok)).toBe(true);
  for (const bad of ["주식회사 누리", "Nuri 누리", "Nuri/Seoul"]) expect(latinName(bad)).toBe(false);
});

it("the wizard asks for the 약칭 and 영문명 after the 법인명, marked optional, with examples, apart from any 대표자", () => {
  const out = renderToStaticMarkup(<KindAndName kind="CORPORATION" onKind={() => undefined} name="" onName={() => undefined} clash={false}
    displayName="" onDisplayName={() => undefined} englishName="" onEnglishName={() => undefined} />);
  const at = (text: string) => out.indexOf(text);
  expect(at("법인명(단체명)")).toBeGreaterThan(-1);
  expect(at("법인명(단체명)")).toBeLessThan(at("다른 이름 · 선택"));
  expect(at("다른 이름 · 선택")).toBeLessThan(at("약칭"));
  expect(at("약칭")).toBeLessThan(at("영문명"));
  for (const example of ["예: 누리", "예: Nuri Co., Ltd."]) expect(out).toContain(example);
  expect(out.match(/선택 사항/g)?.length).toBe(2);
  expect(out).not.toContain("대표자");
});
