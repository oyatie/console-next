import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { apiAs, faultNext, soloTenant } from "./chaos";
import { firstSignIn, go, kstDate, option } from "./flows";
import { inviteAccount } from "./access-flows";
import { reviseFact } from "./helpers/entity";
import { setupCompany } from "./setup-flows";

// Two administrators on one record, and a session that ends while a change is being typed: a save made against
// what is no longer the newest revision is refused, says so, loses nothing typed, and the next try starts from what
// the other person saved.

/**
 * Opens the change of one fact for today and types it: the 법인's own on its record (the 고치기 sheet), or a
 * workplace's in its panel (the fact's own 수정). Returns the sheet and the names of its save and close buttons.
 */
async function change(page: Page, scope: "entity" | "workplace", field: string, value: string) {
  if (scope === "entity") {
    const edit = await reviseFact(page, field, "rev");
    await edit.getByRole("textbox", { name: new RegExp(`^${field}`) }).fill(value);
    return { edit, save: "변경 기록", back: "취소", input: edit.getByRole("textbox", { name: new RegExp(`^${field}`) }) };
  }
  await page.getByRole("complementary", { name: "본사" }).getByRole("button", { name: `${field} 수정` }).click();
  const edit = page.getByRole("dialog", { name: `${field} 수정` });
  await edit.getByLabel(field).fill(value);
  await edit.getByLabel("적용일").fill(kstDate());
  await option(page, "변경 사유", "연락처 변경").click();
  return { edit, save: "변경 저장", back: "돌아가기", input: edit.getByLabel(field) };
}

// governance-01 (no preset roles): the second administrator is now a tenant-role holder (조직 등록·수정 over 회사 전체),
// and the 법인 record still reads restricted for anyone but a legacy title (entity/rest auth.rs may_manage), so its
// 고치기 cannot be built and nothing is sent. Expected to fail until the ENTITY lane's ask lands (lane-corrections,
// UX-R1 ACCESS); then this marker comes off.
test.fail("two administrators change one 법인 and one 사업장: the later save is refused as stale and recovers", { tag: "@chaos" }, async ({ browser }) => {
  const a = await soloTenant(browser, "chaosstale", "동시변경");
  const b = await firstSignIn(browser, await inviteAccount(a, "박관리", "full"));
  await setupCompany(a, "동시변경", "본사");
  const entityPage = new URL(a.url()).pathname;
  await go(b, entityPage);
  await expect(b.getByRole("heading", { name: /동시변경/, level: 1 })).toBeVisible();

  for (const [scope, field, mine, theirs] of [["entity", "대표전화", "02-111-0001", "02-222-0002"], ["workplace", "전화", "031-111-0001", "031-222-0002"]] as const) {
    if (scope === "workplace") for (const p of [a, b]) await p.getByRole("button", { name: /^사업장 \d/ }).click();
    // Both open the change on the same revision; A saves first.
    const A = await change(a, scope, field, mine);
    // The expected failure, at once rather than at the test's timeout (which test.fail does not count as a failure):
    // backend cedar_pbac/actions/legal_entity_manage.rs still permits only the legacy SUPER_ADMIN/EXECUTIVE roles.
    if (scope === "entity") await expect(b.getByRole("button", { name: `${field} 수정`, exact: true })).toBeVisible();
    const B = await change(b, scope, field, theirs);
    await A.edit.getByRole("button", { name: A.save }).click();
    await expect(A.edit).toBeHidden();
    // B's save is against a revision that is no longer the newest: refused, nothing recorded, B's value kept.
    await B.edit.getByRole("button", { name: B.save }).click();
    // The 법인 sheet names what changed in between (ENTITY-FIX: 「그사이 기록된 내용」); the 사업장 sheet keeps the shared copy.
    await expect(B.edit.getByRole("alert").first()).toContainText(scope === "entity" ? "다른 사람이 먼저 이 법인을 변경해 저장해서" : "다른 사람이 먼저 변경해 저장하지 않았습니다");
    await expect(B.input).toHaveValue(theirs);
    await expectAccessible(b, `${scope} edit refused as stale`);
    // Reopened, the form starts from A's saved value, and B's change, made again, lands on top of it.
    await B.edit.getByRole("button", { name: B.back }).click();
    await expect(B.edit).toBeHidden();
    const again = await change(b, scope, field, theirs);
    await again.edit.getByRole("button", { name: again.save }).click();
    await expect(again.edit).toBeHidden();
    await expect(b.getByText(theirs).first()).toBeVisible();
  }
});

// The session ends (its refresh is refused) while a change is typed. Nothing is half-saved: the user signs in again
// over the same sheet (fe/gate-idle), the typed change still there, and saves it once.
test("a session that ends mid-edit records nothing, re-auths in place and keeps the typed change", { tag: "@chaos" }, async ({ browser }) => {
  const admin = await soloTenant(browser, "chaosexp", "세션만료");
  const read = apiAs(admin);
  await setupCompany(admin, "세션만료", "본사");
  const id = new URL(admin.url()).pathname.split("/").pop()!;
  const { edit } = await change(admin, "entity", "대표전화", "02-333-0003");
  const mainPhone = async () => {
    const revisions = await read<{ items: { changes: { field: string }[] }[] }>(`/api/v1/legal-entities/${id}/revisions`);
    return revisions.items.filter((r) => r.changes.some((c) => c.field === "main_phone")).length;
  };
  // The access token expires and the refresh is refused: the server's answer to a session that has ended.
  await admin.route(/\/api\/v1\/auth\/token\/refresh$/, (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthorized", message: "세션이 끝났습니다" } }) }));
  await admin.route(/\/api\/v1\/legal-entities\/[^/]+$/, (r) => (r.request().method() === "PUT" ? r.fulfill({ status: 401, body: "" }) : r.fallback()));
  await edit.getByRole("button", { name: "변경 기록" }).click();
  const dialog = admin.getByRole("dialog", { name: "다시 로그인" });
  await expect(dialog).toContainText("작성 중인 내용은 이 화면에 그대로 있으니");
  expect(await mainPhone()).toBe(0);
  await admin.unrouteAll();
  await faultNext(admin, /\/api\/v1\/legal-entities\/[^/]+$/, "slow", "PUT");
  const saved = admin.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/v1/legal-entities/${id}`);
  await dialog.getByRole("button", { name: "패스키로 다시 로그인" }).click();
  await expect(dialog).toBeHidden();
  // Re-auth finishes before the interrupted save; await the server, then its UI, without a second press.
  expect((await saved).ok()).toBe(true);
  await expect(edit).toBeHidden();
  await go(admin, `/org/entities/${id}`);
  await expect(admin.getByRole("heading", { name: /세션만료/, level: 1 })).toBeVisible();
  expect(await mainPhone()).toBe(1);
});
