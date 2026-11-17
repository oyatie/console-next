import { beforeAll, expect, it } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { candidateBasisLabel, importError } from "./present";
beforeAll(() => loadCatalog("ko"));
it("renders a certificate refusal by code and leaves unknown errors to the shared handler", () => {
  expect(importError("entity_certificate_unconfirmed")).toBe("등록증으로 확인된 법인만 연결할 수 있습니다. 원본 값은 확인 필요로 유지됩니다.");
  expect(importError("unrecognized_error")).toBeUndefined();
});
it("labels known matching evidence and preserves an unfamiliar basis", () => {
  expect(candidateBasisLabel("future_basis")).toBe("future_basis");
  expect(candidateBasisLabel("alias")).not.toBe("alias");
});

it.each(["en", "ko"] as const)("%s names both SQL apply refusals without database details", async locale => {
  await loadCatalog(locale);
  for (const code of ["import_apply_forbidden", "import_apply_timed_out"]) {
    expect(importError(code)).toBeTypeOf("string");
    expect(importError(code)).not.toContain(code);
  }
});

it.each(["en", "ko"] as const)("%s uses the shared timeout message", async locale => {
  await loadCatalog(locale);
  expect(importError("import_apply_timed_out")).toBe(t("import.timedOut", { rows: 1 }));
});
