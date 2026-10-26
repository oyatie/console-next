import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { chooseRadio, firstSignIn, go, routeReady, stepUp } from "./flows";
import { inviteAccount } from "./access-flows";
import { startOperations, tenantInSetup } from "./setup-flows";

// Decision #26 pilot roles, from an empty database: the ops account finds no preset role, creates one in SETUP,
// duplicates and deletes a copy, invites an HR worker and grants the role over the 법인 to start at 운영 시작. The
// readiness list names every grant and the colleague left with none; after 운영 시작 the HR worker reaches the
// granted data and nothing else.


test("pilot roles: no presets, a role made in setup, granted for go-live, enforced after 운영 시작", { tag: "@access" }, async ({ browser }) => {
  // The executive colleague is invited with nothing: the roles view starts empty and readiness names them.
  const { admin } = await tenantInSetup(browser, "roles", "권한상사", false, "본점", "none");

  // No preset roles: the empty state says so, and only ops holds anything.
  // The 관리 ▸ 권한 link opens the roles view.
  await admin.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "권한" }).click();
  await expect(admin).toHaveURL(/\/access\/roles$/);
  await expect(admin.getByRole("heading", { name: "아직 역할이 없습니다" })).toBeVisible();
  await expect(admin.getByText("설정 단계 · 부여는 운영 시작과 함께 적용됩니다")).toBeVisible();
  await expectAccessible(admin, "roles (empty)");

  // A role from the grid: view on HR records and the organization. Nothing is preselected.
  await admin.getByRole("link", { name: "역할 추가" }).first().click();
  await routeReady(admin);
  await expect(admin.getByRole("button", { name: "인사기본 조회", pressed: true })).toHaveCount(0);
  await admin.getByRole("button", { name: "역할 추가" }).click();
  await expect(admin.getByText("역할 이름을 입력하십시오.")).toBeVisible();
  await expect(admin.getByText("할 수 있는 일을 하나 이상 선택하십시오.")).toBeVisible();
  await admin.getByRole("textbox", { name: /^역할 이름/ }).fill("인사 조회");
  await admin.getByRole("button", { name: "인사기본 조회" }).click();
  await admin.getByRole("button", { name: "조직 조회" }).click();
  // 등록·수정 lights 조회 as included; pressing the included cell clears the row.
  await admin.getByRole("button", { name: "근태·휴가 등록·수정" }).click();
  await expect(admin.getByRole("button", { name: /^근태·휴가 조회 · 자동 포함/, pressed: true })).toBeVisible();
  await admin.getByRole("button", { name: /^근태·휴가 조회 · 자동 포함/ }).click();
  await expect(admin.getByRole("button", { name: "근태·휴가 등록·수정", pressed: true })).toHaveCount(0);
  const preview = admin.getByRole("complementary", { name: "이 역할을 가진 사람은" });
  await expect(preview).toContainText("범위 안 직원의 인사기본: 조회할 수 있습니다.");
  await expect(preview).toContainText("자기 자신의 인사 기록 변경");
  await expectAccessible(admin, "role editor");
  await admin.getByRole("button", { name: "역할 추가" }).click();
  await expect(admin).toHaveURL(/\/access\/roles$/);
  const row = admin.getByRole("row", { name: /인사 조회/ });
  await expect(row).toContainText("인사기본 조회");
  await expect(row).toContainText("0명");

  // Duplicate, then delete the copy (no holders: a reason, nothing revoked).
  await admin.getByRole("link", { name: "인사 조회 역할 복제" }).click();
  await expect(admin.getByRole("textbox", { name: /^역할 이름/ })).toHaveValue("인사 조회 사본");
  await expect(admin.getByRole("button", { name: "인사기본 조회", pressed: true })).toBeVisible();
  await admin.getByRole("button", { name: "역할 추가" }).click();
  await admin.getByRole("button", { name: "인사 조회 사본 역할 삭제" }).click();
  const del = admin.getByRole("dialog", { name: "「인사 조회 사본」 역할 삭제" });
  await expect(del).toContainText("이 역할을 가진 사람이 없습니다.");
  await chooseRadio(del, /^권한 정리/);
  await expectAccessible(admin, "role delete");
  await del.getByRole("button", { name: "역할 삭제" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "「인사 조회 사본」 역할을 삭제했습니다" })).toBeVisible();
  await expect(admin.getByRole("row", { name: /인사 조회 사본/ })).toHaveCount(0);

  // An HR worker's account, signed in once (passkey), with no grant yet.
  // The invite has no role at all (governance-01): access comes from the tenant grant alone.
  const hr = await firstSignIn(browser, await inviteAccount(admin, "김인사", "none"));

  // Grant the role over the 법인, from 운영 시작, for a year. Self and ops are refused before any request.
  await go(admin, "/access/grants");
  await expect(admin.getByRole("heading", { name: "부여가 없습니다" })).toBeVisible();
  await admin.getByRole("button", { name: "권한 부여", exact: true }).click();
  const pick = admin.getByRole("combobox", { name: "권한을 부여할 사람 (이름 또는 사번)" });
  await pick.fill("김인사");
  await admin.getByRole("option", { name: /김인사/ }).click();
  const sheet = admin.getByRole("dialog", { name: "권한 부여" });
  await sheet.getByRole("button", { name: /^패스키로 확인하고 부여 1건 저장/ }).click();
  await expect(sheet.getByText("역할을 선택하십시오.")).toBeVisible();
  await expect(sheet.getByText("범위를 선택하십시오.")).toBeVisible();
  await sheet.getByRole("button", { name: / 역할$/ }).click();
  await admin.getByRole("option", { name: /^인사 조회/ }).click();
  // The scope is its own view of the sheet (no sheet over a sheet), with the units below marked as included.
  await sheet.getByRole("button", { name: /범위 선택/ }).click();
  const scope = admin.getByRole("dialog", { name: "범위 선택" });
  // AX-5 (governance-22): a 부서 subtree is a scope now, so no 「not yet」 note.
  await expect(scope.getByText(/부서만 따로 맡기는 범위는 아직 적용할 수 없어/)).toHaveCount(0);
  await scope.getByRole("treegrid", { name: "법인·사업장·부서" }).getByRole("row", { name: /주식회사 권한상사/ }).click();
  // Every unit below the 법인 (its 사업장 and the setup 부서) is marked as included.
  await expect(scope.getByText("포함됨")).toHaveCount(2);
  await scope.getByRole("button", { name: "이 범위로 설정" }).click();
  await sheet.getByRole("button", { name: /^1년/ }).click();
  await chooseRadio(sheet, /^운영 시작과 함께/);
  await chooseRadio(sheet, /^업무 배정·변경/);
  await expect(sheet).toContainText(/김인사님이 운영 시작부터 인사 조회 \(.*권한상사 및 하위/);
  await expectAccessible(admin, "grant sheet");
  await stepUp(sheet, "패스키로 확인하고 부여 1건 저장", admin.getByRole("status").filter({ hasText: "김인사님에게 부여 1건을 저장했습니다" }));
  const grant = admin.getByRole("row", { name: /김인사/ });
  await expect(grant).toContainText("인사 조회");
  await expect(grant).toContainText("준비됨");

  // The readiness list: the grant waits for 운영 시작; the executive colleague would sign in to nothing.
  await go(admin, "/access/ready");
  await expect(admin.getByText("운영 계정(ops)은 언제나 모든 권한을 가집니다")).toBeVisible();
  await expect(admin.getByText("이임원님은 계정이 있지만 부여가 없습니다")).toBeVisible();
  // governance-31: the title adds up to the list (none in force yet, one at go-live).
  await expect(admin.getByRole("heading", { name: "적용 중 0건 (설정 단계부터) · 운영 시작과 함께 적용 1건" })).toBeVisible();
  await expectAccessible(admin, "go-live readiness");

  // The person view: what the grant will allow, and from when.
  await admin.getByRole("link", { name: /^김인사/ }).first().click();
  await expect(admin.getByRole("heading", { name: "김인사님이 할 수 있는 일" })).toBeVisible();
  await expect(admin.getByRole("listitem").filter({ hasText: "인사 조회" })).toBeVisible();
  await expect(admin.getByRole("region", { name: "김인사님이 할 수 있는 일" })).toContainText("운영 시작부터 적용");
  await expectAccessible(admin, "person access");

  await startOperations(admin);

  // After 운영 시작 the grant is in effect: the HR worker reads people, and access management stays closed.
  await go(admin, "/access/grants");
  await expect(admin.getByRole("row", { name: /김인사/ })).toContainText("적용 중");
  await go(hr, "/people");
  await expect(hr.getByRole("heading", { name: "인사", level: 1 })).toBeVisible();
  await expect(hr.getByRole("link", { name: "권한" })).toHaveCount(0);
  await go(hr, "/access/roles");
  await expect(hr.getByText("접근 권한이 없습니다")).toBeVisible();
});
