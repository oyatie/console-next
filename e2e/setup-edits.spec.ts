import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { apiAs, soloTenant } from "./chaos";
import { go, kstDate, option } from "./flows";
import { reviseFact } from "./helpers/entity";
import { addDepartments, box, revealUnit } from "./structure-flows";
import { registerEntity, SECOND, setupCompany } from "./setup-flows";

// The update and void half of the company structure in setup (decisions #21), on the screens that serve it today:
// a workplace's dated changes, a department renamed in place, and a mistaken legal entity removed.

type Entities = { items: { id: string; current?: { name: string } | null }[] };

test("setup edits: a workplace changed twice, a department renamed, a duplicate 법인 removed", { tag: "@first-run" }, async ({ browser }) => {
  const admin = await soloTenant(browser, "setupedit", "설정변경");
  const read = apiAs(admin);
  await setupCompany(admin, "설정변경", "본사");

  // 1. Two 사업장 facts, each from its own row's 수정, twice today: the second save carries the revision the first recorded, and keeps its name.
  await admin.getByRole("button", { name: /^사업장 \d/ }).click();
  for (const [field, value, reason, now] of [["사업장 이름", "서울본사", "이름 변경", "본사"], ["전화", "02-555-0177", "연락처 변경", "서울본사"]] as const) {
    await admin.getByRole("complementary", { name: now }).getByRole("button", { name: `${field} 수정` }).click();
    const edit = admin.getByRole("dialog", { name: `${field} 수정` });
    await edit.getByLabel(field).fill(value);
    await edit.getByLabel("적용일").fill(kstDate());
    await option(admin, "변경 사유", reason).click();
    await edit.getByRole("button", { name: "변경 저장" }).click();
    await expect(edit).toBeHidden();
  }
  const panel = admin.getByRole("complementary", { name: "서울본사" });
  await expect(panel.getByRole("definition").filter({ hasText: "02-555-0177" })).toBeVisible();
  await expectAccessible(admin, "workplace after two changes");

  // 2. A department added in setup, then renamed in place (applies at once, no approval).
  await go(admin, "/org");
  await addDepartments(admin, "서울본사", ["총무팀"]);
  await revealUnit(admin, "총무팀");
  await admin.keyboard.press("F2");
  const rename = admin.getByRole("textbox", { name: "총무팀의 새 이름" });
  await expect(rename).toBeFocused();
  await rename.fill("경영지원팀");
  await rename.press("Enter");
  await expect(box(admin, "경영지원팀")).toBeVisible();
  await expect(box(admin, "총무팀")).toHaveCount(0);
  await expectAccessible(admin, "setup org after a rename");

  // 3. A second 법인 entered by mistake, removed while still in setup: the list is back to one.
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "중복입력", false, undefined, SECOND);
  await admin.getByRole("button", { name: "법인 삭제 미리보기" }).click();
  const remove = admin.getByRole("dialog", { name: "법인 삭제" });
  await expect(remove).toContainText("주식회사 중복입력");
  await expectAccessible(admin, "void entity in setup");
  await option(admin, "삭제 사유", "중복 등록").click();
  await remove.getByRole("button", { name: "법인 삭제" }).click();
  await expect(admin).toHaveURL(/\/org\/entities$/);
  const list = admin.getByRole("grid", { name: "법인 목록" });
  await expect(list.getByRole("row", { name: /주식회사 설정변경/ })).toBeVisible();
  await expect(list.getByRole("row", { name: /중복입력/ })).toHaveCount(0);
  expect((await read<Entities>("/api/v1/legal-entities")).items.map((e) => e.current?.name)).toEqual(["주식회사 설정변경"]);
});

// A revision carries the whole state: a second change of the 법인 made while the first is scheduled starts from the
// scheduled state and dates from its day, so it does not undo the first (it did: the name reverted).
test("a 법인 changed twice ahead of its date keeps both changes", { tag: "@first-run" }, async ({ browser }) => {
  const admin = await soloTenant(browser, "entsched", "예약법인");
  const read = apiAs(admin);
  await setupCompany(admin, "예약법인", "본사");
  const id = new URL(admin.url()).pathname.split("/").pop()!;
  const later = kstDate(7);
  for (const [field, input, value, from] of [["법인명(단체명)", /^법인명/, "주식회사 새이름", later], ["대표전화", /^대표전화/, "02-555-0199", kstDate()]] as const) {
    const edit = await reviseFact(admin, field, "rev", from);
    await edit.getByRole("textbox", { name: input }).fill(value);
    if (from !== later) {
      // Before the scheduled change's day: refused in place, with why; from that day it saves.
      await expect(edit).toContainText("부터 적용할 변경이 예약돼 있어 그날부터 적용할 수 있습니다");
      await expect(edit.getByRole("button", { name: "변경 기록" })).toHaveAttribute("aria-disabled", "true");
      await expectAccessible(admin, "entity change after a scheduled change");
      await option(admin, "언제부터 바뀝니까", "직접 입력").click();
      await edit.getByLabel("적용일").fill(later);
    }
    // The next change opens on what this one scheduled: wait for the entity's read to come back with it.
    const scheduledBefore = from === later ? 0 : 1;
    const reread = admin.waitForResponse(
      async (r) => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/v1/legal-entities/${id}` && ((await r.json()) as { scheduled: unknown[] }).scheduled.length > scheduledBefore,
    );
    await edit.getByRole("button", { name: "변경 기록" }).click();
    await expect(edit).toBeHidden();
    await reread;
  }
  const e = await read<{ scheduled: { version: number; name: string; main_phone?: { display: string } | null }[] }>(`/api/v1/legal-entities/${id}`);
  const newest = e.scheduled.reduce((a, x) => (x.version > a.version ? x : a));
  expect(newest.name).toBe("주식회사 새이름");
  expect(newest.main_phone?.display).toBe("02-555-0199");
});

// Backend bug (entity crate, found 2026-10-06): a workplace read carries no scheduled revisions (a 법인 read does), and
// a revision must name the newest version, so once a change is scheduled for a later date every further change of
// that workplace is refused as stale until the date passes. Expected to fail until the read carries `scheduled`.
test("a workplace change scheduled ahead does not block the next change", { tag: "@first-run" }, async ({ browser }) => {
  test.fail(true, "backend: the workplace read has no scheduled revisions, so the next save is stale");
  const admin = await soloTenant(browser, "setupsched", "예약변경");
  await setupCompany(admin, "예약변경", "본사");
  await admin.getByRole("button", { name: /^사업장 \d/ }).click();
  const panel = admin.getByRole("complementary", { name: "본사" });
  for (const [field, value, reason] of [["사업장 이름", "서울본사", "이름 변경"], ["전화", "02-555-0178", "연락처 변경"]] as const) {
    await admin.getByRole("complementary").filter({ has: admin.getByRole("button", { name: `${field} 수정` }) }).getByRole("button", { name: `${field} 수정` }).click();
    const edit = admin.getByRole("dialog", { name: `${field} 수정` });
    await edit.getByLabel(field).fill(value);
    await edit.getByLabel("적용일").fill(kstDate(7));
    await option(admin, "변경 사유", reason).click();
    await edit.getByRole("button", { name: "변경 저장" }).click();
    await expect(edit).toBeHidden();
  }
});
