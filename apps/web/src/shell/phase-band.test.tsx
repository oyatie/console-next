// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { PhaseBand } from "./phase-band";

const state = vi.hoisted(() => ({ error: null as unknown }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isPending: false, isError: true, error: state.error }) }));
beforeAll(() => loadCatalog("ko"));

test("a failed shell read shows the shared failure card, manual retry and support reference beside its route", () => {
  state.error = new ApiError(503, "service_unavailable", "busy", [], "read-outage", true);
  const html = renderToStaticMarkup(<PhaseBand><p>{t("home.title")}</p></PhaseBand>);
  for (const text of [t("common.loadFailed.title"), t("common.retry"), "read-outage", t("home.title")]) expect(html).toContain(text);
});

test("a refused shell read keeps its existing presentation", () => {
  state.error = new ApiError(403, "forbidden", "refused");
  expect(renderToStaticMarkup(<PhaseBand><p>{t("home.title")}</p></PhaseBand>)).toBe(`<p>${t("home.title")}</p>`);
});
