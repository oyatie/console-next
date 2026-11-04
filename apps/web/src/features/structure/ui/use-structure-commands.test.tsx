// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { read } from "../../../lib/query";
import { useStructureCommands, type Commands } from "./use-structure-commands";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../../reference/org/api", async (original) => ({ ...await original<typeof import("../../../reference/org/api")>(), governed: vi.fn(async () => ({ id: "change", code: "change-code", sent: "sent", status: "APPROVED" })), inlineUnitBody: vi.fn(), changeReceipt: vi.fn(() => "scheduled") }));
vi.mock("../../../reference/org/ui/use-change-note", () => ({ noteChange: vi.fn() }));

test("an inline scheduled change refreshes the toolbar's scheduled count", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const reread = vi.fn(async () => ({ items: [], total: 1 }));
  const scheduled = new QueryObserver(client, {
    ...read("/api/v1/org-changes", reread),
    initialData: { items: [], total: 0 },
    staleTime: Infinity,
  });
  const unsubscribe = scheduled.subscribe(() => undefined);
  let command!: Commands;
  function Probe({ collect }: { collect: (value: Commands) => void }) { collect(useStructureCommands()); return null; }
  renderToStaticMarkup(<QueryClientProvider client={client}><Probe collect={(value) => { command = value; }} /></QueryClientProvider>);
  try {
    command.propose({ kind: "create", parentUnitId: "parent", name: "unit", effectiveDate: "2026-12-01", reason: "Growth", submit: true });
    await vi.waitFor(() => expect(reread).toHaveBeenCalledOnce());
    expect(scheduled.getCurrentResult().data?.total).toBe(1);
  } finally {
    unsubscribe();
    client.clear();
  }
});
