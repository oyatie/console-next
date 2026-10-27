import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { apiAs, faultNext, NETWORK_ERROR, online, sent, soloTenant, statusError } from "./chaos";
import { go, kstDate, option } from "./flows";
import { reviseFact } from "./helpers/entity";
import { box } from "./structure-flows";
import { fillEntity, pickKind, registerEntity, registerWorkplace, setupRail, workplaceSheet } from "./setup-flows";

// The solo administrator's setup on a bad connection: every save that fails says so in words, keeps what was typed,
// and a retry records the thing once (the same idempotency key replays what the server already recorded). Since the
// command ledger (BL-010) a save whose answer never came is held, not pressed again: the screen says it is checking,
// and 「기록됐는지 확인」 reads the original outcome and finishes the same intent under its key.

/** The held save's notice on `scope`, and its in-place check. */
const held = (scope: Page | Locator) => {
  const notice = scope.getByRole("status").filter({ hasText: "처리 여부 확인 중" });
  return { notice, finish: notice.getByRole("button", { name: "기록됐는지 확인" }) };
};

type Entities = { items: { id: string; current?: { name: string } | null; registrations: unknown[]; workplaces: { id: string; current?: { name: string; phone?: { display: string } | null } | null }[] }[] };
type Structure = { entities: Node[] };
type Node = { kind: string; name: string; children: Node[] };
const names = (ns: Node[]): string[] => ns.flatMap((n) => [n.name, ...names(n.children)]);

test("setup on a bad connection: 법인, 사업장 and 부서 are each recorded once and nothing typed is lost", { tag: "@chaos" }, async ({ browser }) => {
  const admin = await soloTenant(browser, "chaosset", "혼돈설정");
  const read = apiAs(admin);

  // 1. 법인: the request never arrives, then its answer is lost, then the second step (its registration) fails.
  await setupRail(admin).getByRole("link", { name: "법인 등록" }).first().click();
  await fillEntity(admin, "혼돈설정");
  const creates = sent(admin, /\/api\/v1\/legal-entities$/);
  const save = admin.getByRole("button", { name: "법인만 등록" });
  const entity = held(admin);
  await faultNext(admin, /\/api\/v1\/legal-entities$/, "abort");
  await save.click();
  await expect(entity.notice).toContainText(NETWORK_ERROR);
  await expect(save).toBeDisabled();
  await expect(admin.getByRole("region", { name: "입력한 내용" })).toContainText("주식회사 혼돈설정");
  await expectAccessible(admin, "setup entity: a save held while its outcome is checked");
  await faultNext(admin, /\/api\/v1\/legal-entities$/, "lost");
  await entity.finish.click();
  await expect(entity.notice).toContainText(NETWORK_ERROR);
  await faultNext(admin, /\/registrations$/, "500");
  await entity.finish.click();
  await expect(entity.notice).toContainText(statusError(500));
  await entity.finish.click();
  await expect(admin.getByRole("heading", { name: /혼돈설정/, level: 1 })).toBeVisible();
  // Three sends of one intent, one key: the server replayed the entity it had recorded instead of adding a second.
  expect(creates.keys().size).toBe(1);
  const mine = (await read<Entities>("/api/v1/legal-entities")).items.filter((e) => e.current?.name === "주식회사 혼돈설정");
  expect(mine).toHaveLength(1);
  expect(mine[0]!.registrations).toHaveLength(1);

  // 2. 사업장: the answer takes 5 s and the button is pressed twice: one workplace.
  await go(admin, "/");
  await setupRail(admin).getByRole("link", { name: "사업장 등록" }).first().click();
  const add = workplaceSheet(admin);
  await add.getByLabel("사업장 이름").fill("본사");
  await pickKind(add);
  await option(admin, "사업자등록", "이미 입력한 등록증").click();
  await add.getByRole("radiogroup", { name: /^원천징수 신고/ }).getByText(/에서 함께 신고$/).click();
  await option(admin, "4대보험", "모두 성립 · 번호는 나중에").click();
  const workplaces = sent(admin, /\/workplaces$/);
  await faultNext(admin, /\/workplaces$/, "slow");
  await add.getByRole("button", { name: "사업장 추가", exact: true }).dblclick();
  await expect(add).toBeHidden({ timeout: 15_000 });
  await expect(admin.getByRole("status").filter({ hasText: "본사 사업장을 등록했습니다" })).toBeAttached();
  test.info().annotations.push({ type: "sends", description: `workplace double press: ${workplaces.count()} POST, ${workplaces.keys().size} key` });
  expect(workplaces.keys().size).toBe(1);
  expect((await read<Entities>("/api/v1/legal-entities")).items.find((e) => e.id === mine[0]!.id)!.workplaces).toHaveLength(1);

  // 3. 부서: the connection drops as it is sent; back online, the same field is still filled and one press adds it.
  // On the chart: select 본사, A, the name, Enter (one batch per add).
  await go(admin, "/org");
  await box(admin, "본사").click();
  await admin.keyboard.press("a");
  const unitName = admin.getByRole("textbox", { name: "본사 아래 새 부서 이름" });
  await unitName.fill("총무팀");
  const units = sent(admin, /\/org-structure\/batches$/);
  await faultNext(admin, /\/org-structure\/batches$/, "offline");
  await unitName.press("Enter");
  const unit = held(admin);
  await expect(unit.notice).toContainText(NETWORK_ERROR);
  await expect(unitName).toHaveValue("총무팀");
  await expectAccessible(admin, "setup org: an add that did not reach the server");
  await online(admin);
  await unit.finish.click();
  await expect(box(admin, "총무팀")).toBeVisible();
  expect(units.keys().size).toBe(1);
  expect(names((await read<Structure>("/api/v1/org-structure")).entities).filter((n) => n === "총무팀")).toHaveLength(1);
});

test("edits on a bad connection: a failed 법인 or 사업장 change keeps the dialog and its values, and lands once", { tag: "@chaos" }, async ({ browser }) => {
  const admin = await soloTenant(browser, "chaosedit", "혼돈변경");
  const read = apiAs(admin);
  await setupRail(admin).getByRole("link", { name: "법인 등록" }).first().click();
  await registerEntity(admin, "혼돈변경");
  const entityPage = new URL(admin.url()).pathname;

  // 법인 대표전화 변경: a 500, then the answer is lost; the retry replays the one revision.
  const edit = await reviseFact(admin, "대표전화", "rev");
  const phoneBox = edit.getByRole("textbox", { name: /^대표전화/ });
  await phoneBox.fill("02-555-0101");
  const revisions = sent(admin, /\/api\/v1\/legal-entities\/[^/]+$/, "PUT");
  const phone = held(edit);
  await faultNext(admin, /\/api\/v1\/legal-entities\/[^/]+$/, "500", "PUT");
  await edit.getByRole("button", { name: "변경 기록" }).click();
  await expect(phone.notice).toContainText(statusError(500));
  await expect(phoneBox).toHaveValue("02-555-0101");
  await expect(edit.getByRole("button", { name: "변경 기록" })).toBeDisabled();
  await expectAccessible(admin, "entity edit: a save the server failed");
  await faultNext(admin, /\/api\/v1\/legal-entities\/[^/]+$/, "lost", "PUT");
  await phone.finish.click();
  await expect(phone.notice).toContainText(NETWORK_ERROR);
  await phone.finish.click();
  await expect(edit).toBeHidden();
  await expect(admin.getByText("02-555-0101").first()).toBeVisible();
  expect(revisions.keys().size).toBe(1);
  type Revisions = { items: { changes: { field: string }[] }[] };
  const changed = (r: Revisions, field: string) => r.items.filter((x) => x.changes.some((c) => c.field === field));
  expect(changed(await read<Revisions>(`/api/v1/legal-entities/${entityPage.split("/").pop()}/revisions`), "main_phone")).toHaveLength(1);

  // 사업장 전화 수정: offline as it is sent, then a slow answer and a double press.
  await go(admin, "/");
  await setupRail(admin).getByRole("link", { name: "사업장 등록" }).first().click();
  await registerWorkplace(admin, "혼돈변경", "본사");
  await go(admin, entityPage);
  await admin.getByRole("tab", { name: /^사업장 \d/ }).click();
  const panel = admin.getByRole("complementary", { name: "본사" });
  await panel.getByRole("button", { name: "전화 수정" }).click();
  const wEdit = admin.getByRole("dialog", { name: "전화 수정" });
  await wEdit.getByLabel("전화").fill("031-555-0102");
  await wEdit.getByLabel("적용일").fill(kstDate());
  await option(admin, "변경 사유", "연락처 변경").click();
  const wSends = sent(admin, /\/api\/v1\/workplaces\/[^/]+$/, "PUT");
  await faultNext(admin, /\/api\/v1\/workplaces\/[^/]+$/, "offline", "PUT");
  await wEdit.getByRole("button", { name: "변경 저장" }).click();
  const place = held(wEdit);
  await expect(place.notice).toContainText(NETWORK_ERROR);
  await online(admin);
  await faultNext(admin, /\/api\/v1\/workplaces\/[^/]+$/, "slow", "PUT");
  await place.finish.dblclick();
  await expect(wEdit).toBeHidden({ timeout: 15_000 });
  await expect(panel.getByRole("definition").filter({ hasText: "031-555-0102" })).toBeVisible();
  test.info().annotations.push({ type: "sends", description: `workplace edit: ${wSends.count()} PUT, ${wSends.keys().size} key` });
  expect(wSends.keys().size).toBe(1);
  const w = (await read<Entities>("/api/v1/legal-entities")).items.find((e) => e.current?.name === "주식회사 혼돈변경")!.workplaces[0]!;
  expect(changed(await read<Revisions>(`/api/v1/workplaces/${w.id}/revisions`), "phone")).toHaveLength(1);
});
