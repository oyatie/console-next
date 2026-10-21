import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import { emptyDraft } from "../domain/draft";
import { RegistryForm } from "./create-registry-form";
import type { CreateState } from "./use-create";

beforeAll(() => loadCatalog("ko"));

const c = { draft: emptyDraft(), put: () => {}, problems: {}, today: "2026-10-13" } as unknown as CreateState;
const html = (client: QueryClient) => renderToStaticMarkup(<QueryClientProvider client={client}><RegistryForm c={c} /></QueryClientProvider>);

// Regression (CL-dev-reds): the 주된 업종 field drew a "list not loaded" note until the KSIC list answered, then swapped
// to the typed code field, moving the form under the user's pointer (j1-register, attendance-schedule layout shift).
test("the registry form holds its code field until the list answers whether it is loaded", () => {
  // Nothing has answered yet (a server render runs no query): the form is held, not drawn in a shape that may swap.
  const pending = html(new QueryClient());
  expect(pending).toContain("불러오는 중…");
  expect(pending).not.toContain("주된 업종");
});
