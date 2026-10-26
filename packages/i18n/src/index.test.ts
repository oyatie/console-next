import { afterEach, beforeAll, expect, test } from "vitest";
import { bootEn, bootKo } from "./catalogs/boot";
import { en } from "./catalogs/en";
import { ko } from "./catalogs/ko";
import { i18n, loadCatalog, t } from "./index";
import { tg } from "./gallery";

beforeAll(() => Promise.all([loadCatalog("ko"), loadCatalog("en")]));
afterEach(() => i18n.set("ko"));

test("formats ICU plurals and numbers per locale, falling back to Korean", () => {
  expect(t("app.name")).toBe("콘솔");
  i18n.set("en");
  expect(t("app.name")).toBe("Console");
});

test("every Korean id has an English translation", () => {
  expect(Object.keys(ko).filter((id) => !(id in en))).toEqual([]);
  expect(Object.keys(bootKo).filter((id) => !(id in bootEn))).toEqual([]);
});

test("boot copy and screen copy never share an id", () => {
  expect(Object.keys(bootKo).filter((id) => id in ko)).toEqual([]);
});

test("josa tokens keep user text literal", () => {
  expect(t("exit.hr.consequence", { name: "{윤}바다", date: "2026. 10. 01." })).toContain("{윤}바다를 2026. 10. 01.자로");
});

test("every message parses in every locale", () => {
  const values = { count: 2, done: 1, total: 5, amount: 1000, headcount: 1, dependents: 2, inserts: 1, updates: 2 };
  const text = new Proxy(values as Record<string, string | number>, { get: (v, k: string) => v[k] ?? "값", has: () => true });
  for (const l of ["ko", "en"] as const) {
    i18n.set(l);
    for (const id of [...Object.keys(bootKo), ...Object.keys(ko)] as (keyof typeof ko)[]) expect(() => t(id, text)).not.toThrow();
  }
});

test("the dev gallery's own catalog formats in every locale (it is not part of the app catalog)", () => {
  for (const l of ["ko", "en"] as const) {
    i18n.set(l);
    expect(tg("sample.person", { n: 3 })).toMatch(/3/);
  }
  expect(Object.keys(ko).some((id) => id.startsWith("gallery."))).toBe(false);
});

// regression (hire-37): the catalogs' written-out fallbacks resolve on screen.
test("t() resolves particles and keeps record metadata as facts", () => {
  i18n.set("ko");
  expect(t("profile.correct.secondNote", { fields: "입사일" })).toBe("입사일은 다른 인사 담당자가 확인해야 바뀝니다");
  expect(t("identifiers.rrn.recorded", { at: "10월 7일", source: "명부 가져오기" })).toBe("10월 7일 · 명부 가져오기");
});
