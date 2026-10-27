import { expect, test, type Locator, type Page } from "@playwright/test";
import { go } from "../flows";
import { box } from "../structure-flows";
import { NAMES, soloWorld } from "./world";

// Each goal starts from the displayed value and allows two role-based interactions to reach its action.
// The walkthrough runs in both setup and operating tenants.

/** `anchor`: the step that sits on the value (default the last; the ⋯ of a row whose verb is in its menu). */
type Goal = { goal: string; start: (p: Page) => Promise<void>; value: (p: Page) => Locator; steps: (p: Page) => Locator[]; anchor?: number };

/** The action's row and the value's row overlap: the action sits on the value it changes. */
async function onValue(value: Locator, action: Locator) {
  const [v, a] = [await value.boundingBox(), await action.boundingBox()];
  return Boolean(v && a && a.y < v.y + v.height && a.y + a.height > v.y);
}

const panel = (p: Page) => p.getByRole("complementary").last();
const fact = (scope: Locator, label: string) => scope.getByRole("term").filter({ hasText: new RegExp(`^${label}$`) });

const GOALS = (w: { entityId: string; personId: string }): Goal[] => [
  {
    goal: "사업장 이름을 바꿔 보세요 (법인 페이지에서)",
    start: (p) => go(p, `/org/entities/${w.entityId}`),
    value: (p) => fact(panel(p), "사업장 이름"),
    steps: (p) => [p.getByRole("tab", { name: /^사업장 1/ }), panel(p).getByRole("button", { name: "사업장 이름 수정", exact: true })],
  },
  {
    goal: "사업장 이름을 바꿔 보세요 (조직도에서)",
    start: (p) => go(p, "/org"),
    value: (p) => fact(panel(p), "사업장 이름"),
    steps: (p) => [box(p, NAMES.workplace), panel(p).getByRole("button", { name: "사업장 이름 수정", exact: true })],
  },
  {
    goal: "사업장 전화번호를 바꿔 보세요",
    start: (p) => go(p, `/org/entities/${w.entityId}`),
    value: (p) => fact(panel(p), "전화"),
    steps: (p) => [p.getByRole("tab", { name: /^사업장 1/ }), panel(p).getByRole("button", { name: "전화 수정", exact: true })],
  },
  {
    goal: "부서 이름을 바꿔 보세요",
    start: (p) => go(p, "/org"),
    value: (p) => fact(panel(p), "부서 이름"),
    steps: (p) => [box(p, NAMES.dept), panel(p).getByRole("button", { name: "부서 이름 수정", exact: true })],
  },
  {
    goal: "비상연락처를 추가해 보세요",
    start: (p) => go(p, `/people/${w.personId}`),
    value: (p) => p.getByRole("region", { name: "인적사항" }).getByText("비상연락처", { exact: true }),
    steps: (p) => [p.getByRole("button", { name: "비상연락처 추가", exact: true })],
  },
  {
    goal: "직원 사진을 올려 보세요",
    start: (p) => go(p, `/people/${w.personId}`),
    value: (p) => p.getByRole("region", { name: "인적사항" }).getByText("사진", { exact: true }),
    steps: (p) => [p.getByRole("button", { name: /^사진 (추가|수정)$/ })],
  },
  {
    goal: "잘못 적은 학교 이름을 정정해 보세요",
    start: (p) => go(p, `/people/${w.personId}`),
    value: (p) => p.getByRole("region", { name: "이력" }).getByRole("cell", { name: NAMES.school, exact: true }).first(),
    steps: (p) => [p.getByRole("button", { name: `${NAMES.school} 수정`, exact: true })],
  },
  {
    goal: "경력 한 줄을 지워 보세요",
    start: (p) => go(p, `/people/${w.personId}`),
    value: (p) => p.getByRole("region", { name: "이력" }).getByRole("cell", { name: "다올기계", exact: true }).first(),
    steps: (p) => [p.getByRole("button", { name: `${NAMES.career} 더보기`, exact: true }), p.getByRole("menuitem", { name: /^(삭제|무효화)$/ })],
    anchor: 0,
  },
];

for (const live of [false, true]) {
  test(`cold persona: each goal's action is found on its value in two interactions: ${live ? "live tenant" : "setup phase"}`, { tag: "@record-actions" }, async ({ browser }) => {
    test.setTimeout(300_000);
    const w = await soloWorld(browser, live ? "ra-goal-live" : "ra-goal", live ? "두레상사" : "하늘상사", live, { dept: true, seed: true });
    const outcome: string[] = [];
    for (const g of GOALS(w)) {
      await w.admin.keyboard.press("Escape");
      await g.start(w.admin);
      const steps = g.steps(w.admin);
      let found = true;
      for (const [i, s] of steps.entries()) {
        found = await s.waitFor({ timeout: 10_000 }).then(() => true, () => false);
        if (found && i === (g.anchor ?? steps.length - 1)) found = await onValue(g.value(w.admin), s);
        if (!found) break;
        if (i < steps.length - 1) await s.click();
      }
      outcome.push(`${found ? "PASS" : "FAIL"} ${g.goal}`);
    }
    test.info().annotations.push({ type: "goals", description: outcome.join("\n") });
    console.log(outcome.join("\n"));
    expect(outcome.filter((o) => o.startsWith("FAIL"))).toEqual([]);
  });
}

// (4d7f6f2ad), where the goal joins GOALS.
