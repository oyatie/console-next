// SPDX-License-Identifier: LicenseRef-Proprietary
import { fmtStamp } from "@console/i18n/format";
import { ko } from "../packages/i18n/src/catalogs/ko";
import { expect, type Page } from "@playwright/test";
import { activatePendingGrants } from "./second-person-fixture";
import { bearerOf } from "./helpers/api";
import { expectAccessible } from "./a11y";
import { chooseRadio, go, stepUp, takeCode } from "./flows";

// There are no preset roles (decision #19, governance-01): an invited account holds nothing. Specs that need a
// colleague who can act give it a tenant-made role here, through the 권한 screens, as a tenant would.

/**
 * What a colleague may do: everything the grid offers, or oversight (조회, 퇴직 확인, 예외·정정 결정 and — on a routed
 * row — 결재, no edit or export). #26: 결재 is a cell only where the tenant routes that change class.
 */
export type Access = "full" | "oversight" | "close";
const ROLE: Record<Access, { name: string; levels: string[] }> = {
  full: { name: "전체 업무", levels: ["등록·수정", "확인", "결정", "결재", "내보내기", "조회"] },
  oversight: { name: "조회·결재", levels: ["확인", "결정", "결재", "조회"] },
  // One domain's cell: the period-close authority (기간 잠금 is a 예외·정정 등록·수정 operation).
  close: { name: "기간 마감", levels: ["예외·정정 등록·수정"] },
};

/** The tenant role for `access`, made once per tenant through the role editor. */
async function ensureRole(admin: Page, access: Access) {
  const { name: FULL, levels } = ROLE[access];
  await go(admin, "/access/roles");
  await expect(admin.getByRole("navigation", { name: "권한 화면" })).toBeVisible();
  await expect(admin.getByRole("link", { name: "역할 추가" }).first()).toBeVisible();
  if (await admin.getByRole("row", { name: new RegExp(`^${FULL}`) }).count()) return;
  await admin.getByRole("link", { name: "역할 추가" }).first().click();
  await admin.getByRole("textbox", { name: /^역할 이름/ }).fill(FULL);
  const grid = admin.getByRole("table", { name: "데이터 영역별 권한" });
  // Levels beyond 조회 first (each lights 조회 as included), then 조회 where it is a domain's only level.
  for (const level of levels) {
    const open = grid.getByRole("button", { name: new RegExp(`(^| )${level}$`), pressed: false });
    for (let n = await open.count(); n > 0; n = await open.count()) await open.first().click();
  }
  await admin.getByRole("button", { name: "역할 추가" }).click();
  await expect(admin).toHaveURL(/\/access\/roles$/);
}

/**
 * Grants `name` the tenant role for `access` over 회사 전체 (or the scope row `scope` names, e.g. one 법인) for a year — from
 * the setup phase when the tenant is still in it — through the 권한 부여 sheet, with the admin's passkey.
 */
export async function grantAccess(admin: Page, name: string, access: Access, scope = /^전체/, activate = true) {
  const token = bearerOf(admin);
  await ensureRole(admin, access);
  const FULL = ROLE[access].name;
  await go(admin, "/access/grants");
  await admin.getByRole("combobox", { name: "권한을 부여할 사람 (이름 또는 사번)" }).fill(name);
  await admin.getByRole("option", { name: new RegExp(name) }).first().click();
  const sheet = admin.getByRole("dialog", { name: "권한 부여" });
  // The role list is a popover; open it again if something took focus before the option was picked.
  const option = admin.getByRole("option", { name: new RegExp(`^${FULL}`) });
  await expect(async () => {
    if (!(await option.isVisible())) await sheet.getByRole("button", { name: / 역할$/ }).click();
    await expect(option).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await option.click();
  await sheet.getByRole("button", { name: /범위 선택/ }).click();
  const pick = admin.getByRole("dialog", { name: "범위 선택" });
  await pick.getByRole("row", { name: scope }).first().click();
  await pick.getByRole("button", { name: "이 범위로 설정" }).click();
  await sheet.getByRole("button", { name: /^1년/ }).click();
  // 적용 시작: from setup while the tenant is in it; once operating, as soon as permitted (nothing is preselected).
  if (await sheet.getByRole("radio", { name: /^설정 단계부터/ }).count()) await chooseRadio(sheet, /^설정 단계부터/);
  else await chooseRadio(sheet, new RegExp(`^${ko["accessGrants.start.NOW"]}`));
  await chooseRadio(sheet, /^업무 배정·변경/);
  // Preview, passkey and apply are three round trips: allowed longer than one assertion under a loaded slot.
  const previewResponse = admin.waitForResponse((r) => r.url().endsWith("/access/grants/preview") && r.request().method() === "POST");
  await sheet.getByRole("button", { name: "패스키로 확인하고 부여 1건 저장" }).click();
  const preview = await (await previewResponse).json() as { items: { enforcement_after: string; activates_at?: string }[] };
  const scheduled = preview.items.filter((i) => i.enforcement_after === "SCHEDULED" && i.activates_at);
  if (scheduled.length) {
    for (const item of scheduled) await expect(sheet.getByText(fmtStamp(item.activates_at), { exact: false })).toBeVisible();
    await sheet.getByRole("button", { name: "패스키로 확인하고 부여 1건 저장" }).click();
  }
  await expect(admin.getByRole("status").filter({ hasText: `${name}님에게 부여 1건을 저장했습니다` })).toBeVisible({ timeout: 20_000 });
  if (activate) await activatePendingGrants(admin, token);
  // this is set-up plumbing for the calling spec, whose own screens are what its stability checks judge; the
  // grant sheet's stability is access-roles.spec's subject. Shifts recorded here are dropped, not charged to the caller.
  await admin.evaluate(() => void window.__shifts?.splice(0));
}

/**
 * Invites an org-wide account for someone who is not an employee (a fresh tenant has no employee records) from the
 * accounts view, and returns its first sign-in code. The account holds nothing until granted: `access` gives it a
 * tenant-made role over 회사 전체 (access-flows.ts), never a preset title.
 */
export async function inviteAccount(admin: Page, name: string, access: Access | "none", audit = false) {
  await go(admin, "/people?view=accounts");
  await admin.getByRole("button", { name: "계정 초대" }).click();
  const sheet = admin.getByRole("dialog", { name: "계정 초대" });
  await expect(sheet).toBeVisible();
  // No preset roles (governance-01): the sheet asks who, never which title.
  await expect(sheet.getByRole("radio")).toHaveCount(0);
  if (audit) await expectAccessible(admin, "invite account sheet");
  await sheet.getByRole("button", { name: "직원이 아닌 사람 초대" }).click();
  // The label carries its 필수 marker, so the field is found by its name prefix.
  await sheet.getByRole("textbox", { name: /^이름/ }).fill(name);
  await stepUp(sheet, "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  const code = await takeCode(admin, audit);
  if (access !== "none") await grantAccess(admin, name, access);
  return code;
}
