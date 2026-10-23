import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { apiAs, setBackend, soloTenant } from "./chaos";
import { go, kstDate } from "./flows";
import { fillRegister, pressRegister, receiptOf, registerSheet } from "./helpers/register";
import { setupCompany } from "./setup-flows";

// The backend restarts while a person is being registered (a deploy, a crash). This stops the slot's whole backend,
// so it is tagged @clock: the "clock" project runs it alone, after the rest (playwright.config.ts).
const DOWN = /서버에 연결하지 못했습니다|서버가 요청을 처리하지 못했습니다/;

test("a backend restart mid-registration: the save fails in words, the session survives, the retry lands once", { tag: ["@clock", "@chaos"] }, async ({ browser }) => {
  const admin = await soloTenant(browser, "chaosboot", "재시작");
  const read = apiAs(admin);
  await setupCompany(admin, "재시작", "본사");
  await go(admin, "/people/new");
  // No department: the 사업장's own unit takes the person (decisions #14).
  await fillRegister(admin, { name: "재시작직원", unit: "본사", hired: kstDate() });

  try {
    await setBackend(false);
    await pressRegister(admin);
    await expect(registerSheet(admin).getByRole("alert")).toContainText(DOWN);
    await expect(registerSheet(admin).getByRole("textbox", { name: /^이름/ })).toHaveValue("재시작직원");
    // The answer never came, so the save is held for its check instead of being sent again (BL-010).
    await expect(registerSheet(admin).getByRole("button", { name: /^직원 등록 1명 반영(?: ⌘|$)/ })).toBeDisabled();
    await expectAccessible(admin, "register employee: the backend is down");
  } finally {
    await setBackend(true);
  }
  // Same session (the refresh cookie and the signing key outlive the process), same draft, one record: the check reads
  // the original outcome and finishes the same intent under its key.
  await registerSheet(admin).getByRole("button", { name: "기록됐는지 확인" }).click();
  await expect(receiptOf(admin, "재시작직원")).toBeVisible();
  const found = await read<{ items: { name: string }[] }>(`/api/v1/employees?search=${encodeURIComponent("재시작직원")}`);
  expect(found.items.filter((e) => e.name === "재시작직원")).toHaveLength(1);
});
