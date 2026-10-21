import { expect, test, type Page } from "@playwright/test";
import { go, kstDate, option } from "../flows";
import { box } from "../structure-flows";
import { FACTS, type Fact, type Surface } from "./facts";
import { NAMES, control, openCard, pageUrl, soloWorld } from "./world";


type World = Awaited<ReturnType<typeof soloWorld>>;
type Edit = { old: string; next: string; run: (w: World) => Promise<void> };

const EDITS: Record<string, Edit> = {
  "workplace.name": {
    old: NAMES.workplace,
    next: "가람허브",
    run: async (w) => {
      await go(w.admin, "/org");
      await box(w.admin, NAMES.workplace).click();
      await w.admin.getByRole("button", { name: "사업장 이름 수정", exact: true }).click();
      const sheet = w.admin.getByRole("dialog", { name: "사업장 이름 수정" });
      await sheet.getByRole("textbox", { name: /^사업장 이름/ }).fill("가람허브");
      await sheet.getByLabel("적용일").fill(kstDate());
      await option(w.admin, "변경 사유", "이름 변경").click();
      await sheet.getByRole("button", { name: "변경 저장" }).click();
      await expect(sheet).toBeHidden({ timeout: 15_000 });
    },
  },
  "employee.emergency_contact": {
    old: NAMES.contact,
    next: "형제자매 홍••",
    run: async (w) => {
      await openCard(w);
      await w.admin.getByRole("button", { name: `비상연락처 ${NAMES.contact} 수정` }).click();
      const sheet = w.admin.getByRole("dialog", { name: "비상연락처 수정" });
      await sheet.getByRole("combobox", { name: /^관계/ }).selectOption({ label: "형제자매" });
      await sheet.getByRole("button", { name: "비상연락처 수정" }).click();
      await expect(sheet).toBeHidden();
    },
  },
  "employee.record_section": {
    old: NAMES.school,
    next: "한빛여자고등학교",
    run: async (w) => {
      await openCard(w);
      await w.admin.getByRole("button", { name: `${NAMES.school} 수정` }).click();
      const row = w.admin.getByRole("group", { name: "학력 줄 수정" });
      await row.getByRole("textbox", { name: "학교" }).fill("한빛여자고등학교");
      await row.getByRole("combobox", { name: /왜 정정합니까/ }).selectOption({ label: "입력 실수" });
      await row.getByRole("button", { name: "정정 기록" }).click();
      await expect(row).toBeHidden();
    },
  },
};

/** The region a surface reads. */
const regionOf = (page: Page, s: Surface) => {
  const r = s.region!;
  return r.name ? page.getByRole(r.role, { name: r.name }).first() : page.getByRole(r.role).first();
};

/** The region's text without the history inside it (it keeps the old value on purpose). */
async function shown(page: Page, s: Surface) {
  return regionOf(page, s).evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('#wp-history, [id^="wh-"], section[aria-labelledby^="wh-"], [role="dialog"]').forEach((x) => x.remove());
    return copy.textContent ?? "";
  });
}

/** Every surface of `fact` against `e`, in the app or after a reload; the failures, each naming its surface. */
async function verify(w: World, fact: Fact, e: Edit, reload: boolean) {
  const failures: string[] = [];
  for (const s of fact.surfaces) {
    await w.admin.keyboard.press("Escape");
    if (reload) await w.admin.goto(pageUrl(w, s.page));
    else await go(w.admin, pageUrl(w, s.page));
    for (const step of s.via ?? []) await control(w.admin, { ...step, name: step.name.replace("{workplace}", e.next) }).click();
    if (s.type) await w.admin.getByRole("combobox", { name: s.type.combobox }).fill(s.type.text);
    // The page is on screen first (a cold load under a busy host takes its own time); then the new value arrives within
    // 10 s (in place, or from the read the visit makes), and the old one must be gone.
    await regionOf(w.admin, s).waitFor({ timeout: 30_000 });
    const text = await expect.poll(() => shown(w.admin, s), { timeout: 10_000 }).toContain(e.next).then(() => shown(w.admin, s), () => null);
    if (text === null) failures.push(`${s.name}: 「${e.next}」 not shown${reload ? " after a reload" : ""}`);
    else if (text.includes(e.old)) failures.push(`${s.name}: still shows 「${e.old}」${reload ? " after a reload" : ""}`);
  }
  return failures;
}

for (const live of [false, true]) {
  test(`every surface of an edited fact shows the new value and never the old: ${live ? "live tenant" : "setup phase"}`, { tag: "@record-actions" }, async ({ browser }) => {
    test.setTimeout(300_000);
    const w = await soloWorld(browser, live ? "ra-prop-live" : "ra-prop", live ? "한결상사" : "가온상사", live, { seed: true });
    const failures: string[] = [];
    for (const fact of FACTS) {
      const e = EDITS[fact.id];
      expect(e, `facts.ts ${fact.id} has no edit in this harness`).toBeDefined();
      await e!.run(w);
      failures.push(...(await verify(w, fact, e!, false)), ...(await verify(w, fact, e!, true)));
    }
    expect(failures).toEqual([]);
  });
}

test("planted: a surface reading a cached copy of the 사업장 name fails the harness", { tag: "@record-actions" }, async ({ browser }) => {
  test.setTimeout(240_000);
  const w = await soloWorld(browser, "ra-prop-plant", "다온상사", false);
  const fact = FACTS.find((f) => f.id === "workplace.name")!;
  const e = EDITS[fact.id]!;
  // The plant, before the edit: every read answers from a copy that never takes the new name (a stale cache, a copied fact).
  await w.admin.route("**/api/v1/**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replaceAll(e.next, e.old) });
  });
  await e.run(w);
  const failures = await verify(w, { ...fact, surfaces: fact.surfaces.filter((s) => s.page === "entity" && s.via) }, e, false);
  expect(failures.length, failures.join("\n")).toBeGreaterThan(0);
});
