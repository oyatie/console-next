import { beforeAll, expect, it } from "vitest";
import { loadCatalog } from "@console/i18n";
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
