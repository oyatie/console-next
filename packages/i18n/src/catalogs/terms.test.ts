import { expect, test } from "vitest";
import { bootEn, bootKo } from "./boot";
import { en } from "./en";
import { ko } from "./ko";

/** Tenant labels refer to the customer account, not a company. */
const TENANT_LABELS = [
  "enum.unitKind.COMPANY",
  "structure.level.tenant",
  "structure.root.name",
  "structure.root.word",
  "structure.root.label",
  "access.scope.tenant",
  "access.scope.tenant.label",
  "access.scope.summary.tenant",
  "access.scope.kind.TENANT",
  "identifiers.scope.tenant",
  "requests.subject.ORGANIZATION",
  "workplace.kinds.tenant",
  "entityCreate.review.rootKicker",
  "entityCreate.context",
  "entityQuick.kicker",
  "tenants.form.name",
  "tenants.form.nameRequired",
  "orgPropose.move.siteFixed",
] as const;

test("no label that stands for the tenant says 회사 (ko) or company (en)", () => {
  for (const id of TENANT_LABELS) {
    expect(ko[id], id).not.toMatch(/회사|그룹/);
    expect(en[id], id).not.toMatch(/company|group/i);
  }
  expect(ko["orgPropose.move.siteFixed"]).toContain("법인 바로 아래");
  // The account's name is never a placeholder in a place's copy: it belongs to the shell.
  for (const id of ["entityCreate.context", "entityCreate.field.corpName", "entityCreate.name.clash", "entityQuick.kicker"] as const) {
    expect(ko[id], id).not.toContain("{tenant}");
    expect(en[id], id).not.toContain("{tenant}");
  }
});

// Entity uploads remain evidence; the MVP does not read their contents.
const PROMISES_FILL = { ko: /채워 드립|자동으로 채|(올리면|올린) [^.]*채[워우]|읽어 (옵|와|채)/, en: /filled in for you|fills? (in )?(the |its )?fields|prefill|reads? (the )?(values|text) from|extracts? (the |its )?(values|fields|text)/i };
const UPLOAD_AREAS = /^(entity|entityCreate|entityQuick|entityRecord|setup|workplace)\./;

test("no entity or setup string promises that an upload fills the fields", () => {
  for (const [locale, cat] of [["ko", ko], ["en", en]] as const) {
    const promising = Object.entries(cat).filter(([id, text]) => UPLOAD_AREAS.test(id) && PROMISES_FILL[locale].test(text));
    expect(promising, locale).toEqual([]);
  }
  expect(ko["setup.action.entity"]).toBe("법인 등록");
  expect(ko["entity.empty.action"]).toBe("법인 등록");
  expect(ko["entityCreate.original.drop"]).toContain("(선택)");
  expect(ko["entityCreate.original.typed"]).toContain("글자를 읽어 오지 않으니");
  expect(ko).not.toHaveProperty("entityCreate.original.why");
});

const SHELL_WORDS = ["shell.link.org"] as const;
const TENANCY_WORDS = [
  "common.failed.code.parent_not_found",
  "structure.title",
  "structure.list.label",
  "orgStructure.title",
  "entityCreate.crumbRoot",
  "orgHistory.crumb",
  "orgBulk.crumb",
  "orgBulk.close",
  "workplace.kinds.kicker",
  "setup.terms.accept",
  "setup.terms.done",
  "setup.remedy.accept_terms",
  "setup.golive.item.terms_not_accepted",
  "accessGrants.scoped.note",
  "accounts.code.preset_role_refused",
] as const;

test("no screen name, crumb or terms line names the tenancy a 회사 (ko) or a company (en)", () => {
  for (const id of TENANCY_WORDS) {
    expect(ko[id], id).not.toMatch(/회사/);
    expect(en[id], id).not.toMatch(/company/i);
  }
  for (const id of SHELL_WORDS) {
    expect(bootKo[id], id).not.toMatch(/회사/);
    expect(bootEn[id], id).not.toMatch(/company/i);
  }
  expect(bootKo["shell.link.org"]).toBe("조직 구조");
  expect(ko["setup.terms.accept"]).toContain("고객 계정");
});

// CX-grade-fix: a catalog's numerical rank is not the GRADE classification.
test("catalog rank copy says 서열; 직급 names only the grade kind", () => {
  for (const id of ["titles.col.rank", "titles.unranked", "titles.rank.hint", "lifecycle.promote.rank"] as const) {
    expect(ko[id], id).not.toContain("직급");
    expect(ko[id], id).toContain("서열");
    expect(en[id], id).not.toMatch(/grade/i);
  }
  expect(ko["empFix.field.grade"]).toBe("직급");
});
