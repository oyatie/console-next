import { expect, test } from "@playwright/test";
import { go } from "../flows";
import { FACTS, UNTRACKED } from "./facts";
import { REACH, type ReachEntry } from "./reach";
import { NAMES, control, fill, pageUrl, soloWorld, walk } from "./world";

// The reachability walk (docs/design/record-actions.md §6): every registered create, update/correct and end action is
// found from its record's own page in at most two interactions, by role and accessible name only (no test ids), in a
// setup-phase tenant and in a live one. Then the census: every 「… 수정」 on the card and the 사업장 panels is a fact with
// its surfaces mapped (facts.ts) or listed as untracked. A planted unreachable action fails the same walk.

const forPhase = (live: boolean) => REACH.filter((e) => !e.phase || e.phase === (live ? "live" : "setup"));
const label = (e: ReachEntry) => `${e.record} ${e.op} (${e.page}: ${e.via.map((s) => fill(s.name)).join(" › ")})`;
type World = Awaited<ReturnType<typeof soloWorld>>;

/** Walks each entry from its page; the ones not found, by label. */
async function missedOf(w: World, entries: readonly ReachEntry[], timeout?: number) {
  const missed: string[] = [];
  for (const e of entries) {
    const action = await walk(w, e.page, e.via, timeout).catch(() => null);
    if (!action) missed.push(label(e));
    else await expect.soft(action, label(e)).toBeVisible();
  }
  return missed;
}
/** The gate's assertion: nothing registered is missed. */
const allReached = (missed: string[]) => expect(missed, `unreachable from the record's own page:\n${missed.join("\n")}`).toEqual([]);

for (const live of [false, true]) {
  test(`every registered action is reached in two interactions or fewer: ${live ? "live tenant" : "setup phase"}`, { tag: "@record-actions" }, async ({ browser }) => {
    test.setTimeout(300_000);
    const w = await soloWorld(browser, live ? "ra-reach-live" : "ra-reach", live ? "누리상사" : "다솜상사", live, { dept: true, seed: true });
    allReached(await missedOf(w, forPhase(live)));

    // The census: each 수정 names its fact; the seeded rows stand for their sections.
    const rows: Record<string, string> = { [`비상연락처 ${NAMES.contact}`]: "비상연락처", [NAMES.school]: "학력", [NAMES.career]: "경력" };
    const known = new Set([...FACTS.map((f) => f.label), ...UNTRACKED]);
    const unknown: string[] = [];
    for (const [page, via] of [["card", []], ["entity", [{ role: "tab", name: "사업장 1", prefix: true }]], ["chart", [{ role: "treeitem", name: "{workplace}", prefix: true }]]] as const) {
      await w.admin.keyboard.press("Escape");
      await go(w.admin, pageUrl(w, page));
      for (const s of via) await control(w.admin, s).click();
      await w.admin.getByRole("button", { name: / 수정$/ }).first().waitFor();
      for (const name of await w.admin.getByRole("button", { name: / 수정$/ }).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? ""))) {
        const fact = name.trim().replace(/ 수정$/, "");
        if (!known.has(rows[fact] ?? fact)) unknown.push(`${page}: ${name}`);
      }
    }
    expect(unknown, "editable rows with no FACTS entry nor UNTRACKED line").toEqual([]);
  });
}

test("planted: an action the UI does not have fails the gate's own assertion, beside a real one that passes", { tag: "@record-actions" }, async ({ browser }) => {
  const w = await soloWorld(browser, "ra-plant", "심음상사", false);
  const planted: ReachEntry = { record: "Entity.workplace", op: "end", page: "entity", via: [{ role: "tab", name: "사업장 1", prefix: true }, { role: "button", name: "사업장 이름 영구 삭제", exact: true }] };
  const real = REACH.find((e) => e.record === "Entity.workplace" && e.op === "update" && e.page === "entity")!;
  const missed = await missedOf(w, [real, planted], 3_000);
  expect(missed).toEqual([label(planted)]);
  expect(() => allReached(missed)).toThrow(/사업장 이름 영구 삭제/);
});
