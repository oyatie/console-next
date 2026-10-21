import { expect, test, type Page } from "@playwright/test";
import { go, takeCode, tenantSlugField, unique, vendorPage } from "./flows";

// regression (UX-R2 SETUP, 2026-10-08): 「테넌트 개설」 read the server's 409 slug_taken as a lost response, found the
// other tenant holding that slug and name on its re-read, and said 「…개설되었지만 응답이 끊겨…」 for a tenant the server
// had refused. A refusal is an answer: it stands on the slug field. Only a response lost before any status re-reads,
// and that re-read finds the tenant by the exact slug sent.

const ORGS = "**/api/platform/orgs";
// The vendor page is shared by the worker's tests: a test that stops early must not leave its routes behind.
test.afterEach(async ({ browser }) => (await vendorPage(browser)).unrouteAll({ behavior: "ignoreErrors" }));

async function fillOnboard(v: Page, name: string, slug: string) {
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByRole("dialog").getByLabel("고객 이름").fill(name);
  await slugField(v).fill(slug);
}

/** The dialog's slug field (the tenant panel beside it lists a 식별자 too). */
const slugField = (v: Page) => tenantSlugField(v.getByRole("dialog"));

/** This screen's list reads as a second vendor's would have, before `slug` was opened. */
const hideFromList = (v: Page, slug: string) =>
  v.route(ORGS, async (r) => {
    if (r.request().method() !== "GET") return r.fallback();
    const res = await r.fetch();
    const all = (await res.json()) as { slug: string }[];
    await r.fulfill({ response: res, json: all.filter((o) => o.slug !== slug) });
  });

test("a slug another tenant holds is the server's refusal on the slug field, never a tenant opened", { tag: "@regression" }, async ({ browser }) => {
  const v = await vendorPage(browser);
  const name = unique("겹친식별자그룹");
  const slug = unique("dupslug409");
  const other = unique("dupslug409b");
  // Someone else (another vendor, another spec on this database) opens it; this screen's list never shows it.
  await hideFromList(v, slug);
  await go(v, "/platform");
  await fillOnboard(v, name, slug);
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  await takeCode(v);

  // The same name and slug again, past the list's own check.
  await v.route("**/api/platform/company-domain?*", async (r) => r.fulfill({ json: { available: true, alias_days: 90 } }));
  await fillOnboard(v, name, slug);
  await slugField(v).fill(`${slug}-temp`);
  await slugField(v).fill(slug);
  await expect(slugField(v)).not.toHaveAttribute("aria-invalid", "true"); // both checks predate the conflicting create
  await v.unrouteAll({ behavior: "wait" }); // the re-read after the answer sees the server as it is
  const sent = v.waitForResponse((r) => r.url().endsWith("/api/platform/orgs") && r.request().method() === "POST");
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const answer = await sent;
  expect(answer.status()).toBe(409);
  expect(((await answer.json()) as { error: { code: string } }).error.code).toBe("slug_taken");

  const dialog = v.getByRole("dialog", { name: "고객 계정 개설" });
  await expect(slugField(v)).toHaveAttribute("aria-invalid", "true");
  await expect(slugField(v)).toBeFocused();
  await expect(dialog).toContainText("이미 쓰거나 이전에 쓴 회사 도메인이라 개설하지 않았습니다. 다른 회사 도메인을 입력하고 다시 개설하십시오.");
  // Negative: no "opened" receipt, no code, no banner repeating the refusal.
  await expect(v.getByText("개설되었지만")).toHaveCount(0);
  await expect(v.getByLabel("일회용 코드")).toHaveCount(0);
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  // The remedy: another slug clears the refusal and opens the tenant.
  await slugField(v).fill(other);
  await expect(slugField(v)).not.toHaveAttribute("aria-invalid", "true");
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  await takeCode(v);
  await expect(v.locator("#tenants-receipt")).toContainText(`회사 도메인 ${other}`);
});

test("a response lost before any status still finds the tenant it opened, by the exact slug sent", { tag: "@regression" }, async ({ browser }) => {
  const v = await vendorPage(browser);
  const name = unique("응답유실그룹");
  const decoy = unique("lostdecoy409");
  const slug = unique("lostresp409");
  // A tenant of the same name, opened meanwhile by someone else: the recovery must never take it for this one.
  await hideFromList(v, decoy);
  await go(v, "/platform");
  await fillOnboard(v, name, decoy);
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  await takeCode(v);
  await fillOnboard(v, name, slug);
  await v.unrouteAll({ behavior: "wait" });

  // The server opens the tenant; its answer never reaches the browser.
  await v.route(ORGS, async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    await r.fetch();
    await r.abort("internetdisconnected");
  });
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const receipt = v.locator("#tenants-receipt");
  await expect(receipt).toContainText("개설되었지만 응답이 끊겨 코드를 받지 못했습니다");
  await expect(receipt).toContainText(name); // its particle follows the name's last character (a repeat's "-r1")
  await expect(receipt).toContainText(`회사 도메인 ${slug}`);
  await expect(receipt).not.toContainText(decoy);
  await expect(v.getByRole("complementary", { name })).toContainText(slug);
  await v.unrouteAll({ behavior: "wait" });
});
