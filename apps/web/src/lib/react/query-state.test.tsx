import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { QueryState } from "./query-state";

beforeAll(() => loadCatalog("ko"));

test.each([undefined, "loaded record"])("a refused read shows its catalog code and preserves existing data (%s)", (data) => {
  const error = new ApiError(404, "scope_not_found", "server fallback", [], undefined, true);
  const html = renderToStaticMarkup(<QueryState
    q={{ isPending: false, error, data, refetch: () => {} }}
    own={code => code === "scope_not_found" ? t("attendance.refusal.scope_not_found") : undefined}
  >{value => <span>{value}</span>}</QueryState>);
  expect(html).toContain(t("attendance.refusal.scope_not_found"));
  expect(html).not.toContain("server fallback");
  if (data) expect(html).toContain(data);
});
