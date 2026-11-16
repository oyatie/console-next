// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog, t } from "@console/i18n";

vi.mock("../api/self-binding", () => { throw new Error("Inbox reviews must not load solo account binding commands"); });

beforeAll(() => loadCatalog("en"));

test("inbox review decisions render without loading solo account binding commands", async () => {
  const { SelfBindingReview } = await import("./self-binding-review");
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><SelfBindingReview id="attestation" /></QueryClientProvider>);
  expect(html).toContain(t("people.account.confirmBinding"));
  expect(html).toContain(t("people.account.revokeBinding"));
});
