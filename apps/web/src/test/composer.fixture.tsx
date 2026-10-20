// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { configure } from "@console/api";
import { webPlatform } from "@console/api/web";
import { loadCatalog, t } from "@console/i18n";
import { BulkSheet } from "../features/people/ui/bulk-sheet";
import { InviteSheet } from "../features/people/ui/account-invite-sheet";
import { EntityQuickSheet } from "../features/entity/ui/entity-quick-sheet";
import { BulkForm, type BulkDraft } from "../features/access/ui/bulk-form";
import { missing, type Missing } from "../features/access/domain/grants";
import { Button } from "../ui/button/button";

export type ComposerCase =
  | { sheet: "bulk"; count: number; paste?: boolean }
  | { sheet: "invite" }
  | { sheet: "entity" }
  | { sheet: "access"; absent: Missing | "people" | "when" | "code" | "memo" | null };

declare global {
  interface Window {
    mountComposer: (value: ComposerCase) => void;
    composerCommits: number;
  }
}

configure(webPlatform);
await loadCatalog("ko");
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
const committed = () => { window.composerCommits++; };
const noop = () => {};

export function Access({ absent }: Extract<ComposerCase, { sheet: "access" }>) {
  const [value, setValue] = useState<BulkDraft>({
    line: {
      key: "grant", role_id: absent === "role" ? null : "role",
      scope: absent === "scope" ? null : { kind: "TENANT", include_descendants: true },
      end: absent === "end" ? null : absent === "end_past" ? "2026-10-19" : "2099-12-31",
    },
    when: absent === "when" ? null : "SETUP",
    reason: { code: absent === "code" ? null : "OTHER", memo: absent === "memo" ? " \u3000\t" : "Test reason" },
  });
  const gaps = missing(value.line, absent === "duplicate" ? [value.line, { ...value.line, key: "duplicate" }] : [value.line], "2026-10-20");
  return <BulkForm roles={[]} setup today="2026-10-20" value={value} onChange={setValue} tried={false} gaps={gaps} picked={absent === "people" ? 0 : 1} onPickScope={noop}>
    <Button variant="primary" onClick={committed}>{t("access.bulk.preview", { count: absent === "people" ? 0 : 1 })}</Button>
  </BulkForm>;
}

export function App() {
  const [value, setValue] = useState<ComposerCase>({ sheet: "invite" });
  useEffect(() => {
    window.mountComposer = (next) => {
      window.composerCommits = 0;
      flushSync(() => setValue(next));
    };
  }, []);
  const key = JSON.stringify(value);
  return <div key={key} data-composer={key}>
    {value.sheet === "access" ? <Access {...value} />
      : value.sheet === "invite" ? <InviteSheet onClose={noop} onIssued={committed} onOpenAccount={noop} />
        : value.sheet === "entity" ? <EntityQuickSheet open onClose={noop} onSaved={committed} />
          : <BulkSheet source={value.paste ? { paste: "" } : { picked: new Map(value.count ? [["test-person", "Test Person"]] : []) }} onClose={noop} onDone={committed} />}
  </div>;
}

const router = createRouter({ routeTree: createRootRoute({ component: App }), history: createMemoryHistory() });
window.composerCommits = 0;
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
